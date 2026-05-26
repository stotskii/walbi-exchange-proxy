/**
 * Tiny client for the walbi-mcp HTTP MCP server (Streamable HTTP transport).
 *
 * walbi-mcp speaks MCP JSON-RPC 2.0 over POST /mcp with a Bearer token. It
 * already handles WALBI auth (encrypted token cache, auto-refresh).
 *
 * We use these MCP tools:
 *   rest_call         — POST to gw.walbi.com on the user's behalf
 *   ws_request        — single WS REQ/RES
 *   ws_subscribe      — polled WS push collection (5–60s windows)
 *   auth_status       — health check
 *
 * Endpoint + Bearer come from env. Default endpoint is the production proxy.
 */

import {randomUUID} from "node:crypto";

const ENDPOINT = process.env.WALBI_MCP_URL ?? "https://walbi-mcp.zw.walbi.cfd/mcp";
const BEARER = process.env.WALBI_MCP_BEARER ?? "";
const ENV = (process.env.WALBI_ENV ?? "prod") as "prod" | "stage";

if (!BEARER) {
  console.warn("[walbi-mcp] WALBI_MCP_BEARER is empty — all calls will fail");
}

type JsonRpcResp<T = unknown> =
  | {jsonrpc: "2.0"; id: string; result: T}
  | {jsonrpc: "2.0"; id: string; error: {code: number; message: string; data?: unknown}};

let mcpSessionId: string | null = null;

/** One JSON-RPC request to walbi-mcp /mcp. */
async function mcpRequest<T>(method: string, params: unknown): Promise<T> {
  const id = randomUUID();
  const body = {jsonrpc: "2.0", id, method, params};

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${BEARER}`,
  };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;

  const res = await fetch(ENDPOINT, {method: "POST", headers, body: JSON.stringify(body)});

  // capture session id if server hands one back
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) mcpSessionId = newSession;

  const text = await res.text();
  // text/event-stream → walk lines for the data: payload
  let payload: JsonRpcResp<T>;
  if (text.startsWith("event:") || text.includes("\ndata:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`SSE response had no data line: ${text.slice(0, 200)}`);
    payload = JSON.parse(dataLine.slice(5).trim()) as JsonRpcResp<T>;
  } else {
    payload = JSON.parse(text) as JsonRpcResp<T>;
  }

  if ("error" in payload) {
    throw new McpError(
      payload.error.code,
      payload.error.message,
      payload.error.data,
    );
  }
  return payload.result;
}

export class McpError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, msg: string, data?: unknown) {
    super(`MCP ${code}: ${msg}`);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

/** Initialize MCP session (required before tool calls). */
let initPromise: Promise<void> | null = null;
async function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await mcpRequest<unknown>("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {name: "walbi-exchange-proxy", version: "0.1.0"},
    });
    // notify initialized — MCP requires this
    try {
      await mcpRequest("notifications/initialized", {});
    } catch {
      // notifications return no result; some servers throw on empty response — ignore
    }
  })();
  return initPromise;
}

interface ToolCallResult {
  content: Array<{type: "text"; text: string} | {type: "image"; data: string; mimeType: string}>;
  isError?: boolean;
}

/** Call an MCP tool by name with arguments. */
async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  await ensureInitialized();
  const result = await mcpRequest<ToolCallResult>("tools/call", {name, arguments: args});

  if (result.isError) {
    const text = result.content.find((c) => c.type === "text")?.text ?? "unknown error";
    throw new McpError(-1, text);
  }

  // walbi-mcp returns JSON-encoded data inside a single text content
  const textBlock = result.content.find((c) => c.type === "text");
  if (!textBlock) throw new McpError(-1, "MCP tool returned no text content");
  try {
    return JSON.parse(textBlock.text) as T;
  } catch {
    // Some tools return plain strings
    return textBlock.text as unknown as T;
  }
}

// ---------- Tools we actually use -------------------------------------------

export interface RestCallResult {
  env: string;
  path: string;
  status: number;
  body: unknown;
}

/** Forward a POST to gw.walbi.com under the cached session. */
export async function walbiRestCall(
  path: string,
  body?: Record<string, unknown>,
): Promise<RestCallResult> {
  return callTool<RestCallResult>("rest_call", {
    env: ENV,
    path,
    body: body ?? {},
  });
}

export interface WsRequestResult {
  env: string;
  event_name: string;
  type: number;
  uuid: string;
  data: unknown;
  error?: unknown;
}

/** Single cerberus WS REQ/RES via walbi-mcp. */
export async function walbiWsRequest(
  event_name: string,
  data?: Record<string, unknown>,
  timeout_s = 15,
): Promise<WsRequestResult> {
  return callTool<WsRequestResult>("ws_request", {
    env: ENV,
    event_name,
    data: data ?? {},
    timeout_s,
  });
}

export interface WsSubscribeFrame {
  event_id: number;
  event_name: string;
  type: number;
  uuid?: string;
  ts?: number;
  data: unknown;
  error?: unknown;
}

export interface WsSubscribeResult {
  env: string;
  subscribed_to: string[];
  duration_s: number;
  max_events: number;
  stats: {received: number; matched: number; dropped: number};
  events: WsSubscribeFrame[];
}

/**
 * Collect WS push frames for a bounded window. Note this is poll-based —
 * each call opens its own ephemeral WS, auths, subscribes, collects, closes.
 * Use with a loop on the proxy side for streaming.
 */
export async function walbiWsSubscribe(
  event_names: string[],
  duration_s = 5,
  max_events = 200,
): Promise<WsSubscribeResult> {
  return callTool<WsSubscribeResult>("ws_subscribe", {
    env: ENV,
    event_names,
    duration_s,
    max_events,
  });
}

/** Read-only auth state check — no network. */
export async function walbiAuthStatus(): Promise<unknown> {
  return callTool("auth_status", {});
}

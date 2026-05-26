/**
 * WebSocket proxy at /ws.
 *
 * Browser opens wss://exchange.walbi.cfd/ws. We accept, and translate frames
 * to walbi-mcp calls:
 *
 *   client → server   { type: "request", event_name, data }     → ws_request
 *   client → server   { type: "subscribe", event_names: [] }   → start polling
 *   client → server   { type: "unsubscribe", event_names: [] } → stop polling
 *
 *   server → client   { type: "response", uuid, event_name, data, error? }
 *   server → client   { type: "push", event_id, event_name, data, ts? }
 *   server → client   { type: "error", message }
 *
 * NOTE: WS pushes here are POLLED via walbi-mcp's ws_subscribe in 5-second
 * windows. This is OK for the inbox / signals / deal-state but is too laggy
 * for sub-second tickers. A future optimization is a direct ws.walbi.com
 * connection from the proxy, but that needs a token-extraction tool we
 * don't have in walbi-mcp yet.
 */

import {WebSocketServer, WebSocket} from "ws";
import type {Server as HttpServer} from "node:http";
import {walbiWsRequest, walbiWsSubscribe, McpError} from "./walbi-mcp.js";

interface ClientMsg {
  type: "request" | "subscribe" | "unsubscribe" | "ping";
  uuid?: string;
  event_name?: string;
  event_names?: string[];
  data?: Record<string, unknown>;
}

const POLL_WINDOW_S = 5;
const POLL_MAX_EVENTS = 200;

interface ClientState {
  subscribed: Set<string>;
  pollLoop: AbortController | null;
}

export function attachWsProxy(server: HttpServer): void {
  const wss = new WebSocketServer({server, path: "/ws"});

  wss.on("connection", (ws) => {
    console.log("[ws-proxy] client connected");
    const state: ClientState = {subscribed: new Set(), pollLoop: null};

    ws.on("message", async (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        send(ws, {type: "error", message: "invalid json"});
        return;
      }

      try {
        switch (msg.type) {
          case "ping":
            send(ws, {type: "pong"});
            return;

          case "request": {
            if (!msg.event_name) {
              send(ws, {type: "error", message: "request missing event_name", uuid: msg.uuid});
              return;
            }
            const result = await walbiWsRequest(msg.event_name, msg.data);
            send(ws, {
              type: "response",
              uuid: msg.uuid,
              event_name: msg.event_name,
              data: result.data,
              error: result.error,
            });
            return;
          }

          case "subscribe": {
            if (!msg.event_names || msg.event_names.length === 0) {
              send(ws, {type: "error", message: "subscribe missing event_names"});
              return;
            }
            for (const n of msg.event_names) state.subscribed.add(n);
            startPolling(ws, state);
            send(ws, {type: "ack", action: "subscribe", count: state.subscribed.size});
            return;
          }

          case "unsubscribe": {
            for (const n of msg.event_names ?? []) state.subscribed.delete(n);
            if (state.subscribed.size === 0) stopPolling(state);
            send(ws, {type: "ack", action: "unsubscribe", count: state.subscribed.size});
            return;
          }

          default:
            send(ws, {type: "error", message: "unknown message type"});
        }
      } catch (err) {
        const message = err instanceof McpError ? err.message : String(err);
        console.error("[ws-proxy] handler error", message);
        send(ws, {type: "error", message, uuid: msg.uuid});
      }
    });

    ws.on("close", () => {
      console.log("[ws-proxy] client disconnected");
      stopPolling(state);
    });

    ws.on("error", (err) => {
      console.warn("[ws-proxy] ws error", err);
    });
  });

  console.log("[ws-proxy] mounted at /ws");
}

function send(ws: WebSocket, obj: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function startPolling(ws: WebSocket, state: ClientState): void {
  if (state.pollLoop) return; // already running
  state.pollLoop = new AbortController();
  void (async () => {
    while (!state.pollLoop?.signal.aborted && state.subscribed.size > 0) {
      try {
        const events = await walbiWsSubscribe(
          [...state.subscribed],
          POLL_WINDOW_S,
          POLL_MAX_EVENTS,
        );
        for (const frame of events.events) {
          send(ws, {
            type: "push",
            event_id: frame.event_id,
            event_name: frame.event_name,
            ts: frame.ts,
            data: frame.data,
          });
        }
      } catch (err) {
        const msg = err instanceof McpError ? err.message : String(err);
        send(ws, {type: "error", message: `poll: ${msg}`});
        // back off on error
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
}

function stopPolling(state: ClientState): void {
  state.pollLoop?.abort();
  state.pollLoop = null;
  state.subscribed.clear();
}

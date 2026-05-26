import {Hono} from "hono";
import {walbiRestCall, McpError} from "./walbi-mcp.js";

/**
 * REST proxy. Mounted at /api/walbi/* on the public side.
 *
 *   POST /api/walbi/user/profile/v1
 *   → walbi-mcp rest_call({ path: "/api/user/profile/v1", body })
 *   → gw.walbi.com under the cached session token
 *
 * Only POST is allowed (narnia has no GET). Body is forwarded as-is.
 * Walbi's own non-2xx status is mirrored back, so TanStack Query on the
 * frontend sees the real error shape.
 */
export const restProxy = new Hono();

restProxy.post("/walbi/*", async (c) => {
  // strip our prefix
  const url = new URL(c.req.url);
  const subPath = url.pathname.replace(/^\/api\/walbi/, "");
  if (!subPath.startsWith("/")) {
    return c.json({error: "bad path"}, 400);
  }

  // narnia path must start with /api — accept both /user/... and /api/user/...
  const walbiPath = subPath.startsWith("/api/") ? subPath : `/api${subPath}`;

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine
  }

  try {
    const result = await walbiRestCall(walbiPath, body);
    // Mirror the upstream status code
    c.status(result.status as 200);
    return c.json(result.body as object);
  } catch (err) {
    if (err instanceof McpError) {
      console.error("[rest-proxy] mcp error", err.code, err.message);
      return c.json({error: {id: "mcp_error", msg: err.message}}, 502);
    }
    console.error("[rest-proxy] unexpected", err);
    return c.json({error: {id: "proxy_internal", msg: String(err)}}, 500);
  }
});

restProxy.all("/walbi/*", (c) => c.json({error: "method not allowed"}, 405));

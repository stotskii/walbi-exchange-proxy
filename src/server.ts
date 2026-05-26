import {Hono} from "hono";
import {logger} from "hono/logger";
import {cors} from "hono/cors";
import {serve} from "@hono/node-server";

import {walbiAuthStatus} from "./walbi-mcp.js";
import {restProxy} from "./rest-proxy.js";
import {attachWsProxy} from "./ws-proxy.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin, // reflect; same-origin behind Caddy in prod
    credentials: true,
  }),
);

app.get("/healthz", (c) => c.json({status: "ok", service: "walbi-exchange-proxy"}));

app.get("/auth/status", async (c) => {
  try {
    const status = await walbiAuthStatus();
    return c.json({ok: true, mcp: status});
  } catch (err) {
    return c.json({ok: false, error: String(err)}, 502);
  }
});

app.route("/api", restProxy);

const PORT = Number(process.env.PORT ?? 3002);
const server = serve({fetch: app.fetch, port: PORT, hostname: "0.0.0.0"}, (info) => {
  console.log(`[walbi-exchange-proxy] listening on http://0.0.0.0:${info.port}`);
});

// @ts-expect-error — node-server returns Http2Server-like, ws expects Server
attachWsProxy(server);

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[walbi-exchange-proxy] got ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

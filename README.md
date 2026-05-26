# walbi-exchange-proxy

Thin BFF that lets [exchange.walbi.cfd](https://exchange.walbi.cfd) talk to real WALBI data.

```
Browser  ──HTTP/WS──▶  walbi-exchange-proxy  ──MCP-over-HTTP──▶  walbi-mcp-http  ──▶  gw.walbi.com / ws.walbi.com
```

We don't own the WALBI auth flow — we hand that to **walbi-mcp** (already deployed at `walbi-mcp.zw.walbi.cfd`), which manages the QR-based login, encrypted token cache, and automatic refresh.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /healthz` | Liveness check |
| `GET /auth/status` | walbi-mcp auth state (sanity) |
| `POST /api/walbi/<domain>/<action>/v<n>` | Forward a REST call to `gw.walbi.com/api/<...>` with the cached Bearer |
| `WS /ws` | Tiny envelope protocol over walbi-mcp's `ws_request` + `ws_subscribe` |

### WS envelope

Client → server:

```json
{ "type": "request",     "uuid": "abc123", "event_name": "fx:candles:history", "data": {...} }
{ "type": "subscribe",   "event_names": ["balance:change:v3", "fx:tick:change"] }
{ "type": "unsubscribe", "event_names": ["fx:tick:change"] }
{ "type": "ping" }
```

Server → client:

```json
{ "type": "response", "uuid": "abc123", "event_name": "...", "data": {...}, "error": null }
{ "type": "push",     "event_id": 55,   "event_name": "balance:change:v3", "ts": 1779..., "data": {...} }
{ "type": "ack",      "action": "subscribe",   "count": 2 }
{ "type": "error",    "message": "...", "uuid": "abc123" }
{ "type": "pong" }
```

Pushes are POLLED via walbi-mcp's `ws_subscribe` in 5-second windows — fine for inbox / signals / deal state, not sub-second-fast for tickers. A future optimization is a direct cerberus connection from the proxy, but that needs a token-extraction tool in walbi-mcp first.

## Run locally

```bash
pnpm install
cp .env.example .env
# fill in WALBI_MCP_BEARER (from /root/secrets/walbi-mcp.env on the server)
pnpm dev
# proxy listens on :3002
curl http://localhost:3002/healthz
curl http://localhost:3002/auth/status
curl -X POST http://localhost:3002/api/walbi/user/profile/v1 -H 'content-type: application/json' -d '{}'
```

## Deploy

The proxy lives next to caddy + walbi-mcp on `46.224.164.185`. See `deploy/`.

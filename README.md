# AI Crawler Worker

Cloudflare Worker in front of `www.aisearchadvertising.com` that:

1. **Detects known AI crawlers** via a User-Agent registry (static list, extensible at runtime via KV)
2. **Serves AI-ready Markdown** to those crawlers (plus a public `/llms.txt`), origin-verified and edge-cached
3. **Logs request events** to pluggable analytics sinks (HTTP webhook + optional Cloudflare Queue)

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full request-flow and module diagrams (Mermaid).

Files:

```
src/index.ts       routing + fail-open error handling + queue consumer
src/crawlers.ts    crawler registry + detection
src/ai-content.ts  markdown variants + llms.txt (mocked content store)
src/origin.ts      origin passthrough + page-existence verification
src/cache.ts       edge cache for AI variants (per-crawler keys, HIT/MISS)
src/analytics.ts   event schema, pluggable sinks (webhook, Queue)
```

## Quick Start

### Prerequisites

- Node.js 18+
- A Cloudflare account with `wrangler` authenticated (`npx wrangler login`)
- Access to the zone in [wrangler.toml](wrangler.toml) if you plan to deploy to the live route

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

[wrangler.toml](wrangler.toml) ships with working defaults for local dev. Before deploying to your own account, update:

| Setting | Where | Notes |
|---|---|---|
| `routes` | `wrangler.toml` | Zone + pattern the Worker runs on |
| `ANALYTICS_WEBHOOK_URL` | `[vars]` in `wrangler.toml` | Where request events are POSTed (mocked with webhook.site) |
| `kv_namespaces` (`KNOWN_CRAWLERS_KV`) | `wrangler.toml` | Run `npx wrangler kv namespace create KNOWN_CRAWLERS_KV` and paste the returned `id` |
| `queues` (`ANALYTICS_QUEUE`) | `wrangler.toml` | Optional; run `npx wrangler queues create ai-ready-analytics`, or delete the `[[queues.producers]]` / `[[queues.consumers]]` blocks to skip it |

### 3. Typecheck

```bash
npm run typecheck
```

### 4. Run locally

```bash
npm run dev   # wrangler dev, http://localhost:8787
```

In another terminal:

```bash
curl -H 'User-Agent: GPTBot' http://localhost:8787/products   # AI-ready markdown
curl http://localhost:8787/products                           # human traffic, origin passthrough
curl http://localhost:8787/llms.txt                           # static llms.txt, served to everyone
```

Look for the `x-ai-cache: MISS` header on the first crawler request and `x-ai-cache: HIT` on the second — confirms the edge cache path.

### 5. Deploy

```bash
npm run deploy   # wrangler deploy — publishes to the route + vars/bindings in wrangler.toml
```

## Design decisions

**Failures are transparet to the "end" user.** The Worker sits on the release path of a live site, so its prime directive is *do no harm*. Any unexpected error in the handler falls back to a transparent `fetch(request)` to the origin. A bug in crawler detection or content rendering can never take the site down — worst case, a crawler sees the normal HTML page.

**Human traffic is a pure pass-through.** Non-crawler and non-GET requests (checkout POSTs, etc.) hit `fetch(request)` directly, the response remains as originaly expected.

**Verify before answering.** An AI variant is only served after a quick origin check (GET with a browser User-Agent, body discarded) confirms the page actually exists — the Worker never invents content for a URL that would 404; the crawler gets the origin's real answer instead. The check is paid at most once per crawler + path per cache TTL.

**Edge cache, keyed by crawler name.** Verified AI responses are cached in `caches.default` under a synthetic `/__ai-cache/<crawler>/<path>` key (query string preserved) for 300s, so repeat crawler hits cost zero origin traffic. Responses carry `x-ai-cache: HIT|MISS`, and cache failures degrade to fresh verification + generation — never to an error. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Analytics never blocks or breaks anything.** Events fan out to every configured `AnalyticsSink` via `ctx.waitUntil()` *after* the response is returned — zero added latency. Each sink swallows its own failures (`Promise.allSettled`, so one broken sink can't starve another);

**Unknown path → origin, not 404.** If a crawler requests a page we have no Markdown for, it gets the original page.

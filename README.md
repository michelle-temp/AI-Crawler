# ai-crawler-worker

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

## Design decisions

**Fail open, always.** The Worker sits on the release path of a live site, so its prime directive is *do no harm*. Any unexpected error in the handler falls back to a transparent `fetch(request)` to the origin. A bug in crawler detection or content rendering can never take the site down — worst case, a crawler sees the normal HTML page.

**Human traffic is a pure pass-through.** Non-crawler and non-GET requests (checkout POSTs, etc.) hit `fetch(request)` directly: bodies stream through, nothing is buffered, no headers are rewritten. The Worker adds microseconds of CPU (one lowercase + substring scan over the small crawler registry) and zero extra network hops.

**Markdown, not modified HTML.** AI pipelines want clean text: fewer tokens, no nav/JS/tracking noise, unambiguous product facts. Serving `text/markdown` is simpler and more robust than transforming origin HTML with HTMLRewriter, and matches the task's "keep it simple" constraint. The `/llms.txt` endpoint follows the emerging convention for LLM content discovery.

**Verify before answering.** An AI variant is only served after a quick origin check (GET with a browser UA, body discarded) confirms the page actually exists — the Worker never invents content for a URL that would 404; the crawler gets the origin's real answer instead. The check is paid at most once per crawler + path per cache TTL.

**Edge cache, keyed by crawler name.** Verified AI responses are cached in `caches.default` under a synthetic `/__ai-cache/<crawler>/<path>` key (query string preserved) for 300s, so repeat crawler hits cost zero origin traffic. Responses carry `x-ai-cache: HIT|MISS`, and cache failures degrade to fresh verification + generation — never to an error. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Cache safety.** AI variants are served with `Vary: User-Agent` so no shared cache ever hands Markdown to a human browser, plus `X-Robots-Tag: noarchive`.

**Analytics never blocks or breaks anything.** Events fan out to every configured `AnalyticsSink` via `ctx.waitUntil()` *after* the response is returned — zero added latency. Each sink swallows its own failures (`Promise.allSettled`, so one broken sink can't starve another); the webhook POST has a hard 3s `AbortSignal.timeout`. Every request — crawler and human alike — is logged. Adding a destination (Workers Analytics Engine, D1, R2, …) is one new sink class plus one branch in `createSinks()` — the request path never changes. A Cloudflare Queue sink ships with the code; enable it by uncommenting the queue blocks in `wrangler.toml`.

**Unknown path → origin, not 404.** If a crawler requests a page we have no Markdown for, it gets the original page. Coverage gaps degrade gracefully.

## Failure modes

| Failure | Behavior |
|---|---|
| Bug anywhere in handler | Fail open: transparent proxy to origin |
| Origin down | 502 (same as without the Worker) |
| Origin 404s a page we have a variant for | Crawler receives the real 404, nothing cached |
| Cache API lookup/write fails | Fresh verification + generation; response unaffected |
| Webhook slow/down | Event dropped after 3s timeout; response unaffected |
| Queue publish fails | Warning logged; webhook sink still delivers |
| No sinks configured | Logging silently skipped; serving unaffected |
| No AI content for a path | Crawler receives the original origin response |

## Runtime considerations

- **CPU**: detection is a single pass over a small registry array (static list + KV extras); well under 1ms. No regex backtracking risk (plain substring matching).
- **Memory**: content store is a few KB of static strings compiled into the bundle.
- **Latency**: a crawler's first hit on a path costs one origin round-trip (the existence check); repeats within the 300s cache TTL are served entirely from the edge. Human requests: one origin fetch, exactly as before.
- **`waitUntil` budget**: background analytics gets up to 30s after the response; the 3s timeout keeps us far inside it.
- **No recursion**: on a zone route, `fetch(request)` from a Worker goes directly to the origin.

## Mocked components (per the task)

| Component | Mocked as | Production replacement |
|---|---|---|
| Analytics warehouse | webhook.site; Queue consumer just logs batches | Workers Analytics Engine, or the Queue consumer flushing to ClickHouse/BigQuery |
| AI content source | in-module `PAGES` map | CMS/product API sync into Workers KV via a build step |
| Crawler registry updates | hardcoded list | Scheduled Worker pulling a maintained list (e.g. ai-robots-txt) into KV |
| Crawler IP verification | not implemented | Validate claimed UAs against published IP ranges / reverse DNS |

## Known limitations

- **UA spoofing**: anyone can send `User-Agent: GPTBot`. Consequence here is benign (they get Markdown), but analytics should treat UA-based counts as approximate until IP verification (mocked above) is added.
- **Content drift**: the mocked `PAGES` map can fall out of sync with the real site; the KV-sync design fixes this.
- **Verification staleness window**: a cached AI variant outlives its origin page by up to the 300s TTL — a page deleted mid-window is still answered for until the entry expires.

## Setup

```bash
npm install
npm run typecheck

npx wrangler deploy   # route + ANALYTICS_WEBHOOK_URL configured in wrangler.toml
```

Local dev:

```bash
npx wrangler dev
curl -H 'User-Agent: GPTBot/1.2' http://localhost:8787/products   # markdown
curl http://localhost:8787/products                                # origin passthrough
curl http://localhost:8787/llms.txt
```

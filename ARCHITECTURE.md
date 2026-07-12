# Architecture

Cloudflare Worker deployed on the zone route in front of
`www.aisearchadvertising.com`. It detects AI crawlers, serves them an
origin-verified, edge-cached Markdown variant, and ships request events to
pluggable analytics sinks — while human traffic streams through untouched.

## Request flow

```mermaid
flowchart TD
    R(["Incoming request"]) --> LLMS{"path is /llms.txt?"}
    LLMS -- yes --> TXT["Serve static llms.txt<br/>to everyone"]
    LLMS -- no --> DET{"Known AI crawler<br/>and GET?"}

    DET -- "no (human / non-GET)" --> PASS["Passthrough to origin<br/>streamed, untouched"]
    DET -- yes --> VAR{"Markdown variant<br/>exists for path?"}

    VAR -- no --> PASS
    VAR -- yes --> CACHE{"Edge cache hit?<br/>key: crawler + path + query"}

    CACHE -- HIT --> HIT["Serve cached AI response<br/>x-ai-cache: HIT"]
    CACHE -- MISS --> VERIFY{"Origin verification:<br/>GET with browser UA — 2xx?"}

    VERIFY -- "no (404/5xx)" --> RELAY["Relay the real origin response —<br/>never invent content for a dead page"]
    VERIFY -- yes --> MISS["Serve Markdown variant<br/>x-ai-cache: MISS"] --> STORE[["cache.put via ctx.waitUntil<br/>TTL 300s"]]

    TXT & PASS & HIT & RELAY & MISS --> FAN[["dispatchEvent via ctx.waitUntil<br/>every request is logged"]]
    FAN --> DONE(["Response"])

    FAN -.fan-out.-> WH[("Webhook sink<br/>3s timeout")]
    FAN -.fan-out.-> Q[("Queue sink<br/>optional binding")]
    Q -.batch.-> QC["queue consumer<br/>in this same Worker"]
```

Fail-open wraps everything above: any unexpected error in the handler falls
back to a transparent passthrough to the origin; only an unreachable origin
yields a 502.

## AI-variant miss path (sequence)

```mermaid
sequenceDiagram
    participant C as AI crawler
    participant W as Worker
    participant E as Edge cache
    participant O as Origin
    participant S as Analytics sinks

    C->>W: GET /products (UA: GPTBot)
    W->>E: match(/__ai-cache/GPTBot/products)
    E-->>W: (miss)
    W->>O: GET /products (browser UA)
    O-->>W: 200 OK
    Note over W: body cancelled — only the status matters
    W-->>C: 200 text/markdown, x-ai-cache: MISS
    par after response (ctx.waitUntil)
        W->>E: put(verified AI response, TTL 300s)
    and
        W->>S: event {crawler, variant, cacheStatus, …} to every configured sink
    end
    Note over C,E: repeat requests within the TTL are HITs:<br/>zero origin traffic, verification amortized
```

## Modules

```mermaid
flowchart LR
    subgraph src
        I["index.ts<br/>routing + fail-open<br/>+ queue consumer"]
        CR["crawlers.ts<br/>UA registry<br/>(static + KV)"]
        AC["ai-content.ts<br/>Markdown variants<br/>+ llms.txt"]
        OR["origin.ts<br/>passthrough +<br/>verification fetch"]
        CA["cache.ts<br/>edge cache,<br/>per-crawler keys"]
        AN["analytics.ts<br/>event schema +<br/>AnalyticsSink fan-out"]
    end
    I --> CR & AC & OR & CA & AN
```

| Module | Owns | Never does |
|---|---|---|
| `index.ts` | Request orchestration, fail-open catch, queue consumer | Business logic |
| `crawlers.ts` | Crawler registry + detection | I/O |
| `ai-content.ts` | Markdown variants, `llms.txt`, cache-safety headers | Network calls |
| `origin.ts` | Passthrough + origin verification | Response mutation |
| `cache.ts` | `caches.default` access, cache keys, HIT/MISS marking | Throwing (best-effort by design) |
| `analytics.ts` | Event schema, sink implementations | Blocking or breaking a response |

## Key decisions

**Verify before answering.** An AI variant is only served after the origin
confirms the page exists (a GET with a browser UA whose body is discarded).
A URL that would 404 gets the origin's real 404 — the Worker never invents
content for dead pages. The check costs one origin round-trip, paid at most
once per crawler + path per cache TTL.

**Edge cache keyed by crawler name, not UA string.** Cache keys live under a
synthetic `/__ai-cache/<crawler>/<path>?<query>` namespace, so entries can't
collide with real site URLs, hit rates aren't destroyed by UA version churn,
and `Vary: User-Agent` handling stays out of the cache (it's re-added to
every response leaving the Worker). Cache failures degrade to fresh
verification + generation.

**Sinks are pluggable, delivery is fan-out.** `AnalyticsSink.deliver()` must
never reject; `dispatchEvent()` fans out with `Promise.allSettled` inside
`ctx.waitUntil`, so a broken destination can neither delay the response nor
starve another sink. Shipped sinks: HTTP webhook (3s hard timeout) and an
optional Cloudflare Queue (enable the binding in `wrangler.toml`; this same
Worker consumes the batches).

**Fail open, always.** See README — the Worker sits on the release path of a
live site; its worst case must be "crawler sees the normal HTML page", never
"site is down".

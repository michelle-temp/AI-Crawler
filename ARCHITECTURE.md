# Architecture

Cloudflare Worker deployed on the zone route in front of
`www.aisearchadvertising.com`. It detects AI crawlers, serves them an
origin-verified, edge-cached Markdown variant, and ships request events to
pluggable analytics sinks — while human traffic streams through untouched.

## Request flow

```mermaid
flowchart TD
    R(["New Incoming request"]) --> LLMS{"path is /llms.txt?"}
    LLMS -- yes --> TXT["Serve static llms.txt<br/>to everyone"]
    LLMS -- no --> DET{"AI Crawler detected?"}

    DET -- "no (human / non-GET request)" --> PASS["Passthrough to origin<br/>"]
    DET -- yes --> VAR{"Markdown variant<br/>exists for path?"}

    VAR -- no --> PASS
    VAR -- yes --> CACHE{"Cache hit?<br/>key: crawler + path + query"}

    CACHE -- HIT --> HIT["Serve cached AI response<br/>x-ai-cache: HIT"]
    CACHE -- MISS --> VERIFY{"Origin verification:<br/>Send GET to origin and validate endpoint exists"}

    VERIFY -- "no (404/5xx)" --> RELAY["Dead page - Relay the real origin response —<br/>"]
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

## Modules

```mermaid
flowchart LR
    subgraph src
        I["index.ts<br/>routing + fail-open<br/>+ queue consumer"]
        CR["crawlers.ts<br/>User-Agent registry<br/>(static + KV)"]
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

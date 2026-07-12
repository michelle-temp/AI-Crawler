/**
 * Cloudflare Worker in front of www.aisearchadvertising.com
 *
 * Responsibilities:
 *  1. Detect known AI crawlers (User-Agent registry).
 *  2. Serve an AI-ready Markdown variant to those crawlers (+ /llms.txt for
 *     all), verified against the origin and cached at the edge.
 *  3. Log request events to pluggable analytics sinks (webhook, Queue).
 *
 * Design invariants (see README for reference):
 *  - FAIL OPEN: any unexpected error → pass the request through to the
 *    origin untouched.
 *  - Analytics is fire-and-forget via ctx.waitUntil(); it adds zero latency
 *    to the response and its failures are invisible to visitors.
 *  - Human traffic is a pure pass-through (fetch to origin).
 *  - Never answer for a page the origin doesn't have: an AI variant is only
 *    served after the origin confirms the page exists (then cached, so the
 *    check is paid at most once per crawler+path per TTL).
 */

import { detectCrawler, loadCrawlers, type Crawler } from './crawlers';
import { aiResponseFor, llmsTxtResponse } from './ai-content';
import { passthrough, fetchOriginForVerification } from './origin';
import { getCachedAiResponse, storeAiResponse, type CacheStatus } from './cache';
import {
  buildEvent,
  dispatchEvent,
  type Env,
  type RequestEvent,
} from './analytics';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      // fallback - if a worker breaks then return origin.
      console.error('worker error, failing open to origin:', err);
      try {
        return await passthrough(request, env);
      } catch {
        // If Origin itself unreachable - return Bad Gateway.
        return new Response('Service temporarily unavailable', { status: 502 });
      }
    }
  },

  
   // Consumer for the analytics Queue (see wrangler.toml).
  async queue(batch: MessageBatch<RequestEvent>): Promise<void> {
    console.log(`analytics batch: ${batch.messages.length} event(s) from ${batch.queue}`);
    for (const message of batch.messages) {
      console.log('analytics event', { id: message.id, attempts: message.attempts, event: message.body });
    }
  },
} satisfies ExportedHandler<Env, RequestEvent>;

// What the request path decided: the response plus how to describe it in analytics.
interface Served {
  response: Response;
  variant: RequestEvent['servedVariant'];
  cacheStatus: CacheStatus;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const crawler = detectCrawler(
    request.headers.get('user-agent'),
    await loadCrawlers(env.KNOWN_CRAWLERS_KV),
  );

  let served: Served;
  if (url.pathname === '/llms.txt') {
    // Served to everyone — it's a public discovery file, like robots.txt.
    served = { response: llmsTxtResponse(), variant: 'llms-txt', cacheStatus: 'BYPASS' };
  } else if (crawler && request.method === 'GET') {
    served = await serveAiVariant(request, env, ctx, crawler);
  } else {
    // Humans, and any non-GET method (POST checkout etc.).
    served = {
      response: await passthrough(request, env),
      variant: 'origin',
      cacheStatus: 'BYPASS',
    };
  }

  // Analytics: every request is logged, shipped asynchronously.
  const event = buildEvent(
    request, crawler, served.variant, served.response.status,
    Date.now() - started, served.cacheStatus,
  );
  dispatchEvent(env, ctx, event); // fans out after the response is returned

  return served.response;
}

/**
 * AI crawler on a GET. Order of operations:
 *  1. No Markdown variant for this path → origin untouched (never 404 an
 *     existing page).
 *  2. Edge cache hit → serve it; the origin was verified when the entry was
 *     stored, so staleness is bounded by the cache TTL (300s).
 *  3. Miss → confirm the origin actually has this page, then serve the
 *     variant and cache it.
 */
async function serveAiVariant(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  crawler: Crawler,
): Promise<Served> {
  const aiResponse = aiResponseFor(new URL(request.url).pathname);
  if (!aiResponse) {
    return {
      response: await passthrough(request, env),
      variant: 'origin',
      cacheStatus: 'BYPASS',
    };
  }

  const cached = await getCachedAiResponse(request, crawler.name);
  if (cached) {
    return { response: cached, variant: 'ai', cacheStatus: 'HIT' };
  }

  const originResponse = await fetchOriginForVerification(request, env);
  if (!originResponse.ok) {
    return { response: originResponse, variant: 'origin', cacheStatus: 'BYPASS' };
  }

  // The verification body is unused; cancel it so the connection is released.
  ctx.waitUntil(originResponse.body?.cancel() ?? Promise.resolve());

  return {
    response: storeAiResponse(request, crawler.name, aiResponse, ctx),
    variant: 'ai',
    cacheStatus: 'MISS',
  };
}

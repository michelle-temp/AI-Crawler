/**
 * Cloudflare Worker in front of www.aisearchadvertising.com
 *
 * Responsibilities:
 *  1. Detect known AI crawlers (User-Agent registry).
 *  2. Serve an AI-ready Markdown variant to those crawlers (+ /llms.txt for
 *     all), verified against the origin.
 *  3. Log request events to pluggable analytics sinks (webhook, Queue).
 *
 * Caching: Workers Cache (wrangler.toml [cache]) sits IN FRONT of this
 * Worker. Fresh hits are answered before the Worker runs — this code only
 * ever sees misses — and cacheability is driven entirely by the
 * Cache-Control / Vary headers on the responses it returns (ai-content.ts
 * for generated content; origin.ts appends Vary: User-Agent to passthrough).
 *
 * Design invariants (see README for reference):
 *  - FAIL OPEN: any unexpected error → pass the request through to the
 *    origin untouched.
 *  - Analytics is fire-and-forget via ctx.waitUntil(); it adds zero latency
 *    to the response and its failures are invisible to visitors.
 *  - Human traffic passes through untouched, except that Vary: User-Agent is
 *    appended so no shared cache can serve one audience the other's content.
 *  - Never answer for a page the origin doesn't have: an AI variant is only
 *    served after the origin confirms the page exists (then cached in front
 *    of the Worker, so the check is paid once per crawler UA per TTL).
 */

import { detectCrawler, loadCrawlers } from './crawlers';
import { aiResponseFor, llmsTxtResponse } from './ai-content';
import { passthrough, fetchOriginForVerification } from './origin';
import {
  buildEvent,
  dispatchEvent,
  type CacheStatus,
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
    // Public discovery file, like robots.txt. No Vary — one front-cache
    // entry serves everyone for an hour.
    served = { response: llmsTxtResponse(), variant: 'llms-txt', cacheStatus: 'MISS' };
  } else if (crawler && request.method === 'GET') {
    served = await serveAiVariant(request, env, ctx);
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
 * AI crawler on a GET — by definition a front-cache miss (fresh hits are
 * answered by Workers Cache before the Worker runs). Order of operations:
 *  1. No Markdown variant for this path → origin untouched (never 404 an
 *     existing page).
 *  2. Confirm the origin actually has this page, then serve the variant.
 *     Workers Cache stores it (max-age=300, one variant per User-Agent), so
 *     the verification round trip is paid once per crawler UA per TTL.
 */
async function serveAiVariant(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Served> {
  const aiResponse = aiResponseFor(new URL(request.url).pathname);
  if (!aiResponse) {
    return {
      response: await passthrough(request, env),
      variant: 'origin',
      cacheStatus: 'BYPASS',
    };
  }

  const originResponse = await fetchOriginForVerification(request, env);
  if (!originResponse.ok) {
    return { response: originResponse, variant: 'origin', cacheStatus: 'BYPASS' };
  }

  // The verification body is unused; cancel it so the connection is released.
  ctx.waitUntil(originResponse.body?.cancel() ?? Promise.resolve());

  return { response: aiResponse, variant: 'ai', cacheStatus: 'MISS' };
}

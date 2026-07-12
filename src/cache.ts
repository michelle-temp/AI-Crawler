/**
 * Edge cache for AI-ready responses.
 *
 * Key design: a synthetic URL namespaced under /__ai-cache/<crawler>/<path>,
 * query string preserved. Keying on the crawler *name*.  The synthetic prefix guarantees
 * entries can never collide with real site URLs in the zone cache.
 */

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

const CACHE_PATH_PREFIX = '/__ai-cache';

function cacheKeyFor(request: Request, crawlerName: string): Request {
  const url = new URL(request.url);
  url.pathname = `${CACHE_PATH_PREFIX}/${encodeURIComponent(crawlerName)}${url.pathname}`;
  return new Request(url.toString(), { method: 'GET' });
}

/** Cached AI response for this request + crawler, or null. */
export async function getCachedAiResponse(
  request: Request,
  crawlerName: string,
): Promise<Response | null> {
  try {
    const hit = await caches.default.match(cacheKeyFor(request, crawlerName));
    return hit ? clientCopy(hit, 'HIT') : null;
  } catch (err) {
    console.warn('AI cache lookup failed, regenerating:', err);
    return null;
  }
}

/**
 * Stores a freshly generated AI response and returns the client-facing copy
 * (marked MISS). The write happens after the response is returned, via
 * ctx.waitUntil; the entry's lifetime comes from the response's own
 * Cache-Control header (ai-content sets max-age=300s).
 */
export function storeAiResponse(
  request: Request,
  crawlerName: string,
  response: Response,
  ctx: ExecutionContext,
): Response {
  const headers = new Headers(response.headers);
  headers.delete('vary');
  const cacheable = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  const stored = cacheable.clone();
  ctx.waitUntil(
    caches.default
      .put(cacheKeyFor(request, crawlerName), stored)
      .catch((err) => console.warn('AI cache write failed:', err)),
  );

  return clientCopy(cacheable, 'MISS');
}

function clientCopy(response: Response, status: CacheStatus): Response {
  const headers = new Headers(response.headers);
  headers.set('x-ai-cache', status);
  // Stored copies have Vary stripped; every response that
  // leaves the Worker must carry it so no shared cache serves Markdown
  // to a human browser.
  headers.set('vary', 'User-Agent');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Origin access: transparent passthrough and page-existence verification.
 */

import type { Env } from './analytics';

// Transparent proxy to the origin.
export async function passthrough(request: Request, env: Env): Promise<Response> {
  return withUserAgentVary(await fetch(originRequest(request, env)));
}

function originRequest(request: Request, env: Env): Request {
  if (!env.ORIGIN_URL) return request;

  const origin = new URL(env.ORIGIN_URL); // explicit origin override for local development
  const url = new URL(request.url);
  url.hostname = origin.hostname;
  url.protocol = origin.protocol;
  url.port = origin.port;
  return new Request(url.toString(), request);
}

// Checks that the origin actually has the requested page before returning any response.
export function fetchOriginForVerification(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('user-agent', 'Mozilla/5.0 (compatible; ai-crawler-worker origin check)');
  return passthrough(new Request(request, { headers }), env);
}

function withUserAgentVary(response: Response): Response {
  // Upgraded connections can't be re-wrapped (and are never cached).
  if (response.status === 101 || response.webSocket) return response;

  const vary = response.headers.get('vary') ?? '';
  if (vary.includes('*') || /(^|,)\s*user-agent\s*(,|$)/i.test(vary)) return response;

  const wrapped = new Response(response.body, response);
  wrapped.headers.append('vary', 'User-Agent');
  return wrapped;
}

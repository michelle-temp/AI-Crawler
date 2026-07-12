/**
 * Origin access: transparent passthrough and page-existence verification.
 */

import type { Env } from './analytics';

// Transparent proxy to the origin. Bodies stream through; nothing is buffered.
export function passthrough(request: Request, env: Env): Promise<Response> {
  if (!env.ORIGIN_URL) {
    return fetch(request);
  }

  const origin = new URL(env.ORIGIN_URL); // explicit origin override for local development
  const url = new URL(request.url);
  url.hostname = origin.hostname;
  url.protocol = origin.protocol;
  url.port = origin.port;
  return fetch(new Request(url.toString(), request));
}

// Checks that the origin actually has the requested page before returning any response.
export function fetchOriginForVerification(request: Request, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('user-agent', 'Mozilla/5.0 (compatible; ai-crawler-worker origin check)');
  return passthrough(new Request(request, { headers }), env);
}

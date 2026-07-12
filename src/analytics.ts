/**
 * Analytics: event schema and pluggable delivery sinks.
 *
 * Invariants:
 *  1. Logging NEVER affects the response — every sink swallows its own
 *     errors, and delivery runs via ctx.waitUntil() after the response is
 *     returned.
 *  2. Every request is logged — crawler and human alike.
 */

import type { Crawler } from './crawlers';
import type { CacheStatus } from './cache';

export interface Env {
  ANALYTICS_WEBHOOK_URL?: string;
  ANALYTICS_QUEUE?: Queue<RequestEvent>; // Optional second sink — bind a Queue in wrangler.toml to enable
  KNOWN_CRAWLERS_KV?: KVNamespace;  // crawler registry (see crawlers.ts loadCrawlers)
  ORIGIN_URL?: string;  // override origin for local dev
}

export interface RequestEvent {
  ts: string;
  method: string;
  url: string;
  path: string;
  userAgent: string;
  ip: string;
  country: string;
  crawler: { name: string; operator: string } | null;
  servedVariant: 'ai' | 'origin' | 'llms-txt';
  status: number;
  durationMs: number;
  cacheStatus: CacheStatus;
}

const ANALYTICS_TIMEOUT_MS = 3000;

/**
 * One analytics destination. deliver() must never throw or reject — each
 * sink owns its failures, so one broken destination can't starve another.
 */
export interface AnalyticsSink {
  deliver(event: RequestEvent): Promise<void>;
}

/** POSTs each event to an HTTP endpoint (webhook.site as the mock sink). */
export class WebhookSink implements AnalyticsSink {
  constructor(private readonly endpoint: string) {}

  async deliver(event: RequestEvent): Promise<void> {
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      });
    } catch {
      // Intentionally swallowed.
    }
  }
}

/** Publishes each event to a Cloudflare Queue for batch consumption. */
export class QueueSink implements AnalyticsSink {
  constructor(private readonly queue: Queue<RequestEvent>) {}

  async deliver(event: RequestEvent): Promise<void> {
    try {
      await this.queue.send(event);
    } catch (err) {
      console.warn('analytics queue publish failed:', err);
    }
  }
}

/** Builds the sink list from whatever is configured; empty list is valid. */
export function createSinks(env: Env): AnalyticsSink[] {
  const sinks: AnalyticsSink[] = [];
  if (env.ANALYTICS_WEBHOOK_URL) sinks.push(new WebhookSink(env.ANALYTICS_WEBHOOK_URL));
  if (env.ANALYTICS_QUEUE) sinks.push(new QueueSink(env.ANALYTICS_QUEUE));
  return sinks;
}

/**
 * Fans one event out to every configured sink without delaying the response.
 */
export function dispatchEvent(env: Env, ctx: ExecutionContext, event: RequestEvent): void {
  const sinks = createSinks(env);
  if (sinks.length === 0) return;
  ctx.waitUntil(
    Promise.allSettled(sinks.map((sink) => sink.deliver(event))).then(() => undefined),
  );
}

export function buildEvent(
  request: Request,
  crawler: Crawler | null,
  servedVariant: RequestEvent['servedVariant'],
  status: number,
  durationMs: number,
  cacheStatus: CacheStatus,
): RequestEvent {
  const url = new URL(request.url);
  return {
    ts: new Date().toISOString(),
    method: request.method,
    url: request.url,
    path: url.pathname,
    userAgent: request.headers.get('user-agent') ?? '',
    ip: request.headers.get('cf-connecting-ip') ?? '',
    country: (request as { cf?: { country?: string } }).cf?.country ?? '',
    crawler: crawler
      ? { name: crawler.name, operator: crawler.operator }
      : null,
    servedVariant,
    status,
    durationMs,
    cacheStatus,
  };
}

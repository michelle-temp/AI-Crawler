/**
 * Known AI crawler registry.
 *
 * The static list below ships with the Worker; loadCrawlers() extends it with
 * names stored in KV (KNOWN_CRAWLERS_KV, key "known-crawlers"), so new
 * crawlers can be added without a redeploy.
 *
 */

export interface Crawler {
  /** Substring to match in the User-Agent header (lowercase). */
  token: string;
  /** Canonical name for analytics. */
  name: string;
  operator: string;
}

export const CRAWLERS: readonly Crawler[] = [
  // OpenAI
  { token: 'gptbot',            name: 'GPTBot',            operator: 'OpenAI' },
  // Anthropic
  { token: 'claudebot',         name: 'ClaudeBot',         operator: 'Anthropic' },
  // Perplexity
  { token: 'perplexitybot',     name: 'PerplexityBot',     operator: 'Perplexity' },

] as const;

const KV_CRAWLERS_KEY = 'known-crawlers';
const KV_CRAWLERS_CACHE_TTL_SECONDS = 300;

/**
 * The static registry plus any extra names from the KV registry (a JSON
 * string[] under "known-crawlers"). KV failures degrade to the static list —
 * detection must never depend on KV being up. The static list keeps
 * precedence for names present in both.
 */
export async function loadCrawlers(kv: KVNamespace | undefined): Promise<readonly Crawler[]> {
  if (!kv) return CRAWLERS;

  let names: unknown;
  try {
    names = await kv.get(KV_CRAWLERS_KEY, {
      type: 'json',
      cacheTtl: KV_CRAWLERS_CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.warn('KV crawler list read failed; using built-in registry:', err);
    return CRAWLERS;
  }
  if (!Array.isArray(names)) return CRAWLERS;

  const builtInTokens = new Set(CRAWLERS.map((c) => c.token));
  const extras: Crawler[] = names
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .filter((name) => !builtInTokens.has(name.toLowerCase()))
    .map((name) => ({ token: name.toLowerCase(), name, operator: 'KV registry' }));

  return [...CRAWLERS, ...extras];
}

 // Returns the matched crawler, or null for regular traffic.
export function detectCrawler(
  userAgent: string | null,
  crawlers: readonly Crawler[] = CRAWLERS,
): Crawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const crawler of crawlers) {
    if (ua.includes(crawler.token)) return crawler;
  }
  return null;
}

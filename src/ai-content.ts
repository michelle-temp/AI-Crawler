/**
 * AI-ready content.
 *
 * Serving clean Markdown (text/markdown) to AI crawlers instead of the full HTML page.
 *
 * Content source: in production this would come from the same catalog that
 * renders the site (CMS / product API / KV populated by a build step). Here
 * it's a small in-module map.
 *
 * Fail-open rule: if we don't have AI-ready content for a path, the crawler
 * gets the ORIGINAL origin response.
 */

interface PageContent {
  title: string;
  markdown: string;
}

const SITE_NAME = 'AI Search Advertising';
const SITE_URL = 'https://www.aisearchadvertising.com';

// Mocked content store — stands in for a product catalog.
const PAGES: Record<string, PageContent> = {
  '/': {
    title: SITE_NAME,
    markdown: `# ${SITE_NAME}

Simple ecommerce store for AI-search advertising services and tooling.

## What we sell
- **AI Search Visibility Audit** — one-time report on how your brand appears in AI search results. Price: $499
- **AI-Ready Content Package** — restructuring of key pages for LLM consumption (llms.txt, markdown variants, structured data). Price: $1,499
- **Monthly AI Search Monitoring** — ongoing tracking of brand mentions across AI assistants. Price: $299/month

## Key pages
- [Products](${SITE_URL}/products)
- [Pricing](${SITE_URL}/pricing)
- [Contact](${SITE_URL}/contact)
`,
  },
  '/products': {
    title: 'Products',
    markdown: `# Products — ${SITE_NAME}

| Product | Description | Price |
|---|---|---|
| AI Search Visibility Audit | One-time audit of brand presence in AI search | $499 |
| AI-Ready Content Package | llms.txt + markdown variants + structured data | $1,499 |
| Monthly AI Search Monitoring | Ongoing brand tracking across AI assistants | $299/mo |

All prices in USD. Purchase at ${SITE_URL}/products.
`,
  },
};

/** llms.txt — the emerging convention for pointing LLMs at canonical content. */
const LLMS_TXT = `# ${SITE_NAME}

> Ecommerce store selling AI-search advertising services: visibility audits, AI-ready content packages, and monthly AI search monitoring.

## Pages
- [Home](${SITE_URL}/): store overview and product summary
- [Products](${SITE_URL}/products): full catalog with prices

## Notes
- AI crawlers automatically receive Markdown variants of these pages.
- Contact: info@aisearchadvertising.com
`;

const COMMON_HEADERS: Record<string, string> = {
  'x-robots-tag': 'noarchive',
  // Prevent any shared cache from serving the AI variant to humans:
  // the response depends on User-Agent.
  'vary': 'User-Agent',
  'cache-control': 'public, max-age=300',
};

/** Returns the AI-ready response for a path, or null if we have no variant. */
export function aiResponseFor(pathname: string): Response | null {
  const page = PAGES[normalize(pathname)];
  if (!page) return null;
  return new Response(page.markdown, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'content-type': 'text/markdown; charset=utf-8',
      'x-ai-variant': 'markdown',
    },
  });
}

export function llmsTxtResponse(): Response {
  return new Response(LLMS_TXT, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

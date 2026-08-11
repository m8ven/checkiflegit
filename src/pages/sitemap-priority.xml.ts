import type { APIRoute } from 'astro';

// A second, deliberately tiny sitemap containing only the pages worth crawling
// first.
//
// The generated sitemap-0.xml carries ~10.8k URLs, and Search Console shows
// 9,897 of them sitting in "Discovered – currently not indexed" — Google has
// never fetched them. Three new guides listed among those 10.8k inherit the
// same queue. A separate small file is processed in full, so the pages that can
// actually earn traffic get discovered on their own merits rather than behind a
// long tail Google has already declined.
//
// This does NOT remove anything from the main sitemap; both are advertised in
// robots.txt and overlapping entries across sitemaps are legitimate.

const SITE = 'https://checkiflegit.com';

// Hand-listed hubs and static pages. Kept explicit rather than globbed so a new
// low-value route cannot quietly dilute the file this exists to keep small.
const STATIC_PATHS = [
  '/',
  '/about/',
  '/guides/',
  '/research/',
  '/stores/',
  '/platform/',
  '/tld/',
  '/verdict/',
];

// Guides and research studies are globbed so new ones are included the moment
// they are added — that is the whole point of the file.
const pageModules = {
  ...import.meta.glob('./guides/*.astro'),
  ...import.meta.glob('./research/*.astro'),
};

function routeFor(file: string): string | null {
  // './guides/how-to-check-if-a-website-is-real.astro' -> '/guides/how-.../'
  const m = file.match(/^\.\/(guides|research)\/(.+)\.astro$/);
  if (!m) return null;
  if (m[2] === 'index') return `/${m[1]}/`; // already in STATIC_PATHS
  return `/${m[1]}/${m[2]}/`;
}

export const GET: APIRoute = async () => {
  const globbed = Object.keys(pageModules)
    .map(routeFor)
    .filter((r): r is string => Boolean(r));

  const paths = [...new Set([...STATIC_PATHS, ...globbed])];

  // No lastmod on purpose. It would have to be build time, which would claim
  // every page here changed on every deploy — the fastest way to teach Google
  // to ignore the field. The main sitemap carries real per-store lastmod from
  // fetchedAt, and that is where the signal belongs.
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths.map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n') +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};

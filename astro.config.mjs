// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const STORES_DIR = fileURLToPath(new URL('./src/content/stores', import.meta.url));
const STORE_URL = /\/store\/([^/]+)\/?$/;
// Frontmatter is machine-written, so the scalar is always on its own line.
const FETCHED_AT = /^fetchedAt:\s*'?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)'?/m;

// slug -> fetchedAt, built once on the first serialize() call. Parsing YAML for
// ~10.5k files would be wasted work when one scalar is all the sitemap needs.
let lastmodBySlug = null;
let corpusLastmod;

function loadLastmods() {
  if (lastmodBySlug) return;
  lastmodBySlug = new Map();
  let newest = '';
  for (const file of readdirSync(STORES_DIR)) {
    if (!file.endsWith('.md')) continue;
    const m = FETCHED_AT.exec(readFileSync(path.join(STORES_DIR, file), 'utf8'));
    if (!m) continue;
    lastmodBySlug.set(file.slice(0, -3), m[1]);
    if (m[1] > newest) newest = m[1]; // ISO-8601 UTC sorts lexicographically
  }
  corpusLastmod = newest || undefined;
}

// Static output deploys directly to Cloudflare Pages (free tier) — no adapter needed.
export default defineConfig({
  site: 'https://checkiflegit.com',
  output: 'static',
  integrations: [
    mdx(),
    sitemap({
      // Unreachable / low-signal stores are emitted with noindex and excluded here.
      // /search is noindex too — submitting it would just raise a Search Console error.
      filter: (page) => !page.includes('/store/_') && !page.includes('/search'),
      // lastmod tells Google which of the 10.5k URLs are worth recrawling. A store
      // page's is its own fetchedAt; browse/hub pages are derived from the whole
      // corpus, so they carry the newest fetchedAt in it. Both only move when the
      // data does — a build-time `new Date()` here would mark every URL fresh on
      // every deploy, which Google learns to ignore.
      serialize(item) {
        loadLastmods();
        const m = STORE_URL.exec(item.url);
        const lastmod = m ? lastmodBySlug.get(m[1]) : corpusLastmod;
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
  build: {
    // Keep clean URLs: /store/example-com/ instead of /store/example-com.html
    format: 'directory',
  },
});

// Store discovery from Common Crawl (free, no account, no AWS).
//
// Streams the crawl's WAT metadata files over public HTTPS, greps each page's
// extracted asset URLs for store-platform fingerprints, and collects the
// page domains. WAT carries every page's <script>/<link>/<img> URLs, so a
// Shopify store's `cdn.shopify.com/s/files` asset and a WooCommerce site's
// `/wp-content/plugins/woocommerce` path both appear there — no full HTML needed.
//
// Output: data/stores.csv (domain,popularity_rank) — rank left blank (CC has no
// popularity rank; the crawl's breadth is inherently long-tail). Feed it through
// `npm run ingest` like the BigQuery export.
//
// Usage: node scripts/harvest-commoncrawl.js
// Env: CC_CRAWL, CC_TARGET (default 14000), CC_MAX_FILES (default 600), CC_CONC (default 8)
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain } from './lib/util.js';
import { isDenied } from './lib/denylist.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'data', 'stores.csv');
const BASE = 'https://data.commoncrawl.org/';
const CRAWL = process.env.CC_CRAWL || 'CC-MAIN-2026-25';
const TARGET = Number(process.env.CC_TARGET || 14000);
const MAX_FILES = Number(process.env.CC_MAX_FILES || 600);
const CONC = Number(process.env.CC_CONC || 8);

const FP = [
  { re: 'cdn.shopify.com/s/files', name: 'Shopify' },
  { re: '/wp-content/plugins/woocommerce', name: 'WooCommerce' },
];

function hostOf(uri) {
  try {
    const h = new URL(uri).hostname;
    const d = normalizeDomain(h);
    if (!d || d.endsWith('.myshopify.com') || isDenied(d)) return null;
    return d;
  } catch { return null; }
}

const state = { domains: new Map(), done: false, files: 0 };

async function flush() {
  const rows = ['domain,popularity_rank', ...[...state.domains.keys()].map((d) => `${d},`)];
  await writeFile(OUT, rows.join('\n') + '\n', 'utf8');
}

async function processFile(url) {
  let res;
  try { res = await fetch(url); } catch { return; }
  if (!res.ok || !res.body) return;
  const stream = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let host = null;
  try {
    for await (const line of rl) {
      if (state.done) break;
      if (line.startsWith('WARC-Target-URI:')) {
        host = hostOf(line.slice(16).trim());
      } else if (host) {
        const hit = FP.find((f) => line.includes(f.re));
        if (hit) {
          if (!state.domains.has(host)) {
            state.domains.set(host, hit.name);
            if (state.domains.size >= TARGET) state.done = true;
          }
          host = null; // one hit per record
        }
      }
    }
  } catch { /* truncated/gzip error — skip rest of file */ }
  finally { rl.close(); stream.destroy(); }
}

// --- run
console.log(`Common Crawl ${CRAWL}: fetching WAT manifest…`);
const pathsGz = await (await fetch(`${BASE}crawl-data/${CRAWL}/wat.paths.gz`)).arrayBuffer();
let paths = zlib.gunzipSync(Buffer.from(pathsGz)).toString('utf8').split('\n').filter(Boolean);
// Shuffle so we sample across the whole crawl, not one contiguous segment.
for (let i = paths.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [paths[i], paths[j]] = [paths[j], paths[i]]; }
paths = paths.slice(0, MAX_FILES);
console.log(`Scanning up to ${paths.length} WAT files (target ${TARGET} domains, concurrency ${CONC})…`);

let idx = 0;
let lastFlush = 0;
async function worker() {
  while (idx < paths.length && !state.done) {
    const url = BASE + paths[idx++];
    await processFile(url);
    state.files++;
    if (state.domains.size - lastFlush >= 500 || state.done) {
      lastFlush = state.domains.size;
      await flush();
    }
    console.log(`  files ${state.files}/${paths.length} · domains ${state.domains.size}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await flush();

const byPlatform = {};
for (const p of state.domains.values()) byPlatform[p] = (byPlatform[p] || 0) + 1;
console.log(`\nDone. ${state.domains.size} unique store domains from ${state.files} WAT files.`);
console.log(`By platform: ${JSON.stringify(byPlatform)}`);
console.log(`Wrote ${path.relative(ROOT, OUT)}. Next: npm run ingest`);

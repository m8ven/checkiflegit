// Batch generator: pick the next N unprocessed domains from the seed list,
// fetch their signals, and write MDX pages. Designed to run in CI on a schedule.
//
// Usage: node scripts/generate.js [count]
// Env:   GEN_COUNT (default 25), SEED_FILE (default scripts/seeds/domains.txt)
import { readFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSignals } from './lib/fetchSignals.js';
import { generatePage } from './lib/generatePage.js';
import { normalizeDomain, domainToSlug } from './lib/util.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const SEED_FILE =
  process.env.SEED_FILE || path.join(ROOT, 'scripts', 'seeds', 'domains.txt');
// Domains confirmed NOT to be stores (REQUIRE_STORE) are recorded here so later
// batches skip them instead of re-fetching them from the top of the queue.
const SKIP_FILE = path.join(ROOT, 'data', 'skipped.txt');
const COUNT = Number(process.env.GEN_COUNT || process.argv[2] || 25);

async function loadSkip() {
  try {
    return new Set((await readFile(SKIP_FILE, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }
}

async function existingSlugs() {
  try {
    const files = await readdir(STORES_DIR);
    return new Set(files.filter((f) => f.endsWith('.mdx')).map((f) => f.replace(/\.mdx$/, '')));
  } catch {
    return new Set();
  }
}

async function loadSeed() {
  const raw = await readFile(SEED_FILE, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(normalizeDomain);
}

const done = await existingSlugs();
const seed = await loadSeed();
const skip = await loadSkip();

// A domain is "done" if it has a page (normal or noindex slug) or was already
// confirmed a non-store.
const queue = seed.filter((d) => {
  const slug = domainToSlug(d);
  return !done.has(slug) && !done.has(`_${slug}`) && !skip.has(d);
});

const batch = queue.slice(0, COUNT);
const CONC = Number(process.env.GEN_CONC || 12);
console.log(`Seed: ${seed.length} domains · already done: ${done.size} · generating: ${batch.length} (concurrency ${CONC})`);

// When set, drop reachable-but-not-a-store domains inline (digital-vendor/news/
// no-platform) instead of generating a page — folds the FP audit into generation
// so bulk batches self-clean with no second fetch pass.
const REQUIRE_STORE = process.env.GEN_REQUIRE_STORE === '1';

let ok = 0;
let skipped = 0;
let nonStore = 0;
let errors = 0;
let cursor = 0;

async function worker() {
  while (cursor < batch.length) {
    const domain = batch[cursor++];
    try {
      const result = await fetchSignals(domain);
      if (REQUIRE_STORE && result.reachable && !result.isStore) {
        nonStore++;
        await appendFile(SKIP_FILE, domain + '\n'); // record so later batches skip it
        continue; // not a storefront — skip without publishing
      }
      const { verdict, noindex } = await generatePage(result);
      if (noindex) skipped++;
      else ok++;
    } catch (err) {
      errors++;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, worker));

console.log(`\nDone. Indexed: ${ok}, unreachable/noindex: ${skipped}, non-store skipped: ${nonStore}, errors: ${errors}.`);

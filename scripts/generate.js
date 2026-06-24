// Batch generator: pick the next N unprocessed domains from the seed list,
// fetch their signals, and write MDX pages. Designed to run in CI on a schedule.
//
// Usage: node scripts/generate.js [count]
// Env:   GEN_COUNT (default 25), SEED_FILE (default scripts/seeds/domains.txt)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSignals } from './lib/fetchSignals.js';
import { generatePage } from './lib/generatePage.js';
import { normalizeDomain, domainToSlug } from './lib/util.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const SEED_FILE =
  process.env.SEED_FILE || path.join(ROOT, 'scripts', 'seeds', 'domains.txt');
const COUNT = Number(process.env.GEN_COUNT || process.argv[2] || 25);

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

// A domain is "done" if either its normal or noindex (_-prefixed) slug exists.
const queue = seed.filter((d) => {
  const slug = domainToSlug(d);
  return !done.has(slug) && !done.has(`_${slug}`);
});

const batch = queue.slice(0, COUNT);
const CONC = Number(process.env.GEN_CONC || 12);
console.log(`Seed: ${seed.length} domains · already done: ${done.size} · generating: ${batch.length} (concurrency ${CONC})`);

let ok = 0;
let skipped = 0;
let errors = 0;
let cursor = 0;

async function worker() {
  while (cursor < batch.length) {
    const domain = batch[cursor++];
    try {
      const result = await fetchSignals(domain);
      const { verdict, noindex } = await generatePage(result);
      if (noindex) skipped++;
      else ok++;
      console.log(`  ${domain} → ${verdict.label}${noindex ? ' (noindex)' : ''}`);
    } catch (err) {
      errors++;
      console.error(`  ${domain} → ERROR ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, worker));

console.log(`\nDone. Indexed: ${ok}, skipped/noindex: ${skipped}, errors: ${errors}.`);

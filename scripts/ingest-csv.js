// Ingest a BigQuery store-discovery export into the batch queue.
//
// Reads data/stores.csv (columns: domain, popularity_rank), normalizes + dedupes,
// drops denylisted domains and any we already have a page for or already seeded,
// orders by long-tail-first (least popular / unranked first), and writes the
// result to scripts/seeds/queue.txt.
//
// Then generate in batches against that queue, e.g.:
//   SEED_FILE=scripts/seeds/queue.txt GEN_COUNT=2500 node scripts/generate.js
//
// Usage: node scripts/ingest-csv.js [path/to.csv]
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain, domainToSlug } from './lib/util.js';
import { isDenied } from './lib/denylist.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CSV = process.argv[2] || path.join(ROOT, 'data', 'stores.csv');
const QUEUE = path.join(ROOT, 'scripts', 'seeds', 'queue.txt');
const SEED = path.join(ROOT, 'scripts', 'seeds', 'domains.txt');
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');

// Minimal CSV row split (domains/ranks contain no commas or quotes worth parsing).
function parseRow(line) {
  const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  return { domain: normalizeDomain(cells[0] || ''), rank: cells[1] === '' || cells[1] == null ? Infinity : Number(cells[1]) };
}

async function existingSlugs() {
  try {
    return new Set((await readdir(STORES_DIR)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '').replace(/^_/, '')));
  } catch { return new Set(); }
}
async function existingSeed() {
  const set = new Set();
  for (const file of [SEED, QUEUE]) {
    try {
      (await readFile(file, 'utf8')).split('\n').forEach((l) => {
        l = l.trim(); if (l && !l.startsWith('#')) set.add(normalizeDomain(l));
      });
    } catch { /* file may not exist */ }
  }
  return set;
}

let raw;
try {
  raw = await readFile(CSV, 'utf8');
} catch {
  console.error(`No CSV at ${CSV}. Drop your BigQuery export there (or pass a path) and re-run.`);
  process.exit(1);
}

const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
// Drop a header row if present.
if (lines[0] && /domain/i.test(lines[0]) && !/\./.test(lines[0].split(',')[0])) lines.shift();

const slugs = await existingSlugs();
const seeded = await existingSeed();

const seen = new Set();
const rows = [];
let total = 0, dupCsv = 0, denied = 0, havePage = 0, alreadySeed = 0;

for (const line of lines) {
  total++;
  const { domain, rank } = parseRow(line);
  if (!domain || !domain.includes('.')) continue;
  if (seen.has(domain)) { dupCsv++; continue; }
  seen.add(domain);
  if (isDenied(domain)) { denied++; continue; }
  if (slugs.has(domainToSlug(domain))) { havePage++; continue; }
  if (seeded.has(domain)) { alreadySeed++; continue; }
  rows.push({ domain, rank });
}

// Long-tail first: unranked (Infinity) first, then least popular (higher rank).
rows.sort((a, b) => b.rank - a.rank);

const out = rows.map((r) => r.domain);
await writeFile(QUEUE, out.join('\n') + (out.length ? '\n' : ''), 'utf8');

console.log(`CSV rows:            ${total}`);
console.log(`duplicates in CSV:   ${dupCsv}`);
console.log(`dropped (denylist):  ${denied}`);
console.log(`already have a page: ${havePage}`);
console.log(`already in seed:     ${alreadySeed}`);
console.log(`---`);
console.log(`queued (new, clean): ${out.length}  ->  ${path.relative(ROOT, QUEUE)}`);
console.log(`\nNext: SEED_FILE=scripts/seeds/queue.txt GEN_COUNT=2500 node scripts/generate.js`);

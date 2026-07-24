// Rewrite title + description on already-generated store pages using the
// current builders in lib/generatePage.js.
//
// Both fields are derived purely from data already stored in each file's
// frontmatter, so this needs no network access and no refetch — it is a pure
// local rewrite. Everything else in the file (signals, verdict, body, fetchedAt)
// is left byte-identical; gray-matter round-trips these files losslessly
// because they were written with it in the first place.
//
// Usage: node scripts/retitle.js           → dry run, prints samples + spread
//        node scripts/retitle.js --apply   → write the changes
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { buildTitle, buildDescription } from './lib/generatePage.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const APPLY = process.argv.includes('--apply');

const files = readdirSync(STORES_DIR).filter((f) => f.endsWith('.md'));

let changed = 0, unchanged = 0, failed = 0, tooLongTitle = 0, tooLongDesc = 0;
const oldTitles = new Set(), newTitles = new Set();
const oldDescs = new Set(), newDescs = new Set();
const samples = [];

for (const file of files) {
  const full = path.join(STORES_DIR, file);
  let parsed;
  try {
    parsed = matter(readFileSync(full, 'utf8'));
  } catch (e) {
    console.error('PARSE FAIL', file, e.message);
    failed++;
    continue;
  }
  const { data, content } = parsed;
  if (!data.verdict) { failed++; continue; }

  const title = buildTitle(data.domain, data.verdict);
  const description = data.reachable
    ? buildDescription(data.domain, data.verdict)
    : `${data.domain} did not load when we checked it.`;

  // Compare templates, not instances — strip the domain so the spread figures
  // report how many genuinely distinct snippets the corpus produces.
  const strip = (s) => String(s ?? '').split(String(data.domain)).join('{D}');
  oldTitles.add(strip(data.title)); newTitles.add(strip(title));
  oldDescs.add(strip(data.description)); newDescs.add(strip(description));

  if (title.length > 60) tooLongTitle++;
  if (description.length > 158) tooLongDesc++;

  if (data.title === title && data.description === description) { unchanged++; continue; }
  changed++;
  if (samples.length < 4 && !data.noindex) {
    samples.push({ domain: data.domain, tier: data.verdict.tier, title, description });
  }
  if (APPLY) writeFileSync(full, matter.stringify(content, { ...data, title, description }), 'utf8');
}

console.log(`files ${files.length} · ${APPLY ? 'rewritten' : 'would rewrite'} ${changed} · unchanged ${unchanged} · failed ${failed}`);
console.log(`distinct title templates : ${oldTitles.size} -> ${newTitles.size}`);
console.log(`distinct desc templates  : ${oldDescs.size} -> ${newDescs.size}`);
console.log(`over-length: ${tooLongTitle} titles (>60), ${tooLongDesc} descriptions (>158)`);
console.log('\nsamples:');
for (const s of samples) {
  console.log(`\n  [${s.tier}] ${s.domain}`);
  console.log(`  T(${String(s.title.length).padStart(3)}) ${s.title}`);
  console.log(`  D(${String(s.description.length).padStart(3)}) ${s.description}`);
}
if (!APPLY) console.log('\nDry run — rerun with --apply to write.');

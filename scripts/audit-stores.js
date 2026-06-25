// One-time audit: re-check every generated store page against the current
// detector + denylist, and report which ones no longer qualify as stores
// (residual false positives). With --prune, delete the flagged pages.
//
// Usage: node scripts/audit-stores.js [--prune]
import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, normalizeDomain } from './lib/util.js';
import { detectPlatform } from './lib/signals/platform.js';
import { isDenied } from './lib/denylist.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const PRUNE = process.argv.includes('--prune');
const CONC = 20;

// Hand-picked starter stores are known-good; some run custom/headless platforms
// with no detectable fingerprint, so never auto-prune them.
const PROTECTED = new Set(['bellroy.com', 'allbirds.com', 'ridge.com', 'mvmt.com', 'gymshark.com']);

async function domainOf(file) {
  const text = await readFile(path.join(STORES_DIR, file), 'utf8');
  const m = text.match(/^domain:\s*(.+)$/m);
  return m ? normalizeDomain(m[1].trim()) : null;
}

async function stillStore(domain) {
  if (isDenied(domain)) return false;
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetchWithTimeout(`${scheme}://${domain}/`, {}, 8000);
      if (!res.ok) continue;
      return detectPlatform(await res.text()).value.isStore;
    } catch { /* next */ }
  }
  return null; // unreachable — leave as-is (already noindexed if so)
}

const files = (await readdir(STORES_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
const items = [];
for (const f of files) items.push({ file: f, domain: await domainOf(f) });

const flagged = [];
for (let i = 0; i < items.length; i += CONC) {
  const slice = items.slice(i, i + CONC);
  const res = await Promise.all(slice.map((it) => stillStore(it.domain)));
  res.forEach((ok, j) => { if (ok === false && !PROTECTED.has(slice[j].domain)) flagged.push(slice[j]); });
  process.stdout.write(`\r  audited ${Math.min(i + CONC, items.length)}/${items.length}, flagged ${flagged.length}`);
}
console.log('');

console.log(`\nFlagged as non-store (${flagged.length}):`);
for (const f of flagged) console.log(`  ${f.domain}`);

if (PRUNE) {
  for (const f of flagged) await unlink(path.join(STORES_DIR, f.file));
  console.log(`\nPruned ${flagged.length} pages.`);
} else {
  console.log('\n(dry run — re-run with --prune to delete these pages)');
}

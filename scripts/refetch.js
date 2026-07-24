// Refresh the oldest already-published store pages.
//
// generate.js only ever processes domains that have NO page yet — a domain with
// a page is "done" forever. So without this, the corpus is a frozen snapshot:
// SSL certificates expire, policy pages come and go, and verdicts keep asserting
// month-old facts. This script is the other half of that loop.
//
// Designed to run unattended, which drives the one rule that matters here:
//
//   A SINGLE FAILED FETCH NEVER DE-INDEXES A LIVE PAGE.
//
// Sites go down for maintenance, rate-limit us, or block a datacentre IP for an
// afternoon. If a transient failure demoted a page, an unattended weekly job
// would quietly delete indexed pages — the exact opposite of the goal. Instead a
// failure records a strike and leaves the page untouched; only REFETCH_STRIKES
// consecutive failures (default 3, so ~3 weeks at a weekly cadence) demote it.
// Any success clears the strikes.
//
// Usage: node scripts/refetch.js [count]
// Env:   REFETCH_COUNT (default 250), REFETCH_CONC (default 12),
//        REFETCH_STRIKES (default 3), REFETCH_DRY (1 = report, write nothing)
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { fetchSignals } from './lib/fetchSignals.js';
import { generatePage } from './lib/generatePage.js';
import { scoreVerdict } from './lib/score.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const STRIKES_FILE = path.join(ROOT, 'data', 'refetch-strikes.json');

const COUNT = Number(process.env.REFETCH_COUNT || process.argv[2] || 250);
const CONC = Number(process.env.REFETCH_CONC || 12);
const MAX_STRIKES = Number(process.env.REFETCH_STRIKES || 3);
const DRY = process.env.REFETCH_DRY === '1';

async function loadStrikes() {
  try { return JSON.parse(await readFile(STRIKES_FILE, 'utf8')); } catch { return {}; }
}

// Oldest-first over indexable pages only. Already-noindexed pages are excluded:
// they are out of the sitemap, so refreshing them spends fetches on pages nobody
// can reach.
async function loadCandidates() {
  const files = (await readdir(STORES_DIR)).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const file of files) {
    try {
      const { data } = matter(await readFile(path.join(STORES_DIR, file), 'utf8'));
      if (data.noindex || !data.domain) continue;
      out.push({ file, domain: data.domain, fetchedAt: data.fetchedAt ?? '', prev: data.verdict });
    } catch { /* unparseable file — leave it alone */ }
  }
  out.sort((a, b) => String(a.fetchedAt).localeCompare(String(b.fetchedAt)));
  return out;
}

const strikes = await loadStrikes();
const candidates = await loadCandidates();
const batch = candidates.slice(0, COUNT);

console.log(
  `Indexable pages: ${candidates.length} · refetching ${batch.length} oldest ` +
    `(${batch[0]?.fetchedAt?.slice(0, 10)} … ${batch.at(-1)?.fetchedAt?.slice(0, 10)}) ` +
    `· concurrency ${CONC}${DRY ? ' · DRY RUN' : ''}`,
);

let refreshed = 0, struck = 0, demoted = 0, blocked = 0, errors = 0;
const tierChanges = [];
let cursor = 0;

async function worker() {
  while (cursor < batch.length) {
    const item = batch[cursor++];
    try {
      const result = await fetchSignals(item.domain);

      // Refused, not dead — leave the page exactly as it is and do not strike.
      // Large retailers rate-limit us every single run; striking them would
      // demote real pages on a schedule.
      if (result.blocked) { blocked++; continue; }

      if (!result.reachable) {
        const n = (strikes[item.domain] ?? 0) + 1;
        strikes[item.domain] = n;
        if (n >= MAX_STRIKES) {
          // Sustained failure — demote to the noindex `_` slug and remove the
          // live page, matching how generate.js treats unreachable domains.
          if (!DRY) {
            await generatePage(result);
            await unlink(path.join(STORES_DIR, item.file)).catch(() => {});
            delete strikes[item.domain];
          }
          demoted++;
        } else {
          struck++;
        }
        continue;
      }

      // scoreVerdict is what generatePage writes, so this is the real new tier
      // in both modes — no re-reading the file, and dry runs still report.
      const after = DRY ? scoreVerdict(result.signals) : (await generatePage(result)).verdict;
      delete strikes[item.domain];
      refreshed++;
      const before = item.prev?.tier;
      if (before && after?.tier && after.tier !== before) {
        tierChanges.push(`${item.domain}: ${before} -> ${after.tier}`);
      }
    } catch {
      errors++;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, worker));

if (!DRY) await writeFile(STRIKES_FILE, JSON.stringify(strikes, null, 2) + '\n', 'utf8');

console.log(
  `\nDone. refreshed ${refreshed} · blocked/skipped ${blocked} · unreachable-strike ${struck} · demoted ${demoted} · errors ${errors}`,
);
if (tierChanges.length) {
  console.log(`\nVerdict changes (${tierChanges.length}):`);
  for (const c of tierChanges.slice(0, 40)) console.log('  ' + c);
  if (tierChanges.length > 40) console.log(`  … and ${tierChanges.length - 40} more`);
}
const pending = Object.entries(strikes).filter(([, n]) => n > 0);
if (pending.length) {
  console.log(`\n${pending.length} domain(s) carrying strikes (demote at ${MAX_STRIKES}):`);
  for (const [d, n] of pending.slice(0, 20)) console.log(`  ${d} — ${n}`);
}

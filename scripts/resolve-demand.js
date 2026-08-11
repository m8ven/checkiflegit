// Resolve demand entities (search phrases) to the domains they refer to.
//
// `data/demand-discover.json` holds the things people actually search "is ___
// legit" about, as query text: "qkkie", "u4gm", "jg wentworth". Pages need
// domains. This bridges the two.
//
//   node scripts/resolve-demand.js [--limit=N] [--conc=6] [--in=path] [--out=path]
//
// THE RISK THIS GUARDS AGAINST: publishing a trust verdict about the wrong
// company. "is loft legit" could be loft.com (US clothing) or loft.co.uk
// (something else entirely); a wrong mapping puts a real business's name on a
// page describing someone else's site. So a candidate is only accepted when the
// site itself confirms the name — the entity has to appear in the domain AND in
// the page's own title/heading/meta. Anything ambiguous is rejected and
// reported, never guessed.
//
// Rejected entities are written out too, so the misses can be resolved by hand
// rather than silently disappearing.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, normalizeDomain } from './lib/util.js';
import { isDenied } from './lib/denylist.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const IN = flag('in', path.join(ROOT, 'data', 'demand-discover.json'));
const OUT = flag('out', path.join(ROOT, 'data', 'demand-resolved.json'));
const LIMIT = parseInt(flag('limit', '0'), 10);
// Skip the first N ranked entities. The head is dominated by large brands that
// are not stores (WWE, WGU), so sampling further down measures whether the tail
// converts to store pages at a different rate.
const OFFSET = parseInt(flag('offset', '0'), 10);
const CONC = parseInt(flag('conc', '6'), 10);

// Entities that are questions about the world, not businesses. The discover
// sweep catches plenty of these ("is wrestling real"), and they must not
// become store pages.
const NON_BUSINESS = /^(wrestling|the |a |an |this|that|it|he|she|they|god|santa|bigfoot|christmas|easter)\b/i;

// Generic words that would resolve to a big unrelated site if we appended .com.
const TOO_GENERIC = new Set([
  'real', 'legit', 'safe', 'scam', 'fake', 'shop', 'store', 'online', 'app',
  'site', 'website', 'company', 'business', 'money', 'gold', 'silver', 'books',
  'music', 'games', 'game', 'news', 'travel', 'health', 'food', 'water',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Candidate domains for an entity, most likely first. */
function candidates(entity) {
  const e = entity.trim().toLowerCase();
  // Already a domain ("vk.com", "qr.io").
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) return [e];

  // Deliberately .com only (plus the hyphenated spelling of the SAME name).
  //
  // Trying .co/.io/.net as fallbacks is what produced "g2a" -> g2a.co and
  // "temu" -> temu.co: whenever the canonical .com timed out or refused the
  // bot, the loop stepped down to a typosquat that happened to carry the brand
  // name in its title. For a site that publishes trust verdicts, attaching a
  // real brand's search demand to a squatter is the worst available failure —
  // far worse than resolving nothing. Unresolved entities go to manual review.
  const tight = e.replace(/[^a-z0-9]/g, '');
  const hyphen = e.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const out = [`${tight}.com`];
  if (hyphen !== tight) out.push(`${hyphen}.com`);
  return out;
}

function textBetween(html, re) {
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/**
 * Does this page actually belong to `entity`? Requires the name to appear in
 * the site's own self-description, not merely somewhere in the markup (which
 * would match any page that happens to mention the word).
 */
function confirms(html, entity) {
  const tight = entity.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (tight.length < 3) return false;

  const title = textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogSite = textBetween(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  const ogTitle = textBetween(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const h1 = textBetween(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const hay = [title, ogSite, ogTitle, h1].join(' ').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return hay.includes(tight);
}

// The server answered and refused us. Same distinction http.js draws: a refusal
// means the site is real and defended, NOT that it is the wrong domain.
const BLOCKED_STATUS = new Set([401, 403, 405, 406, 429, 503]);

async function tryDomain(domain, entity) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetchWithTimeout(`${scheme}://${domain}/`, {}, 10000);
      if (BLOCKED_STATUS.has(res.status)) {
        return { domain, ok: false, blocked: true, reason: `http_${res.status}` };
      }
      // A parked/for-sale page answers 200 too, so confirmation is what decides.
      if (!res.ok) return { domain, ok: false, reason: `http_${res.status}` };
      const html = await res.text();
      if (!confirms(html, entity)) return { domain, ok: false, reason: 'name_not_confirmed' };
      return { domain, ok: true, finalUrl: res.url };
    } catch {
      /* try next scheme */
    }
  }
  return { domain, ok: false, reason: 'unreachable' };
}

async function resolveEntity(row) {
  const entity = row.entity;
  if (NON_BUSINESS.test(entity)) return { entity, ok: false, reason: 'not_a_business' };
  if (TOO_GENERIC.has(entity.replace(/[^a-z0-9]/g, ''))) {
    return { entity, ok: false, reason: 'too_generic' };
  }

  const tried = [];
  for (const cand of candidates(entity)) {
    if (isDenied?.(cand)) { tried.push(`${cand}:denied`); continue; }
    const r = await tryDomain(cand, entity);
    tried.push(`${cand}:${r.ok ? 'ok' : r.reason}`);

    // STOP on a refusal. Continuing would step down to a lower-priority TLD
    // while the canonical one is simply defended — which is how "etsy"
    // resolved to etsy.io instead of etsy.com, i.e. how a real brand's search
    // demand gets attached to a squatter's page. A blocked candidate is
    // reported for manual confirmation instead of being worked around.
    if (r.blocked) {
      return { entity, ok: false, reason: 'blocked_needs_review', candidate: cand, tried };
    }
    // A timeout/DNS failure is equally not evidence the name is wrong, and the
    // remaining candidate is only a spelling variant — so stop here too rather
    // than let a transient failure decide which domain gets the page.
    if (r.reason === 'unreachable') {
      return { entity, ok: false, reason: 'unreachable_needs_review', candidate: cand, tried };
    }

    if (r.ok) {
      return {
        entity,
        ok: true,
        domain: normalizeDomain(r.domain),
        marketCount: row.marketCount ?? 0,
        intentTotal: row.intentTotal ?? 0,
        queries: (row.queries ?? []).slice(0, 6),
        tried,
      };
    }
    await sleep(60);
  }
  return { entity, ok: false, reason: 'no_candidate_confirmed', tried };
}

const src = JSON.parse(await readFile(IN, 'utf8'));
let rows = src.entities ?? [];
// Highest-value first: present in the most markets, then most intent breadth.
rows.sort((a, b) => (b.marketCount ?? 0) - (a.marketCount ?? 0) || (b.intentTotal ?? 0) - (a.intentTotal ?? 0));
if (OFFSET > 0) rows = rows.slice(OFFSET);
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

console.log(`Resolving ${rows.length} demand entities (concurrency ${CONC})…`);

const results = new Array(rows.length);
let cursor = 0;
let done = 0;
await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
  while (cursor < rows.length) {
    const i = cursor++;
    results[i] = await resolveEntity(rows[i]);
    if (++done % 20 === 0) process.stderr.write(`\r  ${done}/${rows.length}`);
  }
}));
process.stderr.write('\n');

const resolved = results.filter((r) => r?.ok);
const failed = results.filter((r) => r && !r.ok);

// Two domains can resolve from different phrasings of the same brand.
const seen = new Set();
const unique = resolved.filter((r) => (seen.has(r.domain) ? false : seen.add(r.domain)));

const byReason = {};
for (const f of failed) byReason[f.reason] = (byReason[f.reason] || 0) + 1;

await writeFile(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: path.basename(IN),
  considered: rows.length,
  resolved: unique.length,
  domains: unique,
  failed,
}, null, 2));

console.log(`\nResolved ${unique.length}/${rows.length} to confirmed domains.`);
console.log('Rejections by reason:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log('\nTop resolved:');
for (const r of unique.slice(0, 25)) console.log(`  ${String(r.marketCount)}mkt  ${r.entity.padEnd(22)} → ${r.domain}`);
console.log(`\nWrote ${OUT}`);

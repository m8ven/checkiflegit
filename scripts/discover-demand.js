// Demand discovery via Google Suggest (autocomplete).
//
// The corpus was built supply-first: every store Common Crawl could fingerprint,
// regardless of whether anyone searches for it. This script measures the other
// side — which store names people actually type "is ___ legit" about — so pages
// can be built against demand instead of availability.
//
// Google's suggest endpoint is public, unauthenticated and free. It returns the
// queries Google itself considers worth completing, which is a direct (if
// unquantified) demand signal: a store only appears if real people search it.
//
//   node scripts/discover-demand.js discover            # enumerate demand
//   node scripts/discover-demand.js audit               # test the existing corpus
//   node scripts/discover-demand.js info                # informational queries
//
// Flags: --depth=2 --markets=us,gb,ca,au --hl=en --limit=N --conc=4 --out=path
//
// Markets default to the four highest-CPM English ad markets (US, UK, Canada,
// Australia). Each is swept separately and results are merged with per-market
// attribution, so an entity's value can be read as demand x ad price rather
// than raw demand.
//
// CAVEAT: suggestions are personalised by the caller's IP. `gl` biases the
// result but does not override it — running this from Zurich leaks Swiss
// results into every market. The `localLeak` field in the output flags this.
// For a clean read, run from a VPN/proxy in-market, or use a paid SERP API.
// This endpoint also gives no volume or CPC numbers: use it to DISCOVER which
// entities have demand, then quantify the shortlist in Google Keyword Planner
// (free, gives per-country volume ranges AND top-of-page bid) or DataForSEO.

import { readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const DATA_DIR = path.join(ROOT, 'data');

// Buy-intent tails. These are the query shapes this site's pages can answer;
// a suggestion has to end in one of them to count as demand for a trust check.
const INTENT = [
  'legit', 'legitimate', 'a scam', 'scam', 'safe', 'safe to order from',
  'safe to buy from', 'trustworthy', 'reliable', 'real', 'a real site',
  'a real company', 'fake', 'a ripoff', 'a rip off', 'any good', 'worth it',
  'legit site', 'legit website', 'a legit website',
];
const INTENT_RE = new RegExp(`\\s+(${INTENT.map((s) => s.replace(/ /g, '\\s+')).join('|')})\\s*$`, 'i');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
const ALNUM = [...ALPHABET, ...'0123456789'.split('')];

// Entities that are not stores. Autocomplete for "is X legit" is dominated by
// non-commerce questions (people, places, media), which would otherwise flood
// the output.
const STOPWORDS = new Set([
  'it', 'this', 'that', 'he', 'she', 'they', 'god', 'santa', 'bigfoot',
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'their',
]);

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) || 'discover';
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const DEPTH = parseInt(flag('depth', '2'), 10);
// Highest-CPM English-language ad markets. Ad revenue per click varies by
// several times across these vs. the corpus's actual .ru/.pl/.vn skew, so
// demand is only worth chasing where it monetises.
const MARKETS = flag('markets', 'us,gb,ca,au').split(',').map((m) => m.trim()).filter(Boolean);
const HL = flag('hl', 'en');
const CONC = parseInt(flag('conc', '4'), 10);
const LIMIT = parseInt(flag('limit', '0'), 10);

// Detects the caller's own geo leaking into results (see CAVEAT above).
const LOCAL_LEAK_RE = /\b(zurich|switzerland|swiss|geneva|basel|zug|luzern|lucerne)\b/i;

/**
 * One call to Google Suggest. Returns the suggestion strings.
 * Backs off on 429 rather than failing — the endpoint rate-limits by IP and a
 * long run will hit it.
 */
async function suggest(query, gl, attempt = 0) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox` +
    `&hl=${encodeURIComponent(HL)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt >= 4) return { rateLimited: true, suggestions: [] };
      await sleep(1500 * 2 ** attempt);
      return suggest(query, gl, attempt + 1);
    }
    if (!res.ok) return { suggestions: [] };
    const body = await res.json();
    return { suggestions: Array.isArray(body?.[1]) ? body[1] : [] };
  } catch {
    if (attempt >= 2) return { suggestions: [] };
    await sleep(800 * 2 ** attempt);
    return suggest(query, gl, attempt + 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with a fixed-size worker pool, in order, with a small pacing delay. */
async function pool(items, worker, conc) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
      await sleep(120);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Split "is shein legit" into { entity: 'shein', intent: 'legit' }.
 * Returns null when the suggestion is not an intent question about an entity.
 */
function parseSuggestion(s) {
  const q = String(s).toLowerCase().trim();
  if (!q.startsWith('is ')) return null;
  const m = q.match(INTENT_RE);
  if (!m) return null;
  const entity = q.slice(3, q.length - m[0].length).trim();
  if (!entity || entity.length < 2) return null;
  if (STOPWORDS.has(entity)) return null;
  if (entity.split(/\s+/).length > 4) return null; // long clauses aren't store names
  return { entity, intent: m[1].trim() };
}

function progress(done, total, label) {
  if (done % 25 !== 0 && done !== total) return;
  process.stderr.write(`\r  ${label}: ${done}/${total}`);
  if (done === total) process.stderr.write('\n');
}

/* ------------------------------------------------------------------ discover */

async function discover() {
  // Prefix soup: Google completes forward from a prefix, so enumerating short
  // prefixes after "is " surfaces the highest-volume completion for each.
  const prefixes = [];
  for (const a of ALNUM) prefixes.push(`is ${a}`);
  if (DEPTH >= 2) for (const a of ALPHABET) for (const b of ALNUM) prefixes.push(`is ${a}${b}`);
  if (DEPTH >= 3) {
    for (const a of ALPHABET) for (const b of ALPHABET) for (const c of ALNUM) prefixes.push(`is ${a}${b}${c}`);
  }

  console.log(`Discover: ${prefixes.length} prefixes x ${MARKETS.length} markets ` +
    `(${MARKETS.join(',')}), depth ${DEPTH}`);

  const found = new Map(); // entity -> { entity, markets: Map<gl, {intents,bestRank}>, queries:Set }
  let localLeak = 0;
  let rateLimited = 0;

  for (const gl of MARKETS) {
    let done = 0;
    await pool(prefixes, async (p) => {
      const { suggestions, rateLimited: rl } = await suggest(p, gl);
      if (rl) rateLimited++;
      suggestions.forEach((s, rank) => {
        if (LOCAL_LEAK_RE.test(s)) localLeak++;
        const parsed = parseSuggestion(s);
        if (!parsed) return;
        const cur = found.get(parsed.entity) || {
          entity: parsed.entity, markets: new Map(), queries: new Set(),
        };
        const m = cur.markets.get(gl) || { intents: new Set(), bestRank: 99 };
        m.intents.add(parsed.intent);
        m.bestRank = Math.min(m.bestRank, rank);
        cur.markets.set(gl, m);
        cur.queries.add(s);
        found.set(parsed.entity, cur);
      });
      progress(++done, prefixes.length, `${gl} prefixes`);
    }, CONC);
  }

  // Two proxies, since the endpoint gives no volume:
  //  - intent breadth: Google only keeps many completions for entities people
  //    ask about a lot;
  //  - market breadth: appearing across several high-CPM markets separates
  //    globally-searched stores from one-country blips.
  const rows = [...found.values()]
    .map((r) => {
      const markets = {};
      let intentTotal = 0;
      let bestRank = 99;
      for (const [gl, m] of r.markets) {
        markets[gl] = { intents: [...m.intents].sort(), intentCount: m.intents.size, bestRank: m.bestRank };
        intentTotal += m.intents.size;
        bestRank = Math.min(bestRank, m.bestRank);
      }
      return {
        entity: r.entity,
        marketCount: r.markets.size,
        markets,
        intentTotal,
        bestRank,
        queries: [...r.queries].sort(),
      };
    })
    // Rank by markets first: demand present in US+UK+CA+AU is worth more than
    // the same intent breadth in one market only.
    .sort((a, b) => b.marketCount - a.marketCount || b.intentTotal - a.intentTotal || a.bestRank - b.bestRank);

  if (rateLimited) console.warn(`\n  ${rateLimited} prefix(es) gave up to rate limiting.`);
  return {
    mode: 'discover', markets: MARKETS, hl: HL, depth: DEPTH,
    prefixesQueried: prefixes.length * MARKETS.length,
    localLeak,
    entities: rows,
  };
}

/* ---------------------------------------------------------------------- info */

// Entity demand tops out at roughly 200-300 store pages (measured), so the
// informational queries — which have no entity dependence and far more volume —
// have to carry traffic rather than supplement it. These are the question
// shapes this site can answer from its own corpus measurements.
const INFO_SEEDS = [
  'how to tell if a website is',
  'how to tell if an online store is',
  'how to know if a website is',
  'how to check if a website is',
  'how to check if an online store is',
  'how to spot a fake',
  'how to verify a website',
  'is it safe to buy from',
  'signs of a fake website',
  'signs of a scam website',
  'what to do if you bought from a scam',
  'how to avoid online shopping',
  'how to check a website before buying',
  'why do websites say only',
  'are countdown timers on websites',
  'are website reviews',
];

async function info() {
  // Expand each seed with a trailing letter to pull distinct completions —
  // the bare phrase alone returns only the single most popular continuation.
  const queries = [];
  for (const s of INFO_SEEDS) {
    queries.push(s);
    for (const a of ALPHABET) queries.push(`${s} ${a}`);
  }

  console.log(`Info: ${queries.length} queries x ${MARKETS.length} markets (${MARKETS.join(',')})`);

  const found = new Map(); // suggestion -> { query, markets:Set, bestRank }
  for (const gl of MARKETS) {
    let done = 0;
    await pool(queries, async (q) => {
      const { suggestions } = await suggest(q, gl);
      suggestions.forEach((s, rank) => {
        const key = String(s).toLowerCase().trim();
        // Keep only genuine questions, not navigational or entity lookups.
        if (!/^(how|what|why|is it|are|should|can|do|does|where)\b/.test(key)) return;
        const cur = found.get(key) || { query: key, markets: new Set(), bestRank: 99 };
        cur.markets.add(gl);
        cur.bestRank = Math.min(cur.bestRank, rank);
        found.set(key, cur);
      });
      progress(++done, queries.length, `${gl} info`);
    }, CONC);
  }

  const rows = [...found.values()]
    .map((r) => ({ query: r.query, marketCount: r.markets.size, markets: [...r.markets], bestRank: r.bestRank }))
    // Market breadth first, then how early Google ranks the completion — both
    // proxy volume, since the endpoint reports none.
    .sort((a, b) => b.marketCount - a.marketCount || a.bestRank - b.bestRank);

  return { mode: 'info', markets: MARKETS, hl: HL, seeds: INFO_SEEDS.length, queriesRun: queries.length * MARKETS.length, queries: rows };
}

/* --------------------------------------------------------------------- audit */

// Multi-part public suffixes common in the corpus. Without these, the brand of
// "damart.co.uk" reads as "co".
const CC_SLD = new Set([
  'co.uk', 'com.au', 'com.br', 'co.nz', 'co.za', 'co.il', 'com.pk', 'com.tr',
  'com.mx', 'com.ar', 'co.jp', 'or.jp', 'ne.jp', 'com.sg', 'com.my', 'com.hk',
  'com.tw', 'com.cn', 'org.uk', 'net.au', 'org.au', 'com.pl', 'com.ua', 'com.vn',
]);

/**
 * Registrable brand token for a domain. Takes the label before the public
 * suffix, NOT the first label — "woo.zwaardenvolk.nl" is the store
 * `zwaardenvolk`, and reading it as "woo" matches unrelated demand.
 */
function brandOf(domain) {
  const parts = String(domain).replace(/^www\./, '').toLowerCase().split('.');
  if (parts.length < 2) return parts[0] || '';
  const lastTwo = parts.slice(-2).join('.');
  const suffixLen = CC_SLD.has(lastTwo) ? 2 : 1;
  return parts[parts.length - 1 - suffixLen] || parts[0];
}

async function corpusDomains() {
  const files = (await readdir(STORES_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  const domains = [];
  for (const f of files) {
    const head = (await readFile(path.join(STORES_DIR, f), 'utf8')).slice(0, 400);
    const m = head.match(/^domain:\s*(.+)$/m);
    if (m) domains.push(m[1].trim());
  }
  return domains;
}

async function audit() {
  let domains = await corpusDomains();
  // The corpus is stored alphabetically, so slicing the head oversamples the
  // numeric/junk domains that sort first. Shuffle before limiting.
  if (LIMIT > 0) {
    for (let i = domains.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [domains[i], domains[j]] = [domains[j], domains[i]];
    }
    domains = domains.slice(0, LIMIT);
  }
  console.log(`Audit: ${domains.length} corpus domains x ${MARKETS.length} markets (${MARKETS.join(',')})`);

  let done = 0;
  const rows = await pool(domains, async (domain) => {
    const brand = brandOf(domain);
    // Query the brand alone in each market; if Google has no completion tying
    // it to intent anywhere, there is no "is it legit" demand for that store.
    const hits = {};
    // Short brands collide with unrelated entities ("fd", "737"), and a prefix
    // match pulls in different businesses entirely ("books" -> "books a
    // million"), so demand only counts on an exact entity match.
    if (brand.length >= 4) {
      for (const gl of MARKETS) {
        const { suggestions } = await suggest(`is ${brand} `, gl);
        const matches = suggestions.filter((s) => parseSuggestion(s)?.entity === brand);
        if (matches.length) hits[gl] = matches;
      }
    }
    progress(++done, domains.length, 'domains');
    return {
      domain, brand,
      hasDemand: Object.keys(hits).length > 0,
      marketCount: Object.keys(hits).length,
      hits,
    };
  }, CONC);

  const withDemand = rows.filter((r) => r.hasDemand)
    .sort((a, b) => b.marketCount - a.marketCount);
  return {
    mode: 'audit',
    markets: MARKETS, hl: HL,
    checked: rows.length,
    withDemand: withDemand.length,
    pctWithDemand: +((withDemand.length / rows.length) * 100).toFixed(2),
    demandRows: withDemand,
    noDemandDomains: rows.filter((r) => !r.hasDemand).map((r) => r.domain),
  };
}

/* ---------------------------------------------------------------------- main */

const started = Date.now();
const result = mode === 'audit' ? await audit() : mode === 'info' ? await info() : await discover();
result.generatedAt = new Date().toISOString();
result.elapsedSec = Math.round((Date.now() - started) / 1000);

const outPath = flag('out', path.join(DATA_DIR, `demand-${result.mode}.json`));
await writeFile(outPath, JSON.stringify(result, null, 2));

if (result.mode === 'info') {
  console.log(`\nFound ${result.queries.length} informational queries.`);
  console.log('Top 45 by market breadth, then rank:');
  for (const q of result.queries.slice(0, 45)) {
    console.log(`  ${q.marketCount}mkt r${q.bestRank}  ${q.query}`);
  }
} else if (result.mode === 'discover') {
  console.log(`\nFound ${result.entities.length} entities with trust-check demand.`);
  if (result.localLeak) {
    console.warn(`  NOTE: ${result.localLeak} suggestion(s) leaked caller geo — run via in-market proxy for a clean read.`);
  }
  console.log('Top 40 by market breadth, then intent breadth:');
  for (const e of result.entities.slice(0, 40)) {
    const mk = Object.keys(e.markets).join('/');
    console.log(`  ${e.marketCount}mkt ${String(e.intentTotal).padStart(2)}int  ${e.entity.padEnd(24)} [${mk}]`);
  }
} else {
  console.log(`\n${result.withDemand}/${result.checked} corpus stores show any demand (${result.pctWithDemand}%).`);
  for (const r of result.demandRows.slice(0, 30)) {
    const sample = Object.values(r.hits)[0] || [];
    console.log(`  ${r.marketCount}mkt  ${r.domain.padEnd(28)} → ${sample.slice(0, 2).join(' | ')}`);
  }
}
console.log(`\nWrote ${outPath} (${result.elapsedSec}s)`);

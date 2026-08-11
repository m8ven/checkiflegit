// Code-level deception detection.
//
// Every other signal in this pipeline measures what a store *publishes* — a
// policy page, a phone number, a certificate. Those are cheap to fake: adding a
// privacy policy costs nothing. This module measures what the store's code
// actually *does*, which is far harder to fake because the deception has to be
// implemented to work at all.
//
// The canonical case: a scrolling "Joe from Nashville bought 5 units 30 seconds
// ago" banner whose implementation is a hardcoded name array, Math.random() for
// the quantity, and a randomised "time ago" string. Nothing touches a server.
// No human shopper ever opens devtools to check, so it goes unchallenged.
//
// HARD RULES (consistent with score.js and the project's never-fabricate rule):
//  - No finding without evidence. Every detection carries the actual source
//    line, with file and line number. If we cannot show the code, we do not
//    make the claim.
//  - Static analysis only. Deterministic regex/proximity matching cannot
//    hallucinate a finding, which is the same reason the page prose is
//    rule-based. (The brief's LLM pass over flagged regions is deliberately NOT
//    implemented here; it would reintroduce that risk and a per-page cost.)
//  - Detectors require CO-OCCURRENCE, never a bare primitive. `Math.random()`
//    alone is ubiquitous and innocent — cache busting, A/B bucketing, request
//    IDs. It only counts when it sits next to social-proof or scarcity
//    vocabulary.

import { fetchWithTimeout } from '../util.js';

// Bound the work: a store with 40 bundles must not cost 40 fetches.
const MAX_BUNDLES = 6;
const MAX_BYTES = 900_000; // per source; theme bundles are typically 100-400KB
const SNIPPET_MAX = 240;

/** Vocabulary that makes a nearby random/timer primitive meaningful. */
const VOCAB = {
  socialProof: /\b(just\s+(bought|purchased|ordered)|someone\s+(bought|purchased)|recently\s+purchased|purchased\s+this|bought\s+this|customers?\s+(are\s+)?(bought|viewing|looking)|verified\s+buyer|testimonial)\b/i,
  timeAgo: /\b(\d+\s*)?(second|minute|hour|day)s?\s+ago\b/i,
  scarcity: /\b(left\s+in\s+stock|items?\s+left|only\s+\d+\s+left|in\s+high\s+demand|selling\s+fast|almost\s+gone|people\s+(are\s+)?(viewing|watching|looking\s+at))\b/i,
  urgency: /\b(countdown|count_?down|deadline|offer\s+ends|expires?\s+in|hurry|flash\s+sale|limited\s+time)\b/i,
};

/** A plausible hardcoded first-name / city array: >=5 short quoted words. */
const NAME_ARRAY = /\[\s*(?:["'][A-Z][a-zA-Z .'-]{1,18}["']\s*,\s*){4,}["'][A-Z][a-zA-Z .'-]{1,18}["']\s*,?\s*\]/;

const RANDOM = /Math\.random\s*\(\s*\)/;
const NOW = /Date\.now\s*\(\s*\)|new\s+Date\s*\(\s*\)\.getTime\s*\(\s*\)/;

// A value that arrives over the network is server-driven, so a nearby random
// primitive is not what produces it. Seeing any of these between the primitive
// and the claim means we cannot attribute the number to the RNG — so we don't.
const SERVER_DRIVEN = /\bfetch\s*\(|XMLHttpRequest|\baxios\b|\$\.(get|post|ajax)\b|\.json\s*\(\s*\)|\bawait\b/;

/**
 * Detector table. A detector fires when one of its `primitives` appears within
 * `maxDist` characters of one of its `vocab` matches — a specific pair, not
 * merely both somewhere in the same region. The evidence then spans that pair,
 * so the snippet always shows the mechanism being claimed.
 *
 * `also` is an extra pattern that must appear in the span's neighbourhood.
 */
const DETECTORS = [
  {
    signal: 'fabricated_social_proof',
    severity: 'high',
    label: 'Purchase notifications are generated in the browser, not from real orders.',
    primitives: ['random', 'nameArray'],
    vocab: ['socialProof'],
    maxDist: 220,
  },
  {
    signal: 'fabricated_activity_timestamps',
    severity: 'high',
    label: '"Time ago" labels on activity notices are randomised in the browser rather than read from real events.',
    primitives: ['random'],
    vocab: ['timeAgo'],
    also: VOCAB.socialProof,
    maxDist: 200,
  },
  {
    signal: 'fabricated_scarcity',
    severity: 'high',
    label: 'Stock-level or "people viewing" counters are produced by a random number generator.',
    primitives: ['random'],
    vocab: ['scarcity'],
    maxDist: 160,
  },
  {
    signal: 'evergreen_countdown',
    severity: 'medium',
    // A real deadline is a fixed timestamp. A countdown seeded from the
    // visitor's own clock restarts for every visitor, so the "offer ends"
    // claim is never true for anyone.
    label: 'A countdown timer is seeded from the visitor\'s own clock, so it restarts on every visit rather than counting to a real deadline.',
    primitives: ['now'],
    vocab: ['urgency'],
    also: /setInterval|setTimeout|requestAnimationFrame/,
    maxDist: 220,
  },
  {
    signal: 'reset_on_reload_timer',
    severity: 'medium',
    label: 'An "offer ends" timer is stored per-visitor in the browser, so the deadline is different for every shopper.',
    primitives: ['now'],
    vocab: ['urgency'],
    also: /localStorage|sessionStorage|document\.cookie/,
    maxDist: 220,
  },
];

const PRIMITIVES = { random: RANDOM, now: NOW, nameArray: NAME_ARRAY };

/** All match positions for a pattern in a source. */
function positions(pattern, src) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ index: m.index, length: m[0].length, text: m[0] });
    if (m[0].length === 0) re.lastIndex++;
    if (out.length > 400) break;
  }
  return out;
}

/** Split source into lines once, for line-number lookup. */
function lineIndex(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offsets.push(i + 1);
  return offsets;
}

function lineAt(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Pull a readable snippet around a match. Minified bundles are one enormous
 * line, so slice by character window and collapse whitespace — the point is to
 * show a human the actual code, not to reproduce formatting.
 */
function snippetAt(src, pos, len) {
  const start = Math.max(0, pos - 60);
  const raw = src.slice(start, Math.min(src.length, pos + len + 60));
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned.length > SNIPPET_MAX ? `${cleaned.slice(0, SNIPPET_MAX)}…` : cleaned;
}

/**
 * Scan one source by pairing primitives with nearby vocabulary. Pairing (rather
 * than "both appear in this window") is what keeps the evidence honest: the
 * emitted snippet spans the exact pair that triggered the finding, so it always
 * shows the mechanism being claimed.
 */
function scanSource(src, file, found) {
  const offsets = lineIndex(src);

  // Cheap pre-filter — most sources contain none of these at all.
  if (!RANDOM.test(src) && !NOW.test(src) && !NAME_ARRAY.test(src)) return;

  const primCache = {};
  const vocabCache = {};
  const primPos = (k) => (primCache[k] ??= positions(PRIMITIVES[k], src));
  const vocabPos = (k) => (vocabCache[k] ??= positions(VOCAB[k], src));

  for (const d of DETECTORS) {
    if (found.has(d.signal)) continue; // one evidence item per signal is enough

    for (const pk of d.primitives) {
      for (const p of primPos(pk)) {
        for (const vk of d.vocab) {
          const hit = vocabPos(vk).find(
            (v) => Math.abs(v.index - p.index) <= d.maxDist
          );
          if (!hit) continue;

          const from = Math.min(p.index, hit.index);
          const to = Math.max(p.index + p.length, hit.index + hit.length);
          // Look slightly wider than the pair for the supporting pattern and
          // for evidence the value is actually fetched from a server.
          const context = src.slice(Math.max(0, from - 200), to + 200);
          if (SERVER_DRIVEN.test(context)) continue;
          if (d.also && !d.also.test(context)) continue;

          found.set(d.signal, {
            signal: d.signal,
            severity: d.severity,
            label: d.label,
            source: 'code_analysis',
            location: `${file}:${lineAt(offsets, from)}`,
            snippet: snippetAt(src, from, to - from),
          });
          break;
        }
        if (found.has(d.signal)) break;
      }
      if (found.has(d.signal)) break;
    }
  }
}

// Conversion-optimisation vendors whose whole product is manufactured urgency
// and social proof. These are third-party hosts, but unlike analytics they are
// installed deliberately by the merchant to produce this behaviour, so findings
// in them are fairly attributed to the store. The evidence records the vendor
// file by name either way, so a reader can see the source of any claim.
const APP_HOSTS = /(provesrc|useproof|fomo|nudgify|salespop|beeketing|hextom|hurrify|care-?cart|zooomy|essential-?apps|conversionbear|adoric|privy)/i;

/** Script URLs worth scanning: the store's own code plus urgency/social-proof apps. */
function scriptUrls(html, baseUrl) {
  const urls = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u;
    try {
      u = new URL(m[1], baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    // Generic third-party analytics/tag bundles are not the store's own code,
    // and scanning them would attribute someone else's patterns to this store.
    const sameSite = u.hostname === new URL(baseUrl).hostname ||
      u.hostname.endsWith('.shopify.com') || u.hostname.endsWith('.shopifycdn.com');
    if (!sameSite && !APP_HOSTS.test(u.hostname)) continue;
    urls.push(u.toString());
  }
  // Urgency/social-proof apps first, then theme bundles, then everything else —
  // MAX_BUNDLES caps the fetches, so ordering decides what actually gets read.
  const rank = (u) => (APP_HOSTS.test(u) ? 0 : /theme|app|custom|main|bundle|store/i.test(u) ? 1 : 2);
  return [...new Set(urls)].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_BUNDLES);
}

/**
 * Detect code-level deception patterns in a store's homepage and its own JS.
 *
 * Returns the standard signal shape. `unknown` when we could not read enough
 * source to make the claim either way — per the pipeline's rule, that is
 * excluded from scoring rather than counted as clean.
 */
export async function checkDeception(html, finalUrl) {
  if (!html || !finalUrl) {
    return {
      status: 'unknown',
      value: { findings: [], sourcesScanned: 0 },
      detail: 'No page source available to analyse.',
    };
  }

  const found = new Map();
  let scanned = 0;

  scanSource(html.slice(0, MAX_BYTES), 'homepage HTML', found);
  scanned++;

  const urls = scriptUrls(html, finalUrl);
  const bundles = await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await fetchWithTimeout(u, {}, 8000);
        if (!res.ok) return null;
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_BYTES) return null;
        const text = (await res.text()).slice(0, MAX_BYTES);
        return { url: u, text };
      } catch {
        return null;
      }
    })
  );

  for (const b of bundles) {
    if (!b) continue;
    // Show the path, not the full CDN URL with its cache-busting query.
    const file = new URL(b.url).pathname.split('/').pop() || b.url;
    scanSource(b.text, file, found);
    scanned++;
  }

  const findings = [...found.values()];
  const high = findings.filter((f) => f.severity === 'high').length;

  // Scanning only the homepage is weak evidence of absence: this code usually
  // lives in a theme bundle. No findings + no bundles read => unknown, not pass.
  if (findings.length === 0 && scanned === 1 && urls.length > 0) {
    return {
      status: 'unknown',
      value: { findings: [], sourcesScanned: scanned },
      detail: 'Could not retrieve the store\'s script files, so page behaviour was not analysed.',
    };
  }

  if (findings.length === 0) {
    return {
      status: 'pass',
      value: { findings: [], sourcesScanned: scanned },
      detail: `No fabricated urgency or social-proof code found (${scanned} source file(s) analysed).`,
    };
  }

  return {
    status: high > 0 ? 'fail' : 'warn',
    value: { findings, sourcesScanned: scanned },
    detail: `Found ${findings.length} deceptive interface pattern(s) in the code this store serves.`,
  };
}

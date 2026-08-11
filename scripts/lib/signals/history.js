// Web history signal — how long this domain has existed *as a visible site*,
// according to a third party.
//
// This is the closest thing to external corroboration we can get for free, and
// it does two jobs the existing signals cannot:
//
//  1. It covers the WHOIS gap. Roughly 28% of the corpus has no creation date,
//     because many ccTLD registries don't publish one over port 43. Those
//     stores currently have their strongest age signal reported as `unknown`.
//     The Internet Archive doesn't care which registry a domain sits in.
//  2. It measures footprint depth, not just age. A domain registered in 2011
//     that has been archived in 4 distinct months is a different proposition
//     from one archived in 90 — the first is a name someone parked, the second
//     is a site that has been continuously visible.
//
// This is the `thin_footprint` state from the detection brief, made measurable:
// when nothing outside the business itself has any record of it, that is a
// finding, not a data gap.
//
// Source: the Internet Archive CDX API — free, keyless, documented for this use.
//
// HARD RULE: archive coverage is uneven. Small and non-English sites get
// crawled less, so a thin archive is reported as thin evidence, never as proof
// the store is new. Absence of capture is never scored as a fail.

import { fetchWithTimeout } from '../util.js';

// One row per distinct capture month (collapse=timestamp:6 truncates the
// YYYYMMDDhhmmss stamp to YYYYMM), so the row count is "months seen" rather
// than "times crawled" — which would just measure the Archive's own attention.
const CDX = 'https://web.archive.org/cdx/search/cdx';
const MAX_ROWS = 400;

// archive.org throttles hard under parallel load. The generator runs stores
// concurrently, so without a limiter here most stores in a batch get `unknown`
// — measured at 17 of 26 on the first demand batch. That would repeat the
// reviews-signal failure: a signal advertised on every page that in practice
// scores nothing. Cap archive traffic globally and space the requests out;
// this signal is slow by nature and correctness matters more than throughput.
const MAX_CONCURRENT = 2;
const MIN_SPACING_MS = 350;
let active = 0;
let lastStart = 0;
const waiting = [];

async function acquire() {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active++;
  const gap = Date.now() - lastStart;
  if (gap < MIN_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_SPACING_MS - gap));
  }
  lastStart = Date.now();
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

function parseStamp(ts) {
  const s = String(ts);
  if (s.length < 8) return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Archived web history for a domain.
 * Returns first-seen date, distinct months captured, and a status reflecting
 * how much independent evidence of existence there is.
 */
export async function checkHistory(domain) {
  const url = `${CDX}?url=${encodeURIComponent(domain)}&output=json&fl=timestamp` +
    `&collapse=timestamp:6&limit=${MAX_ROWS}&filter=statuscode:200`;

  // The CDX API is slow — it routinely takes 15-25s for a domain with a long
  // history, which is precisely the case we most want to capture. A short
  // timeout here silently converts "well-established store" into `unknown`.
  let rows;
  let lastErr = null;
  await acquire();
  try {
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      // Back off between attempts — a throttled archive needs time, not a
      // faster retry.
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const res = await fetchWithTimeout(url, {}, 30000);
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        rows = await res.json();
      } catch (err) {
        lastErr = err.message;
      }
    }
  } finally {
    release();
  }
  if (!rows) {
    return {
      status: 'unknown',
      value: null,
      detail: `Web archive lookup failed: ${lastErr}`,
    };
  }

  // First row is the header (["timestamp"]); an empty result means no captures.
  const stamps = Array.isArray(rows) ? rows.slice(1).map((r) => r[0]) : [];
  if (stamps.length === 0) {
    // No archive record is a real finding for a store asking for card details,
    // but the Archive's coverage is uneven enough that it can't be a `fail`.
    return {
      status: 'warn',
      value: { firstSeen: null, monthsSeen: 0, yearsSeen: 0 },
      detail: 'No independent web-archive history found for this domain.',
    };
  }

  const first = parseStamp(stamps[0]);
  const last = parseStamp(stamps[stamps.length - 1]);
  const monthsSeen = stamps.length;
  const yearsSeen = first
    ? +((Date.now() - first.getTime()) / (365 * 86_400_000)).toFixed(1)
    : 0;

  const value = {
    firstSeen: first ? first.toISOString().slice(0, 10) : null,
    lastSeen: last ? last.toISOString().slice(0, 10) : null,
    monthsSeen,
    yearsSeen,
    // True when MAX_ROWS was hit — the real count is higher than reported.
    truncated: stamps.length >= MAX_ROWS,
  };

  const seenLabel = value.truncated ? `${monthsSeen}+` : `${monthsSeen}`;

  // A long, well-covered history is meaningful corroboration. A single-month
  // or very recent archive is thin — flagged, but never called proof.
  if (yearsSeen >= 2 && monthsSeen >= 6) {
    return {
      status: 'pass',
      value,
      detail: `Independently archived since ${value.firstSeen} — captured in ${seenLabel} separate months.`,
    };
  }

  if (yearsSeen < 1 || monthsSeen <= 2) {
    return {
      status: 'warn',
      value,
      detail: `Little independent web history — first archived ${value.firstSeen}, captured in only ${seenLabel} month(s).`,
    };
  }

  return {
    status: 'warn',
    value,
    detail: `Some web history — first archived ${value.firstSeen}, captured in ${seenLabel} month(s).`,
  };
}

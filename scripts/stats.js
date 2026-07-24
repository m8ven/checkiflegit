// Dataset statistics across all store pages: coverage of each trust signal,
// domain-age distribution, platform/TLD split, verdict spread, and a few
// age/platform vs trust correlations.
//
// Read-only over src/content/stores — safe to rerun as the corpus grows.
//
// Usage: node scripts/stats.js            → writes data/stats.json, prints summary
//        node scripts/stats.js --json     → prints the full JSON report to stdout
//        node scripts/stats.js --out=path → write the report elsewhere
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');

const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '').slice(6) || path.join(ROOT, 'data', 'stats.json');

const files = readdirSync(STORES_DIR).filter((f) => f.endsWith('.md'));

const all = [];
for (const f of files) {
  try {
    const { data } = matter(readFileSync(path.join(STORES_DIR, f), 'utf8'));
    all.push(data);
  } catch (e) {
    console.error('PARSE FAIL', f, e.message);
  }
}

// Headline counts are over indexable (reachable, non-noindex) pages.
const stores = all.filter((s) => !s.noindex);
const N = stores.length;
if (!N) {
  console.error(`No indexable stores found in ${STORES_DIR}`);
  process.exit(1);
}

const pct = (n) => +((n / N) * 100).toFixed(2);
const rate = (n, d) => (d ? +((n / d) * 100).toFixed(2) : null);
const sig = (s, k) => s.signals?.[k] ?? null;
const val = (s, k) => sig(s, k)?.value ?? null;
const status = (s, k) => sig(s, k)?.status ?? 'missing';

const out = {};
out.generatedAt = new Date().toISOString();
out.counts = {
  filesOnDisk: all.length,
  indexable: N,
  noindexExcluded: all.length - N,
};

// ---------- 1. Contact page ----------
{
  const pv = stores.map((s) => val(s, 'pages'));
  const known = pv.filter((v) => v && typeof v.contact === 'boolean');
  const missing = known.filter((v) => v.contact === false).length;
  out.contactPage = {
    measured: known.length,
    unmeasured: N - known.length,
    missing,
    present: known.length - missing,
    pctMissingOfAll: pct(missing),
    pctMissingOfMeasured: rate(missing, known.length),
  };
}

// ---------- 2. Policy pages ----------
{
  const TYPES = ['privacy', 'terms', 'refund', 'shipping'];
  const perType = {};
  for (const t of TYPES) {
    const known = stores.filter((s) => typeof val(s, 'pages')?.[t] === 'boolean');
    const missing = known.filter((s) => val(s, 'pages')[t] === false).length;
    perType[t] = {
      measured: known.length,
      missing,
      pctMissing: rate(missing, known.length),
    };
  }
  const known = stores.filter((s) => val(s, 'pages'));
  const missingAll = known.filter((s) => TYPES.every((t) => val(s, 'pages')[t] === false)).length;
  const missingAny = known.filter((s) => TYPES.some((t) => val(s, 'pages')[t] === false)).length;
  const coreThree = ['privacy', 'terms', 'refund'];
  const missingAllCore = known.filter((s) => coreThree.every((t) => val(s, 'pages')[t] === false)).length;
  const missingAnyCore = known.filter((s) => coreThree.some((t) => val(s, 'pages')[t] === false)).length;

  // Distribution of how many of the 4 policy pages each store has.
  const dist = {};
  for (const s of known) {
    const n = TYPES.filter((t) => val(s, 'pages')[t] === true).length;
    dist[n] = (dist[n] ?? 0) + 1;
  }
  out.policyPages = {
    measured: known.length,
    perType,
    missingAllFour: { n: missingAll, pct: rate(missingAll, known.length) },
    missingAnyOfFour: { n: missingAny, pct: rate(missingAny, known.length) },
    missingAllCoreThree: { n: missingAllCore, pct: rate(missingAllCore, known.length) },
    missingAnyCoreThree: { n: missingAnyCore, pct: rate(missingAnyCore, known.length) },
    countHeldDistribution: dist,
  };
}

// ---------- 3. Third-party reviews ----------
{
  const tally = {};
  for (const s of stores) {
    const v = val(s, 'reviews');
    const key = `trustpilot=${v?.trustpilot ?? 'absent'}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  const st = {};
  for (const s of stores) {
    const k = status(s, 'reviews');
    st[k] = (st[k] ?? 0) + 1;
  }
  out.reviews = { trustpilotValueTally: tally, signalStatusTally: st };
}

// ---------- 4. Domain age ----------
{
  const withAge = stores.filter((s) => typeof val(s, 'domainAge')?.ageDays === 'number');
  const days = withAge.map((s) => val(s, 'domainAge').ageDays);
  const u6 = days.filter((d) => d < 182).length;
  const u12 = days.filter((d) => d < 365).length;
  const u24 = days.filter((d) => d < 730).length;
  const sorted = [...days].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  out.domainAge = {
    measured: withAge.length,
    unknown: N - withAge.length,
    pctUnknown: pct(N - withAge.length),
    under6mo: { n: u6, pctOfMeasured: rate(u6, withAge.length), pctOfAll: pct(u6) },
    under1yr: { n: u12, pctOfMeasured: rate(u12, withAge.length), pctOfAll: pct(u12) },
    under2yr: { n: u24, pctOfMeasured: rate(u24, withAge.length), pctOfAll: pct(u24) },
    medianAgeYears: median != null ? +(median / 365.25).toFixed(1) : null,
  };
}

// ---------- 5. Social presence ----------
const PLATS = ['facebook', 'instagram', 'twitter', 'tiktok', 'youtube', 'linkedin', 'pinterest'];
{
  const known = stores.filter((s) => val(s, 'social'));
  const none = known.filter((s) => PLATS.every((p) => val(s, 'social')[p] !== true)).length;
  const perPlat = {};
  for (const p of PLATS) {
    const n = known.filter((s) => val(s, 'social')[p] === true).length;
    perPlat[p] = { present: n, pct: rate(n, known.length) };
  }
  out.social = {
    measured: known.length,
    noneFound: none,
    pctNone: rate(none, known.length),
    perPlatformPresent: perPlat,
  };
}

// ---------- 6. Verdict distribution ----------
{
  const tiers = {};
  for (const s of stores) {
    const t = s.verdict?.tier ?? 'missing';
    tiers[t] = (tiers[t] ?? 0) + 1;
  }
  const scores = stores.map((s) => s.verdict?.score).filter((x) => typeof x === 'number');
  const srt = [...scores].sort((a, b) => a - b);
  out.verdict = {
    tiers: Object.fromEntries(
      Object.entries(tiers).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { n: v, pct: pct(v) }])
    ),
    meanScore: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null,
    medianScore: scores.length ? srt[Math.floor(srt.length / 2)] : null,
  };
}

// ---------- 7. Platform split ----------
{
  const p = {};
  for (const s of stores) {
    const name = val(s, 'platform')?.platform ?? 'Undetected';
    p[name] = (p[name] ?? 0) + 1;
  }
  out.platform = Object.fromEntries(
    Object.entries(p).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { n: v, pct: pct(v) }])
  );
}

// ---------- 8. TLD distribution ----------
{
  // Treat known two-level suffixes as one TLD (co.uk, com.au, co.nz …).
  const TWO_LEVEL = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
  const t = {};
  for (const s of stores) {
    const parts = String(s.domain).split('.');
    const last2 = parts.slice(-2).join('.');
    const key = TWO_LEVEL.test(last2) ? last2 : parts.at(-1);
    t[key] = (t[key] ?? 0) + 1;
  }
  out.tld = {
    distinct: Object.keys(t).length,
    top15: Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([k, v]) => ({ tld: '.' + k, n: v, pct: pct(v) })),
  };
}

// ---------- 9. Most commonly missing trust signal ----------
{
  // Count a signal as "absent" only when it was actually MEASURED and came back
  // negative — otherwise unfetchable sites inflate every miss rate.
  const absent = {};
  const measured = {};
  const bump = (k, isAbsent, wasMeasured) => {
    if (wasMeasured) measured[k] = (measured[k] ?? 0) + 1;
    if (wasMeasured && isAbsent) absent[k] = (absent[k] ?? 0) + 1;
  };
  for (const s of stores) {
    const pg = val(s, 'pages'), ct = val(s, 'contact'), so = val(s, 'social');
    bump('Contact page', pg?.contact === false, !!pg);
    bump('Privacy policy', pg?.privacy === false, !!pg);
    bump('Terms of service', pg?.terms === false, !!pg);
    bump('Returns/refund policy', pg?.refund === false, !!pg);
    bump('Shipping policy', pg?.shipping === false, !!pg);
    bump('Public email address', ct?.email === false, !!ct);
    bump('Public phone number', ct?.phone === false, !!ct);
    bump('Physical address', ct?.address === false, !!ct);
    bump('Any social media', so ? PLATS.every((p) => so[p] !== true) : false, !!so);
    bump('Valid SSL', status(s, 'ssl') === 'fail', status(s, 'ssl') !== 'unknown');
  }
  out.missingSignals = Object.entries(absent)
    .map(([k, v]) => ({ signal: k, missing: v, measured: measured[k], pctMissing: rate(v, measured[k]) }))
    .sort((a, b) => b.pctMissing - a.pctMissing);
}

// ---------- 9b. Per-platform signal detail ----------
// Powers /research/shopify-vs-woocommerce. Kept here rather than computed in
// the page so the weekly refetch refreshes the study for free.
{
  const P = {};
  for (const s of stores) {
    const name = val(s, 'platform')?.platform ?? 'Undetected';
    P[name] ??= { n: 0, privacy: 0, terms: 0, refund: 0, shipping: 0, contactPage: 0,
                  noSocial: 0, ages: [], ssl: 0, sslN: 0, email: 0, phone: 0, contactN: 0, scores: [] };
    const b = P[name];
    b.n++;
    const pg = val(s, 'pages') || {};
    for (const k of ['privacy', 'terms', 'refund', 'shipping']) if (pg[k] === true) b[k]++;
    if (pg.contact === true) b.contactPage++;
    const so = val(s, 'social');
    if (so && PLATS.every((p) => so[p] !== true)) b.noSocial++;
    const days = val(s, 'domainAge')?.ageDays;
    if (typeof days === 'number') b.ages.push(days);
    const sslStatus = status(s, 'ssl');
    if (sslStatus !== 'unknown' && sslStatus !== 'missing') { b.sslN++; if (sslStatus === 'pass') b.ssl++; }
    const c = val(s, 'contact');
    if (c) { b.contactN++; if (c.email) b.email++; if (c.phone) b.phone++; }
    if (typeof s.verdict?.score === 'number') b.scores.push(s.verdict.score);
  }
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  out.platformDetail = Object.entries(P)
    .filter(([, b]) => b.n >= 50)   // below this the percentages are noise
    .sort((a, b) => b[1].n - a[1].n)
    .map(([platform, b]) => ({
      platform,
      n: b.n,
      pctPrivacy: rate(b.privacy, b.n),
      pctTerms: rate(b.terms, b.n),
      pctRefund: rate(b.refund, b.n),
      pctShipping: rate(b.shipping, b.n),
      pctContactPage: rate(b.contactPage, b.n),
      pctNoSocial: rate(b.noSocial, b.n),
      medianAgeYears: median(b.ages) != null ? +(median(b.ages) / 365.25).toFixed(1) : null,
      pctSslValid: rate(b.ssl, b.sslN),
      pctEmail: rate(b.email, b.contactN),
      pctPhone: rate(b.phone, b.contactN),
      meanScore: b.scores.length ? +(b.scores.reduce((x, y) => x + y, 0) / b.scores.length).toFixed(1) : null,
    }));
}

// ---------- 10. Correlations ----------
{
  const CORE = ['privacy', 'terms', 'refund'];
  const withAge = stores.filter(
    (s) => typeof val(s, 'domainAge')?.ageDays === 'number' && val(s, 'pages')
  );
  const buckets = [
    ['<6 months', (d) => d < 182],
    ['6–12 months', (d) => d >= 182 && d < 365],
    ['1–2 years', (d) => d >= 365 && d < 730],
    ['2–5 years', (d) => d >= 730 && d < 1826],
    ['5–10 years', (d) => d >= 1826 && d < 3653],
    ['10+ years', (d) => d >= 3653],
  ];
  const rows = [];
  for (const [label, fn] of buckets) {
    const g = withAge.filter((s) => fn(val(s, 'domainAge').ageDays));
    if (!g.length) { rows.push({ bucket: label, n: 0 }); continue; }
    const noPolicy = g.filter((s) => CORE.every((t) => val(s, 'pages')[t] === false)).length;
    const noContact = g.filter((s) => val(s, 'pages').contact === false).length;
    const noSocial = g.filter((s) => {
      const so = val(s, 'social');
      return so && PLATS.every((p) => so[p] !== true);
    }).length;
    const avgPolicies = g.reduce(
      (a, s) => a + ['privacy', 'terms', 'refund', 'shipping'].filter((t) => val(s, 'pages')[t] === true).length, 0
    ) / g.length;
    const scores = g.map((s) => s.verdict?.score).filter((x) => typeof x === 'number');
    rows.push({
      bucket: label,
      n: g.length,
      pctNoCorePolicy: +((noPolicy / g.length) * 100).toFixed(1),
      pctNoContactPage: +((noContact / g.length) * 100).toFixed(1),
      pctNoSocial: +((noSocial / g.length) * 100).toFixed(1),
      avgPolicyPagesOf4: +avgPolicies.toFixed(2),
      meanScore: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null,
    });
  }
  out.correlationAgeVsTrust = rows;

  // Platform vs policy completeness (platforms with a usable sample only).
  const byPlat = {};
  for (const s of stores) {
    const pg = val(s, 'pages'); if (!pg) continue;
    const name = val(s, 'platform')?.platform ?? 'Undetected';
    byPlat[name] ??= { n: 0, policies: 0, noContact: 0, scoreSum: 0, scoreN: 0 };
    const b = byPlat[name];
    b.n++;
    b.policies += ['privacy', 'terms', 'refund', 'shipping'].filter((t) => pg[t] === true).length;
    if (pg.contact === false) b.noContact++;
    if (typeof s.verdict?.score === 'number') { b.scoreSum += s.verdict.score; b.scoreN++; }
  }
  out.correlationPlatformVsTrust = Object.entries(byPlat)
    .filter(([, b]) => b.n >= 50)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, b]) => ({
      platform: k, n: b.n,
      avgPolicyPagesOf4: +(b.policies / b.n).toFixed(2),
      pctNoContactPage: +((b.noContact / b.n) * 100).toFixed(1),
      meanScore: b.scoreN ? +(b.scoreSum / b.scoreN).toFixed(1) : null,
    }));

  // Pearson r between domain age (days) and verdict score.
  const pairs = stores
    .filter((s) => typeof val(s, 'domainAge')?.ageDays === 'number' && typeof s.verdict?.score === 'number')
    .map((s) => [val(s, 'domainAge').ageDays, s.verdict.score]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  if (pairs.length > 1) {
    const mx = mean(xs), my = mean(ys);
    const cov = pairs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
    const sx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const sy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
    out.correlationAgeScorePearson = { n: pairs.length, r: sx && sy ? +(cov / (sx * sy)).toFixed(3) : null };
  } else {
    out.correlationAgeScorePearson = { n: pairs.length, r: null };
  }
}

if (JSON_ONLY) {
  console.log(JSON.stringify(out, null, 2));
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const top = out.missingSignals[0];
  console.log(`${out.counts.indexable} indexable stores (${out.counts.filesOnDisk} files, ${out.counts.noindexExcluded} noindex)`);
  console.log(`verdict tiers    : ${Object.entries(out.verdict.tiers).map(([k, v]) => `${k} ${v.pct}%`).join('  ')}`);
  console.log(`mean score       : ${out.verdict.meanScore}   median ${out.verdict.medianScore}`);
  console.log(`domain age known : ${out.domainAge.measured} (${(100 - out.domainAge.pctUnknown).toFixed(1)}%)  median ${out.domainAge.medianAgeYears}y  under 1yr ${out.domainAge.under1yr.pctOfMeasured}%`);
  console.log(`no contact page  : ${out.contactPage.pctMissingOfMeasured}% of ${out.contactPage.measured} measured`);
  console.log(`no social at all : ${out.social.pctNone}% of ${out.social.measured} measured`);
  console.log(`top platform     : ${Object.entries(out.platform)[0][0]} ${Object.entries(out.platform)[0][1].pct}%`);
  console.log(`most-missed sig  : ${top.signal} ${top.pctMissing}% of ${top.measured}`);
  console.log(`age↔score r      : ${out.correlationAgeScorePearson.r} (n=${out.correlationAgeScorePearson.n})`);
  console.log(`\nfull report → ${path.relative(ROOT, OUT)}`);
}

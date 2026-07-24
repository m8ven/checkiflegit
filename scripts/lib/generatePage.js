import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';
import { domainToSlug } from './util.js';
import { scoreVerdict } from './score.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');

function titleCaseDomain(domain) {
  const name = domain.replace(/\.[a-z.]+$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Human phrasing for a signal as a *strength* and as a *concern*. Used to
// synthesize a genuine takeaway rather than re-listing the signal breakdown.
const STRENGTH = {
  platform: (s) => (s.value?.platform ? `it runs on ${s.value.platform}, an established e-commerce platform` : `it has a working storefront with cart and checkout`),
  domainAge: (s) => `its domain has been registered for ${s.value?.ageYears ?? 'several'} years`,
  ssl: () => `it secures traffic with a valid HTTPS certificate`,
  pages: () => `it publishes the contact and policy pages shoppers expect`,
  contact: () => `it lists genuine business contact details`,
  reviews: () => `it has an independent review presence on Trustpilot`,
  social: () => `it maintains active social media profiles`,
};
const CONCERN = {
  domainAge: (s) => (s.status === 'fail' ? `the domain was only registered very recently` : `the domain is still relatively young`),
  ssl: (s) => (s.status === 'fail' ? `it does not present a valid security certificate` : `its security certificate is not fully trusted`),
  pages: (s) => (s.status === 'fail' ? `we could not find the usual contact and policy pages` : `some standard contact or policy pages appear to be missing`),
  contact: (s) => (s.status === 'fail' ? `there are no clear public contact details` : `only limited contact details are listed`),
  reviews: () => `it has no third-party review presence we could find`,
  social: (s) => (s.status === 'fail' ? `it has little or no social media footprint` : `its social media presence is limited`),
  platform: () => `we could not confirm a standard storefront setup`,
};
// Order signals by how much weight a shopper reasonably gives them.
const PRIORITY = ['domainAge', 'reviews', 'contact', 'pages', 'ssl', 'platform', 'social'];

function joinPhrases(arr) {
  if (arr.length <= 1) return arr[0] || '';
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

/** A synthesized, plain-language takeaway (not a re-list of the signal rows). */
function buildBody(domain, verdict, signals) {
  const name = titleCaseDomain(domain);
  const strengths = PRIORITY.filter((k) => signals[k]?.status === 'pass' && STRENGTH[k]).map((k) => STRENGTH[k](signals[k]));
  const concerns = PRIORITY.filter((k) => ['fail', 'warn'].includes(signals[k]?.status) && CONCERN[k]).map((k) => CONCERN[k](signals[k]));
  const topStrengths = strengths.slice(0, 2);
  const topConcerns = concerns.slice(0, 2);

  const paras = [];
  if (verdict.tier === 'strong') {
    let p = `${domain} looks like a well-established store.`;
    if (topStrengths.length) p += ` The clearest positives are that ${joinPhrases(topStrengths)}.`;
    if (topConcerns.length) p += ` The main thing we would flag is that ${joinPhrases(topConcerns)}, though it does not outweigh the positives.`;
    p += ` On balance the public signals here are reassuring — shop with the same common-sense caution you would use anywhere online.`;
    paras.push(p);
  } else if (verdict.tier === 'moderate') {
    let p = `${domain} sends a mixed set of signals.`;
    if (topStrengths.length) p += ` On the positive side, ${joinPhrases(topStrengths)}.`;
    if (topConcerns.length) p += ` Against that, ${joinPhrases(topConcerns)} — worth weighing before you buy.`;
    p += ` It is not a clear red flag, but we would treat a first purchase with measured caution and use a payment method that offers buyer protection.`;
    paras.push(p);
  } else {
    let p = `We found limited public trust signals for ${domain}.`;
    if (topConcerns.length) p += ` In particular, ${joinPhrases(topConcerns)}.`;
    if (topStrengths.length) p += ` It does have some positives — ${joinPhrases(topStrengths)} — but that alone is not much to go on.`;
    p += ` This does not mean the store is fraudulent, but we would be cautious: research it further and avoid paying by methods without recourse.`;
    paras.push(p);
  }

  if (PRIORITY.some((k) => signals[k]?.status === 'unknown')) {
    paras.push(`A few checks were inconclusive when we looked, so they count neither for nor against ${name} in the score above.`);
  }
  paras.push(`This assessment is generated automatically from publicly available information at the time of checking and is not a definitive judgement of the business. Always do your own research before buying.`);
  return paras.join('\n\n');
}

// ---------------------------------------------------------------------------
// SERP snippet builders.
//
// These decide what a searcher sees in Google, so they are the site's main
// click-through lever. Every page used to share one title template and one of
// three descriptions, which made 10.5k results indistinguishable in the SERP.
// Both now carry the store's own score and findings.
//
// Exported because scripts/retitle.js rewrites already-generated pages with
// them — the two must never drift apart.
// ---------------------------------------------------------------------------

// Measured language only, per the hard rule in score.js: no "scam"/"warning".
const TIER_SUFFIX = {
  strong: 'Trust Checks Pass',
  moderate: 'Mixed Signals',
  limited: 'Proceed With Caution',
};
const TITLE_MAX = 60;   // ~Google's title truncation point
const DESC_MAX = 158;   // ~Google's description truncation point

// The platform flag is true of 91% of the corpus, so it differentiates nothing
// in a snippet. Sort it behind findings that actually vary between stores.
const GENERIC_FLAG = /^(Built on |Recognisable storefront)/;

export function buildTitle(domain, verdict) {
  const base = `Is ${domain} Legit?`;
  if (verdict.score == null) return `${base} Trust Signal Check`;
  const withScore = `${base} Trust Score ${verdict.score}/100`;
  const suffix = TIER_SUFFIX[verdict.tier];
  const full = suffix ? `${withScore} — ${suffix}` : withScore;
  if (full.length <= TITLE_MAX) return full;
  if (withScore.length <= TITLE_MAX) return withScore;
  return `${base} Score ${verdict.score}/100`;
}

export function buildDescription(domain, verdict) {
  if (verdict.score == null) {
    return `We could not gather enough public information to assess ${domain}. See which trust checks were inconclusive and why.`;
  }
  // Strong stores lead with what they got right; everyone else leads with the
  // concern, because that is what the searcher is actually asking about.
  const findings = (verdict.tier === 'strong'
    ? [...verdict.greenFlags, ...verdict.cautions]
    : [...verdict.redFlags, ...verdict.cautions, ...verdict.greenFlags]
  ).slice();
  findings.sort((a, b) => (GENERIC_FLAG.test(a) ? 1 : 0) - (GENERIC_FLAG.test(b) ? 1 : 0));

  let out = `${domain} scores ${verdict.score}/100 on our public trust checks.`;
  for (const flag of findings) {
    const next = `${out} ${String(flag).trim().replace(/\s+/g, ' ')}`;
    if (next.length > DESC_MAX) break;
    out = next;
  }
  return out;
}

/**
 * Turn a fetched-signals object into an MDX file on disk.
 * Unreachable domains are written with `noindex: true` and an `_` slug prefix so
 * they are excluded from the sitemap and search indexing (hard rule).
 */
export async function generatePage(result) {
  const { domain, reachable, signals, fetchedAt, finalUrl } = result;
  const verdict = reachable
    ? scoreVerdict(signals)
    : {
        tier: 'unreachable',
        label: 'Store unreachable',
        summary:
          'This website did not load when we checked it. We cannot assess a store we cannot reach, so this page is not indexed.',
        score: null,
        greenFlags: [],
        redFlags: ['The website did not respond.'],
        cautions: [],
      };

  const noindex = !reachable;
  const slug = (noindex ? '_' : '') + domainToSlug(domain);

  const frontmatter = {
    domain,
    slug,
    title: buildTitle(domain, verdict),
    description: reachable
      ? buildDescription(domain, verdict)
      : `${domain} did not load when we checked it.`,
    fetchedAt,
    finalUrl: finalUrl || null,
    reachable,
    noindex,
    verdict,
    signals,
  };

  const body = reachable ? buildBody(domain, verdict, signals) : verdict.summary;
  const file = matter.stringify(`\n${body}\n`, frontmatter);

  await mkdir(STORES_DIR, { recursive: true });
  const outPath = path.join(STORES_DIR, `${slug}.md`);
  await writeFile(outPath, file, 'utf8');
  return { outPath, slug, noindex, verdict };
}

// Verdict logic. Derives a measured trust assessment purely from fetched signals.
//
// HARD RULES enforced here:
//  - No definitive "SCAM" labels. Tiers use measured language only.
//  - `unknown` signals never count against a store; they are excluded from the
//    denominator so a missing signal can't be silently treated as a failure.

// Per-signal weight + human-readable flag text.
const SIGNALS = {
  // Informational only (weight 0): being on a known platform isn't proof of
  // legitimacy, so it surfaces as a green flag but does not move the score.
  platform: {
    weight: 0,
    pass: (v) => (v?.platform ? `Built on ${v.platform}, an established e-commerce platform.` : 'Recognisable storefront features (cart/checkout).'),
    warn: () => 'Limited storefront features detected.',
    fail: () => 'No e-commerce storefront features detected.',
  },
  domainAge: {
    weight: 3,
    pass: (v) => `Established domain — registered ${v?.ageYears ?? '1+'} years ago.`,
    warn: () => 'Domain is relatively young.',
    fail: (v) => `Domain registered very recently${v?.ageDays != null ? ` (${v.ageDays} days ago)` : ''}.`,
  },
  ssl: {
    weight: 2,
    pass: () => 'Valid HTTPS/SSL certificate in place.',
    warn: () => 'HTTPS certificate present but its trust chain is incomplete.',
    fail: () => 'No valid SSL certificate — connection may not be secure.',
  },
  pages: {
    weight: 2,
    pass: () => 'Has a contact page and multiple policy pages (privacy/terms/refund).',
    warn: () => 'Some standard policy or contact pages appear to be missing.',
    fail: () => 'Standard contact and policy pages were not found.',
  },
  contact: {
    weight: 2,
    pass: () => 'Public business contact details are listed.',
    warn: () => 'Only limited contact details were found.',
    fail: () => 'No public contact details detected on the homepage.',
  },
  reviews: {
    weight: 2,
    pass: () => 'Has a presence on Trustpilot.',
    warn: () => 'No Trustpilot listing was found.',
    fail: () => 'No third-party review presence detected.',
  },
  social: {
    weight: 1,
    pass: () => 'Maintains links to multiple social media platforms.',
    warn: () => 'Limited social media presence.',
    fail: () => 'No links to major social platforms found.',
  },
  // Independent evidence the site has existed and been visible over time.
  // Weighted like domain age because it measures the same underlying thing,
  // and covers the ~28% of domains whose registry publishes no creation date.
  history: {
    weight: 3,
    pass: (v) => `Independently archived on the web since ${v?.firstSeen ?? 'well before now'}.`,
    warn: (v) => (v?.monthsSeen === 0
      ? 'No independent web-archive record of this domain.'
      : 'Only a short independent web history.'),
    fail: () => 'No independent record of this site existing.',
  },
  // Only mail capability is scored; hosting and network are context. See infra.js.
  infra: {
    weight: 1,
    pass: () => 'Standard hosting and mail records are in place.',
    warn: () => 'The domain has no mail records, so it cannot receive email.',
    fail: () => 'Core DNS records are missing.',
  },
};

const SCORE_BY_STATUS = { pass: 1, warn: 0.4, fail: -0.5, unknown: null };

export function scoreVerdict(signals) {
  let total = 0;
  let max = 0;
  const greenFlags = [];
  const redFlags = [];
  const cautions = [];

  for (const [key, cfg] of Object.entries(SIGNALS)) {
    const sig = signals[key];
    if (!sig) continue;
    const factor = SCORE_BY_STATUS[sig.status];
    if (factor === null || factor === undefined) continue; // unknown → excluded

    total += factor * cfg.weight;
    max += cfg.weight;

    if (sig.status === 'pass') greenFlags.push(cfg.pass(sig.value));
    else if (sig.status === 'warn') cautions.push(cfg.warn(sig.value));
    else if (sig.status === 'fail') redFlags.push(cfg.fail(sig.value));
  }

  // Normalize to 0–100. With no scorable signals, score is null (unknown).
  const ratio = max > 0 ? Math.max(0, total / max) : null;
  let score = ratio === null ? null : Math.round(ratio * 100);

  let tier, label, summary;
  if (ratio === null) {
    tier = 'unknown';
    label = 'Not enough signals';
    summary =
      'We could not gather enough public information to assess this store. Treat the absence of data as a reason for extra caution.';
  } else if (ratio >= 0.7) {
    tier = 'strong';
    label = 'Strong trust signals';
    summary =
      'This store shows several positive public trust signals. As always, use secure payment methods when shopping online.';
  } else if (ratio >= 0.45) {
    tier = 'moderate';
    label = 'Moderate trust signals';
    summary =
      'This store shows a mix of trust signals. Some positive indicators are present, but a few are missing — review the breakdown below before buying.';
  } else {
    tier = 'limited';
    label = 'Limited trust signals — proceed with caution';
    summary =
      'This store shows limited public trust signals. That does not necessarily mean it is fraudulent, but we recommend extra caution and using buyer-protected payment methods.';
  }

  // `thin_footprint` (detection brief §2): corroboration is three-state, not
  // two. When the ONLY source of information about a business is the business
  // itself — nothing archived it, no third-party reviews, no social presence —
  // that is a distinct and reportable finding, not a data gap. Scoring systems
  // that treat absence as neutral let a brand-new storefront with a polished
  // site sit mid-scale purely by having no history.
  const noArchive = signals.history?.status !== 'unknown' &&
    (signals.history?.value?.monthsSeen ?? 0) === 0;
  const noReviews = signals.reviews?.status !== 'pass';
  const noSocial = signals.social?.status === 'fail';
  if (noArchive && noReviews && noSocial && tier !== 'unknown') {
    tier = 'thin';
    label = 'No independent footprint — proceed with caution';
    summary =
      'Everything we could find about this store comes from the store itself. Nothing has archived it, we found no third-party review presence, and it links to no social accounts. That is not proof of anything wrong, but it means there is no outside record to check it against — treat it as unverified and use payment methods with buyer protection.';
    redFlags.push('No independent record of this business exists outside its own website.');
  }

  // Code-level deception is handled outside the weighted average deliberately.
  // The other signals measure what a store publishes, which is cheap to fake;
  // this one measures what its code does, which had to be built to work. A
  // store can hold a valid certificate, full policy pages and a phone number
  // and still generate its "12 people are viewing this" from Math.random() —
  // averaging that away would let the easy signals outvote the hard evidence.
  const deception = signals.deception;
  const findings = deception?.value?.findings ?? [];
  if (findings.length > 0) {
    const high = findings.filter((f) => f.severity === 'high');
    // Each finding carries its own source line, so the flag states a fact about
    // the code rather than an accusation about the business — which keeps the
    // no-SCAM-labels rule intact while still being a real warning.
    for (const f of findings) (f.severity === 'high' ? redFlags : cautions).push(f.label);

    if (high.length > 0 && tier !== 'unknown') {
      tier = 'limited';
      // The numeric score is rendered in the page title next to the label, so
      // it has to move with the tier — "Trust Score 100/100 — Deceptive
      // interface code found" would read as a contradiction. Pull it into the
      // limited band (<45) rather than zeroing it: the other signals were
      // genuinely measured and did pass.
      if (score !== null) score = Math.min(score, 40);
      label = 'Deceptive interface code found — proceed with caution';
      summary =
        'Regardless of its other signals, this store serves code that manufactures social proof or scarcity — purchase notices, stock counts or viewer counts generated in your browser rather than from real activity. The exact code is quoted below. Treat urgency messaging on this site as marketing, not fact.';
    }
  } else if (deception?.status === 'pass') {
    greenFlags.push('No fabricated urgency or social-proof code found in the pages this store serves.');
  }

  return { tier, label, summary, score, greenFlags, redFlags, cautions };
}

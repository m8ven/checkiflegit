// Verdict logic. Derives a measured trust assessment purely from fetched signals.
//
// HARD RULES enforced here:
//  - No definitive "SCAM" labels. Tiers use measured language only.
//  - `unknown` signals never count against a store; they are excluded from the
//    denominator so a missing signal can't be silently treated as a failure.

// Per-signal weight + human-readable flag text.
const SIGNALS = {
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
  const score = ratio === null ? null : Math.round(ratio * 100);

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

  return { tier, label, summary, score, greenFlags, redFlags, cautions };
}

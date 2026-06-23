// Social presence: detect outbound links to major platforms in homepage HTML.
// Presence check only — no profile scraping.

const PLATFORMS = {
  facebook: /facebook\.com\/[a-z0-9.\-/]+/i,
  instagram: /instagram\.com\/[a-z0-9._\-/]+/i,
  twitter: /(?:twitter|x)\.com\/[a-z0-9_\-/]+/i,
  tiktok: /tiktok\.com\/@?[a-z0-9._\-/]+/i,
  youtube: /youtube\.com\/(channel|user|c|@)[a-z0-9._\-/]+/i,
  linkedin: /linkedin\.com\/(company|in)\/[a-z0-9._\-/]+/i,
  pinterest: /pinterest\.[a-z.]+\/[a-z0-9._\-/]+/i,
};

// Generic share/intent links shouldn't count as "having a presence".
const NOISE = /sharer|intent\/tweet|share\.php|\/share\?/i;

export function checkSocial(html) {
  if (!html) {
    return { status: 'unknown', value: {}, detail: 'No page content to inspect.' };
  }
  const found = {};
  for (const [name, re] of Object.entries(PLATFORMS)) {
    const m = html.match(re);
    found[name] = Boolean(m) && !NOISE.test(m[0]);
  }
  const platforms = Object.keys(found).filter((k) => found[k]);
  let status = 'fail';
  if (platforms.length >= 2) status = 'pass';
  else if (platforms.length === 1) status = 'warn';

  return {
    status,
    value: found,
    detail: platforms.length
      ? `Links to ${platforms.length} social platform(s): ${platforms.join(', ')}.`
      : 'No links to major social platforms found.',
  };
}

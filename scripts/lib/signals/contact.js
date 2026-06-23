// Detect business contact info (email / phone / address) from homepage HTML.
// Presence checks only — we do not store or republish the contact details.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// E.164-ish / common formats with at least 7 digits.
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;
const TEL_RE = /href=["']tel:/i;
const ADDRESS_RE =
  /\b\d{1,6}\s+[\w.\s]{2,40}\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|suite|ste|floor|unit)\b/i;

function stripScripts(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

export function checkContactInfo(html) {
  if (!html) {
    return { status: 'unknown', value: {}, detail: 'No page content to inspect.' };
  }
  const cleaned = stripScripts(html);
  // Email: prefer explicit mailto:, fall back to a plausible address in body text.
  const hasMailto = /href=["']mailto:/i.test(html);
  const hasEmail = hasMailto || EMAIL_RE.test(cleaned);
  const hasPhone = TEL_RE.test(html) || PHONE_RE.test(cleaned.replace(/<[^>]+>/g, ' '));
  const hasAddress = ADDRESS_RE.test(cleaned.replace(/<[^>]+>/g, ' '));

  const count = [hasEmail, hasPhone, hasAddress].filter(Boolean).length;
  let status = 'fail';
  if (count >= 2) status = 'pass';
  else if (count === 1) status = 'warn';

  const present = [
    hasEmail && 'email',
    hasPhone && 'phone',
    hasAddress && 'address',
  ].filter(Boolean);

  return {
    status,
    value: { email: hasEmail, phone: hasPhone, address: hasAddress },
    detail: present.length
      ? `Public contact details found: ${present.join(', ')}.`
      : 'No public contact details detected on the homepage.',
  };
}

// Shared helpers for signal fetching.

const UA =
  'Mozilla/5.0 (compatible; CheckIfLegitBot/0.1; +https://checkiflegit.com/about)';

/**
 * Normalize a user/seed-provided domain to a bare hostname.
 * "https://www.Example.com/path" -> "example.com"
 */
export function normalizeDomain(input) {
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/\/.*$/, '');
  d = d.replace(/^www\./, '');
  d = d.replace(/:.*$/, ''); // strip port
  return d;
}

/** Slug used for the page path: example.com -> example-com */
export function domainToSlug(domain) {
  return normalizeDomain(domain).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** fetch() with a hard timeout. Returns the Response or throws. */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: controller.signal,
      ...opts,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Days between a date and now (floored). Negative if in the future. */
export function daysSince(date) {
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / 86_400_000);
}

export const USER_AGENT = UA;

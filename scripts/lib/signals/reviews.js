import { fetchWithTimeout } from '../util.js';

/**
 * Review footprint — PRESENCE CHECK ONLY (no review content is read or stored).
 *
 * Trustpilot: a profile page at /review/<domain> resolves (HTTP 200) when the
 * domain has a listing, and 404 when it has never been added. We check only the
 * status code. If Trustpilot rate-limits/blocks the bot we report "unknown"
 * rather than guessing.
 *
 * Google: a reliable presence check requires the paid Places API or scraping
 * search results (brittle + against guidelines), so we honestly report it as
 * "unknown" rather than fabricate a signal.
 */
export async function checkReviews(domain) {
  const result = { trustpilot: 'unknown', google: 'unknown' };
  let detail = '';

  try {
    const res = await fetchWithTimeout(
      `https://www.trustpilot.com/review/${domain}`,
      { method: 'GET' },
      10000
    );
    if (res.status === 200) {
      result.trustpilot = 'present';
      detail = 'Has a Trustpilot listing.';
    } else if (res.status === 404) {
      result.trustpilot = 'absent';
      detail = 'No Trustpilot listing found.';
    } else {
      detail = `Trustpilot presence inconclusive (HTTP ${res.status}).`;
    }
  } catch (err) {
    detail = `Trustpilot presence check failed: ${err.message}`;
  }

  // Google review presence is left explicitly unknown (see note above).
  let status = 'unknown';
  if (result.trustpilot === 'present') status = 'pass';
  else if (result.trustpilot === 'absent') status = 'warn';

  return {
    status,
    value: result,
    detail: `${detail} Google review presence not checked (no free, reliable signal).`,
  };
}

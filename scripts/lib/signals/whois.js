import whoiser from 'whoiser';
import { daysSince } from '../util.js';

// WHOIS field names vary by registry; check the common ones.
const CREATED_KEYS = [
  'Created Date',
  'Creation Date',
  'created',
  'Registered On',
  'Domain Registration Date',
  'Registration Time',
];

function pickCreationDate(data) {
  // whoiser returns a map keyed by WHOIS server; merge all candidate values.
  for (const server of Object.keys(data)) {
    const rec = data[server];
    if (!rec || typeof rec !== 'object') continue;
    for (const key of CREATED_KEYS) {
      const val = rec[key];
      if (!val) continue;
      const raw = Array.isArray(val) ? val[0] : val;
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Domain age via WHOIS (port 43, free — no paid API).
 * Returns status + age in days when a creation date is found, else unknown.
 */
export async function checkDomainAge(domain) {
  try {
    const data = await whoiser(domain, { timeout: 8000, follow: 2 });
    const created = pickCreationDate(data);
    if (!created) {
      return { status: 'unknown', value: null, detail: 'Creation date not present in WHOIS record.' };
    }
    const ageDays = daysSince(created);
    const ageYears = +(ageDays / 365).toFixed(1);
    // Older domains are a positive trust signal; very new ones warrant caution.
    let status = 'warn';
    if (ageDays >= 365) status = 'pass';
    if (ageDays < 90) status = 'fail';
    return {
      status,
      value: { createdAt: created.toISOString().slice(0, 10), ageDays, ageYears },
      detail:
        ageDays < 90
          ? `Registered very recently (${ageDays} days ago).`
          : `Registered ${ageYears} years ago (${created.toISOString().slice(0, 10)}).`,
    };
  } catch (err) {
    return { status: 'unknown', value: null, detail: `WHOIS lookup failed: ${err.message}` };
  }
}

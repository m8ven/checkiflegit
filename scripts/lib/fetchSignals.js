import { normalizeDomain, fetchWithTimeout } from './util.js';
import { checkHttp } from './signals/http.js';
import { checkSsl } from './signals/ssl.js';
import { checkDomainAge } from './signals/whois.js';
import { checkContactInfo } from './signals/contact.js';
import { checkSocial } from './signals/social.js';
import { checkReviews } from './signals/reviews.js';
import { detectPlatform } from './signals/platform.js';

/**
 * Fetch every public signal for a domain.
 *
 * HARD RULES enforced here:
 *  - Reachability is checked first. If the homepage does not load, we stop and
 *    flag `reachable: false` so the generator can skip / de-index the domain.
 *  - Every signal comes from a real fetch. Failures yield `status: 'unknown'`,
 *    never a fabricated value.
 */
export async function fetchSignals(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  const fetchedAt = new Date().toISOString();

  // 1. Reachability + page checks (also gives us homepage HTML to reuse).
  const http = await checkHttp(domain);

  if (!http.reachable) {
    return {
      domain,
      fetchedAt,
      reachable: false,
      signals: { http: http.signal },
    };
  }

  // 2. Remaining signals. SSL/WHOIS/reviews hit the network in parallel;
  //    contact/social parse the already-fetched HTML.
  const [ssl, domainAge, reviews] = await Promise.all([
    checkSsl(domain),
    checkDomainAge(domain),
    checkReviews(domain),
  ]);

  let contact = checkContactInfo(http.html);
  // SPA homepages often omit contact details; if we found a contact page, scan it.
  if (contact.status !== 'pass' && http.contactUrl) {
    try {
      const res = await fetchWithTimeout(http.contactUrl, {}, 8000);
      if (res.ok) {
        const recovered = checkContactInfo(await res.text());
        if (recovered.status === 'pass' || (recovered.status === 'warn' && contact.status === 'fail')) {
          contact = recovered;
        }
      }
    } catch { /* keep homepage result */ }
  }

  const social = checkSocial(http.html);
  const platform = detectPlatform(http.html);

  return {
    domain,
    fetchedAt,
    reachable: true,
    isStore: platform.value.isStore,
    finalUrl: http.finalUrl,
    signals: {
      http: http.signal,
      platform,
      pages: http.pages,
      ssl,
      domainAge,
      contact,
      social,
      reviews,
    },
  };
}

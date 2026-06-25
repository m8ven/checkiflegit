import { fetchWithTimeout } from '../util.js';

// Keyword sets for detecting standard e-commerce trust pages via on-page links.
// Multilingual (EN/DE/FR/ES/IT) so non-English stores aren't unfairly penalised
// for not using English page names — e.g. German shops use Impressum/Datenschutz/
// AGB/Kontakt/Widerruf, which are legally mandated.
const PAGE_PATTERNS = {
  contact: /contact|kontakt|contacto|contatti|impressum|support|help|customer[-\s]?(service|care)|kundenservice|assistance|aide/i,
  privacy: /privacy|datenschutz|privacidad|confidentialit|riservatezza|privacit/i,
  terms: /terms|conditions|t&c|tos\b|\bagb\b|t[ée]rminos|condizioni|mentions[-\s]?l[ée]gales/i,
  refund: /refund|return|widerruf|r[üu]ckgabe|retoure|reembolso|remboursement|recesso|reso\b/i,
  shipping: /shipping|delivery|versand|lieferung|env[íi]o|livraison|spedizione/i,
};

// Standard URLs to probe directly when a page isn't linked from the homepage.
// Many modern stores are JS-rendered (SPA) and expose no footer links in the
// initial HTML, so link-detection alone unfairly fails them. Includes Shopify's
// canonical /policies/* and /pages/* paths plus common generic paths.
const PROBE_PATHS = {
  privacy: ['/privacy', '/privacy-policy', '/policies/privacy-policy', '/datenschutz', '/datenschutzerklaerung', '/confidentialite', '/privacidad'],
  terms: ['/terms', '/terms-of-service', '/terms-and-conditions', '/policies/terms-of-service', '/agb', '/conditions-generales-de-vente', '/terminos'],
  refund: ['/refund-policy', '/returns', '/return-policy', '/policies/refund-policy', '/widerruf', '/widerrufsrecht', '/retoure'],
  shipping: ['/shipping', '/shipping-policy', '/delivery', '/versand', '/versandkosten', '/livraison'],
  contact: ['/contact', '/contact-us', '/pages/contact', '/kontakt', '/impressum', '/contacto', '/contatti'],
};

function extractLinks(html) {
  const links = [];
  const re = /<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push(`${href} ${text}`);
    if (links.length > 4000) break;
  }
  return links;
}

function detectPages(html) {
  const links = extractLinks(html);
  const found = {};
  for (const [name, pattern] of Object.entries(PAGE_PATTERNS)) {
    found[name] = links.some((l) => pattern.test(l));
  }
  return found;
}

/** Return the first probe path under `base` that resolves (HTTP 200, not a
 * redirect back to the homepage), else null. Sequential, stops at first hit. */
async function firstExisting(base, paths) {
  for (const p of paths) {
    try {
      const res = await fetchWithTimeout(`${base}${p}`, {}, 6000);
      if (res.ok && new URL(res.url).pathname.replace(/\/$/, '') !== '') return res.url;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * HTTP reachability + trust-page checks (homepage links, then direct probing of
 * standard URLs for anything not linked). `reachable: false` => skip/de-index.
 * Returns homepage HTML (for contact/social/platform reuse) and a contact URL
 * when one was confirmed, so contact info can be recovered from it.
 */
export async function checkHttp(domain) {
  let res;
  let finalUrl;
  for (const scheme of ['https', 'http']) {
    try {
      res = await fetchWithTimeout(`${scheme}://${domain}/`, {}, 12000);
      finalUrl = res.url;
      break;
    } catch (err) {
      res = { _error: err.message };
    }
  }

  if (!res || res._error || !res.ok) {
    return {
      reachable: false,
      html: '',
      finalUrl: finalUrl || null,
      contactUrl: null,
      signal: {
        status: 'fail',
        value: { httpStatus: res?.status ?? null },
        detail: res?._error
          ? `Homepage did not load: ${res._error}`
          : `Homepage returned HTTP ${res?.status}.`,
      },
      pages: { status: 'unknown', value: {}, detail: 'Homepage unreachable.' },
    };
  }

  let html = '';
  try {
    html = await res.text();
  } catch {
    html = '';
  }

  const pages = detectPages(html);
  const base = `https://${domain}`;
  let contactUrl = null;

  // Probe (in parallel) every category not already found via homepage links.
  const toProbe = Object.keys(PROBE_PATHS).filter((k) => !pages[k]);
  const probed = await Promise.all(
    toProbe.map(async (k) => [k, await firstExisting(base, PROBE_PATHS[k])])
  );
  for (const [k, url] of probed) {
    if (url) {
      pages[k] = true;
      if (k === 'contact') contactUrl = url;
    }
  }
  // If contact was found via a homepage link, we still don't have its URL; the
  // probe above only runs when not linked. That's fine — homepage HTML usually
  // carries the contact details in that case.

  const hasContact = pages.contact;
  const policyCount = ['privacy', 'terms', 'refund', 'shipping'].filter((k) => pages[k]).length;

  let pageStatus = 'fail';
  if (hasContact && policyCount >= 2) pageStatus = 'pass';
  else if (hasContact || policyCount >= 1) pageStatus = 'warn';

  return {
    reachable: true,
    html,
    finalUrl,
    contactUrl,
    signal: {
      status: 'pass',
      value: { httpStatus: res.status, finalUrl },
      detail: `Homepage loads (HTTP ${res.status}).`,
    },
    pages: {
      status: pageStatus,
      value: pages,
      detail: `Found ${policyCount} policy page(s)${hasContact ? ' and a contact page' : ', no contact page'}.`,
    },
  };
}

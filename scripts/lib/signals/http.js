import { fetchWithTimeout } from '../util.js';

// Keyword sets for detecting standard e-commerce trust pages via on-page links.
// Multilingual (EN/DE/FR/ES/IT) so non-English stores aren't unfairly penalised
// for not using English page names — e.g. German shops use Impressum/Datenschutz/
// AGB/Kontakt/Widerruf, which are legally mandated.
// Link-text matching costs nothing extra per store, so this list is as broad as
// we can make it: EN/DE/FR/ES/IT plus NL/PL/PT/RU/VI, which together cover the
// languages actually present in the corpus.
const PAGE_PATTERNS = {
  contact: /contact|contato|kontakt|kontakty|contacto|contatti|impressum|support|help|customer[-\s]?(service|care)|kundenservice|assistance|aide|контакт|li[êe]n[-\s]?h[eê]/i,
  privacy: /privacy|privacybeleid|datenschutz|privacidad|privacidade|prywatno|confidentialit|riservatezza|privacit|конфиденциальн|b[ae]?o[-\s]?m[aâ]t/i,
  terms: /terms|termos|conditions|voorwaarden|t&c|tos\b|\bagb\b|regulamin|t[ée]rminos|condizioni|mentions[-\s]?l[ée]gales|услови|оферта|[dđ]i[eê]u[-\s]?kho[aả]n/i,
  refund: /refund|return|retour|widerruf|r[üu]ckgabe|retoure|herroeping|reembolso|remboursement|devolu|troca|recesso|res[oi]\b|zwrot|reklamacj|возврат|[dđ][oổ]i[-\s]?tr[aả]/i,
  shipping: /shipping|delivery|versand|lieferung|verzend|levering|env[íi]o|entrega|frete|livraison|spedizion|dostaw|wysy[łl]k|доставка|v[aậ]n[-\s]?chuy[eể]n|giao[-\s]?h[aà]ng/i,
};

// Standard URLs to probe directly when a page isn't linked from the homepage.
// Many modern stores are JS-rendered (SPA) and expose no footer links in the
// initial HTML, so link-detection alone unfairly fails them. Includes Shopify's
// canonical /policies/* and /pages/* paths plus common generic paths.
// English + platform-canonical paths, tried for every store.
const PROBE_PATHS = {
  privacy: ['/privacy', '/privacy-policy', '/policies/privacy-policy'],
  terms: ['/terms', '/terms-of-service', '/terms-and-conditions', '/policies/terms-of-service'],
  refund: ['/refund-policy', '/returns', '/return-policy', '/policies/refund-policy'],
  shipping: ['/shipping', '/shipping-policy', '/delivery'],
  contact: ['/contact', '/contact-us', '/pages/contact'],
};

// Probing is sequential and only runs for categories NOT found via homepage
// links, so a store with no policy pages pays for every path in its list. These
// are therefore selected by TLD rather than all tried on every store — which
// also means a .com no longer gets probed with /datenschutz and /privacidad,
// cutting requests for the largest slice of the corpus. Link-text matching
// above is language-blind, so a German-language .com is still detected when it
// links its pages, which is the common case.
const PROBE_PATHS_BY_LANG = {
  de: { privacy: ['/datenschutz', '/datenschutzerklaerung'], terms: ['/agb'], refund: ['/widerruf', '/widerrufsrecht', '/retoure'], shipping: ['/versand', '/versandkosten'], contact: ['/kontakt', '/impressum'] },
  fr: { privacy: ['/confidentialite'], terms: ['/conditions-generales-de-vente', '/mentions-legales'], refund: ['/retours'], shipping: ['/livraison'], contact: ['/contactez-nous'] },
  es: { privacy: ['/privacidad', '/politica-de-privacidad'], terms: ['/terminos', '/terminos-y-condiciones'], refund: ['/devoluciones'], shipping: ['/envios'], contact: ['/contacto'] },
  it: { privacy: ['/informativa-privacy'], terms: ['/termini-e-condizioni'], refund: ['/resi'], shipping: ['/spedizioni'], contact: ['/contatti'] },
  nl: { privacy: ['/privacybeleid'], terms: ['/algemene-voorwaarden', '/voorwaarden'], refund: ['/retourneren', '/herroepingsrecht'], shipping: ['/verzending', '/levering'], contact: ['/contactformulier'] },
  pl: { privacy: ['/polityka-prywatnosci'], terms: ['/regulamin'], refund: ['/zwroty', '/reklamacje'], shipping: ['/dostawa', '/wysylka'], contact: ['/kontakt'] },
  pt: { privacy: ['/politica-de-privacidade', '/privacidade'], terms: ['/termos', '/termos-de-uso'], refund: ['/devolucoes', '/trocas'], shipping: ['/entrega', '/frete'], contact: ['/contato'] },
  ru: { privacy: ['/politika-konfidencialnosti'], terms: ['/oferta', '/usloviya'], refund: ['/vozvrat'], shipping: ['/dostavka'], contact: ['/kontakty'] },
  vi: { privacy: ['/chinh-sach-bao-mat'], terms: ['/dieu-khoan'], refund: ['/doi-tra', '/chinh-sach-doi-tra'], shipping: ['/van-chuyen', '/giao-hang'], contact: ['/lien-he'] },
};

const LANG_BY_TLD = {
  de: 'de', at: 'de', ch: 'de',
  nl: 'nl', be: 'nl',
  fr: 'fr',
  es: 'es', mx: 'es', ar: 'es', cl: 'es', co: 'es', pe: 'es',
  it: 'it',
  pl: 'pl',
  pt: 'pt', br: 'pt',
  ru: 'ru', ua: 'ru', by: 'ru', kz: 'ru',
  vn: 'vi',
};

/** Probe paths for a domain: the shared set plus its TLD's language, if known. */
function probePathsFor(domain) {
  const lang = LANG_BY_TLD[String(domain).split('.').pop()];
  const extra = lang ? PROBE_PATHS_BY_LANG[lang] : null;
  if (!extra) return PROBE_PATHS;
  const merged = {};
  for (const k of Object.keys(PROBE_PATHS)) merged[k] = [...PROBE_PATHS[k], ...(extra[k] ?? [])];
  return merged;
}

// Statuses that mean "the server is alive and refused us", not "the site is
// gone". Deliberately includes 503: keeping a page for a site that is genuinely
// down is a far cheaper mistake than deleting one for a site that is up.
const BLOCKED_STATUS = new Set([401, 403, 429, 503]);

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
    // A refusal is not a death. 403/429/503 all mean the server answered and
    // declined us — bot protection, rate limiting, a maintenance window. Large
    // legitimate retailers do this constantly. Calling that "unreachable" would
    // publish a de-indexed page claiming a live store did not load, and would
    // let an unattended refetch loop delete real pages after a few weeks.
    // `blocked` is reported separately so callers can skip rather than judge.
    const blocked = BLOCKED_STATUS.has(res?.status);
    return {
      reachable: false,
      blocked,
      html: '',
      finalUrl: finalUrl || null,
      contactUrl: null,
      signal: {
        status: blocked ? 'unknown' : 'fail',
        value: { httpStatus: res?.status ?? null },
        detail: blocked
          ? `Homepage responded HTTP ${res?.status} (request refused, not a failed site).`
          : res?._error
            ? `Homepage did not load: ${res._error}`
            : `Homepage returned HTTP ${res?.status}.`,
      },
      pages: {
        status: 'unknown',
        value: {},
        detail: blocked ? 'Homepage request was refused.' : 'Homepage unreachable.',
      },
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
  const probePaths = probePathsFor(domain);
  const toProbe = Object.keys(probePaths).filter((k) => !pages[k]);
  const probed = await Promise.all(
    toProbe.map(async (k) => [k, await firstExisting(base, probePaths[k])])
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

import { fetchWithTimeout } from '../util.js';

// Keyword sets for detecting standard e-commerce trust pages via on-page links.
const PAGE_PATTERNS = {
  contact: /contact|support|help|customer[-\s]?(service|care)/i,
  privacy: /privacy/i,
  terms: /terms|conditions|t&c|tos\b/i,
  refund: /refund|return/i,
  shipping: /shipping|delivery/i,
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

/**
 * HTTP reachability + on-page trust-page checks.
 * `reachable: false` means the domain should be skipped / de-indexed entirely.
 * Returns the homepage HTML so contact/social checks can reuse it.
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
  const hasContact = pages.contact;
  const hasPolicies = pages.privacy || pages.terms || pages.refund;
  const policyCount = ['privacy', 'terms', 'refund', 'shipping'].filter((k) => pages[k]).length;

  let pageStatus = 'fail';
  if (hasContact && policyCount >= 2) pageStatus = 'pass';
  else if (hasContact || policyCount >= 1) pageStatus = 'warn';

  return {
    reachable: true,
    html,
    finalUrl,
    signal: {
      status: 'pass',
      value: { httpStatus: res.status, finalUrl },
      detail: `Homepage loads (HTTP ${res.status}).`,
    },
    pages: {
      status: pageStatus,
      value: pages,
      detail: `Found ${policyCount} policy page link(s)${hasContact ? ' and a contact page' : ', no contact page'}.`,
    },
  };
}

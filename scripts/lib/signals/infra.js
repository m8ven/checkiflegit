// Infrastructure signal — who actually hosts and routes this domain.
//
// Every other signal reads the storefront. This one reads the plumbing, which
// a merchant does not write and therefore cannot compose for us. Two things
// make it worth the lookups:
//
//  1. Mail records are a genuine trust signal. A business that takes orders
//     needs to receive mail; a domain with no MX at all cannot, which is
//     common among storefronts that exist only to take payments.
//  2. The ASN / nameserver / MX triple is a stable fingerprint. Storing it now
//     is what makes operator clustering possible later — the same reseller
//     infrastructure behind a dozen "independent" brands is only visible once
//     these are recorded per store.
//
// All lookups are free and keyless: node:dns for records, and Team Cymru's
// public DNS interface for ASN (origin.asn.cymru.com), which avoids the
// rate-limited HTTP geo-IP APIs entirely.
//
// HARD RULE: infrastructure is reported, not moralised. Cheap shared hosting
// and Cloudflare are used by plenty of honest small shops, so this signal only
// scores the one thing that is genuinely meaningful (mail capability) and
// reports the rest as context.

import { Resolver } from 'node:dns/promises';

const TIMEOUT_MS = 6000;

/** A resolver with a hard timeout — node:dns has no per-query timeout option. */
function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), ms)),
  ]);
}

const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });

async function safe(fn) {
  try {
    return await withTimeout(fn());
  } catch {
    return null;
  }
}

// Recognisable networks, so the page can say "hosted on Cloudflare" rather than
// printing a bare AS number at a shopper.
const NETWORK_NAMES = [
  [/cloudflare/i, 'Cloudflare'],
  [/amazon|aws/i, 'Amazon Web Services'],
  [/google/i, 'Google Cloud'],
  [/microsoft|azure/i, 'Microsoft Azure'],
  [/shopify/i, 'Shopify'],
  [/fastly/i, 'Fastly'],
  [/akamai/i, 'Akamai'],
  [/digitalocean/i, 'DigitalOcean'],
  [/hetzner/i, 'Hetzner'],
  [/ovh/i, 'OVH'],
  [/godaddy/i, 'GoDaddy'],
  [/squarespace/i, 'Squarespace'],
  [/wix/i, 'Wix'],
];

function friendlyNetwork(name) {
  if (!name) return null;
  for (const [re, label] of NETWORK_NAMES) if (re.test(name)) return label;
  return null;
}

// Mail providers worth naming — a domain on a real mail platform is a stronger
// signal than one with a single self-hosted MX.
const MAIL_PROVIDERS = [
  [/google|googlemail|gmail/i, 'Google Workspace'],
  [/outlook|microsoft|office365/i, 'Microsoft 365'],
  [/zoho/i, 'Zoho Mail'],
  [/proton/i, 'Proton Mail'],
  [/yandex/i, 'Yandex Mail'],
  [/mailgun|sendgrid|mandrill|postmark/i, 'a transactional mail service'],
  [/ovh|hetzner|ionos|godaddy|namecheap|hostinger|siteground|bluehost/i, 'its hosting provider'],
];

function mailProvider(hosts) {
  for (const h of hosts) {
    for (const [re, label] of MAIL_PROVIDERS) if (re.test(h)) return label;
  }
  return null;
}

/**
 * ASN lookup via Team Cymru's DNS interface. For 1.2.3.4 we query
 * 4.3.2.1.origin.asn.cymru.com, which returns a TXT record shaped
 * "13335 | 1.2.3.0/24 | US | arin | 2010-07-14". Free, no key, no rate limit
 * worth worrying about at our volume.
 */
async function lookupAsn(ip) {
  if (!ip || ip.includes(':')) return null; // IPv6 uses a different zone; skip
  const rev = ip.split('.').reverse().join('.');
  const txt = await safe(() => resolver.resolveTxt(`${rev}.origin.asn.cymru.com`));
  if (!txt?.length) return null;
  const parts = txt[0].join('').split('|').map((s) => s.trim());
  const asn = parts[0]?.split(/\s+/)[0];
  if (!asn) return null;

  // Second lookup turns the AS number into an operator name.
  const nameTxt = await safe(() => resolver.resolveTxt(`AS${asn}.asn.cymru.com`));
  const asName = nameTxt?.length
    ? nameTxt[0].join('').split('|').map((s) => s.trim()).pop()
    : null;

  return { asn: `AS${asn}`, asName: asName || null, country: parts[2] || null };
}

/** Registrable parent of a hostname, used to group nameservers by operator. */
function parentDomain(host) {
  const p = String(host).toLowerCase().replace(/\.$/, '').split('.');
  return p.length <= 2 ? p.join('.') : p.slice(-2).join('.');
}

/**
 * Hosting, mail and network records for a domain.
 *
 * Scores ONLY mail capability. Everything else is recorded for context and for
 * later operator clustering, and is deliberately weightless.
 */
export async function checkInfra(domain) {
  const [addrs, mx, ns] = await Promise.all([
    safe(() => resolver.resolve4(domain)),
    safe(() => resolver.resolveMx(domain)),
    safe(() => resolver.resolveNs(domain)),
  ]);

  // No A record at all means DNS itself failed; the caller already knows the
  // site loaded, so treat this as a lookup failure rather than a finding.
  if (!addrs?.length && !mx && !ns) {
    return {
      status: 'unknown',
      value: null,
      detail: 'DNS records could not be read.',
    };
  }

  const ip = addrs?.[0] ?? null;
  const asnInfo = ip ? await lookupAsn(ip) : null;

  const mxHosts = (mx ?? []).map((r) => String(r.exchange).toLowerCase().replace(/\.$/, ''));
  const nsHosts = (ns ?? []).map((h) => String(h).toLowerCase().replace(/\.$/, ''));
  const hasMx = mxHosts.length > 0;

  const network = friendlyNetwork(asnInfo?.asName);
  const provider = mailProvider(mxHosts);

  const value = {
    ip,
    ipCount: addrs?.length ?? 0,
    asn: asnInfo?.asn ?? null,
    asName: asnInfo?.asName ?? null,
    networkName: network,
    country: asnInfo?.country ?? null,
    hasMx,
    mxHosts: mxHosts.slice(0, 4),
    mailProvider: provider,
    nameservers: nsHosts.slice(0, 4),
    // The clustering key (brief §4): shared operators reuse these together.
    fingerprint: {
      asn: asnInfo?.asn ?? null,
      nsParent: nsHosts.length ? parentDomain(nsHosts[0]) : null,
      mxParent: mxHosts.length ? parentDomain(mxHosts[0]) : null,
    },
  };

  const bits = [];
  if (network) bits.push(`hosted on ${network}`);
  else if (asnInfo?.asName) bits.push(`hosted on ${asnInfo.asName}`);
  if (hasMx) bits.push(provider ? `email runs through ${provider}` : 'has mail records');

  if (!hasMx) {
    return {
      status: 'warn',
      value,
      detail: bits.length
        ? `Domain is ${bits.join(' and ')}, but has no mail records — it cannot receive email at this domain.`
        : 'Domain has no mail records — it cannot receive email at this domain.',
    };
  }

  return {
    status: 'pass',
    value,
    detail: bits.length
      ? `Domain is ${bits.join(' and ')}.`
      : 'Standard hosting and mail records are in place.',
  };
}

// Seed harvester: walk the Tranco top-sites list, fetch each candidate's
// homepage, and append the ones that are actually e-commerce stores to the seed
// file. This is what keeps `scripts/seeds/domains.txt` full of real, custom-domain
// stores for the page generator to process.
//
// Usage: node scripts/harvest-seeds.js
// Env:
//   HARVEST_TARGET   new stores to find this run        (default 200)
//   HARVEST_MAX      max candidates to fetch this run   (default 3000)
//   HARVEST_CONC     concurrent fetches                 (default 20)
//   TRANCO_FILE      path to top-1m.csv (auto-downloads if missing)
//   SEED_FILE        output seed file
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, normalizeDomain } from './lib/util.js';
import { detectPlatform } from './lib/signals/platform.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SEED_FILE = process.env.SEED_FILE || path.join(ROOT, 'scripts', 'seeds', 'domains.txt');
const CURSOR_FILE = path.join(ROOT, 'scripts', 'seeds', 'harvest-cursor.json');
const TRANCO_FILE = process.env.TRANCO_FILE || path.join(ROOT, 'data', 'raw', 'tranco-top-1m.csv');

const TARGET = Number(process.env.HARVEST_TARGET || 200);
const MAX = Number(process.env.HARVEST_MAX || 3000);
const CONC = Number(process.env.HARVEST_CONC || 20);

// Non-store domains that can slip past detection: e-commerce *platform vendors*
// (whose own sites demo storefront markup), plus infra / SaaS / registrars /
// CDNs / analytics. Plus gov/edu/mil TLDs, which are effectively never stores.
const DENY_TLD = /\.(gov|mil|int|edu)$|\.(gov|edu|ac)\.[a-z]{2,3}$/i;
const DENY = new Set([
  // platform vendors
  'shopify.com', 'squarespace.com', 'wix.com', 'weebly.com', 'bigcommerce.com',
  'woocommerce.com', 'odoo.com', 'ecwid.com', 'bigcartel.com', 'prestashop.com', 'magento.com',
  // marketing / SaaS / payments
  'stripe.com', 'paypal.com', 'klaviyo.com', 'mailchimp.com', 'mailchi.mp', 'sendgrid.com',
  'hubspot.com', 'salesforce.com', 'intuit.com', 'twilio.com', 'atlassian.com',
  // registrars / hosting / CDN / infra
  'gandi.net', 'reg.ru', 'nic.ru', 'namecheap.com', 'godaddy.com', 'ionos.com',
  'hostgator.com', 'bluehost.com', 'cloudflare.com', 'fastly.net', 'akamai.com',
  'cpanel.net', 'no-ip.com', 'b-cdn.net', 'cdnvideo.ru', 'workers.dev', 'one.one', 'myfritz.net',
  // CMS / dev / community
  'themeforest.net', 'envato.com', 'wordpress.com', 'wordpress.org', 'wp.com',
  'automattic.com', 'gravatar.com', 'github.com', 'github.io', 'gitlab.com',
  'stackoverflow.com', 'mozilla.org', 'apache.org', 'iso.org',
  // big tech / analytics / misc non-store
  'doubleclick.net', 'google-analytics.com', 'googleapis.com', 'gstatic.com', 'criteo.com',
  'sentry.io', 'unity3d.com', 'zoom.us', 'opera.com', 'meraki.com', 'ui.com',
  'smartthings.com', 'forter.com', 'eset.com', 'webempresa.eu', 'pinimg.com',
  't.me', 'bit.ly', 'discord.gg', 'youtu.be', 'blogspot.com',
]);

function isDenied(domain) {
  return DENY_TLD.test(domain) || DENY.has(domain);
}

async function ensureTranco() {
  if (existsSync(TRANCO_FILE)) return;
  console.log('Tranco list not found — downloading…');
  await mkdir(path.dirname(TRANCO_FILE), { recursive: true });
  const zip = path.join(path.dirname(TRANCO_FILE), 'tranco.zip');
  execSync(`curl -sL "https://tranco-list.eu/top-1m.csv.zip" -o "${zip}"`, { stdio: 'inherit' });
  execSync(`unzip -o -q "${zip}" -d "${path.dirname(TRANCO_FILE)}"`, { stdio: 'inherit' });
  execSync(`mv "${path.join(path.dirname(TRANCO_FILE), 'top-1m.csv')}" "${TRANCO_FILE}"`);
}

async function loadCursor() {
  try { return JSON.parse(await readFile(CURSOR_FILE, 'utf8')).line || 0; } catch { return 0; }
}
async function saveCursor(line) {
  await writeFile(CURSOR_FILE, JSON.stringify({ line, updatedAt: new Date().toISOString() }, null, 2));
}

async function loadSeedSet() {
  try {
    const raw = await readFile(SEED_FILE, 'utf8');
    return new Set(
      raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(normalizeDomain)
    );
  } catch { return new Set(); }
}

/** Light store check: fetch homepage, detect platform/storefront. */
async function isStore(domain) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetchWithTimeout(`${scheme}://${domain}/`, {}, 8000);
      if (!res.ok) continue;
      const html = await res.text();
      return detectPlatform(html).value.isStore;
    } catch { /* try next scheme */ }
  }
  return false;
}

await ensureTranco();
const lines = (await readFile(TRANCO_FILE, 'utf8')).split('\n');
const seen = await loadSeedSet();
let cursor = await loadCursor();

console.log(`Tranco: ${lines.length} rows · cursor at ${cursor} · seed has ${seen.size} · target +${TARGET}`);

const found = [];
let fetched = 0;
let i = cursor;

while (i < lines.length && found.length < TARGET && fetched < MAX) {
  // Build a batch of unseen candidate domains.
  const batch = [];
  while (i < lines.length && batch.length < CONC) {
    const domain = normalizeDomain((lines[i].split(',')[1] || '').trim());
    i++;
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    if (isDenied(domain)) continue;
    batch.push(domain);
  }
  if (!batch.length) break;

  const results = await Promise.all(
    batch.map(async (d) => ({ d, store: await isStore(d) }))
  );
  fetched += batch.length;
  for (const { d, store } of results) {
    if (store) {
      found.push(d);
      console.log(`  ✓ store: ${d}`);
    }
  }
  if (fetched % 200 === 0 || found.length >= TARGET) {
    console.log(`  …scanned ${fetched}, found ${found.length}`);
  }
}

cursor = i;
await saveCursor(cursor);

if (found.length) {
  await appendFile(SEED_FILE, `\n# harvested ${new Date().toISOString().slice(0, 10)}\n${found.join('\n')}\n`);
}

console.log(`\nDone. Scanned ${fetched} candidates, found ${found.length} stores. Cursor now ${cursor}.`);
console.log(found.length ? `Appended to ${SEED_FILE}.` : 'Nothing appended.');

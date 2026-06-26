// Drain user-requested domains (from the search box) into the seed list.
//
// Reads the `req:*` keys from the Cloudflare KV namespace, filters out domains
// we already have pages for or that are already seeded or denylisted, appends
// the rest to scripts/seeds/domains.txt under a "requested" section, and deletes
// the drained keys. The normal (manually-triggered) generate workflow then turns
// them into reviewed pages — no real-time verdicts.
//
// Env required:
//   CF_API_TOKEN     Cloudflare API token with KV read/write
//   CF_ACCOUNT_ID    Cloudflare account id
//   REQUESTS_KV_ID   id of the KV namespace bound as REQUESTS
import { readFile, appendFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain, domainToSlug } from './lib/util.js';
import { isDenied } from './lib/denylist.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SEED_FILE = path.join(ROOT, 'scripts', 'seeds', 'domains.txt');
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');

const { CF_API_TOKEN, CF_ACCOUNT_ID, REQUESTS_KV_ID } = process.env;
if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !REQUESTS_KV_ID) {
  console.error('Missing CF_API_TOKEN / CF_ACCOUNT_ID / REQUESTS_KV_ID env.');
  process.exit(1);
}
const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${REQUESTS_KV_ID}`;
const auth = { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } };

async function listKeys(prefix) {
  const keys = [];
  let cursor = '';
  do {
    const url = `${API}/keys?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${cursor}` : ''}`;
    const r = await (await fetch(url, auth)).json();
    keys.push(...r.result.map((k) => k.name));
    cursor = r.result_info?.cursor || '';
  } while (cursor);
  return keys;
}
const getVal = async (k) => (await fetch(`${API}/values/${encodeURIComponent(k)}`, auth)).json();
const delKey = (k) => fetch(`${API}/values/${encodeURIComponent(k)}`, { method: 'DELETE', ...auth });

async function existing() {
  const seed = new Set();
  try {
    (await readFile(SEED_FILE, 'utf8')).split('\n').forEach((l) => {
      l = l.trim(); if (l && !l.startsWith('#')) seed.add(normalizeDomain(l));
    });
  } catch {}
  const slugs = new Set();
  try {
    (await readdir(STORES_DIR)).forEach((f) => slugs.add(f.replace(/^_/, '').replace(/\.mdx$/, '')));
  } catch {}
  return { seed, slugs };
}

const keys = await listKeys('req:');
const { seed, slugs } = await existing();
const toAdd = []; // {domain, count}
const processed = [];

for (const key of keys) {
  processed.push(key);
  const domain = normalizeDomain(key.slice('req:'.length));
  if (!domain || isDenied(domain) || seed.has(domain) || slugs.has(domainToSlug(domain))) continue;
  const val = await getVal(key); // { domain, count, firstSeen }
  toAdd.push({ domain, count: val?.count || 1 });
  seed.add(domain);
}

// Prioritise real demand: most-requested domains first in the seed order, so the
// next batch reviews them ahead of one-off requests.
toAdd.sort((a, b) => b.count - a.count);

if (toAdd.length) {
  const block = toAdd.map((r) => r.domain).join('\n');
  await appendFile(SEED_FILE, `\n# requested via search box ${new Date().toISOString().slice(0, 10)} (demand-ranked)\n${block}\n`);
}
for (const k of processed) await delKey(k);

console.log(`Drained ${processed.length} request key(s); added ${toAdd.length} new domain(s) to the seed (demand-ranked).`);

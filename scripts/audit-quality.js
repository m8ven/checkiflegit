// Full quality audit of live store pages → classify each into:
//   STORE  : confirmed shopping store (keep)
//   A      : confident non-store (course/LMS, nonprofit/.org w/o commerce, or a
//            fully-rendered content/subscription site with zero products anywhere)
//   B      : ambiguous / couldn't confirm (SPA/sparse/unreachable, thin maybe-real
//            shop) — HOLD, never auto-delete
//
// Writes data/bucket-a.txt and data/bucket-b.txt (domain<TAB>reason). Does NOT
// delete anything. Bias: when unsure, send to B (keep).
//
// Usage: node scripts/audit-quality.js
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { fetchWithTimeout } from './lib/util.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');
const CONC = 18;

// Courses/LMS sell courses, not products → confident non-store regardless of cart.
const COURSE = /^(academy|aula|cursos?|courses?|learn|learning|campus|lms|escuela|formacion|akademie|elearning|kurse?)\.|\.(training|academy|courses|education)$/i;
const NONPROFIT = /\.org$|(foundation|association|institut|society|verein|nonprofit|charity|ministr)/i;
const BLOG = /^blog\./i;
const COMMERCE = /add[\s_-]?to[\s_-]?(cart|bag|basket)|href=["'][^"']*\/(cart|checkout)(\/|["'?])|"@type"\s*:\s*"(Product|Offer)"|"priceCurrency"|itemprop=["']price/i;
const SPA = /id=["'](root|app|__next|__nuxt)["']|data-reactroot|__NEXT_DATA__|window\.__NUXT__|ng-version|data-server-rendered|data-v-app/i;
const SHOP_PATHS = ['/shop', '/store', '/products', '/collections/all', '/tienda', '/boutique', '/produkte', '/negozio'];

function visibleLen(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

async function classify(domain) {
  if (COURSE.test(domain)) return ['A', 'course/LMS'];
  let html = '';
  try { const r = await fetchWithTimeout(`https://${domain}/`, {}, 8000); if (r.ok) html = await r.text(); } catch {}
  if (!html) return ['B', 'unreachable/blocked'];
  if (COMMERCE.test(html)) return ['STORE', 'homepage-commerce'];
  // SPA-aware: probe standard shop pages for products
  for (const p of SHOP_PATHS) {
    try {
      const r = await fetchWithTimeout(`https://${domain}${p}`, {}, 6000);
      if (r.ok && new URL(r.url).pathname.replace(/\/$/, '') !== '') {
        const h = await r.text();
        if (COMMERCE.test(h) || /\/(products?|collections)\//i.test(h)) return ['STORE', `shop-page ${p}`];
      }
    } catch {}
  }
  // No products found anywhere.
  if (SPA.test(html) && visibleLen(html) < 2500) return ['B', 'SPA/JS-rendered (unverified)'];
  if (visibleLen(html) < 2500) return ['B', 'thin content (maybe-real)'];
  if (NONPROFIT.test(domain)) return ['A', 'nonprofit/.org, no products'];
  if (BLOG.test(domain)) return ['A', 'blog, no products'];
  return ['A', 'content/subscription site, zero products'];
}

const files = (await readdir(STORES_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
const domains = [];
for (const f of files) { const { data } = matter(await readFile(path.join(STORES_DIR, f), 'utf8')); domains.push(data.domain); }

const A = [], B = [];
let store = 0, idx = 0;
async function worker() {
  while (idx < domains.length) {
    const d = domains[idx++];
    const [bucket, reason] = await classify(d);
    if (bucket === 'STORE') store++;
    else if (bucket === 'A') A.push(`${d}\t${reason}`);
    else B.push(`${d}\t${reason}`);
    if (idx % 500 === 0) {
      console.log(`  ${idx}/${domains.length} · store ${store} · A ${A.length} · B ${B.length}`);
      await writeFile(path.join(ROOT, 'data', 'bucket-a.txt'), A.join('\n') + '\n');
      await writeFile(path.join(ROOT, 'data', 'bucket-b.txt'), B.join('\n') + '\n');
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await writeFile(path.join(ROOT, 'data', 'bucket-a.txt'), A.join('\n') + '\n');
await writeFile(path.join(ROOT, 'data', 'bucket-b.txt'), B.join('\n') + '\n');

const reasonCount = (arr) => arr.reduce((m, l) => { const r = l.split('\t')[1]; m[r] = (m[r] || 0) + 1; return m; }, {});
console.log(`\nDONE. total ${domains.length} · STORE(keep) ${store} · A(delete) ${A.length} · B(hold) ${B.length}`);
console.log('Bucket A by reason:', JSON.stringify(reasonCount(A), null, 0));
console.log('Bucket B by reason:', JSON.stringify(reasonCount(B), null, 0));

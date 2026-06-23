import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';
import { domainToSlug } from './util.js';
import { scoreVerdict } from './score.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STORES_DIR = path.join(ROOT, 'src', 'content', 'stores');

function titleCaseDomain(domain) {
  const name = domain.replace(/\.[a-z.]+$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A short, unique prose body for SEO (the structured UI is rendered from frontmatter). */
function buildBody(domain, verdict, signals) {
  const name = titleCaseDomain(domain);
  const lines = [];
  lines.push(
    `Wondering whether **${domain}** is a legitimate place to shop? We checked the public trust signals for this store and here is what we found.`
  );
  lines.push(verdict.summary);

  const points = [];
  for (const key of ['domainAge', 'ssl', 'pages', 'contact', 'reviews', 'social']) {
    const s = signals[key];
    if (s?.detail) points.push(`- ${s.detail}`);
  }
  if (points.length) {
    lines.push(`Here is a quick rundown of what our automated check observed for ${name}:`);
    lines.push(points.join('\n'));
  }
  lines.push(
    `This assessment is generated automatically from publicly available information and is not a definitive judgement of the business. Always do your own research before buying.`
  );
  return lines.join('\n\n');
}

/**
 * Turn a fetched-signals object into an MDX file on disk.
 * Unreachable domains are written with `noindex: true` and an `_` slug prefix so
 * they are excluded from the sitemap and search indexing (hard rule).
 */
export async function generatePage(result) {
  const { domain, reachable, signals, fetchedAt, finalUrl } = result;
  const verdict = reachable
    ? scoreVerdict(signals)
    : {
        tier: 'unreachable',
        label: 'Store unreachable',
        summary:
          'This website did not load when we checked it. We cannot assess a store we cannot reach, so this page is not indexed.',
        score: null,
        greenFlags: [],
        redFlags: ['The website did not respond.'],
        cautions: [],
      };

  const noindex = !reachable;
  const slug = (noindex ? '_' : '') + domainToSlug(domain);

  const frontmatter = {
    domain,
    slug,
    title: `Is ${domain} Legit? Trust Signal Check`,
    description: reachable
      ? `An automated trust-signal check for ${domain}: ${verdict.label.toLowerCase()}. Domain age, SSL, contact info, reviews and more.`
      : `${domain} did not load when we checked it.`,
    fetchedAt,
    finalUrl: finalUrl || null,
    reachable,
    noindex,
    verdict,
    signals,
  };

  const body = reachable ? buildBody(domain, verdict, signals) : verdict.summary;
  const file = matter.stringify(`\n${body}\n`, frontmatter);

  await mkdir(STORES_DIR, { recursive: true });
  const outPath = path.join(STORES_DIR, `${slug}.mdx`);
  await writeFile(outPath, file, 'utf8');
  return { outPath, slug, noindex, verdict };
}

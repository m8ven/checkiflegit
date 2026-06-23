// Fetch signals for a single domain and write its MDX page.
// Usage: node scripts/fetch-one.js example.com
import { fetchSignals } from './lib/fetchSignals.js';
import { generatePage } from './lib/generatePage.js';

const domain = process.argv[2];
if (!domain) {
  console.error('Usage: node scripts/fetch-one.js <domain>');
  process.exit(1);
}

console.log(`Fetching signals for ${domain} ...`);
const result = await fetchSignals(domain);
console.log(JSON.stringify(result, null, 2));

const { outPath, noindex, verdict } = await generatePage(result);
console.log(`\nVerdict: ${verdict.label}${verdict.score != null ? ` (${verdict.score}/100)` : ''}`);
console.log(`Wrote ${outPath}${noindex ? ' (noindex — unreachable/skipped)' : ''}`);

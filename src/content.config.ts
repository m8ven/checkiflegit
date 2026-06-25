import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// A single signal result as produced by the fetcher modules.
const signal = z.object({
  status: z.enum(['pass', 'warn', 'fail', 'unknown']),
  detail: z.string(),
  value: z.any().optional(),
});

const verdict = z.object({
  tier: z.string(),
  label: z.string(),
  summary: z.string(),
  score: z.number().nullable(),
  greenFlags: z.array(z.string()),
  redFlags: z.array(z.string()),
  cautions: z.array(z.string()),
});

const stores = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stores' }),
  schema: z.object({
    domain: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    fetchedAt: z.string(),
    finalUrl: z.string().nullable().optional(),
    reachable: z.boolean(),
    noindex: z.boolean(),
    verdict,
    signals: z.record(signal),
  }),
});

export const collections = { stores };

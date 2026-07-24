import { getCollection, type CollectionEntry } from 'astro:content';

export type Store = CollectionEntry<'stores'>;

/**
 * Shared catalogue helpers used by the store pages, the paginated browse index
 * and the platform / verdict / TLD hubs. Everything here is pure and derived
 * from signals already present in the MDX frontmatter — no new claims.
 */

// ---------------------------------------------------------------- collection

let _cache: Store[] | null = null;

/** All reachable, indexable stores, sorted by domain. Computed once per build. */
export async function getIndexableStores(): Promise<Store[]> {
  if (_cache) return _cache;
  _cache = (await getCollection('stores'))
    .filter((s) => !s.data.noindex)
    .sort((a, b) => a.data.domain.localeCompare(b.data.domain));
  return _cache;
}

// ---------------------------------------------------------------- accessors

/** Public-suffix-ish TLD: keeps `co.uk` / `com.au` together rather than `uk` / `au`. */
export function tldOf(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(last2)) return last2;
  return parts.at(-1) ?? '';
}

/** Detected e-commerce platform, or null when the fingerprint was inconclusive. */
export function platformOf(store: Store): string | null {
  const p = (store.data.signals as Record<string, any>)?.platform?.value?.platform;
  return typeof p === 'string' && p ? p : null;
}

/** URL-safe segment: "Salesforce Commerce" -> "salesforce-commerce", "co.uk" -> "co-uk". */
export function toSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const TIERS = ['strong', 'moderate', 'limited'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_META: Record<string, { short: string; heading: string; blurb: string }> = {
  strong: {
    short: 'Strong signals',
    heading: 'Stores with strong trust signals',
    blurb:
      'These stores showed the most complete set of public trust signals when we checked them — ' +
      'an established domain, valid HTTPS, reachable contact details and standard policy pages.',
  },
  moderate: {
    short: 'Moderate signals',
    heading: 'Stores with moderate trust signals',
    blurb:
      'These stores showed a mixed picture: several trust signals were present, but at least one ' +
      'standard signal was missing or could not be verified when we checked.',
  },
  limited: {
    short: 'Limited signals',
    heading: 'Stores with limited trust signals — proceed with caution',
    blurb:
      'These stores showed few public trust signals at the time of checking. That does not mean ' +
      'they are fraudulent, but we suggest extra care and buyer-protected payment methods.',
  },
};

// ---------------------------------------------------------------- grouping

export function groupBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k == null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Hubs below this size would be thin listing pages, so we don't publish them. */
export const MIN_HUB_SIZE = 25;

// ---------------------------------------------------------------- related

export interface Related {
  slug: string;
  domain: string;
  tier: string;
  reason: string;
}

const RELATED_TARGET = 8;

/**
 * Build the full related-stores graph in one pass.
 *
 * Relatedness is tiered: same platform + same TLD first, then same TLD, then
 * same verdict tier, then the global alphabetical index as fill. Within each
 * bucket we take immediate alphabetical neighbours *and* a couple of strided
 * picks. The stride matters: neighbours alone would produce one long chain,
 * whereas strided links turn the catalogue into a small-world graph where every
 * page is a few hops from every other — which is the point of the exercise.
 */
export function buildRelatedGraph(stores: Store[]): Map<string, Related[]> {
  const byPlatformTld = new Map<string, Store[]>();
  const byTld = new Map<string, Store[]>();
  const byTier = new Map<string, Store[]>();

  // Position of each store within each bucket, recorded as we fill them so the
  // buckets stay in the (already alphabetical) order of `stores`.
  const pos = new Map<string, { pt: number; tld: number; tier: number }>();

  const push = (map: Map<string, Store[]>, key: string, store: Store): number => {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    arr.push(store);
    return arr.length - 1;
  };

  for (const store of stores) {
    const tld = tldOf(store.data.domain);
    const platform = platformOf(store);
    const tier = store.data.verdict.tier;
    pos.set(store.data.slug, {
      pt: platform ? push(byPlatformTld, `${platform}|${tld}`, store) : -1,
      tld: push(byTld, tld, store),
      tier: push(byTier, tier, store),
    });
  }

  const graph = new Map<string, Related[]>();

  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    const { slug } = store.data;
    const tld = tldOf(store.data.domain);
    const platform = platformOf(store);
    const tier = store.data.verdict.tier;
    const p = pos.get(slug)!;

    const out: Related[] = [];
    const seen = new Set<string>([slug]);

    const take = (bucket: Store[] | undefined, idx: number, offsets: number[], reason: string) => {
      if (!bucket || bucket.length < 2 || idx < 0) return;
      for (const off of offsets) {
        if (out.length >= RELATED_TARGET) return;
        const j = (((idx + off) % bucket.length) + bucket.length) % bucket.length;
        const cand = bucket[j];
        if (seen.has(cand.data.slug)) continue;
        seen.add(cand.data.slug);
        out.push({
          slug: cand.data.slug,
          domain: cand.data.domain,
          tier: cand.data.verdict.tier,
          reason,
        });
      }
    };

    // 1. Same platform *and* same TLD — the strongest form of relatedness here.
    if (platform) {
      const bucket = byPlatformTld.get(`${platform}|${tld}`);
      const len = bucket?.length ?? 0;
      take(bucket, p.pt, [1, -1, Math.max(2, Math.floor(len / 3))], `${platform} · .${tld}`);
    }

    // 2. Same TLD / country.
    {
      const bucket = byTld.get(tld);
      const len = bucket?.length ?? 0;
      take(bucket, p.tld, [1, -1, Math.floor(len / 2)], `Another .${tld} store`);
    }

    // 3. Same verdict tier.
    {
      const bucket = byTier.get(tier);
      const len = bucket?.length ?? 0;
      take(bucket, p.tier, [1, Math.floor(len / 2)], `Also rated “${TIER_META[tier]?.short ?? tier}”`);
    }

    // 4. Global alphabetical fill — guarantees every page reaches RELATED_TARGET.
    take(stores, i, [1, -1, 2, -2, Math.floor(stores.length / 2), 3, -3], 'Also checked');

    graph.set(slug, out.slice(0, RELATED_TARGET));
  }

  return graph;
}

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

// Static JSON index of pages we ALREADY have. Built at deploy time; the search
// box matches against this only — it never triggers a live assessment.
export const GET: APIRoute = async () => {
  const stores = (await getCollection('stores'))
    .filter((s) => !s.data.noindex)
    .map((s) => ({ d: s.data.domain, s: s.data.slug, v: s.data.verdict.tier }));
  return new Response(JSON.stringify(stores), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
};

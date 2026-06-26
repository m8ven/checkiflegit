// Cloudflare Pages Function — POST /api/request-check
//
// Queues a user-requested domain for the NORMAL reviewed pipeline. It does NOT
// generate any page or verdict; it only records the request. A later run of
// scripts/pull-requests.js drains these into the seed list, which the
// (manually-triggered) generate workflow then processes deterministically.
//
// Setup (when ready to deploy): create a KV namespace and bind it to this Pages
// project as `REQUESTS` (Pages → Settings → Functions → KV namespace bindings).
// Until bound, this endpoint fails safe (503) and queues nothing.

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/;
const DAILY_LIMIT = 10; // requests per IP per day

function normalize(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\/.*$/, '').replace(/:.*$/, '');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

// Validate the domain actually resolves and responds before queuing, so the
// queue can't be filled with typos or dead domains.
async function reachable(domain) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://${domain}/`, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'CheckIfLegitBot/0.1 (+https://checkiflegit.com/about)' },
      });
      if (res.status < 500) return true;
    } catch { /* try next scheme */ }
  }
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const KV = env.REQUESTS;
  if (!KV) return json({ ok: false, error: 'not_configured' }, 503);

  let domain;
  try {
    const body = await request.json();
    domain = normalize(body.domain);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!DOMAIN_RE.test(domain)) return json({ ok: false, error: 'invalid_domain' }, 400);

  // Per-IP daily rate limit.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${ip}:${day}`;
  const count = parseInt((await KV.get(rlKey)) || '0', 10);
  if (count >= DAILY_LIMIT) return json({ ok: false, error: 'rate_limited' }, 429);
  await KV.put(rlKey, String(count + 1), { expirationTtl: 86400 });

  // Dedupe: one entry per domain; bump a demand counter on repeats (used to
  // prioritise multi-person requests when draining to the seed list).
  const reqKey = `req:${domain}`;
  const existing = await KV.get(reqKey, 'json');
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    await KV.put(reqKey, JSON.stringify(existing));
    return json({ ok: true, status: 'already_queued', count: existing.count });
  }

  // New domain: require it to actually resolve/respond before queuing.
  if (!(await reachable(domain))) return json({ ok: false, error: 'unreachable' }, 422);

  await KV.put(reqKey, JSON.stringify({ domain, count: 1, firstSeen: new Date().toISOString() }));
  return json({ ok: true, status: 'queued' });
}

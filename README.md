# CheckIfLegit

Programmatic-SEO site that publishes one page per online store answering
**"Is _[store]_ legit?"** using only publicly fetchable trust signals.

- **Astro** static site → deploys to **Cloudflare Pages** (free tier, no adapter)
- One **MDX file per store** under `src/content/stores/`
- A scheduled **GitHub Action** generates N new pages/day, commits them, and the
  host auto-deploys
- Monetized with display-ad slots (placeholders wired in)

## How it works

```
seed domains ─► fetchSignals() ─► scoreVerdict() ─► generatePage() ─► *.mdx ─► Astro build
```

### Signals (public only — never fabricated)

| Signal            | Source                                   | Module |
|-------------------|------------------------------------------|--------|
| Domain age        | WHOIS over port 43 (`whoiser`, free)     | `scripts/lib/signals/whois.js` |
| SSL / HTTPS       | Direct TLS handshake (`node:tls`)        | `scripts/lib/signals/ssl.js` |
| Reachability + pages | HTTP fetch of homepage + link detection | `scripts/lib/signals/http.js` |
| E-commerce platform | Asset/code fingerprints (Shopify, Woo, Magento…) | `scripts/lib/signals/platform.js` |
| Contact info      | Email/phone/address detection in HTML    | `scripts/lib/signals/contact.js` |
| Review footprint  | Trustpilot listing **presence** (status only) | `scripts/lib/signals/reviews.js` |
| Social presence   | Outbound links to major platforms        | `scripts/lib/signals/social.js` |
| Web history       | Internet Archive CDX — first seen + months captured | `scripts/lib/signals/history.js` |
| Hosting & mail    | DNS records + ASN via Team Cymru (free, keyless) | `scripts/lib/signals/infra.js` |
| Page behaviour    | Static scan of served HTML/JS for deceptive UI code | `scripts/lib/signals/deception.js` |

#### Code-level deception detection

`deception.js` is the one signal that measures what a store's code *does* rather
than what it publishes. Publishing a privacy policy is free; fabricating social
proof has to be implemented to work, so it leaves evidence. It detects
browser-generated purchase notifications, randomised "time ago" labels, RNG
stock and viewer counts, and countdowns seeded from the visitor's own clock.

Two rules keep it honest, and both were arrived at by watching it get them wrong:

- **Findings pair a specific primitive with a specific nearby phrase.** An
  earlier version tested whether both merely appeared in the same window; it
  flagged a cache-busting `Math.random()` sitting near an API-driven "left in
  stock", and printed a snippet showing a different mechanism than it claimed.
- **No finding without its snippet.** Every detection carries file, line and the
  real source, rendered on the page (`CodeEvidence.astro`). If the code can't be
  shown, the claim isn't made.

Scored outside the weighted average (`score.js`): a high-severity finding caps
the tier at `limited`, because signals that are cheap to fake must not outvote
code evidence.

The "About this check" / "Our take" paragraph is **deterministically synthesized**
from these signals (`buildBody()` in `generatePage.js`) — **no LLM, no API key, ~$0
per page.** This is deliberate: rule-based prose cannot hallucinate a signal or
claim, which is what the "never fabricate" hard rule requires.

### Hard rules enforced in code

- **Every verdict derives from real fetched data.** A signal we can't fetch is
  reported as `unknown` and **excluded** from scoring — never guessed (`score.js`).
- **No "SCAM" labels.** Verdict tiers use measured language only: _Strong /
  Moderate / Limited trust signals — proceed with caution_ (`score.js`).
- **Unreachable domains are skipped.** They're written with a `_`-prefixed slug,
  `noindex` meta, and excluded from the sitemap (`generatePage.js`, `astro.config.mjs`).

## Commands

```bash
npm install
npm run fetch -- bellroy.com   # fetch one domain + write its MDX page (debug)
npm run harvest                # discover real stores from Tranco → seed list
npm run demand                 # what people actually search "is X legit" about
npm run demand:audit           # which existing pages have any search demand
npm run demand:resolve         # demand entities → confirmed domains → seed list
npm run generate -- 25         # batch: next 25 unprocessed seed domains
npm run dev                    # local preview
npm run build                  # static build → dist/
```

`generate` accepts `GEN_CONC` (parallel fetches, default 12) and `GEN_COUNT`.
`harvest` accepts `HARVEST_TARGET`, `HARVEST_MAX`, `HARVEST_CONC`.

## Seed source

Domains come from the free [Tranco list](https://tranco-list.eu) (top ~1M sites),
filtered down to **actual stores** by `scripts/harvest-seeds.js`: it fetches each
candidate and keeps only those with a recognised e-commerce platform fingerprint
or clear add-to-cart + cart-link markup, with a denylist for platform vendors and
infrastructure. Confirmed stores are appended to `scripts/seeds/domains.txt`; a
cursor (`harvest-cursor.json`) tracks progress so reruns don't rescan the top of
the list. The Tranco CSV auto-downloads to `data/raw/` (gitignored).

## Deploy (Cloudflare Pages)

1. Push this repo to GitHub.
2. Cloudflare Pages → Create project → connect the repo.
3. Build command `npm run build`, output directory `dist`.
4. Add the custom domain `checkiflegit.com`.

Pushes (including the bot's daily generation commits) auto-deploy.

> **Scale note:** Cloudflare Pages allows a maximum of **20,000 files per
> deployment**. Each store page is its own `index.html`, so the site will hit
> this ceiling around ~18-20k stores. Plan to shard into multiple Pages projects
> (or move the long tail elsewhere) as the count approaches ~15k. Cloudflare's
> free **unlimited bandwidth** is the reason it's preferred here over metered
> hosts for an ad-supported, high-traffic SEO site.

## Scheduled jobs

- `.github/workflows/generate.yml` — runs daily (and on demand), generates pages,
  and pushes them back to the repo (`permissions: contents: write`). Tune via the
  `GEN_COUNT` input.
- `.github/workflows/harvest.yml` — runs weekly (and on demand), tops up the seed
  list with newly discovered stores from Tranco. Tune via the `target` input.

Both push from CI; Cloudflare Pages auto-deploys on push.

## Monetization

Ad slots are placeholder boxes (`src/components/AdSlot.astro`) on the homepage and
each store page. Add your network's script in `src/layouts/BaseLayout.astro` and
swap the slot markup once approved (AdSense/Ezoic/Mediavine, etc.).

## Notes / known limits

- **Trustpilot** often returns HTTP 403 to bots; that correctly yields `unknown`
  (not a negative). A paid API would be needed for reliable review data — out of
  scope by design.
- **Google reviews** presence has no free, reliable signal, so it's reported as
  `unknown` rather than guessed.

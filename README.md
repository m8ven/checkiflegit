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
| Contact info      | Email/phone/address detection in HTML    | `scripts/lib/signals/contact.js` |
| Review footprint  | Trustpilot listing **presence** (status only) | `scripts/lib/signals/reviews.js` |
| Social presence   | Outbound links to major platforms        | `scripts/lib/signals/social.js` |

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
npm run generate -- 25         # batch: next 25 unprocessed seed domains
npm run dev                    # local preview
npm run build                  # static build → dist/
```

## Seed source

`scripts/seeds/domains.txt` — one domain per line. The cheapest bulk source is the
free [Tranco list](https://tranco-list.eu); download the CSV, filter to retail
domains, and append. The generator normalizes domains and skips ones already done.

## Deploy (Cloudflare Pages)

1. Push this repo to GitHub.
2. Cloudflare Pages → Create project → connect the repo.
3. Build command `npm run build`, output directory `dist`.
4. Add the custom domain `checkiflegit.com`.

Pushes (including the bot's daily generation commits) auto-deploy.

## Scheduled generation

`.github/workflows/generate.yml` runs daily (and on demand), generates pages, and
pushes them back to the repo (`permissions: contents: write`). Tune the count via
the `GEN_COUNT` env / workflow input.

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

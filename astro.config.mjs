// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// Static output deploys directly to Cloudflare Pages (free tier) — no adapter needed.
export default defineConfig({
  site: 'https://checkiflegit.com',
  output: 'static',
  integrations: [
    mdx(),
    sitemap({
      // Unreachable / low-signal stores are emitted with noindex and excluded here.
      filter: (page) => !page.includes('/store/_'),
    }),
  ],
  build: {
    // Keep clean URLs: /store/example-com/ instead of /store/example-com.html
    format: 'directory',
  },
});

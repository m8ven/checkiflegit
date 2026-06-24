// E-commerce platform / store detection from homepage HTML.
//
// Used two ways:
//  - by the seed harvester, to decide whether a Tranco domain is actually a
//    store worth generating a page for (`isStore`)
//  - as an informational signal on the page ("built on Shopify", etc.)
//
// PRECISION over recall. We match only asset/code fingerprints that indicate a
// site is *built on* a platform — never bare keyword mentions, which appear in
// the marketing copy of countless non-stores (Stripe, Mailchimp, etc. all
// mention "WooCommerce"). Generic detection requires add-to-cart AND a cart
// link together. This misses some real stores (acceptable); it should almost
// never flag a non-store.

const PLATFORMS = [
  // Store-serving markers only — NOT bare cdn.shopify.com, which also appears
  // when a non-store embeds a Shopify Buy Button widget for merch.
  { name: 'Shopify', re: /Shopify\.theme|window\.Shopify\b|shopify-section|\/cdn\/shop\/|cdn\.shopify\.com\/s\/files|\.myshopify\.com|x-shopify-stage/i },
  { name: 'WooCommerce', re: /wp-content\/plugins\/woocommerce|wc-ajax=|woocommerce\/assets|wc_add_to_cart_params/i },
  { name: 'Magento', re: /data-mage-init|Magento_|mage\/requirejs|Mage\.Cookies/i },
  { name: 'BigCommerce', re: /cdn\d*\.bigcommerce\.com|stencil-utils|data-stencil/i },
  { name: 'PrestaShop', re: /var\s+prestashop\s*=|id=["']prestashop["']|\/modules\/ps_/i },
  { name: 'Salesforce Commerce', re: /\/on\/demandware|dwstatic/i },
  { name: 'BigCartel', re: /bigcartel\.com|data-bc-/i },
  { name: 'Ecwid', re: /app\.ecwid\.com|data-single-product-id|ecwid_script/i },
];

const ADD_TO_CART = /add[\s_-]?to[\s_-]?(cart|bag|basket)|addtocart|wc_add_to_cart/i;
const CART_LINK = /href=["'][^"']*\/(cart|basket)(\/|["'?])/i;
// Links into an actual product catalog. News/SaaS sites have carts (subscriptions,
// licences) but no product/collection catalog — this is what separates them.
const CATALOG = /href=["'][^"']*\/(products?|collections?|catalog(ue)?|category|categories|departments?|shop|store)(\/|["'?])/i;
const PRODUCT_SCHEMA = /"@type"\s*:\s*"Product"|itemtype=["'][^"']*schema\.org\/Product/i;
// News/media homepages sometimes embed a store platform for merch. Exclude them.
const NEWS = /"@type"\s*:\s*"(NewsArticle|NewsMediaOrganization|Newspaper)"|property=["']og:type["'][^>]*content=["']article["']/i;

export function detectPlatform(html) {
  if (!html) {
    return { status: 'unknown', value: { platform: null, isStore: false }, detail: 'No page content to inspect.' };
  }

  let platform = null;
  for (const p of PLATFORMS) {
    if (p.re.test(html)) { platform = p.name; break; }
  }

  const hasAddToCart = ADD_TO_CART.test(html);
  const hasCartLink = CART_LINK.test(html);
  const hasCatalog = CATALOG.test(html) || PRODUCT_SCHEMA.test(html);
  const hasCartFlow = hasAddToCart && hasCartLink && hasCatalog;

  // Harvest gating uses the platform fingerprint ONLY (high-precision; targets the
  // DTC/independent stores people actually question), and excludes news/media
  // homepages that merely embed a store platform for merch. Generic cart markers
  // are too noisy (news/SaaS have /shop sections too) to qualify a domain alone.
  const isNews = NEWS.test(html);
  const isStore = Boolean(platform) && !isNews;

  let status = 'unknown';
  let detail = 'No clear e-commerce platform or storefront markers detected.';
  if (platform) {
    status = 'pass';
    detail = `Built on ${platform}, an established e-commerce platform.`;
  } else if (hasCartFlow) {
    status = 'pass';
    detail = 'Storefront features detected (product catalog with add-to-cart and shopping cart).';
  }

  return {
    status,
    value: { platform, isStore, markers: { hasAddToCart, hasCartLink, hasCatalog, hasCartFlow } },
    detail,
  };
}

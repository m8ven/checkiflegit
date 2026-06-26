// Non-store domains that can slip past detection: e-commerce *platform vendors*
// (whose own sites demo storefront markup), infra / SaaS / registrars / CDNs /
// analytics / news, plus residual WooCommerce-on-non-shopping sites. Plus
// gov/edu/mil TLDs, which are effectively never stores. Shared by the harvester
// and the store audit.
export const DENY_TLD = /\.(gov|mil|int|edu)$|\.(gov|edu|ac)\.[a-z]{2,3}$/i;

export const DENY = new Set([
  // platform vendors
  'shopify.com', 'squarespace.com', 'wix.com', 'weebly.com', 'bigcommerce.com',
  'woocommerce.com', 'odoo.com', 'ecwid.com', 'bigcartel.com', 'prestashop.com', 'magento.com',
  // marketing / SaaS / payments
  'stripe.com', 'paypal.com', 'klaviyo.com', 'mailchimp.com', 'mailchi.mp', 'sendgrid.com',
  'hubspot.com', 'salesforce.com', 'intuit.com', 'twilio.com', 'atlassian.com',
  // registrars / hosting / CDN / infra
  'gandi.net', 'reg.ru', 'nic.ru', 'namecheap.com', 'godaddy.com', 'ionos.com',
  'hostgator.com', 'bluehost.com', 'cloudflare.com', 'fastly.net', 'akamai.com',
  'cpanel.net', 'no-ip.com', 'b-cdn.net', 'cdnvideo.ru', 'workers.dev', 'one.one', 'myfritz.net',
  // CMS / dev / community
  'themeforest.net', 'envato.com', 'wordpress.com', 'wordpress.org', 'wp.com',
  'automattic.com', 'gravatar.com', 'github.com', 'github.io', 'gitlab.com',
  'stackoverflow.com', 'mozilla.org', 'apache.org', 'iso.org',
  // big tech / analytics / misc non-store
  'doubleclick.net', 'google-analytics.com', 'googleapis.com', 'gstatic.com', 'criteo.com',
  'sentry.io', 'unity3d.com', 'zoom.us', 'opera.com', 'meraki.com', 'ui.com',
  'smartthings.com', 'forter.com', 'eset.com', 'webempresa.eu', 'pinimg.com',
  't.me', 'bit.ly', 'discord.gg', 'youtu.be', 'blogspot.com',
  // news / media (often embed a merch store on a real platform)
  'hollywoodreporter.com', 'billboard.com', 'usmagazine.com', 'complex.com', 'allure.com',
  'mindbodygreen.com', 'houstonchronicle.com', 'sfchronicle.com', 'suntimes.com',
  'reviewjournal.com', 'timesunion.com', 'visualcapitalist.com', 'poynter.org', 'meduza.io',
  'guinnessworldrecords.com', 'barchart.com', 'podscribe.com',
  // SaaS / plugins / themes / dev tooling (sell licences via a store platform)
  'yoast.com', 'framer.com', 'framerusercontent.com', 'getresponse.com', 'wpml.org',
  'kadencewp.com', 'superbthemes.com', 'theme-fusion.com', 'avada.com', 'wp-rocket.me',
  'yotpo.com', 'loox.io', 'usercentrics.eu', 'matterport.com', 'plex.tv', 'crealitycloud.com',
  'prodigygame.com', 'facepunch.com', 'datenschutz-generator.de', 'namirial.it', 'iql.ru',
  'evotor.ru', 'youradchoices.ca', 'platform.sh', 'platformsh.site',
  // registrars / domains
  'register.it', 'nominalia.com', '101domain.com', 'websupport.sk', 'xmission.com',
  // residual WooCommerce-on-non-shopping sites found in the first 500 batch
  'aioseo.com', 'wenthemes.com', 'crmback.io', 'heanet.ie', 'webspace-verkauf.de',
  'ecosense.io', 'worldsurfleague.com', 'pch.com',
  // IANA-reserved example/placeholder domains (never real stores)
  'example.com', 'example.org', 'example.net', 'localhost',
]);

export function isDenied(domain) {
  return DENY_TLD.test(domain) || DENY.has(domain);
}

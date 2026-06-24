// Site-wide ad configuration.
//
// While AD_CLIENT is empty, NO ad markup renders anywhere — no boxes, no
// "Advertisement" labels, nothing. To enable ads site-wide later, set AD_CLIENT
// to your network's publisher id (e.g. a Google AdSense 'ca-pub-XXXXXXXX').
// The loader script (BaseLayout) and every <AdSlot/> then activate automatically.
export const AD_CLIENT = '';

export const adsEnabled = AD_CLIENT.trim().length > 0;

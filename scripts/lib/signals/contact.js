// Detect business contact info (email / phone / address) from homepage HTML.
// Presence checks only — we do not store or republish the contact details.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// E.164-ish / common formats with at least 7 digits.
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;
const TEL_RE = /href=["']tel:/i;
// Street addresses, in the three shapes the world actually writes them. The
// original pattern was the English one alone, which detected addresses on
// English-language sites ~3x more often than on everything else (19.2% vs 6.1%
// by TLD group) — an artefact of the regex, not a fact about the stores.
// PAGE_PATTERNS in http.js is multilingual for the same reason.

// Number first: "123 Main Street", "45 Oak Ave, Suite 2".
const ADDRESS_EN =
  /\b\d{1,6}\s+[\w.\s]{2,40}\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|suite|ste|floor|unit)\b/i;

// Germanic/Nordic compound, number last: "Musterstraße 12", "Bahnhofstr. 3",
// "Hoofdstraat 5", "Kerkplein 7", "Storgatan 4".
const ADDRESS_COMPOUND =
  /\b\p{L}[\p{L}.\-]{2,38}(stra(?:ß|ss)e|str\.|gasse|weg|allee|platz|straat|laan|plein|vej|gata|gatan|vei)\s*\.?\s*\d{1,5}\b/iu;

// Type first, number last: "Via Roma 12", "Calle Mayor 5", "ul. Kwiatowa 3",
// "Rua das Flores 100", "Avenida de la Constitución 21", "улица Ленина 5".
//
// Two guards keep this off ordinary English prose, where "via" means "through":
// the street NAME must be capitalised (killing "via email support 24"), and the
// number is capped at 4 digits (killing "via WhatsApp on 12345" — house numbers
// are not 5 digits, phone numbers are). The keyword itself may be either case,
// so the alternation is built rather than written with an /i flag, which would
// also relax the capitalisation guard.
const TYPE_WORDS = [
  'via', 'viale', 'piazza', 'corso', 'strada',        // it
  'calle', 'avenida', 'plaza', 'carrer', 'paseo',     // es/ca
  'rua', 'travessa',                                  // pt
  'ulica', 'ul\\.', 'aleja',                          // pl
  'улица', 'ул\\.', 'проспект',                       // ru
];
// Each keyword in lower, Capitalised and UPPER form. \b is ASCII-only in JS, so
// it never fires before a Cyrillic letter — a letter/digit lookbehind is used
// instead, which works for every script here.
const caseForms = (w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()];
const ADDRESS_TYPE_FIRST = new RegExp(
  `(?<![\\p{L}\\d])(?:${TYPE_WORDS.flatMap(caseForms).join('|')})` +
    `(?:\\s+[\\p{Ll}.\\-]{1,12}){0,2}` +   // optional lowercase connectors: "de la", "das"
    `\\s+\\p{Lu}[\\p{L}.\\-]{1,24}` +      // the capitalised street name
    `[,\\s]+\\d{1,4}(?![\\d])`,
  'u',
);

// French/Iberian number first: "12 rue de la Paix", "8 avenue Victor Hugo".
const ADDRESS_FR =
  /\b\d{1,5}(?:\s*(?:bis|ter))?[,\s]+(rue|avenue|av\.|boulevard|bd\.|chemin|impasse|all[ée]e|quai|route)\s+\p{L}/iu;

const ADDRESS_RES = [ADDRESS_EN, ADDRESS_COMPOUND, ADDRESS_TYPE_FIRST, ADDRESS_FR];

function stripScripts(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

export function checkContactInfo(html) {
  if (!html) {
    return { status: 'unknown', value: {}, detail: 'No page content to inspect.' };
  }
  const cleaned = stripScripts(html);
  // Email: prefer explicit mailto:, fall back to a plausible address in body text.
  const hasMailto = /href=["']mailto:/i.test(html);
  const hasEmail = hasMailto || EMAIL_RE.test(cleaned);
  const hasPhone = TEL_RE.test(html) || PHONE_RE.test(cleaned.replace(/<[^>]+>/g, ' '));
  const text = cleaned.replace(/<[^>]+>/g, ' ');
  const hasAddress = ADDRESS_RES.some((re) => re.test(text));

  const count = [hasEmail, hasPhone, hasAddress].filter(Boolean).length;
  let status = 'fail';
  if (count >= 2) status = 'pass';
  else if (count === 1) status = 'warn';

  const present = [
    hasEmail && 'email',
    hasPhone && 'phone',
    hasAddress && 'address',
  ].filter(Boolean);

  return {
    status,
    value: { email: hasEmail, phone: hasPhone, address: hasAddress },
    detail: present.length
      ? `Public contact details found: ${present.join(', ')}.`
      : 'No public contact details detected on the homepage.',
  };
}

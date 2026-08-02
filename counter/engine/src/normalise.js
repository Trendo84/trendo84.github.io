/**
 * Listing titles are written by four different merchandising teams who agree on
 * nothing. This turns them into something comparable.
 */

/** Brands we recognise. Order matters only for multi-word brands. */
const BRANDS = [
  "milwaukee", "makita", "dewalt", "bosch", "ryobi", "aeg", "hikoki", "hitachi",
  "festool", "metabo", "paslode", "stanley", "sidchrome", "kincrome", "toolpro",
  "sika", "selleys", "bostik", "parbond", "hb fuller",
  "reece", "holman", "kembla", "crane", "iplex", "vinidex",
  "3m", "gp", "norton", "flexovit", "josco", "diablo"
];

/** Words that carry no signal and only dilute the fuzzy score. */
const STOP = new Set([
  "the", "and", "with", "for", "a", "of", "in", "to",
  "tool", "tools", "only", "skin", "bare", "body",
  "new", "genuine", "pack", "pk", "each", "ea", "per",
  "trade", "professional", "pro", "heavy", "duty", "premium", "quality"
]);

/** Unit suffixes we understand, normalised to a base so 1L === 1000ml. */
const UOM = {
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  litre: { base: "ml", factor: 1000 },
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  mm: { base: "mm", factor: 1 },
  cm: { base: "mm", factor: 10 },
  m: { base: "mm", factor: 1000 }
};

/** Strip trademark noise, collapse punctuation, lowercase. */
export function clean(title) {
  return String(title)
    .toLowerCase()
    .replace(/[®™©]/g, " ")
    // "15mm x 3m" → "15mm 3m". The leading \s matters: without it this eats
    // the trailing x of any word before a number ("sikaflex 11fc" → "sikafle").
    .replace(/\s[×x]\s*(?=\d)/g, " ")
    .replace(/[^a-z0-9.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First recognised brand in the title, or null. */
export function brandOf(title) {
  const t = clean(title);
  return BRANDS.find(b => t.includes(b)) ?? null;
}

/**
 * A model code is a token mixing letters and digits that isn't a measurement —
 * DTD153Z, M18FID2, GSR18V. This is the single most reliable signal we have.
 */
export function modelOf(title) {
  const tokens = clean(title).split(" ");
  const candidates = tokens.filter(tok => {
    if (tok.length < 4 || tok.length > 16) return false;
    if (!/[a-z]/.test(tok) || !/\d/.test(tok)) return false;
    if (isMeasurement(tok)) return false;
    return true;
  });
  // Longest wins: "m18fid2" beats "18v".
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function isMeasurement(tok) {
  return /^\d+(\.\d+)?(v|ah|mm|cm|m|ml|l|g|kg|w|pc|pk|tpi)$/.test(tok);
}

/**
 * Voltage, capacity and size are hard constraints, never fuzzy signals. An 18V
 * and a 40V tool can share every other word and still be different products.
 */
export function constraintsOf(title) {
  const t = clean(title);
  const out = {};

  const volts = t.match(/(\d+(?:\.\d+)?)\s?v\b/);
  if (volts) out.volts = Number(volts[1]);

  const amps = t.match(/(\d+(?:\.\d+)?)\s?ah\b/);
  if (amps) out.ampHours = Number(amps[1]);

  const size = t.match(/(\d+(?:\.\d+)?)\s?(ml|l|litre|g|kg|mm|cm|m)\b/);
  if (size && UOM[size[2]]) {
    const { base, factor } = UOM[size[2]];
    out.size = Number(size[1]) * factor;
    out.uom = base;
  }

  const packQty = t.match(/(\d+)\s?(?:pk|pack|pce|pcs|piece)\b/);
  if (packQty) out.packQty = Number(packQty[1]);

  return out;
}

/**
 * Meaningful tokens only, deduplicated, for fuzzy comparison.
 *
 * Hyphenated tokens are kept *and* split: one merchant writes "sikaflex-11fc"
 * where another writes "sikaflex 11fc", and without this they score as
 * strangers despite being the same tube of sealant.
 */
export function tokensOf(title) {
  const out = [];
  for (const tok of clean(title).split(" ")) {
    for (const part of [tok, ...(tok.includes("-") ? tok.split("-") : [])]) {
      if (part.length > 1 && !STOP.has(part) && !/^\d+$/.test(part)) out.push(part);
    }
  }
  return [...new Set(out)];
}

/** Everything a matcher needs, computed once per listing. */
export function fingerprint(listing) {
  const title = listing.title ?? "";
  return {
    gtin: listing.gtin ?? null,
    brand: brandOf(title),
    model: modelOf(title),
    constraints: constraintsOf(title),
    tokens: tokensOf(title)
  };
}

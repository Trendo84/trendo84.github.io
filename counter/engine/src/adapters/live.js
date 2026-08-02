import { get, productsFromJsonLd } from "../http.js";

/**
 * Live adapter template.
 *
 * Every merchant needs its own search URL and, occasionally, its own fallback
 * parser. The JSON-LD path below works unchanged on most retail platforms —
 * try it first and only write a selector parser when it comes back empty.
 *
 * Verify each `searchUrl` against the live site before trusting it, and read
 * the merchant's terms first. Where an affiliate product feed exists, use that
 * instead: it is licensed, structured, and it pays you.
 */

export const SOURCES = {
  bunnings: {
    id: "bunnings",
    searchUrl: q => `https://www.bunnings.com.au/search/products?q=${encodeURIComponent(q)}`,
    verified: false
  },
  "total-tools": {
    id: "total-tools",
    searchUrl: q => `https://www.totaltools.com.au/catalogsearch/result/?q=${encodeURIComponent(q)}`,
    verified: false
  },
  "sydney-tools": {
    id: "sydney-tools",
    searchUrl: q => `https://sydneytools.com.au/search?q=${encodeURIComponent(q)}`,
    verified: false
  },
  blackwoods: {
    id: "blackwoods",
    searchUrl: q => `https://www.blackwoods.com.au/search?text=${encodeURIComponent(q)}`,
    verified: false
  },
  reece: {
    id: "reece",
    searchUrl: q => `https://www.reece.com.au/search?q=${encodeURIComponent(q)}`,
    verified: false
  }
};

/**
 * Fetch and parse one merchant's search results.
 * @returns {Promise<import("./index.js").Listing[]>}
 */
export async function fetchLive(merchantId, query, options = {}) {
  const source = SOURCES[merchantId];
  if (!source) throw new Error(`No live source configured for ${merchantId}`);

  const { body } = await get(source.searchUrl(query), options);
  const parsed = productsFromJsonLd(body);

  return parsed
    .filter(p => p.title && Number.isFinite(p.priceCents))
    .map(p => ({
      merchantId,
      sku: p.sku || slug(p.title),
      title: p.title,
      priceCents: p.priceCents,
      inStock: p.inStock,
      gtin: p.gtin,
      url: p.url
    }));
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48);

/**
 * Quick check that a merchant still parses, without committing a scrape run to
 * the archive. Run this after any merchant redesign.
 *
 *   node -e 'import("./src/adapters/live.js").then(m=>m.probe("bunnings","impact driver").then(console.log))'
 */
export async function probe(merchantId, query = "impact driver") {
  try {
    const listings = await fetchLive(merchantId, query);
    return {
      merchantId,
      ok: listings.length > 0,
      found: listings.length,
      sample: listings[0]?.title ?? null
    };
  } catch (err) {
    return { merchantId, ok: false, error: String(err.message) };
  }
}

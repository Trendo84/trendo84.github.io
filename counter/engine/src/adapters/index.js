import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");

/**
 * Every merchant adapter is this shape. Keeping the contract this thin is
 * deliberate — adding a merchant should be an afternoon, because the catalogue
 * growing on request is the whole coverage promise.
 *
 * @typedef {Object} Listing
 * @property {string} merchantId
 * @property {string} sku
 * @property {string} title
 * @property {number} priceCents
 * @property {boolean} [inStock]
 * @property {{size:number, uom:string}} [unit]
 * @property {string} [gtin]
 * @property {string} [url]
 */

export const MERCHANTS = [
  { id: "bunnings",     name: "Bunnings Trade", colour: "#0D7B3E" },
  { id: "total-tools",  name: "Total Tools",    colour: "#E01E26" },
  { id: "sydney-tools", name: "Sydney Tools",   colour: "#F5A623" },
  { id: "blackwoods",   name: "Blackwoods",     colour: "#2C6CB0" },
  { id: "reece",        name: "Reece",          colour: "#00539B" }
];

/**
 * Fixture-backed source. Swap the body for a real fetch when running locally —
 * check the merchant's terms first, and prefer an affiliate product feed over
 * scraping wherever one is offered.
 */
export async function fetchListings({ merchantId, query }) {
  const raw = await readFile(join(FIXTURES, `${merchantId}.json`), "utf8");
  /** @type {Listing[]} */
  const listings = JSON.parse(raw);
  if (!query) return listings;

  const needle = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listings.filter(l => {
    const hay = l.title.toLowerCase();
    return needle.every(word => hay.includes(word));
  });
}

/** Pull one query across every merchant, tolerating individual failures. */
export async function fetchAll(query) {
  const results = await Promise.allSettled(
    MERCHANTS.map(m => fetchListings({ merchantId: m.id, query }))
  );

  const listings = [];
  const failures = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") listings.push(...res.value);
    else failures.push({ merchantId: MERCHANTS[i].id, error: String(res.reason) });
  });

  // A merchant being down must never look like a bargain. Callers surface
  // failures rather than quietly comparing across a smaller set.
  return { listings, failures };
}

export const merchantName = id =>
  MERCHANTS.find(m => m.id === id)?.name ?? id;

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Polite fetching. You are a guest on someone else's server and you want to be
 * doing this every day for years, so the defaults here are deliberately slow.
 *
 * Before pointing this at a live merchant: read their terms, check
 * /robots.txt, and use an affiliate product feed instead wherever one exists.
 * A feed is licensed, structured, and nobody has to be talked out of blocking
 * you later.
 */

const DEFAULTS = {
  minDelayMs: 1500,        // per host, between requests
  timeoutMs: 15000,
  retries: 2,
  cacheDir: ".cache",
  cacheTtlMs: 12 * 60 * 60 * 1000,
  userAgent: "CounterBot/0.1 (+https://trendo84.github.io/counter/; price comparison; contact: you@example.com)"
};

const lastHit = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle(host, minDelayMs) {
  const previous = lastHit.get(host) ?? 0;
  const wait = previous + minDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function cacheKey(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 32) + ".html";
}

/**
 * GET with per-host throttling, retry-with-backoff, and an on-disk cache so
 * development never re-hits a live site for the same page twice.
 */
export async function get(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { host } = new URL(url);
  const cachePath = join(opts.cacheDir, cacheKey(url));

  if (opts.cacheTtlMs > 0) {
    try {
      const [body, stat] = await Promise.all([
        readFile(cachePath, "utf8"),
        readFile(cachePath + ".at", "utf8")
      ]);
      if (Date.now() - Number(stat) < opts.cacheTtlMs) return { body, cached: true };
    } catch { /* cold cache, carry on */ }
  }

  let lastError;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt) await sleep(opts.minDelayMs * Math.pow(2, attempt));
    await throttle(host, opts.minDelayMs);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": opts.userAgent, "Accept": "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: "follow"
      });

      // 429 and 5xx are worth retrying. 403 means stop — they've said no, and
      // hammering it is how you turn a grey area into a legal letter.
      if (res.status === 403) throw new Error(`403 refused by ${host} — stop and use a feed`);
      if (!res.ok) throw new Error(`${res.status} from ${host}`);

      const body = await res.text();
      if (opts.cacheTtlMs > 0) {
        await mkdir(opts.cacheDir, { recursive: true });
        await Promise.all([
          writeFile(cachePath, body),
          writeFile(cachePath + ".at", String(Date.now()))
        ]);
      }
      return { body, cached: false };
    } catch (err) {
      lastError = err;
      if (String(err.message).startsWith("403")) break;
    }
  }
  throw lastError;
}

/**
 * Pull schema.org Product data out of a page.
 *
 * Nearly every retail platform emits JSON-LD for SEO, and it is far more
 * stable than CSS selectors — marketing redesigns the page monthly, but the
 * structured data has to keep working or they lose their Google rich results.
 * Selector scraping is the fallback, not the plan.
 */
export function productsFromJsonLd(html) {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];

  const products = [];
  for (const [, raw] of blocks) {
    let parsed;
    try { parsed = JSON.parse(raw.trim()); } catch { continue; }
    for (const node of flatten(parsed)) {
      if (!isProduct(node)) continue;
      const offer = [].concat(node.offers ?? [])[0] ?? {};
      const price = Number(offer.price ?? offer.lowPrice);
      if (!Number.isFinite(price)) continue;

      products.push({
        title: String(node.name ?? "").trim(),
        sku: String(node.sku ?? node.mpn ?? "").trim(),
        gtin: node.gtin13 ?? node.gtin ?? node.gtin12 ?? undefined,
        priceCents: Math.round(price * 100),
        currency: offer.priceCurrency ?? "AUD",
        inStock: !/OutOfStock|SoldOut/i.test(String(offer.availability ?? "")),
        url: offer.url ?? node.url
      });
    }
  }
  return products;
}

function isProduct(node) {
  const type = node?.["@type"];
  return Array.isArray(type) ? type.includes("Product") : type === "Product";
}

/** JSON-LD nests under @graph, arrays, and itemListElement. Walk the lot. */
function flatten(node, out = []) {
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const key of ["@graph", "itemListElement", "item", "mainEntity"]) {
    if (node[key]) flatten(node[key], out);
  }
  return out;
}

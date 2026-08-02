#!/usr/bin/env node
import { fetchAll } from "./adapters/index.js";
import { groupListings } from "./match.js";
import { openStore } from "./store.js";
import { buildDigest, formatDigest } from "./alerts.js";

/**
 * The daily job. One run per day is enough — prices move overnight, not hourly,
 * and the snapshot table is unique per day so extra runs are wasted requests.
 *
 *   node src/ingest.js                       # today, into counter.db
 *   node src/ingest.js 2026-08-02 counter.db
 *
 * Cron (6am AEST, staggered off the hour so you're not hitting every merchant
 * at exactly the same second as everyone else's scraper):
 *
 *   7 6 * * *  cd /path/to/engine && /usr/bin/node src/ingest.js >> ingest.log 2>&1
 */

const [, , day = new Date().toISOString().slice(0, 10), dbPath = "counter.db"] = process.argv;

const store = openStore(dbPath);
const started = Date.now();

// Human decisions are applied before scoring, so a resolved listing never
// re-enters the queue after tomorrow's run.
const { listings, failures } = await fetchAll("");
const { products, review } = groupListings(listings, { overrides: store.overrides() });

let snapshots = 0;
for (const group of products) {
  store.recordProduct(group, day);
  snapshots += group.members.length;
}

console.log(`[${day}] ${products.length} products, ${snapshots} snapshots, ${Date.now() - started}ms`);

store.queueReview(review, day);
if (review.length) {
  const atStake = review.reduce((n, r) => n + r.priceImpactCents, 0);
  console.log(`[${day}] ${review.length} listing(s) queued for review, ` +
    `$${(atStake / 100).toFixed(2)} of price difference at stake:`);
  for (const r of review.slice(0, 10)) {
    console.log(`         ${r.reason.padEnd(22)} ${r.merchantId}/${r.sku}` +
      `  $${(r.priceImpactCents / 100).toFixed(2)}`);
  }
}

// A merchant failing is not a neutral event: that day's comparison is
// incomplete, and the gap needs to be visible in the log rather than inferred
// later from a suspiciously flat price series.
for (const f of failures) {
  console.warn(`[${day}] MERCHANT UNAVAILABLE ${f.merchantId} — ${f.error}`);
}

const digest = buildDigest(store, products.map(p => p.id), { minPercent: 2 });
if (digest.items.length) {
  const titles = new Map(products.map(p => [p.id, p.members[0].listing.title]));
  console.log("\n" + formatDigest(digest, { titleFor: id => titles.get(id) ?? id }));
}

store.close();

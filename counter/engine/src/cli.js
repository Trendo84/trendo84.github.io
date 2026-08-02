#!/usr/bin/env node
import { fetchAll, merchantName } from "./adapters/index.js";
import { groupListings, toComparison } from "./match.js";
import { openStore } from "./store.js";

const money = cents => "$" + (cents / 100).toFixed(2);
const [, , command = "compare", ...rest] = process.argv;

if (command === "compare") {
  const query = rest.join(" ");
  const { listings, failures } = await fetchAll(query);
  const { products, review } = groupListings(listings);

  if (!products.length) {
    console.log(`No listings matched ${JSON.stringify(query)}.`);
    process.exit(0);
  }

  for (const group of products) {
    const cmp = toComparison(group);
    console.log(`\n${group.members[0].listing.title}`);
    console.log(`  ${group.id}  ·  spread ${money(cmp.spreadCents)}`);
    console.log("  " + "─".repeat(66));

    for (const row of cmp.rows) {
      const name = merchantName(row.merchantId).padEnd(16);
      const price = row.inStock ? money(row.priceCents).padStart(9) : "     —   ";
      const delta = !row.inStock ? "not stocked"
        : row.isCheapest ? "cheapest"
        : "+" + money(row.deltaCents);
      const conf = row.confidence < 1 ? `  (${row.confidence.toFixed(2)})` : "";
      console.log(`  ${name}${price}   ${delta.padEnd(14)}${conf}`);
    }
  }

  if (review.length) {
    console.log(`\n${review.length} listing(s) held for review:`);
    for (const r of review) {
      const impact = r.priceImpactCents ? `  ${money(r.priceImpactCents)} at stake` : "";
      console.log(`  ${r.reason.padEnd(22)} ${r.merchantId}/${r.sku}${impact}`);
    }
  }
  for (const f of failures) {
    console.log(`\n! ${f.merchantId} unavailable — excluded from comparison, not treated as expensive`);
  }

} else if (command === "ingest") {
  const day = rest[0] ?? new Date().toISOString().slice(0, 10);
  const store = openStore(rest[1] ?? "counter.db");
  const { listings } = await fetchAll("");
  const { products } = groupListings(listings);

  for (const group of products) store.recordProduct(group, day);
  console.log(`Recorded ${products.length} products for ${day}.`);

  const [first] = products;
  if (first) {
    const moves = store.movements(first.id, { minPercent: 1 });
    console.log(moves.length
      ? `${moves.length} price movement(s) on ${first.id}.`
      : `No movements yet on ${first.id} — needs a second day of snapshots.`);
  }
  store.close();

} else {
  console.log("usage: cli.js [compare <query> | ingest [YYYY-MM-DD] [db-path]]");
  process.exit(1);
}

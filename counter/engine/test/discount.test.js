import test from "node:test";
import assert from "node:assert/strict";

import { fetchAll } from "../src/adapters/index.js";
import { groupListings, toComparison } from "../src/match.js";
import { applyDiscounts, normaliseDiscounts, effectivePrice, basketSaving } from "../src/discount.js";
import { openStore } from "../src/store.js";
import { buildDigest, formatDigest } from "../src/alerts.js";

async function driverComparison() {
  const { listings } = await fetchAll("impact driver");
  const { products } = groupListings(listings);
  return toComparison(products.find(p => p.id === "makita:dtd153z"));
}

test("rejects nonsense discounts instead of trusting them", () => {
  assert.deepEqual(
    normaliseDiscounts({ a: -5, b: 0, c: "nope", d: 200, e: 12.5 }),
    { d: 95, e: 12.5 },
    "negatives and junk dropped, absurd values clamped"
  );
});

test("effective price rounds to whole cents", () => {
  assert.equal(effectivePrice(19900, 8), 18308);
  assert.equal(effectivePrice(19900, 0), 19900);
  assert.equal(effectivePrice(1499, 33.3), 1000);
});

test("no discounts leaves the ordering alone", async () => {
  const cmp = await driverComparison();
  const same = applyDiscounts(cmp, {});
  assert.deepEqual(same.rows.map(r => r.merchantId), cmp.rows.map(r => r.merchantId));
  assert.equal(same.winnerSwitched, false);
});

test("a big account discount changes who is actually cheapest", async () => {
  const cmp = await driverComparison();
  assert.equal(cmp.rows.find(r => r.isCheapest).merchantId, "sydney-tools");

  // Blackwoods is dearest on list at $214 but 25% off beats Sydney's $179.
  const mine = applyDiscounts(cmp, { blackwoods: 25 });
  assert.equal(mine.yourWinner, "blackwoods");
  assert.equal(mine.listWinner, "sydney-tools");
  assert.equal(mine.winnerSwitched, true, "this is the whole point of the feature");
  assert.equal(mine.rows[0].priceCents, 16050);
  assert.equal(mine.rows[0].listPriceCents, 21400, "list price is kept for the strikethrough");
});

test("discounted rows still report a correct delta to the new cheapest", async () => {
  const cmp = await driverComparison();
  const mine = applyDiscounts(cmp, { blackwoods: 25 });
  const cheapest = mine.rows[0].priceCents;
  for (const row of mine.rows.filter(r => r.inStock)) {
    assert.equal(row.deltaCents, row.priceCents - cheapest);
  }
});

test("basket saving totals list against account", async () => {
  const cmp = await driverComparison();
  const { listTotal, yourTotal, savingCents } = basketSaving([cmp], { sydney: 0, blackwoods: 25 });
  assert.equal(listTotal, 17900);
  assert.equal(yourTotal, 16050);
  assert.equal(savingCents, 1850);
});

test("digest reports a rise and names the merchant", async () => {
  const store = openStore(":memory:");
  const { listings } = await fetchAll("impact driver");
  const { products } = groupListings(listings);
  const group = products.find(p => p.id === "makita:dtd153z");

  store.recordProduct(group, "2026-08-01");
  for (const m of group.members) m.listing.priceCents += 1500;
  store.recordProduct(group, "2026-08-02");

  const digest = buildDigest(store, [group.id], { minPercent: 2 });
  assert.ok(digest.rises.length >= 4, "every merchant moved");
  assert.equal(digest.drops.length, 0);

  const text = formatDigest(digest, { titleFor: () => "Makita DTD153Z" });
  assert.match(text, /RISES/);
  assert.match(text, /Bunnings Trade/);
  store.close();
});

test("several small rises are reported as creep, not ignored", async () => {
  const store = openStore(":memory:");
  const { listings } = await fetchAll("sikaflex");
  const { products } = groupListings(listings);
  const group = products[0];

  // Four 3% rises: no single one is alarming, the sum of them is.
  const days = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"];
  for (const day of days) {
    store.recordProduct(group, day);
    for (const m of group.members) m.listing.priceCents = Math.round(m.listing.priceCents * 1.03);
  }

  const digest = buildDigest(store, [group.id], { minPercent: 2 });
  assert.ok(digest.creep.length, "creep detected across multiple small rises");

  const worst = digest.creep[0];
  assert.ok(worst.steps >= 3);
  assert.ok(worst.percent > 9, `cumulative rise should exceed any single step, got ${worst.percent}`);
  assert.match(formatDigest(digest), /QUIET CLIMBS/);
  store.close();
});

test("an empty watch list produces a digest that says so, not a crash", () => {
  const store = openStore(":memory:");
  assert.equal(formatDigest(buildDigest(store, [])), "No price movements on your watch list this week.");
  store.close();
});

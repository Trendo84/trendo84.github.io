import test from "node:test";
import assert from "node:assert/strict";

import { brandOf, modelOf, constraintsOf, tokensOf } from "../src/normalise.js";
import { dice, constraintsAgree, scorePair, groupListings, toComparison } from "../src/match.js";
import { fingerprint } from "../src/normalise.js";
import { fetchAll } from "../src/adapters/index.js";
import { openStore } from "../src/store.js";

test("extracts brand and model code from merchant prose", () => {
  const title = "Makita 18V Brushless Impact Driver Skin Only DTD153Z";
  assert.equal(brandOf(title), "makita");
  assert.equal(modelOf(title), "dtd153z");
});

test("does not mistake a measurement for a model code", () => {
  assert.equal(modelOf("Josco 100mm Grinding Disc 10 Pack"), null);
  assert.equal(modelOf("Makita 18V Impact Driver"), null);
});

test("reads voltage, capacity and pack size as constraints", () => {
  assert.deepEqual(constraintsOf("Makita DTD153Z 18V Impact Driver"), { volts: 18 });
  assert.deepEqual(constraintsOf("Sikaflex 11FC 300ml Grey"), { size: 300, uom: "ml" });
  assert.equal(constraintsOf("Josco Disc 10 Pack").packQty, 10);
  assert.equal(constraintsOf("Sika Sealant 1L").size, 1000, "litres normalise to ml");
});

test("splits hyphenated model codes so spelling variants still meet", () => {
  const a = tokensOf("Sika Sikaflex-11FC Sealant 300ml");
  const b = tokensOf("Sika Sikaflex 11FC Sealant 300ml");
  assert.ok(a.includes("sikaflex") && a.includes("11fc"));
  assert.ok(dice(a, b) > 0.8);
});

test("a differing declared constraint is fatal, silence is not", () => {
  assert.equal(constraintsAgree({ volts: 18 }, { volts: 40 }), false);
  assert.equal(constraintsAgree({ volts: 18 }, {}), true, "unstated voltage must not penalise");
  assert.equal(constraintsAgree({ size: 300, uom: "ml" }, { size: 600, uom: "ml" }), false);
});

test("matching GTINs beat everything, mismatched GTINs kill the pair", () => {
  const a = fingerprint({ title: "Sika Sikaflex-11FC 300ml", gtin: "9312345678901" });
  const b = fingerprint({ title: "Totally Different Words 300ml", gtin: "9312345678901" });
  assert.deepEqual(scorePair(a, b), { score: 1, reason: "gtin" });

  const c = fingerprint({ title: "Sika Sikaflex-11FC 300ml", gtin: "0000000000000" });
  assert.equal(scorePair(a, c).score, 0);
});

test("brand + model outranks fuzzy, and a fuzzy match can never reach it", () => {
  const a = fingerprint({ title: "Makita 18V Brushless Impact Driver Skin Only DTD153Z" });
  const b = fingerprint({ title: "Makita DTD153Z 18V Cordless Brushless Impact Driver" });
  const exact = scorePair(a, b);
  assert.equal(exact.reason, "brand+model");
  assert.equal(exact.score, 0.95);

  const fuzzy = scorePair(
    fingerprint({ title: "Josco 100mm Metal Grinding Disc 10 Pack" }),
    fingerprint({ title: "Josco Grinding Disc Metal 100mm 10 Pack" })
  );
  assert.equal(fuzzy.reason, "fuzzy");
  assert.ok(fuzzy.score <= 0.85, "fuzzy is capped below a model-code match");
});

test("groups the same driver across four merchants and rejects the 40V", async () => {
  const { listings } = await fetchAll("impact driver");
  const { products } = groupListings(listings);

  const eighteen = products.find(p => p.id === "makita:dtd153z");
  assert.ok(eighteen, "18V group exists");
  const merchants = new Set(eighteen.members.map(m => m.listing.merchantId));
  assert.deepEqual([...merchants].sort(),
    ["blackwoods", "bunnings", "sydney-tools", "total-tools"]);

  const forty = products.find(p => p.id === "makita:td001gz");
  assert.ok(forty, "40V is its own product, never folded into the 18V");
});

test("two SKUs from one merchant: keeps the better, sends the other to review", async () => {
  const { listings } = await fetchAll("impact driver");
  const { products, review } = groupListings(listings);

  const group = products.find(p => p.id === "makita:dtd153z");
  const sydney = group.members.filter(m => m.listing.merchantId === "sydney-tools");
  assert.equal(sydney.length, 1, "one row per merchant in a comparison");

  const dupe = review.find(r => r.reason === "duplicate-merchant-sku");
  assert.ok(dupe, "the loser is queued, not silently dropped");
});

test("comparison sorts by price, flags cheapest, keeps out-of-stock visible", async () => {
  const { listings } = await fetchAll("grinding disc");
  const { products } = groupListings(listings);
  const cmp = toComparison(products[0]);

  assert.equal(cmp.rows[0].merchantId, "total-tools");
  assert.equal(cmp.cheapestCents, 1995);
  assert.ok(cmp.rows[0].isCheapest);
  assert.equal(cmp.rows[1].deltaCents, 2100 - 1995);

  const oos = cmp.rows.find(r => r.merchantId === "blackwoods");
  assert.equal(oos.inStock, false);
  assert.equal(oos.isCheapest, false, "out of stock is never the cheapest");
  assert.equal(cmp.rows.at(-1).merchantId, "blackwoods", "out of stock sorts last");
});

test("unit price makes different pack sizes comparable", async () => {
  const { listings } = await fetchAll("sikaflex");
  const { products } = groupListings(listings);
  const cmp = toComparison(products[0]);
  const cheapest = cmp.rows.find(r => r.isCheapest);
  assert.equal(cheapest.unitPriceCents, Math.round(1490 / 300));
});

test("snapshots are append-only and a same-day re-run changes nothing", async () => {
  const store = openStore(":memory:");
  const { listings } = await fetchAll("impact driver");
  const { products } = groupListings(listings);
  const group = products.find(p => p.id === "makita:dtd153z");

  store.recordProduct(group, "2026-08-01");
  store.recordProduct(group, "2026-08-01");
  assert.equal(store.latest(group.id).length, 4, "re-running a scrape must be idempotent");

  store.close();
});

test("a price rise is two rows, and shows up as a movement", async () => {
  const store = openStore(":memory:");
  const { listings } = await fetchAll("impact driver");
  const { products } = groupListings(listings);
  const group = products.find(p => p.id === "makita:dtd153z");

  store.recordProduct(group, "2026-08-01");
  for (const m of group.members) m.listing.priceCents += 1000;
  store.recordProduct(group, "2026-08-02");

  const history = store.history(group.id, "bunnings");
  assert.equal(history.length, 2, "yesterday's price is still there");
  assert.equal(history[0].price_cents, 19900);
  assert.equal(history[1].price_cents, 20900);

  const moves = store.movements(group.id, { minPercent: 1 });
  assert.ok(moves.some(m => m.merchantId === "bunnings" && m.percent > 4));
  store.close();
});

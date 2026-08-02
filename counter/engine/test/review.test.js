import test from "node:test";
import assert from "node:assert/strict";

import { groupListings, scorePair, NEAR_MISS_FLOOR, REVIEW_THRESHOLD } from "../src/match.js";
import { fingerprint } from "../src/normalise.js";
import { openStore } from "../src/store.js";

/** Terse vs verbose titles for the same disc — the case Dice is worst at. */
const TERSE = {
  merchantId: "bunnings", sku: "A1", priceCents: 2100, inStock: true,
  title: "Josco 100mm Grinding Disc 10 Pack"
};
const VERBOSE = {
  merchantId: "total-tools", sku: "B1", priceCents: 1995, inStock: true,
  title: "Josco Industrial Abrasive Metal Grinding Disc 100mm 6mm 16mm Bore 10 Pack Trade"
};
/** Same brand, no shared detail — genuinely weak evidence. */
const UNRELATED = {
  merchantId: "reece", sku: "C1", priceCents: 899, inStock: true,
  title: "Josco Grinder Wheel"
};

test("the near-miss pair lands in the band the floor was chosen for", () => {
  const score = scorePair(fingerprint(TERSE), fingerprint(VERBOSE)).score;
  assert.ok(score >= NEAR_MISS_FLOOR && score < REVIEW_THRESHOLD,
    `expected ${NEAR_MISS_FLOOR} ≤ ${score} < ${REVIEW_THRESHOLD}`);
});

test("a near miss stays two products but gets queued, with the money at stake", () => {
  const { products, review } = groupListings([TERSE, VERBOSE]);
  assert.equal(products.length, 2, "still shown separately — we do not guess");

  const item = review.find(r => r.reason === "near-miss");
  assert.ok(item, "queued rather than silently split");
  assert.equal(item.merchantId, "total-tools");
  assert.equal(item.candidateProductId, products[0].id);
  assert.equal(item.priceImpactCents, 2100 - 1995,
    "impact is what the user's number moves by if this goes the other way");
});

test("below the floor there is no near-miss — that queue would be unworkable", () => {
  const { review } = groupListings([TERSE, UNRELATED]);
  assert.ok(scorePair(fingerprint(TERSE), fingerprint(UNRELATED)).score < NEAR_MISS_FLOOR);
  assert.equal(review.filter(r => r.reason === "near-miss").length, 0);
});

test("a lone-merchant product is queued even when no score came close", () => {
  const { review } = groupListings([TERSE, UNRELATED]);
  const flagged = review.filter(r => r.reason === "single-merchant").map(r => r.sku).sort();
  assert.deepEqual(flagged, ["A1", "C1"],
    "across five merchants, stocked by one is usually a matching failure");
});

test("the queue is ordered by money, not by score", () => {
  const cheap = { merchantId: "blackwoods", sku: "D1", priceCents: 2095, inStock: true,
    title: "Josco 100mm Grinding Disc 10 Pack Metal" };
  const { review } = groupListings([TERSE, VERBOSE, cheap]);
  const impacts = review.map(r => r.priceImpactCents);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a));
});

test("a merge override forces the group and skips scoring entirely", () => {
  const overrides = new Map([
    ["bunnings|A1",    { mergeInto: "josco:100gd10", blocked: new Set() }],
    ["total-tools|B1", { mergeInto: "josco:100gd10", blocked: new Set() }]
  ]);
  const { products, review } = groupListings([TERSE, VERBOSE], { overrides });

  assert.equal(products.length, 1);
  assert.equal(products[0].id, "josco:100gd10");
  assert.equal(products[0].members.length, 2);
  assert.equal(review.length, 0, "a decided listing is not re-queued under any reason");
});

test("a split override stops a match the scorer would otherwise make", () => {
  const a = { merchantId: "bunnings", sku: "M1", priceCents: 19900, inStock: true,
    title: "Makita 18V Brushless Impact Driver Skin Only DTD153Z" };
  const b = { merchantId: "total-tools", sku: "M2", priceCents: 18900, inStock: true,
    title: "Makita DTD153Z 18V Cordless Brushless Impact Driver" };

  assert.equal(scorePair(fingerprint(a), fingerprint(b)).score, 0.95, "these normally merge");

  const overrides = new Map([
    ["total-tools|M2", { mergeInto: null, blocked: new Set(["makita:dtd153z"]) }]
  ]);
  const { products } = groupListings([a, b], { overrides });
  assert.equal(products.length, 2, "the human's no wins over a 0.95");
});

test("store: a new merge replaces the old one, splits accumulate", () => {
  const store = openStore(":memory:");
  store.addOverride("bunnings", "A1", "josco:one", "merge");
  store.addOverride("bunnings", "A1", "josco:two", "merge");
  store.addOverride("bunnings", "A1", "makita:dtd153z", "split");
  store.addOverride("bunnings", "A1", "sika:11fc", "split");

  const rule = store.overrides().get("bunnings|A1");
  assert.equal(rule.mergeInto, "josco:two", "a listing belongs to one product");
  assert.deepEqual([...rule.blocked].sort(), ["makita:dtd153z", "sika:11fc"]);
  store.close();
});

test("store: re-queuing keeps first_seen and never resurrects a decision", () => {
  const store = openStore(":memory:");
  const item = { merchantId: "total-tools", sku: "B1", reason: "near-miss",
    title: "Josco", candidateProductId: "sku:bunnings:a1", score: 0.57, priceImpactCents: 105 };

  store.queueReview([item], "2026-08-01");
  store.resolveReview("total-tools", "B1", "near-miss", "ignore");
  store.queueReview([{ ...item, priceImpactCents: 300 }], "2026-08-02");

  assert.equal(store.pendingReview().length, 0, "an ignored item does not come back");
  const row = store.db.prepare(`SELECT * FROM review_queue`).get();
  assert.equal(row.first_seen, "2026-08-01");
  assert.equal(row.last_seen, "2026-08-02");
  assert.equal(row.price_impact_cents, 300, "impact still refreshes");
  store.close();
});

test("resolving needs a product id for merge and split, but not to ignore", () => {
  const store = openStore(":memory:");
  store.queueReview([{ merchantId: "b", sku: "1", reason: "near-miss" }], "2026-08-01");
  assert.throws(() => store.resolveReview("b", "1", "near-miss", "merge"), /needs a productId/);
  store.resolveReview("b", "1", "near-miss", "ignore");
  assert.equal(store.pendingReview().length, 0);
  store.close();
});

test("the loop closes: resolve once, and tomorrow's run honours it", () => {
  const store = openStore(":memory:");
  const listings = [TERSE, VERBOSE];

  // Day one: two products, one queued.
  const day1 = groupListings(listings, { overrides: store.overrides() });
  store.queueReview(day1.review, "2026-08-01");
  assert.equal(day1.products.length, 2);
  const queued = store.pendingReview();
  assert.ok(queued.length > 0);

  // A human merges the near miss into the product it nearly matched.
  const nearMiss = queued.find(r => r.reason === "near-miss");
  store.resolveReview(nearMiss.merchant_id, nearMiss.sku, "near-miss",
    "merge", nearMiss.candidate_product_id);
  // ...and the listing it should join needs to point at the same product.
  store.addOverride("bunnings", "A1", nearMiss.candidate_product_id, "merge");

  // Day two: same raw listings, different answer.
  const day2 = groupListings(listings, { overrides: store.overrides() });
  store.queueReview(day2.review, "2026-08-02");

  assert.equal(day2.products.length, 1, "one product, as the human said");
  assert.equal(day2.products[0].members.length, 2);
  assert.equal(day2.review.length, 0, "and it does not come back tomorrow");
  assert.equal(store.pendingReview().length, 0,
    "including the single-merchant row the same listing was also queued under");
  store.close();
});

test("deciding a listing supersedes its other pending rows", () => {
  const store = openStore(":memory:");
  store.queueReview([
    { merchantId: "bunnings", sku: "A1", reason: "near-miss", priceImpactCents: 105 },
    { merchantId: "bunnings", sku: "A1", reason: "single-merchant", priceImpactCents: 0 },
    { merchantId: "reece", sku: "C1", reason: "single-merchant", priceImpactCents: 0 }
  ], "2026-08-01");
  assert.equal(store.pendingReview().length, 3);

  store.resolveReview("bunnings", "A1", "near-miss", "merge", "josco:100gd10");

  const pending = store.pendingReview();
  assert.equal(pending.length, 1, "both rows for A1 are settled, C1 is untouched");
  assert.equal(pending[0].merchant_id, "reece");
  store.close();
});

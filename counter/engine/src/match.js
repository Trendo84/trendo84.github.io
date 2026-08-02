import { fingerprint } from "./normalise.js";

/** At or above this, two listings are the same product. */
export const REVIEW_THRESHOLD = 0.72;

/**
 * Below REVIEW_THRESHOLD but at or above this, a listing starts its own group
 * *and* gets queued for a human. Below it, it starts its own group silently.
 *
 * 0.45 rather than something higher because Dice scales with title verbosity:
 * a perfect subset match between a four-token title and a twelve-token one
 * scores around 0.5 by construction. A higher floor would silently discard the
 * terse-vs-verbose case, which is both the matcher's weakest spot and the one
 * most likely to be a real match.
 *
 * This is a config constant, not a truth. A week of live ingest will say more
 * about it than any amount of reasoning.
 */
export const NEAR_MISS_FLOOR = 0.45;

/** A fuzzy match must never outrank a model-code match. */
const FUZZY_CEILING = 0.85;

/**
 * Dice coefficient over two token sets. Chosen over Jaccard because it's
 * kinder to listings of unequal length, and merchant titles vary wildly in
 * verbosity — Blackwoods writes essays, Sydney Tools writes four words.
 */
export function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter(tok => setB.has(tok)).length;
  return (2 * shared) / (a.length + b.length);
}

/**
 * Hard constraints. Any disagreement on a constraint both listings declare is
 * fatal, regardless of how similar the text is. Silence is not disagreement —
 * if only one listing mentions voltage we don't punish it.
 */
export function constraintsAgree(a, b) {
  for (const key of ["volts", "ampHours", "packQty"]) {
    if (a[key] != null && b[key] != null && a[key] !== b[key]) return false;
  }
  if (a.size != null && b.size != null) {
    if (a.uom !== b.uom) return false;
    if (a.size !== b.size) return false;
  }
  return true;
}

/**
 * Score one pair of listings.
 * @returns {{score: number, reason: string}}
 */
export function scorePair(fpA, fpB) {
  if (!constraintsAgree(fpA.constraints, fpB.constraints)) {
    return { score: 0, reason: "constraint-mismatch" };
  }

  if (fpA.gtin && fpB.gtin) {
    return fpA.gtin === fpB.gtin
      ? { score: 1, reason: "gtin" }
      : { score: 0, reason: "gtin-mismatch" };
  }

  if (fpA.model && fpB.model && fpA.model === fpB.model) {
    const brandsClash = fpA.brand && fpB.brand && fpA.brand !== fpB.brand;
    if (!brandsClash) return { score: 0.95, reason: "brand+model" };
  }

  if (fpA.brand && fpB.brand && fpA.brand !== fpB.brand) {
    return { score: 0, reason: "brand-mismatch" };
  }

  const score = Math.min(dice(fpA.tokens, fpB.tokens), FUZZY_CEILING);
  return { score, reason: "fuzzy" };
}

/**
 * Group listings from many merchants into products.
 *
 * Greedy single-pass clustering: each listing joins the best-scoring existing
 * group above threshold, otherwise it starts its own. Good enough at this
 * scale, and every decision is inspectable — which matters more than elegance
 * when you're hand-checking the review queue.
 *
 * One listing per merchant per group: if two Bunnings SKUs both look like the
 * same product, the better-scoring one wins and the loser goes to review
 * rather than silently vanishing.
 *
 * @param {Array} listings
 * @returns {{products: Array, review: Array}}
 */
export function groupListings(listings, options = {}) {
  const { overrides = new Map(), floor = NEAR_MISS_FLOOR } = options;
  const groups = [];
  const review = [];
  const nearMisses = [];

  for (const listing of listings) {
    const fp = fingerprint(listing);
    const rule = overrides.get(overrideKey(listing));

    // A human already decided this one. Skip scoring entirely — that is what
    // makes a resolved listing stay resolved across re-derivation.
    if (rule?.mergeInto) {
      let group = groups.find(g => g.id === rule.mergeInto);
      if (!group) {
        group = { id: rule.mergeInto, fingerprint: fp, members: [] };
        groups.push(group);
      }
      group.members.push({ listing, score: 1, reason: "override" });
      continue;
    }

    // Track the best candidate even below threshold — the queue needs to know
    // what a listing *nearly* matched, not just that it matched nothing.
    let best = null;
    for (const group of groups) {
      if (rule?.blocked.has(group.id)) continue;   // human said: not this one
      const { score, reason } = scorePair(fp, group.fingerprint);
      if (!best || score > best.score) best = { group, score, reason };
    }

    if (best && best.score >= REVIEW_THRESHOLD) {
      const clash = best.group.members.find(m => m.listing.merchantId === listing.merchantId);
      if (clash) {
        // Two SKUs from one merchant claiming the same product. Keep the stronger.
        const loser = best.score > clash.score ? clash.listing : listing;
        if (best.score > clash.score) {
          best.group.members = best.group.members.filter(m => m !== clash);
          best.group.members.push({ listing, score: best.score, reason: best.reason });
        }
        review.push(reviewItem(loser, "duplicate-merchant-sku", best.group, best.score));
        continue;
      }
      best.group.members.push({ listing, score: best.score, reason: best.reason });
      continue;
    }

    groups.push({
      id: productId(fp, listing),
      fingerprint: fp,
      members: [{ listing, score: 1, reason: "seed" }]
    });

    if (best && best.score >= floor) {
      nearMisses.push({ listing, candidate: best.group, score: best.score });
    }
  }

  for (const nm of nearMisses) {
    review.push(reviewItem(nm.listing, "near-miss", nm.candidate, nm.score));
  }

  // A product only one of five merchants stocks is either genuinely exclusive
  // or a matching failure, and the second is far more common. This catches the
  // case a score threshold never sees: two listings for the same item worded
  // so differently they never came close, each rendering alone.
  const queued = new Set(review.map(r => `${r.merchantId}|${r.sku}`));
  for (const group of groups) {
    if (new Set(group.members.map(m => m.listing.merchantId)).size !== 1) continue;
    const { listing } = group.members[0];
    if (queued.has(overrideKey(listing))) continue;
    // A human has already ruled on this listing. Re-queuing it under a
    // different reason is the same recurrence bug one level up.
    if (overrides.has(overrideKey(listing))) continue;

    const nearest = bestOtherGroup(group, groups);
    review.push(reviewItem(listing, "single-merchant", nearest?.group ?? null, nearest?.score ?? null));
  }

  // Worth-most-money first: the reviewer's first ten clicks should be the ten
  // that change what a user sees.
  review.sort((a, b) => b.priceImpactCents - a.priceImpactCents);

  return { products: groups, review };
}

const overrideKey = listing => `${listing.merchantId}|${listing.sku}`;

/** Cheapest in-stock price in a group, falling back to cheapest overall. */
function cheapestOf(group) {
  const prices = group.members.filter(m => m.listing.inStock !== false).map(m => m.listing.priceCents);
  const all = group.members.map(m => m.listing.priceCents);
  return Math.min(...(prices.length ? prices : all));
}

function bestOtherGroup(group, groups) {
  let best = null;
  for (const other of groups) {
    if (other === group) continue;
    const { score } = scorePair(group.fingerprint, other.fingerprint);
    if (score > 0 && (!best || score > best.score)) best = { group: other, score };
  }
  return best;
}

/**
 * Price impact is the point of the ranking: how much the number a user sees
 * would move if this decision went the other way. Absolute, because both
 * directions mislead someone — if the loose listing is cheaper, the group's
 * shoppers see too high a price; if dearer, its own page does.
 */
function reviewItem(listing, reason, candidate, score) {
  return {
    merchantId: listing.merchantId,
    sku: listing.sku,
    title: listing.title,
    reason,
    candidateProductId: candidate?.id ?? null,
    score: score == null ? null : Number(score.toFixed(3)),
    priceImpactCents: candidate ? Math.abs(cheapestOf(candidate) - listing.priceCents) : 0
  };
}

/** Stable, human-readable id. Falls back to the merchant SKU when unbranded. */
function productId(fp, listing) {
  if (fp.gtin) return `gtin:${fp.gtin}`;
  if (fp.brand && fp.model) return `${fp.brand}:${fp.model}`;
  return `sku:${listing.merchantId}:${String(listing.sku).toLowerCase()}`;
}

/**
 * Turn a group into the row the landing page renders: sorted by price,
 * cheapest flagged, out-of-stock kept visible rather than hidden.
 */
export function toComparison(group) {
  const rows = group.members
    .map(m => ({
      merchantId: m.listing.merchantId,
      sku: m.listing.sku,
      title: m.listing.title,
      priceCents: m.listing.priceCents,
      inStock: m.listing.inStock !== false,
      unitPriceCents: unitPrice(m.listing),
      confidence: m.score
    }))
    .sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      return a.priceCents - b.priceCents;
    });

  const available = rows.filter(r => r.inStock);
  const best = available.length ? available[0].priceCents : null;

  return {
    productId: group.id,
    rows: rows.map(r => ({
      ...r,
      isCheapest: r.inStock && r.priceCents === best,
      deltaCents: best == null || !r.inStock ? null : r.priceCents - best
    })),
    cheapestCents: best,
    spreadCents: available.length > 1
      ? available[available.length - 1].priceCents - best
      : 0
  };
}

function unitPrice(listing) {
  const size = listing.unit?.size;
  if (!size || size <= 0) return null;
  return Math.round(listing.priceCents / size);
}

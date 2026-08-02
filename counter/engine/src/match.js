import { fingerprint } from "./normalise.js";

/** Below this, a pairing is never shown to a user — it goes to review. */
export const REVIEW_THRESHOLD = 0.72;

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
export function groupListings(listings) {
  const groups = [];
  const review = [];

  for (const listing of listings) {
    const fp = fingerprint(listing);
    let best = null;

    for (const group of groups) {
      const { score, reason } = scorePair(fp, group.fingerprint);
      if (score >= REVIEW_THRESHOLD && (!best || score > best.score)) {
        best = { group, score, reason };
      }
    }

    if (!best) {
      groups.push({
        id: productId(fp, listing),
        fingerprint: fp,
        members: [{ listing, score: 1, reason: "seed" }]
      });
      continue;
    }

    const clash = best.group.members.find(m => m.listing.merchantId === listing.merchantId);
    if (clash) {
      // Two SKUs from one merchant claiming the same product. Keep the stronger.
      const loser = best.score > clash.score ? clash : { listing, score: best.score, reason: best.reason };
      if (best.score > clash.score) {
        best.group.members = best.group.members.filter(m => m !== clash);
        best.group.members.push({ listing, score: best.score, reason: best.reason });
      }
      review.push({ listing: loser.listing, why: "duplicate-merchant-sku", groupId: best.group.id });
      continue;
    }

    best.group.members.push({ listing, score: best.score, reason: best.reason });
  }

  return { products: groups, review };
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

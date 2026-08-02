/**
 * Trade discounts are negotiated per account, so nobody outside it can see
 * them. The user tells us theirs once per merchant and every comparison is
 * recalculated against what they actually pay.
 *
 * The interesting output isn't the cheaper number — it's when the winner
 * changes. A merchant who looks dearest on list is often cheapest on account,
 * and that's the whole reason to bother.
 */

/** Percent off list, clamped to something sane. Bad input becomes zero. */
export function normaliseDiscounts(input = {}) {
  const out = {};
  for (const [merchantId, raw] of Object.entries(input)) {
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    out[merchantId] = Math.min(pct, 95);
  }
  return out;
}

export function effectivePrice(priceCents, percentOff = 0) {
  if (!percentOff) return priceCents;
  return Math.round(priceCents * (1 - percentOff / 100));
}

/**
 * Rebuild a comparison against the user's own pricing.
 *
 * @param {ReturnType<import("./match.js").toComparison>} comparison
 * @param {Record<string, number>} discounts percent off list, by merchant id
 */
export function applyDiscounts(comparison, discounts = {}) {
  const pct = normaliseDiscounts(discounts);

  const rows = comparison.rows.map(row => {
    const percentOff = pct[row.merchantId] ?? 0;
    return {
      ...row,
      percentOff,
      listPriceCents: row.priceCents,
      priceCents: effectivePrice(row.priceCents, percentOff)
    };
  });

  rows.sort((a, b) => {
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return a.priceCents - b.priceCents;
  });

  const available = rows.filter(r => r.inStock);
  const best = available.length ? available[0].priceCents : null;

  const listWinner = comparison.rows.find(r => r.isCheapest)?.merchantId ?? null;
  const yourWinner = available[0]?.merchantId ?? null;

  return {
    ...comparison,
    rows: rows.map(r => ({
      ...r,
      isCheapest: r.inStock && r.priceCents === best,
      deltaCents: best == null || !r.inStock ? null : r.priceCents - best
    })),
    cheapestCents: best,
    spreadCents: available.length > 1
      ? available[available.length - 1].priceCents - best
      : 0,
    listWinner,
    yourWinner,
    // The headline: your account changes who you should be buying from.
    winnerSwitched: Boolean(listWinner && yourWinner && listWinner !== yourWinner)
  };
}

/** Total saving across a basket, list vs. account, for the spend-leak report. */
export function basketSaving(comparisons, discounts = {}) {
  let listTotal = 0;
  let yourTotal = 0;

  for (const cmp of comparisons) {
    const withDiscount = applyDiscounts(cmp, discounts);
    if (cmp.cheapestCents == null || withDiscount.cheapestCents == null) continue;
    listTotal += cmp.cheapestCents;
    yourTotal += withDiscount.cheapestCents;
  }

  return { listTotal, yourTotal, savingCents: listTotal - yourTotal };
}

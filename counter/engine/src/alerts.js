import { merchantName } from "./adapters/index.js";

/**
 * "Four rises, none announced." The archive only earns its keep if someone
 * reads it back, so this turns snapshot history into the weekly email.
 */

const money = cents => "$" + (cents / 100).toFixed(2);

/**
 * @param {ReturnType<import("./store.js").openStore>} store
 * @param {string[]} productIds the user's watch list
 */
export function buildDigest(store, productIds, { minPercent = 2, since = null } = {}) {
  const items = [];

  for (const productId of productIds) {
    for (const move of store.movements(productId, { minPercent })) {
      if (since && move.on < since) continue;
      items.push({ productId, ...move });
    }
  }

  // Biggest movement first — a 14% jump matters more than four 2% ones.
  items.sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent));

  const rises = items.filter(i => i.percent > 0);
  const drops = items.filter(i => i.percent < 0);

  return {
    items,
    rises,
    drops,
    // Creep is the quiet one: several small rises on the same product from the
    // same merchant. No single move trips an alert, the sum of them does.
    creep: findCreep(items)
  };
}

function findCreep(items) {
  const byPair = new Map();
  for (const item of items) {
    const key = `${item.productId}|${item.merchantId}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(item);
  }

  const out = [];
  for (const [key, moves] of byPair) {
    if (moves.length < 2) continue;
    const rises = moves.filter(m => m.percent > 0);
    if (rises.length < 2) continue;

    const [productId, merchantId] = key.split("|");
    const ordered = [...moves].sort((a, b) => a.on.localeCompare(b.on));
    const from = ordered[0].from;
    const to = ordered[ordered.length - 1].to;
    out.push({
      productId,
      merchantId,
      steps: rises.length,
      from,
      to,
      percent: Number((((to - from) / from) * 100).toFixed(2))
    });
  }
  return out.sort((a, b) => b.percent - a.percent);
}

/** Plain text, because a trade email that renders in every client beats a pretty one. */
export function formatDigest(digest, { titleFor = id => id } = {}) {
  if (!digest.items.length) return "No price movements on your watch list this week.";

  const lines = [];

  if (digest.creep.length) {
    lines.push("QUIET CLIMBS");
    for (const c of digest.creep) {
      lines.push(`  ${titleFor(c.productId)}`);
      lines.push(`    ${merchantName(c.merchantId)}: ${money(c.from)} → ${money(c.to)} ` +
                 `over ${c.steps} rises (+${c.percent}%)`);
    }
    lines.push("");
  }

  if (digest.drops.length) {
    lines.push("DROPS");
    for (const d of digest.drops.slice(0, 10)) {
      lines.push(`  ${titleFor(d.productId)} — ${merchantName(d.merchantId)} ` +
                 `${money(d.from)} → ${money(d.to)} (${d.percent}%) on ${d.on}`);
    }
    lines.push("");
  }

  if (digest.rises.length) {
    lines.push("RISES");
    for (const r of digest.rises.slice(0, 10)) {
      lines.push(`  ${titleFor(r.productId)} — ${merchantName(r.merchantId)} ` +
                 `${money(r.from)} → ${money(r.to)} (+${r.percent}%) on ${r.on}`);
    }
  }

  return lines.join("\n").trim();
}

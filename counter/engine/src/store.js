import { DatabaseSync } from "node:sqlite";

/**
 * Append-only price archive.
 *
 * Snapshots are never updated and never deleted. A price "change" is two rows,
 * not one row edited — that's the entire point of the product, and the one
 * thing a competitor starting later cannot reconstruct.
 */
export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      brand       TEXT,
      model       TEXT,
      title       TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY,
      product_id   TEXT NOT NULL,
      merchant_id  TEXT NOT NULL,
      sku          TEXT NOT NULL,
      price_cents  INTEGER NOT NULL,
      in_stock     INTEGER NOT NULL,
      captured_at  TEXT NOT NULL,
      UNIQUE (product_id, merchant_id, captured_at)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_product
      ON snapshots (product_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS signups (
      email       TEXT PRIMARY KEY,
      source      TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watches (
      email       TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (email, product_id)
    );

    -- Human decisions about matching. Keyed on (merchant_id, sku) because
    -- that is the only thing stable across re-derivation: groupListings()
    -- rebuilds product ids from the listings on every run.
    --
    -- Both polarities are required. Without 'split', a reviewer rejecting a
    -- bad match watches it reappear identically after tomorrow's ingest.
    CREATE TABLE IF NOT EXISTS match_overrides (
      merchant_id TEXT NOT NULL,
      sku         TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      polarity    TEXT NOT NULL CHECK (polarity IN ('merge', 'split')),
      note        TEXT,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (merchant_id, sku, product_id, polarity)
    );

    -- One row per listing needing a decision, never one per candidate pair.
    CREATE TABLE IF NOT EXISTS review_queue (
      merchant_id          TEXT NOT NULL,
      sku                  TEXT NOT NULL,
      reason               TEXT NOT NULL,
      title                TEXT,
      candidate_product_id TEXT,
      score                REAL,
      price_impact_cents   INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'pending',
      first_seen           TEXT NOT NULL,
      last_seen            TEXT NOT NULL,
      resolved_at          TEXT,
      PRIMARY KEY (merchant_id, sku, reason)
    );

    CREATE INDEX IF NOT EXISTS idx_review_pending
      ON review_queue (status, price_impact_cents DESC);
  `);

  const insertProduct = db.prepare(`
    INSERT INTO products (id, brand, model, title, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);

  // Idempotent by day: re-running a scrape can't invent a price movement.
  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots (product_id, merchant_id, sku, price_cents, in_stock, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (product_id, merchant_id, captured_at) DO NOTHING
  `);

  return {
    db,

    /** @param {string} capturedAt ISO date, e.g. "2026-08-02" */
    recordProduct(group, capturedAt) {
      const { brand, model } = group.fingerprint;
      const title = group.members[0]?.listing.title ?? group.id;
      insertProduct.run(group.id, brand, model, title, capturedAt);

      for (const { listing } of group.members) {
        insertSnapshot.run(
          group.id,
          listing.merchantId,
          String(listing.sku),
          listing.priceCents,
          listing.inStock === false ? 0 : 1,
          capturedAt
        );
      }
    },

    /** Latest price per merchant for one product. */
    latest(productId) {
      return db.prepare(`
        SELECT s.* FROM snapshots s
        JOIN (
          SELECT merchant_id, MAX(captured_at) AS captured_at
          FROM snapshots WHERE product_id = ? GROUP BY merchant_id
        ) newest
          ON newest.merchant_id = s.merchant_id
         AND newest.captured_at = s.captured_at
        WHERE s.product_id = ?
        ORDER BY s.price_cents ASC
      `).all(productId, productId);
    },

    /** Full price series for one merchant — the archive, read back. */
    history(productId, merchantId) {
      return db.prepare(`
        SELECT captured_at, price_cents, in_stock
        FROM snapshots
        WHERE product_id = ? AND merchant_id = ?
        ORDER BY captured_at ASC
      `).all(productId, merchantId);
    },

    /**
     * Price moves above a threshold, in a window. This is what powers alerts
     * and the "four rises, none announced" pitch on the landing page.
     */
    movements(productId, { minPercent = 1 } = {}) {
      const rows = db.prepare(`
        SELECT merchant_id, captured_at, price_cents
        FROM snapshots WHERE product_id = ?
        ORDER BY merchant_id, captured_at ASC
      `).all(productId);

      const out = [];
      let prev = null;
      for (const row of rows) {
        if (prev && prev.merchant_id === row.merchant_id && prev.price_cents !== row.price_cents) {
          const pct = ((row.price_cents - prev.price_cents) / prev.price_cents) * 100;
          if (Math.abs(pct) >= minPercent) {
            out.push({
              merchantId: row.merchant_id,
              from: prev.price_cents,
              to: row.price_cents,
              percent: Number(pct.toFixed(2)),
              on: row.captured_at
            });
          }
        }
        prev = row;
      }
      return out;
    },

    // ── Matching overrides ──────────────────────────────────────────────

    /**
     * Record a human decision.
     * @param {"merge"|"split"} polarity
     */
    addOverride(merchantId, sku, productId, polarity, note = null) {
      const now = new Date().toISOString();
      // A listing belongs to exactly one product, so a new merge replaces any
      // previous one. Splits accumulate — a listing can be "not that, and not
      // that either".
      if (polarity === "merge") {
        db.prepare(`DELETE FROM match_overrides WHERE merchant_id = ? AND sku = ? AND polarity = 'merge'`)
          .run(merchantId, String(sku));
      }
      db.prepare(`
        INSERT INTO match_overrides (merchant_id, sku, product_id, polarity, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (merchant_id, sku, product_id, polarity) DO UPDATE SET note = excluded.note
      `).run(merchantId, String(sku), productId, polarity, note, now);

      // One listing can sit in the queue under several reasons at once — a
      // near miss that is also the only merchant stocking it. Deciding the
      // listing settles all of them; leaving the others pending would put the
      // same item back in front of the reviewer with nothing left to decide.
      db.prepare(`
        UPDATE review_queue SET status = 'superseded', resolved_at = ?
        WHERE merchant_id = ? AND sku = ? AND status = 'pending'
      `).run(now, merchantId, String(sku));
    },

    /**
     * Every override, shaped for the matcher.
     * @returns {Map<string, {mergeInto: string|null, blocked: Set<string>}>}
     */
    overrides() {
      const map = new Map();
      for (const row of db.prepare(`SELECT * FROM match_overrides`).all()) {
        const key = `${row.merchant_id}|${row.sku}`;
        if (!map.has(key)) map.set(key, { mergeInto: null, blocked: new Set() });
        const rule = map.get(key);
        if (row.polarity === "merge") rule.mergeInto = row.product_id;
        else rule.blocked.add(row.product_id);
      }
      return map;
    },

    // ── Review queue ────────────────────────────────────────────────────

    /**
     * Upsert today's queue. Re-seeing an item refreshes its impact and
     * last_seen but never resurrects one a human has already resolved, and
     * never loses the date it first appeared.
     */
    queueReview(items, day = new Date().toISOString().slice(0, 10)) {
      const stmt = db.prepare(`
        INSERT INTO review_queue
          (merchant_id, sku, reason, title, candidate_product_id, score,
           price_impact_cents, status, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (merchant_id, sku, reason) DO UPDATE SET
          title                = excluded.title,
          candidate_product_id = excluded.candidate_product_id,
          score                = excluded.score,
          price_impact_cents   = excluded.price_impact_cents,
          last_seen            = excluded.last_seen
      `);
      for (const item of items) {
        stmt.run(item.merchantId, String(item.sku), item.reason, item.title ?? null,
          item.candidateProductId ?? null, item.score ?? null,
          item.priceImpactCents ?? 0, day, day);
      }
    },

    /** Worth-most-money first. A queue sorted by score trains you to skim it. */
    pendingReview(limit = 50) {
      return db.prepare(`
        SELECT * FROM review_queue WHERE status = 'pending'
        ORDER BY price_impact_cents DESC, score DESC LIMIT ?
      `).all(limit);
    },

    /**
     * Resolve one queue item and write the override that makes it stick.
     *
     * @param {"merge"|"split"|"ignore"} decision
     * @param {string} [productId] required for merge and split
     */
    resolveReview(merchantId, sku, reason, decision, productId = null, note = null) {
      if ((decision === "merge" || decision === "split") && !productId) {
        throw new Error(`${decision} needs a productId`);
      }
      if (decision !== "ignore") {
        this.addOverride(merchantId, sku, productId, decision, note);
      }
      db.prepare(`
        UPDATE review_queue SET status = ?, resolved_at = ?
        WHERE merchant_id = ? AND sku = ? AND reason = ?
      `).run(decision, new Date().toISOString(), merchantId, String(sku), reason);
    },

    reviewCounts() {
      return db.prepare(`
        SELECT status, COUNT(*) AS n, SUM(price_impact_cents) AS impact
        FROM review_queue GROUP BY status
      `).all();
    },

    /** Early-access capture. Idempotent — signing up twice is not an error. */
    addSignup(email, source = "counter-landing") {
      db.prepare(`
        INSERT INTO signups (email, source, created_at) VALUES (?, ?, ?)
        ON CONFLICT (email) DO NOTHING
      `).run(String(email).trim().toLowerCase(), source, new Date().toISOString());
    },

    signupCount() {
      return db.prepare(`SELECT COUNT(*) AS n FROM signups`).get().n;
    },

    watch(email, productId) {
      db.prepare(`
        INSERT INTO watches (email, product_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT (email, product_id) DO NOTHING
      `).run(String(email).toLowerCase(), productId, new Date().toISOString());
    },

    watchedBy(email) {
      return db.prepare(`SELECT product_id FROM watches WHERE email = ?`)
        .all(String(email).toLowerCase())
        .map(r => r.product_id);
    },

    close() { db.close(); }
  };
}

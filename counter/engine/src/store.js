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

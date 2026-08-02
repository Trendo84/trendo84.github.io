# Counter — price engine

Zero-dependency prototype of the part that actually matters: turning four
merchants' messy product listings into one comparable row, and keeping every
price forever.

Plain ESM JavaScript, Node 22+, no npm install. Uses `node:sqlite` and
`node:test` from the standard library so it runs anywhere Node does.

```bash
cd counter/engine
node --test              # run the matcher tests
node src/cli.js compare "makita impact driver"
node src/cli.js ingest   # load fixtures into the snapshot store
```

## Why this shape

The scraping is the boring part and every competitor can do it. The two things
that are genuinely hard, and therefore worth owning:

1. **Matching** — the same impact driver is `DTD153Z`, `DTD153Z 18V Impact
   Driver Skin`, and `Makita 18V Brushless Impact Driver (Tool Only)` across
   three merchants, with three different SKUs and no shared identifier. Get
   this wrong and every price you show is a lie.
2. **The archive** — snapshots are append-only and never updated in place.
   Nobody can go back and collect last year's prices, which is the whole moat.

## Layout

| Path | Does |
|---|---|
| `src/normalise.js` | Title → brand, model code, capacity tokens, clean token set |
| `src/match.js` | Groups listings across merchants into products, with confidence |
| `src/store.js` | Append-only SQLite snapshot store + comparison queries |
| `src/adapters/` | One module per merchant, all satisfying the same contract |
| `fixtures/` | Real-shaped listing data so tests never touch the network |

## Adapter contract

Each merchant module exports:

```js
export const merchant = { id: "sydney-tools", name: "Sydney Tools" };
export async function fetchListings({ query, fixture }) { /* → Listing[] */ }
```

A `Listing` is:

```js
{
  merchantId: "sydney-tools",
  sku: "DTD153Z",
  title: "Makita DTD153Z 18V Brushless Impact Driver - Skin Only",
  priceCents: 17900,
  currency: "AUD",
  inStock: true,
  unit: { size: 1, uom: "ea" },   // optional
  gtin: "0088381803670",          // optional, wins over everything if present
  url: "https://..."
}
```

Adapters are fixture-driven here. Point `fetchListings` at the live source when
you run it locally — check each merchant's terms first, and prefer an affiliate
product feed over scraping wherever one exists.

## Matching, in order

1. **GTIN** — if both listings carry one and they agree, done, confidence 1.0.
2. **Brand + model code** — `makita` + `dtd153z`. Confidence 0.95. This is the
   workhorse; model codes are stable and merchants nearly always print them.
3. **Fuzzy** — Dice coefficient over normalised tokens, with capacity and
   voltage treated as hard constraints (an 18V never matches a 40V, a 300ml
   never matches a 600ml, however similar the words are). Confidence is the
   Dice score, capped at 0.85 so a fuzzy match never outranks a real one.

Anything below `REVIEW_THRESHOLD` (0.72) is not shown to users. It goes to a
review queue, gets matched by hand once, and is remembered. That manual pass is
the unglamorous work that keeps this defensible.

## Storage

Two tables. `products` is the canonical catalogue you build up over time.
`snapshots` is append-only — one row per merchant per product per day, never
updated, never deleted.

```sql
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  in_stock INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (product_id, merchant_id, captured_at)
);
```

The `UNIQUE` constraint makes a re-run idempotent: scraping twice in one day
can't create a phantom price movement.

## Not done yet

- Live adapters (fixtures only)
- Per-user trade discount maths
- Price-move alerting
- The review queue UI

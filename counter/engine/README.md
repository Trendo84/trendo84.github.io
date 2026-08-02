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

- **Live adapters are unverified.** `src/adapters/live.js` has a search URL per
  merchant, none of them checked against the real site. Everything runs on
  fixtures until you do that.
- **No review queue UI.** Held listings are reported by the CLI and the ingest
  job, but matching them by hand is still a database edit.
- **No email delivery.** `formatDigest()` produces the text; nothing sends it.
- **No auth.** The API is open, so don't put it on a public host as-is.

## Running the whole thing

```bash
cd counter/engine
node src/server.js          # http://localhost:8787
```

| Route | Serves |
|---|---|
| `/` | The landing page |
| `/app/` | The working search UI |
| `/api/search?q=…&discounts=bunnings:8,reece:22` | Comparisons, discounted |
| `/api/history?id=makita:dtd153z&merchant=bunnings` | One merchant's price series |
| `/api/signup` | POST `{email}` — writes to SQLite |

The landing page form posts to `/api/signup` automatically when served from
localhost, and stays in demo mode on GitHub Pages where there's no backend.
Paste a hosted endpoint into `SIGNUP` in `counter/index.html` to change that.

The daily job:

```bash
node src/ingest.js                        # today
node src/ingest.js 2026-08-02 counter.db  # a specific day
```

Cron it once a day, not hourly — prices move overnight and the snapshot table
is unique per day, so extra runs are wasted requests.

## Trade discounts

The differentiator, and the reason the landing page admits it shows list price.
Discounts live in the browser's localStorage, go to the API as a query param,
and never touch the archive — Counter stores what merchants publish, not what
any individual pays.

The output worth having isn't the smaller number, it's `winnerSwitched`: on
list Sydney Tools wins the Makita at $179, but 25% off at Blackwoods makes
their $214 into $160.50. Different shop, opposite answer.

## Going live

`src/adapters/live.js` holds one entry per merchant. Each `searchUrl` is
**unverified** — check it against the real site before trusting it.

Parsing goes after schema.org JSON-LD first, not CSS selectors. Almost every
retail platform emits it for Google rich results, which means it survives the
redesigns that break selectors, and they can't quietly drop it without losing
search traffic.

`src/http.js` is deliberately slow: 1.5s between requests per host, exponential
backoff, a 12-hour disk cache so development never re-hits a live page, and a
hard stop on 403 rather than retrying into a legal letter. Read each merchant's
terms and robots.txt first, and take an affiliate product feed over scraping
wherever one exists — licensed, structured, and it pays you.

Check a merchant still parses after a redesign:

```bash
node -e 'import("./src/adapters/live.js").then(m=>m.probe("bunnings").then(console.log))'
```

## Alerts

`buildDigest()` reads the archive back. Beyond single jumps it detects *creep* —
several small rises from the same merchant on the same product, where no
individual move trips a threshold but the cumulative climb matters. Four 3%
rises is 12.5%, and nobody sends a letter about it.

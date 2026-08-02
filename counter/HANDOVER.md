# Counter — handover

Everything needed to pick this up locally. Read top to bottom once; after that
the section headings are the index.

---

## 1. Getting the latest code

The code lives on a branch of the GitHub Pages repo, not on `main`.

| | |
|---|---|
| Repo | `https://github.com/Trendo84/trendo84.github.io` |
| Branch | `claude/saas-ideas-brainstorm-a6kito` |
| Latest commit | `7e7f3c6` — "Add review queue schema and the matching override path" |
| Folder | `counter/` |

Fresh clone:

```bash
git clone https://github.com/Trendo84/trendo84.github.io.git
cd trendo84.github.io
git checkout claude/saas-ideas-brainstorm-a6kito
cd counter/engine
node --test          # expect 34 passing
```

Already have a clone:

```bash
git fetch origin claude/saas-ideas-brainstorm-a6kito
git checkout claude/saas-ideas-brainstorm-a6kito
git pull origin claude/saas-ideas-brainstorm-a6kito
```

**If you're working from the zip, you're behind.** The zip was cut at commit
`e10c258`, before the review queue landed. Pull `7e7f3c6` or re-clone — don't
merge the zip folder by hand.

Verify you're current:

```bash
git log --oneline -1        # 7e7f3c6
cd counter/engine && node --test | grep '^# pass'   # 34
```

Requirements: **Node 22.5+**, nothing else. No npm install, no dependencies —
`node:sqlite` and `node:test` come from the standard library. `node:sqlite`
prints an experimental warning on every run; that's expected, not a problem.

---

## 2. What Counter is

Live price comparison for Australian trades. One search across Bunnings, Total
Tools, Sydney Tools, Blackwoods and Reece, showing today's price at each.

Chosen after checking 52 other ideas against the market — nearly every SaaS
niche with an obvious name already had three or more incumbents, usually with
free tiers. This one survived: no SKU-level trade price comparison exists in
Australia. TradePricer does it in the UK but only Screwfix vs Toolstation.
Rawlinsons and Cordell sell construction *estimating* data to quantity
surveyors — different buyer, different product, not live retail prices.

**The moat is the price archive, not the code.** Snapshots accumulate from day
one and nobody can backfill history later. Scraping is commodity; the SKU
matching and the archive are the defensible parts.

---

## 3. Current state

```
counter/
  HANDOVER.md             this file
  index.html              landing page
  app/index.html          working search UI, talks to the API
  engine/
    README.md             engine detail — architecture, adapter contract
    package.json          no dependencies
    src/
      normalise.js        title → brand, model code, constraints, tokens
      match.js            grouping, scoring, overrides, review queue generation
      discount.js         per-merchant trade discounts
      alerts.js           digest generation, creep detection
      store.js            SQLite: snapshots, overrides, review queue, signups
      http.js             polite fetch — throttle, backoff, cache, 403 stop
      server.js           API + static file serving, port 8787
      cli.js              compare / ingest from the terminal
      ingest.js           the daily job
      adapters/index.js   fixture-backed adapters — working
      adapters/live.js    live adapters — URLs UNVERIFIED
    test/                 34 tests
    fixtures/             realistic listing data, five merchants
```

Run it:

```bash
cd counter/engine
node src/server.js                          # localhost:8787
node src/cli.js compare "impact driver"
node src/ingest.js                          # today's snapshot + queue
node --test
```

| Route | Serves |
|---|---|
| `/` | Landing page |
| `/app/` | Search UI |
| `/api/search?q=…&discounts=bunnings:8,reece:22` | Comparisons, discounted |
| `/api/history?id=…&merchant=…` | One merchant's price series |
| `/api/signup` | POST `{email}` |

Working end to end on fixture data: matching across five merchants, trade
discounts, snapshot archive, movement and creep detection, review queue with
override persistence, signup capture.

---

## 4. Design decisions — don't undo these without a reason

1. **Matching runs in confidence order.** GTIN (1.0) → brand + model code
   (0.95) → Dice similarity over normalised tokens, capped at 0.85 so fuzzy can
   never outrank a real match. Below 0.72 nothing is merged. Showing a wrong
   price is worse than showing no price.

2. **Voltage, capacity and pack size are hard constraints, not fuzzy signals.**
   An 18V tool must never fold into a 40V listing however similar the words.
   Silence isn't disagreement — an unstated voltage doesn't penalise.

3. **Snapshots are append-only**, unique per (product, merchant, day). A price
   change is two rows, never one row edited. Re-running a scrape the same day
   is idempotent and can't invent a phantom movement.

4. **Unreachable merchants are reported, never silently omitted.** A comparison
   across four shops must not look like one across five.

5. **Out-of-stock stays visible** and sorts last — never shown as cheapest.

6. **Parse schema.org JSON-LD before CSS selectors.** Retail platforms emit it
   for Google rich results, so it survives the redesigns that break selectors
   and they can't drop it without losing search traffic.

7. **The list-price limitation is stated openly on the landing page**, not
   buried. Trade prices are negotiated per account and we can't see them; users
   enter their own discount per merchant. Keep that honesty — a tradie spots
   the gap in five minutes and trusts you less for hiding it.

8. **The near-miss floor is 0.45.** Dice scales with title verbosity: a perfect
   subset match between a four-token title and a twelve-token one scores about
   0.5 by construction. A higher floor silently discards the terse-vs-verbose
   case, which is both the matcher's weakest spot and the most likely to be a
   real match. It's a config constant — a week of live ingest will say more
   about it than any reasoning.

---

## 5. The review queue

`groupListings()` is pure and re-derives every group from raw listings on each
run, so a human decision needs somewhere to live *and* something that consults
it. Both exist now.

**Overrides** are keyed on `(merchant_id, sku)` — the only thing stable across
re-derivation — and applied inside the grouping pass, before scoring. A merged
listing skips scoring entirely; a blocked candidate is never considered.

Both polarities are required. Without `split`, a reviewer rejecting a bad match
watches it reappear identically tomorrow.

**Three things reach the queue:**

| Reason | Trigger |
|---|---|
| `near-miss` | Best candidate scored in [0.45, 0.72) |
| `single-merchant` | A product only one of five merchants stocks |
| `duplicate-merchant-sku` | Two SKUs from one merchant claiming one product |

One row per listing, never one per candidate pair — that bounds the queue at
O(listings) and is what makes a floor as low as 0.45 affordable.

`single-merchant` catches what no threshold can: two listings for the same item
worded so differently they never came close, each rendering alone. Bunnings at
$21.00 shown by itself when Total Tools has it at $19.95 is the exact failure
this tool exists to prevent, and a score-based rule never sees it.

**Ordered by price impact**, not score — how far the number a user sees would
move if the decision went the other way. A queue sorted by score trains you to
click through it.

API surface:

```js
groupListings(listings, { overrides: store.overrides(), floor: 0.45 })
  → { products, review }

store.queueReview(review, "2026-08-02");
store.pendingReview(limit);      // worth-most-money first
store.resolveReview(merchantId, sku, reason, "merge"|"split"|"ignore", productId?);
```

Review items are flat: `{ merchantId, sku, title, reason, candidateProductId,
score, priceImpactCents }`.

Two behaviours worth knowing before building the UI:

- **Deciding a listing supersedes its other pending rows.** One listing can be
  queued as both a near miss and a lone merchant; one decision settles both. If
  the UI resolves row by row, expect siblings to vanish from the pending list.
- **`ignore` writes no override** but the queue row stays resolved, so it won't
  come back. Re-queuing refreshes impact and `last_seen` but never resurrects a
  decided row or loses `first_seen`.

---

## 6. Next, in order

1. **Verify the live adapter URLs.** Every `searchUrl` in
   `src/adapters/live.js` is an unverified placeholder. Start with a sourcing
   decision per merchant, not with `probe()`:

   | Situation | Do |
   |---|---|
   | Affiliate feed exists | Take it — licensed, structured, pays commission. Commission Factory is the big AU network; check merchant by merchant |
   | No feed, terms permit | Scrape politely. `http.js` is built for it |
   | Terms prohibit, or 403 | Don't. Drop from launch coverage and say so |

   This blocks everything downstream.

2. **`/api/review` + the review screen.** Schema and override path are done and
   tested; list-pending and post-a-resolution endpoints and the UI are not.
   First UI test case: the 40V Makita in the fixtures is flagged
   `single-merchant` and is a true positive a reviewer would mark `ignore`.

3. **Signup endpoint.** Currently auto-targets `/api/signup` on localhost, demo
   mode elsewhere. See open questions.

4. **Email delivery.** `formatDigest()` produces the text; nothing sends it.

5. **Auth.** The API is open — needed before any public host.

6. **Seed the top ~500 SKUs by hand.** Tedious, and exactly why nobody else has
   done this.

---

## 7. Open questions

- **`faultcode`** — the email setup to copy lives only on the Mac, so it was
  never available to inspect. Needed: the endpoint URL and whether it takes
  JSON or form-encoded. Drop it into `SIGNUP` at the bottom of
  `counter/index.html` and the form goes live; nothing else changes.
- **`openship`** — never established what this is or what "get Codex to boost
  on openship" meant. Not in the GitHub account.

---

## 8. Gotchas

- **The live adapter URLs are guesses.** Nothing has ever hit a real merchant
  site. Verify before trusting.
- **Read each merchant's terms and robots.txt first.** `http.js` defaults are
  deliberately slow — 1.5s per host, backoff, 12-hour disk cache, and a hard
  stop on 403 rather than retrying. Don't tune those up.
- **Ingest runs once daily, not hourly.** Prices move overnight and the
  snapshot table is unique per day, so extra runs are wasted requests against
  someone else's servers.
- **All sample data on the landing page is labelled illustrative** and the page
  states it's independent and unaffiliated. Keep both until real prices flow —
  naming real merchants next to invented prices needs it.
- **Normalisation bugs are silent** and look like matching failures. The worst
  one so far: the `15mm x 3m` separator rule in `clean()` was eating the
  trailing `x` of any word before a number, so `sikaflex 11fc` became
  `sikafle` and those listings scored as strangers. Test 4 in `match.test.js`
  guards it. If matching quality drops mysteriously, check normalisation
  output before touching thresholds.
- **Australian market**: AUD, GST-inclusive, AEST timestamps.

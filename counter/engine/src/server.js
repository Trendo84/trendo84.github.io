import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { fetchAll } from "./adapters/index.js";
import { groupListings, toComparison } from "./match.js";
import { applyDiscounts } from "./discount.js";
import { openStore } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..");          // counter/
const PORT = Number(process.env.PORT ?? 8787);
const DB = process.env.COUNTER_DB ?? "counter.db";

const store = openStore(DB);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit = 8_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("payload too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // ── API ──────────────────────────────────────────────────────────────
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      const discounts = parseDiscounts(url.searchParams.get("discounts"));

      const { listings, failures } = await fetchAll(query);
      const { products, review } = groupListings(listings, { overrides: store.overrides() });

      const comparisons = products
        .map(toComparison)
        .map(cmp => Object.keys(discounts).length ? applyDiscounts(cmp, discounts) : cmp)
        .map((cmp, i) => ({ ...cmp, title: products[i].members[0].listing.title }));

      // A merchant being unreachable is reported, never silently omitted —
      // otherwise a comparison across four shops looks like one across five.
      return json(res, 200, { query, products: comparisons, review, failures });
    }

    if (url.pathname === "/api/history") {
      const productId = url.searchParams.get("id");
      const merchantId = url.searchParams.get("merchant");
      if (!productId) return json(res, 400, { error: "id required" });
      return json(res, 200, merchantId
        ? { history: store.history(productId, merchantId) }
        : { latest: store.latest(productId), movements: store.movements(productId) });
    }

    if (url.pathname === "/api/signup" && req.method === "POST") {
      const { email, source } = await readBody(req);
      if (!VALID_EMAIL.test(String(email ?? ""))) {
        return json(res, 400, { error: "That email doesn't look right." });
      }
      store.addSignup(email, source);
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

    // ── Static ───────────────────────────────────────────────────────────
    const rel = url.pathname === "/" ? "index.html"
      : url.pathname.endsWith("/") ? url.pathname + "index.html"
      : url.pathname;

    // normalize + prefix check keeps ../ out of the served tree
    const path = join(SITE, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!path.startsWith(SITE)) return json(res, 403, { error: "nope" });

    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);

  } catch (err) {
    if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
    json(res, 500, { error: String(err.message) });
  }
});

/** "bunnings:8,reece:22" → { bunnings: 8, reece: 22 } */
function parseDiscounts(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(",")
      .map(pair => pair.split(":"))
      .filter(([id, pct]) => id && pct)
      .map(([id, pct]) => [id.trim(), Number(pct)])
  );
}

server.listen(PORT, () => {
  console.log(`Counter on http://localhost:${PORT}`);
  console.log(`  landing  /`);
  console.log(`  app      /app/`);
  console.log(`  api      /api/search?q=impact+driver&discounts=bunnings:8,reece:22`);
  console.log(`  db       ${DB} — ${store.signupCount()} signup(s)`);
});

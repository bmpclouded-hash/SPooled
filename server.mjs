// SPOOLED backend: static site + Stripe Checkout + Printify order fulfilment.
// Requires Node 18+. No npm packages needed.
// Run: node --env-file=.env server.mjs

import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, "..");
const catalog = JSON.parse(await fs.readFile(path.join(__dirname, "products.json"), "utf8"));
const printifyMap = JSON.parse(
  await fs.readFile(path.join(__dirname, "printify-map.json"), "utf8").catch(() => '{"products":{}}')
);

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRINTIFY_TOKEN,
  PORT = "3000",
  PUBLIC_URL = `http://localhost:${PORT}`,
} = process.env;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

// ---- Helpers ----
const findProduct = (id) => catalog.products.find((p) => p.id === id);

// Build a validated, server-priced line list from whatever the browser sent.
// The browser's prices are never trusted.
function priceCart(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error("Invalid cart");
  return items.map((it) => {
    const p = findProduct(it.id);
    const qty = Math.floor(Number(it.qty));
    if (!p) throw new Error(`Unknown product ${it.id}`);
    if (!p.sizes.includes(it.size)) throw new Error(`Invalid size for ${p.id}`);
    const color = p.colors.find((c) => c.name === it.color);
    if (!color) throw new Error(`Invalid color for ${p.id}`);
    if (!(qty >= 1 && qty <= 10)) throw new Error("Invalid quantity");
    return { product: p, size: it.size, color: color.name, qty };
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) reject(new Error("Body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---- Stripe (REST, no SDK) ----
async function stripeForm(route, params) {
  const body = new URLSearchParams();
  const walk = (prefix, val) => {
    if (Array.isArray(val)) val.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (val && typeof val === "object") for (const k of Object.keys(val)) walk(`${prefix}[${k}]`, val[k]);
    else if (val !== undefined && val !== null) body.append(prefix, String(val));
  };
  for (const k of Object.keys(params)) walk(k, params[k]);
  const res = await fetch(`https://api.stripe.com/v1${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe error ${res.status}`);
  return data;
}

// Verify Stripe webhook signature (t=timestamp,v1=signature)
function verifyStripeSignature(payload, header) {
  if (!STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const signed = `${parts.t}.${payload.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(signed).digest("hex");
  const ok = header.split(",").filter((kv) => kv.startsWith("v1=")).some((kv) => {
    const sig = kv.slice(3);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  // Reject events older than 5 minutes
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return ok && fresh;
}

// ---- Printify (order fulfilment) ----
async function printifyOrder(externalId, items, address) {
  if (!PRINTIFY_TOKEN) throw new Error("PRINTIFY_TOKEN not set");
  const map = printifyMap.products;
  const line_items = items.map((it) => {
    const entry = map[it.id];
    const variantId = entry?.variants[`${it.color}|${it.size}`];
    if (!entry || !variantId) throw new Error(`No Printify mapping for ${it.id} ${it.color} ${it.size}`);
    return { product_id: entry.printify_product_id, variant_id: variantId, quantity: it.qty };
  });
  const res = await fetch(`https://api.printify.com/v1/shops/${printifyMap.shop_id}/orders.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PRINTIFY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      external_id: externalId,
      label: externalId,
      line_items,
      shipping_method: 1,
      send_shipping_notification: true,
      address_to: address,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Printify order failed: ${JSON.stringify(data)}`);
  return data;
}

// ---- Routes ----
async function handleCheckout(req, res) {
  if (!STRIPE_SECRET_KEY) return sendJson(res, 503, { error: "Checkout is not configured yet." });
  let payload;
  try { payload = JSON.parse((await readBody(req)).toString("utf8")); }
  catch { return sendJson(res, 400, { error: "Bad JSON" }); }

  let lines;
  try { lines = priceCart(payload.items); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  // Compact cart record for the webhook (Stripe metadata values are limited to 500 chars)
  const cartCode = lines.map((l) => `${l.product.id}|${l.color}|${l.size}|${l.qty}`).join(";");

  try {
    const session = await stripeForm("/checkout/sessions", {
      mode: "payment",
      line_items: lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: catalog.currency,
          unit_amount: Math.round(l.product.price * 100),
          product_data: { name: `${l.product.name} — ${l.color} / ${l.size}` },
        },
      })),
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      success_url: `${PUBLIC_URL}/?order=success`,
      cancel_url: `${PUBLIC_URL}/?order=cancelled`,
      metadata: { cart: cartCode.slice(0, 500) },
    });
    sendJson(res, 200, { url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    sendJson(res, 502, { error: "Could not start checkout. Please try again." });
  }
}

async function handleWebhook(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"])) {
    return sendJson(res, 400, { error: "Bad signature" });
  }
  const event = JSON.parse(raw.toString("utf8"));
  if (event.type !== "checkout.session.completed") return sendJson(res, 200, { received: true });

  const s = event.data.object;
  const cart = (s.metadata?.cart || "").split(";").filter(Boolean).map((seg) => {
    const [id, color, size, qty] = seg.split("|");
    return { id, color, size, qty: Number(qty) };
  });
  const sh = s.collected_information?.shipping_details || s.shipping_details || {};
  const a = sh.address || {};
  const address = {
    first_name: (sh.name || "").split(" ")[0] || "Customer",
    last_name: (sh.name || "").split(" ").slice(1).join(" ") || "-",
    email: s.customer_details?.email || "",
    phone: s.customer_details?.phone || "",
    country: a.country || "US",
    region: a.state || "",
    address1: a.line1 || "",
    address2: a.line2 || "",
    city: a.city || "",
    zip: a.postal_code || "",
  };

  try {
    const order = await printifyOrder(s.id, cart, address);
    console.log("Printify order created:", order.id, "for session", s.id);
    sendJson(res, 200, { received: true });
  } catch (e) {
    // Return 500 so Stripe retries. Fix the cause (mapping, token) then it will succeed.
    console.error("Fulfilment failed for", s.id, e.message);
    sendJson(res, 500, { error: "Fulfilment failed" });
  }
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(SITE, p));
  if (!file.startsWith(SITE + path.sep) || file.includes(`${path.sep}backend${path.sep}`)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/checkout") return await handleCheckout(req, res);
    if (req.method === "POST" && req.url === "/api/stripe-webhook") return await handleWebhook(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(Number(PORT), () => console.log(`SPOOLED running at ${PUBLIC_URL}`));

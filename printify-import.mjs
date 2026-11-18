// One-time Printify listing import for SPOOLED.
// Usage (from the backend folder):
//   PRINTIFY_TOKEN=... node scripts/printify-import.mjs
// Optional: PRINTIFY_SHOP_ID=... (if omitted, the first shop on the account is used)
//
// Reads products.json, uploads the print art, creates each product in Printify,
// and writes printify-map.json, which the order webhook uses to fulfil orders.
// Products are created UNPUBLISHED. Review them in Printify before publishing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..");
const SITE = path.resolve(BACKEND, "..");
const API = "https://api.printify.com/v1";

const token = process.env.PRINTIFY_TOKEN;
if (!token) {
  console.error("Set PRINTIFY_TOKEN first.");
  process.exit(1);
}

async function pfy(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "spooled-import/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const catalog = JSON.parse(await fs.readFile(path.join(BACKEND, "products.json"), "utf8"));

let shopId = process.env.PRINTIFY_SHOP_ID;
if (!shopId) {
  const shops = await pfy("GET", "/shops.json");
  if (!shops.length) throw new Error("No Printify shops on this account. Connect a store in Printify first.");
  shopId = String(shops[0].id);
  console.log(`Using shop "${shops[0].title}" (${shopId})`);
}

const map = {};

for (const product of catalog.products) {
  const pf = product.printify;
  if (!pf.blueprint_id || !pf.print_provider_id) {
    console.log(`SKIP ${product.id}: set printify.blueprint_id and print_provider_id in products.json`);
    continue;
  }

  // 1. Upload the print art
  const artPath = path.resolve(SITE, pf.print_image);
  const contents = (await fs.readFile(artPath)).toString("base64");
  const upload = await pfy("POST", "/uploads/images.json", {
    file_name: path.basename(artPath),
    contents,
  });
  console.log(`Uploaded art for ${product.id}: ${upload.id}`);

  // 2. Find the Printify variants that match our colors and sizes
  const vdata = await pfy(
    "GET",
    `/catalog/blueprints/${pf.blueprint_id}/print_providers/${pf.print_provider_id}/variants.json`
  );
  const wanted = [];
  for (const color of product.colors) {
    for (const size of product.sizes) {
      const v = vdata.variants.find((x) => {
        const t = (x.title || "").toLowerCase();
        return t.includes(color.name.toLowerCase()) && t.split(/[\s/,]+/).includes(size.toLowerCase());
      });
      if (!v) {
        throw new Error(`No Printify variant for ${product.id} ${color.name} / ${size}. Check the blueprint.`);
      }
      wanted.push({ color: color.name, size, id: v.id });
    }
  }

  // 3. Create the product (unpublished)
  const created = await pfy("POST", `/shops/${shopId}/products.json`, {
    title: product.name,
    description: product.description,
    blueprint_id: Number(pf.blueprint_id),
    print_provider_id: Number(pf.print_provider_id),
    variants: wanted.map((w) => ({
      id: w.id,
      price: Math.round(product.price * 100),
      is_enabled: true,
    })),
    print_areas: [
      {
        variant_ids: wanted.map((w) => w.id),
        placeholders: [
          {
            position: pf.placeholder,
            images: [{ id: upload.id, x: 0.5, y: pf.y, scale: pf.scale, angle: 0 }],
          },
        ],
      },
    ],
  });

  map[product.id] = {
    printify_product_id: created.id,
    variants: Object.fromEntries(wanted.map((w) => [`${w.color}|${w.size}`, w.id])),
  };
  console.log(`Created ${product.id} -> Printify product ${created.id}`);
}

await fs.writeFile(path.join(BACKEND, "printify-map.json"), JSON.stringify({ shop_id: shopId, products: map }, null, 2));
console.log("Wrote printify-map.json");
console.log("Next: review the products in Printify, then publish them there.");

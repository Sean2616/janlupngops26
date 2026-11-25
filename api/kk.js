// ============================================================
// Proxy Menu Live Kopi Kenangan — JanLupNgops.fun (situs utama)
// (Vercel Serverless Function, CommonJS)
// ============================================================

const UPSTREAM = "https://flappyyu.store";
const ROUTES = { menu: "/api/menu", options: "/api/product-options", status: "/api/store-status" };
const CODE_RE = /^[A-Za-z0-9.\-]{1,64}$/;

const MENU_CACHE_TTL_MS = 90 * 1000;
const OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
const menuCache = new Map();    // store_code -> { at, json }
const optionsCache = new Map(); // "store_code|product_id" -> { at, json, largePrice }

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function extractLargePrice(po) {
  if (!po || !Array.isArray(po.dimensions) || !po.variants || !po.defaultSelectionPath) return 0;
  let sd = null;
  for (let i = 0; i < po.dimensions.length; i++) {
    if (/size/i.test(po.dimensions[i].title)) { sd = po.dimensions[i]; break; }
  }
  if (!sd || !Array.isArray(sd.values)) return 0;
  let lv = null;
  for (let j = 0; j < sd.values.length; j++) {
    if (sd.values[j].label === "Large") { lv = sd.values[j]; break; }
  }
  if (!lv) return 0;
  const segs = String(po.defaultSelectionPath).split(":").filter(Boolean).map((s) =>
    s.indexOf(sd.code + "-") === 0 ? sd.code + "-" + lv.id : s
  );
  const v = po.variants[segs.join(":") + ":"];
  return (v && v.price) ? Number(v.price) || 0 : 0;
}

async function fetchSingleProductOptions(storeCode, pid, timeoutMs) {
  const key = storeCode + "|" + pid;
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.at < OPTIONS_CACHE_TTL_MS) return hit;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(UPSTREAM + ROUTES.options, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "JanLupNgops-MenuLive/1.0" },
      body: JSON.stringify({ store_code: storeCode, product_id: pid }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!r.ok || !json) return null;
    const largePrice = extractLargePrice(json.productOptions);
    if (optionsCache.size > 4000) optionsCache.clear();
    const entry = { at: Date.now(), json, largePrice };
    optionsCache.set(key, entry);
    return entry;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { message: "Method tidak diizinkan. Pakai POST." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (c) => { data += c; if (data.length > 100000) req.destroy(); });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(raw || "{}");
    } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") return send(res, 400, { message: "Body JSON tidak valid." });

  const storeCode = String(body.store_code || "");
  if (!CODE_RE.test(storeCode)) return send(res, 400, { message: "store_code tidak valid." });

  // Batch Large-price lookup to avoid dozens of browser HTTP requests per outlet
  if (body.type === "options_batch") {
    if (!Array.isArray(body.product_ids)) return send(res, 400, { message: "product_ids harus berupa array." });
    const ids = [...new Set(body.product_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40);
    const prices = {};
    let idx = 0;
    const concurrency = Math.min(8, ids.length || 1);
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < ids.length) {
        const pid = ids[idx++];
        const entry = await fetchSingleProductOptions(storeCode, pid, 10000);
        if (entry) prices[pid] = entry.largePrice;
      }
    });
    await Promise.all(workers);
    return send(res, 200, { prices });
  }

  const route = ROUTES[body.type];
  if (!route) return send(res, 400, { message: "type harus salah satu dari: menu, options, options_batch, status." });

  if (body.type === "menu") {
    const hit = menuCache.get(storeCode);
    if (hit && Date.now() - hit.at < MENU_CACHE_TTL_MS) return send(res, 200, hit.json);
  }

  if (body.type === "options") {
    const pid = Number(body.product_id);
    if (!Number.isInteger(pid) || pid <= 0) return send(res, 400, { message: "product_id tidak valid." });
    const entry = await fetchSingleProductOptions(storeCode, pid, 15000);
    if (!entry) return send(res, 502, { message: "Gagal mengambil opsi produk. Coba lagi sebentar." });
    return send(res, 200, entry.json);
  }

  let payload;
  if (body.type === "menu") {
    payload = { store_code: storeCode };
  } else {
    const lat = String(body.latitude || ""), lng = String(body.longitude || "");
    if (!/^-?\d{1,3}(\.\d+)?$/.test(lat) || !/^-?\d{1,3}(\.\d+)?$/.test(lng)) {
      return send(res, 400, { message: "latitude/longitude tidak valid." });
    }
    payload = { store_code: storeCode, latitude: lat, longitude: lng };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(UPSTREAM + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "JanLupNgops-MenuLive/1.0" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!r.ok || !json) {
      return send(res, 502, { message: "Server sumber menu menjawab " + r.status + ". Coba lagi sebentar." });
    }
    if (body.type === "menu") {
      if (!Array.isArray(json.menuGroups) || !json.menuGroups.length) {
        return send(res, 502, { message: "Server sumber menu mengembalikan data yang tidak lengkap. Coba lagi sebentar." });
      }
      if (menuCache.size > 500) menuCache.clear();
      menuCache.set(storeCode, { at: Date.now(), json });
    }
    return send(res, 200, json);
  } catch (e) {
    return send(res, 502, { message: "Tidak bisa menghubungi server sumber menu. Coba lagi sebentar." });
  } finally {
    clearTimeout(timer);
  }
};

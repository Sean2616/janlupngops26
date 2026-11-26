// ============================================================
// Proxy Menu Live Kopi Kenangan — JanLupNgops.fun (Multi-Upstream Failover)
// (Vercel Serverless Function, CommonJS)
// ============================================================

const UPSTREAM_JASDER = "https://jasdersalll.store";
const UPSTREAM_FLAPPY = "https://flappyyu.store";
const FLAPPY_ROUTES = { menu: "/api/menu", options: "/api/product-options", status: "/api/store-status" };
const CODE_RE = /^[A-Za-z0-9.\-]{1,64}$/;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MENU_CACHE_TTL_MS = 2 * 60 * 1000;
const OPTIONS_CACHE_TTL_MS = 15 * 60 * 1000;
const DOWN_COOLDOWN_MS = 3 * 60 * 1000;

const menuCache = new Map();    // store_code -> { at, json }
const optionsCache = new Map(); // "store_code|product_id" -> { at, json, largePrice }
const upstreamDownUntil = { jasder: 0, flappy: 0 };

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function isUp(name) {
  return Date.now() >= (upstreamDownUntil[name] || 0);
}

function markDown(name) {
  upstreamDownUntil[name] = Date.now() + DOWN_COOLDOWN_MS;
}

function markUp(name) {
  upstreamDownUntil[name] = 0;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// NORMALISASI MENU LIVE DARI BERBAGAI SUMBER
// ============================================================
function normalizeMenuGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups
    .map((g) => {
      if (!g || typeof g !== "object") return null;
      const gName = String(g.name || g.groupName || "").trim();
      if (!gName) return null;
      const products = Array.isArray(g.products)
        ? g.products
            .filter((p) => p && p.id != null && p.name)
            .map((p) => ({
              id: Number(p.id),
              name: String(p.name),
              price: Number(p.price) || 0,
              origPrice: Number(p.origPrice ?? p.originalPrice ?? p.price) || 0,
              image: String(p.image || ""),
              isSoldOut: Boolean(p.isSoldOut || p.soldOut),
              hasPromotion: Boolean(p.hasPromotion),
            }))
        : [];
      return {
        name: gName,
        groupCode: g.groupCode || "",
        products,
      };
    })
    .filter((g) => g && g.products.length > 0);
}

async function fetchMenuFromJasder(storeCode, lat, lng) {
  const qs = new URLSearchParams({ storeCode });
  if (lat && /^-?\d{1,3}(\.\d+)?$/.test(String(lat))) qs.set("lat", String(lat));
  if (lng && /^-?\d{1,3}(\.\d+)?$/.test(String(lng))) qs.set("lng", String(lng));
  const res = await fetchWithTimeout(
    `${UPSTREAM_JASDER}/api/menu?${qs.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Referer: `${UPSTREAM_JASDER}/`,
        "User-Agent": BROWSER_UA,
      },
    },
    18000
  );
  if (!res.ok || !res.json || res.json.success === false) {
    throw new Error("jasder menu HTTP " + res.status);
  }
  const menuGroups = normalizeMenuGroups(res.json.menuGroups);
  if (!menuGroups.length) throw new Error("jasder empty menuGroups");
  return { menuGroups, source: "jasder" };
}

async function fetchMenuFromFlappy(storeCode) {
  const res = await fetchWithTimeout(
    UPSTREAM_FLAPPY + FLAPPY_ROUTES.menu,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ store_code: storeCode }),
    },
    14000
  );
  if (!res.ok || !res.json) {
    throw new Error("flappy menu HTTP " + res.status);
  }
  const menuGroups = normalizeMenuGroups(res.json.menuGroups);
  if (!menuGroups.length) throw new Error("flappy empty menuGroups");
  return { menuGroups, source: "flappy" };
}

async function fetchLiveMenuWithFailover(storeCode, lat, lng) {
  const order = [];
  if (isUp("jasder")) order.push("jasder");
  if (isUp("flappy")) order.push("flappy");
  if (!order.includes("jasder")) order.push("jasder");
  if (!order.includes("flappy")) order.push("flappy");

  let lastErr = null;
  for (const provider of order) {
    try {
      const data = provider === "jasder"
        ? await fetchMenuFromJasder(storeCode, lat, lng)
        : await fetchMenuFromFlappy(storeCode);
      markUp(provider);
      return data;
    } catch (e) {
      lastErr = e;
      markDown(provider);
    }
  }
  throw lastErr || new Error("Semua server menu live sedang sibuk");
}

// ============================================================
// EKSTRAKSI HARGA LARGE & NORMALISASI OPSI PRODUK
// ============================================================
function extractLargePriceFromFlappy(po) {
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

function extractPricesFromJasderOptions(opts) {
  if (!opts || typeof opts !== "object") return { regPrice: 0, largePrice: 0 };
  const sp = opts.sizePrices || {};
  let regPrice = Number(sp.Regular || (opts.baseProduct && opts.baseProduct.price) || 0) || 0;
  let largePrice = Number(sp.Large || 0) || 0;

  if (!largePrice && Array.isArray(opts.dimensions) && opts.optionProductMap) {
    const sizeDim = opts.dimensions.find((d) => /size/i.test(String(d.dimension_text || d.title || "")));
    if (sizeDim && Array.isArray(sizeDim.dimension_value_wordings)) {
      const largeVal = sizeDim.dimension_value_wordings.find((v) => /large/i.test(String(v.value_text || v.label || "")));
      if (largeVal) {
        const token = `${sizeDim.dimension_code}-${largeVal.value}:`;
        let best = 0;
        for (const [k, v] of Object.entries(opts.optionProductMap)) {
          if (k.includes(token) && v && Number(v.price) > 0) {
            const p = Number(v.price);
            if (!best || p < best) best = p;
          }
        }
        largePrice = best;
      }
    }
  }
  return { regPrice, largePrice };
}

function buildNormalizedProductOptions(regPrice, largePrice) {
  const values = [{ id: "1", label: "Regular" }];
  const variants = { "size-1:": { price: regPrice || 0 } };
  if (largePrice > 0) {
    values.push({ id: "2", label: "Large" });
    variants["size-2:"] = { price: largePrice };
  }
  return {
    productOptions: {
      dimensions: [{ code: "size", title: "Size", values }],
      defaultSelectionPath: "size-1:",
      variants,
    },
  };
}

async function fetchOptionsFromJasder(storeCode, pid, timeoutMs) {
  const qs = new URLSearchParams({
    storeCode,
    productId: String(pid),
    tier: "normal",
  });
  const res = await fetchWithTimeout(
    `${UPSTREAM_JASDER}/api/options?${qs.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Referer: `${UPSTREAM_JASDER}/`,
        "User-Agent": BROWSER_UA,
      },
    },
    timeoutMs || 10000
  );
  if (!res.ok || !res.json || res.json.success === false || !res.json.options) {
    throw new Error("jasder options HTTP " + res.status);
  }
  const { regPrice, largePrice } = extractPricesFromJasderOptions(res.json.options);
  return {
    largePrice,
    json: buildNormalizedProductOptions(regPrice, largePrice),
  };
}

async function fetchOptionsFromFlappy(storeCode, pid, timeoutMs) {
  const res = await fetchWithTimeout(
    UPSTREAM_FLAPPY + FLAPPY_ROUTES.options,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ store_code: storeCode, product_id: pid }),
    },
    timeoutMs || 10000
  );
  if (!res.ok || !res.json) {
    throw new Error("flappy options HTTP " + res.status);
  }
  const largePrice = extractLargePriceFromFlappy(res.json.productOptions);
  return { largePrice, json: res.json };
}

async function fetchSingleProductOptions(storeCode, pid, timeoutMs) {
  const key = storeCode + "|" + pid;
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.at < OPTIONS_CACHE_TTL_MS) return hit;

  const order = [];
  if (isUp("jasder")) order.push("jasder");
  if (isUp("flappy")) order.push("flappy");
  if (!order.length) order.push("jasder", "flappy");

  for (const provider of order) {
    try {
      const out = provider === "jasder"
        ? await fetchOptionsFromJasder(storeCode, pid, timeoutMs)
        : await fetchOptionsFromFlappy(storeCode, pid, timeoutMs);
      markUp(provider);
      if (optionsCache.size > 4000) optionsCache.clear();
      const entry = { at: Date.now(), json: out.json, largePrice: out.largePrice };
      optionsCache.set(key, entry);
      return entry;
    } catch (e) {
      markDown(provider);
    }
  }
  return null;
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

  // 1. Batch harga Large (cepat & hemat koneksi)
  if (body.type === "options_batch") {
    if (!Array.isArray(body.product_ids)) return send(res, 400, { message: "product_ids harus berupa array." });
    const ids = [...new Set(body.product_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40);
    const prices = {};
    let idx = 0;
    const concurrency = Math.min(8, ids.length || 1);
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < ids.length) {
        const pid = ids[idx++];
        const entry = await fetchSingleProductOptions(storeCode, pid, 9000);
        if (entry) prices[pid] = entry.largePrice;
      }
    });
    await Promise.all(workers);
    return send(res, 200, { prices });
  }

  // 2. Opsi satu produk
  if (body.type === "options") {
    const pid = Number(body.product_id);
    if (!Number.isInteger(pid) || pid <= 0) return send(res, 400, { message: "product_id tidak valid." });
    const entry = await fetchSingleProductOptions(storeCode, pid, 12000);
    if (!entry) return send(res, 502, { message: "Gagal mengambil opsi produk. Coba lagi sebentar." });
    return send(res, 200, entry.json);
  }

  // 3. Menu live per outlet (dengan multi-upstream failover)
  if (body.type === "menu") {
    const hit = menuCache.get(storeCode);
    if (hit && Date.now() - hit.at < MENU_CACHE_TTL_MS) return send(res, 200, hit.json);
    try {
      const data = await fetchLiveMenuWithFailover(storeCode, body.latitude, body.longitude);
      if (menuCache.size > 500) menuCache.clear();
      menuCache.set(storeCode, { at: Date.now(), json: data });
      return send(res, 200, data);
    } catch (e) {
      return send(res, 502, { message: "Server sumber menu sedang sibuk. Coba lagi sebentar." });
    }
  }

  // 4. Status outlet (opsional)
  if (body.type === "status") {
    if (!isUp("flappy")) return send(res, 502, { message: "Status live tidak tersedia." });
    const lat = String(body.latitude || ""), lng = String(body.longitude || "");
    if (!/^-?\d{1,3}(\.\d+)?$/.test(lat) || !/^-?\d{1,3}(\.\d+)?$/.test(lng)) {
      return send(res, 400, { message: "latitude/longitude tidak valid." });
    }
    try {
      const r = await fetchWithTimeout(
        UPSTREAM_FLAPPY + FLAPPY_ROUTES.status,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
          body: JSON.stringify({ store_code: storeCode, latitude: lat, longitude: lng }),
        },
        8000
      );
      if (!r.ok || !r.json) {
        markDown("flappy");
        return send(res, 502, { message: "Gagal mengecek status outlet." });
      }
      return send(res, 200, r.json);
    } catch (e) {
      markDown("flappy");
      return send(res, 502, { message: "Gagal mengecek status outlet." });
    }
  }

  return send(res, 400, { message: "type harus salah satu dari: menu, options, options_batch, status." });
};

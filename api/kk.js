// ============================================================
// Proxy Menu Live Kopi Kenangan — JanLupNgops.fun (situs utama)
// (Vercel Serverless Function, CommonJS)
// ------------------------------------------------------------
// Kenapa perlu proxy ini?
// Server sumber menu (flappyyu.store) tidak mengirim header
// CORS, jadi browser di domain lain tidak boleh memanggilnya
// langsung. Fungsi ini berjalan di server (domain yang sama
// dengan halaman utama), meneruskan permintaan ke sana, lalu
// mengembalikan hasilnya ke browser. Server-ke-server tidak
// kena aturan CORS.
//
// POST /api/kk
// Body JSON salah satu dari:
//   { "type": "menu",    "store_code": "JKT.STGAMBIR" }
//   { "type": "options", "store_code": "JKT.STGAMBIR", "product_id": 12383 }
//   { "type": "status",  "store_code": "JKT.STGAMBIR", "latitude": "-6.17...", "longitude": "106.83..." }
//
// Tidak ada API key di sini: endpoint sumber memang publik
// tanpa kunci dari sisi browser (kredensial upstream Kopi
// Kenangan ada di server mereka, bukan di file ini).
// ============================================================

const UPSTREAM = "https://flappyyu.store";
const ROUTES = { menu: "/api/menu", options: "/api/product-options", status: "/api/store-status" };
const CODE_RE = /^[A-Za-z0-9.\-]{1,64}$/;

// Cache singkat untuk menu yang BERHASIL diambil (per outlet, 90 detik).
// Upstream kadang sangat lambat dan isi menunya bisa berubah antar
// panggilan dalam hitungan detik, jadi pemuatan ulang dalam waktu singkat
// mengembalikan menu yang sama tanpa memanggil upstream lagi. Cache ini
// hanya di memori (best-effort): kalau function-nya cold start, cache
// kosong dan upstream dipanggil seperti biasa. Yang gagal / tidak
// lengkap TIDAK pernah di-cache.
const MENU_CACHE_TTL_MS = 90 * 1000;
const menuCache = new Map(); // store_code -> { at, json }

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { message: "Method tidak diizinkan. Pakai POST." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    // Vercel biasanya sudah mem-parse body JSON; jaga-jaga baca manual dari stream.
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

  const route = ROUTES[body.type];
  if (!route) return send(res, 400, { message: "type harus salah satu dari: menu, options, status." });

  const storeCode = String(body.store_code || "");
  if (!CODE_RE.test(storeCode)) return send(res, 400, { message: "store_code tidak valid." });

  if (body.type === "menu") {
    const hit = menuCache.get(storeCode);
    if (hit && Date.now() - hit.at < MENU_CACHE_TTL_MS) return send(res, 200, hit.json);
  }

  let payload;
  if (body.type === "menu") {
    payload = { store_code: storeCode };
  } else if (body.type === "options") {
    const pid = Number(body.product_id);
    if (!Number.isInteger(pid) || pid <= 0) return send(res, 400, { message: "product_id tidak valid." });
    payload = { store_code: storeCode, product_id: pid };
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
      // Jangan teruskan (dan jangan cache) respons yang tidak lengkap:
      // frontend menganggapnya "menu belum tersedia" dan akan mencoba
      // lagi / menampilkan menu tersimpan, bukan menu kosong.
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

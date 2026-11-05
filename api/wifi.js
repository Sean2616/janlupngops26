// ============================================================
// API Password WiFi — JanLupNgops.fun  (Vercel Serverless Function)
// ------------------------------------------------------------
// GET  /api/wifi   -> { passwords: { "1": "...", ..., "31": "..." } }
//                     Publik, karena password memang ditampilkan di situs.
// POST /api/wifi   -> Simpan password baru ke database online.
//                     Wajib header:  x-admin-secret: <WIFI_ADMIN_SECRET>
//                     Body JSON:     { "passwords": { "1": "...", ... } }
//
// Penyimpanan: Upstash Redis (dari menu Storage di Vercel) lewat REST API.
// Env yang didukung (otomatis terisi saat database dihubungkan ke project):
//   KV_REST_API_URL + KV_REST_API_TOKEN
//   atau UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// Env wajib untuk menulis: WIFI_ADMIN_SECRET (bebas, buat sendiri).
// ============================================================

const KEY = "janlup_wifi_passwords_v1";

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function redisGet(cfg) {
  const r = await fetch(cfg.url + "/get/" + KEY, {
    headers: { Authorization: "Bearer " + cfg.token },
  });
  if (!r.ok) throw new Error("redis get gagal: " + r.status);
  const j = await r.json();
  return j.result || null;
}

async function redisSet(cfg, value) {
  const r = await fetch(cfg.url + "/set/" + KEY, {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.token },
    body: value,
  });
  if (!r.ok) throw new Error("redis set gagal: " + r.status);
}

function sanitizePasswords(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (let d = 1; d <= 31; d++) {
    const v = input[d] !== undefined ? input[d] : input[String(d)];
    if (v === undefined) continue;
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > 64) return null;
    out[d] = t;
  }
  return Object.keys(out).length > 0 ? out : null;
}

module.exports = async function handler(req, res) {
  const cfg = redisConfig();
  if (!cfg) {
    return res.status(503).json({ error: "Database belum terhubung. Buat Upstash Redis di menu Storage Vercel lalu hubungkan ke project ini." });
  }

  if (req.method === "GET") {
    try {
      const raw = await redisGet(cfg);
      let passwords = {};
      if (raw) { try { passwords = JSON.parse(raw) || {}; } catch (e) { passwords = {}; } }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ passwords });
    } catch (e) {
      return res.status(502).json({ error: "Gagal membaca database." });
    }
  }

  if (req.method === "POST") {
    const secret = process.env.WIFI_ADMIN_SECRET;
    if (!secret) {
      return res.status(503).json({ error: "WIFI_ADMIN_SECRET belum dipasang di Environment Variables Vercel." });
    }
    if ((req.headers["x-admin-secret"] || "") !== secret) {
      return res.status(401).json({ error: "Kata sandi server salah." });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const clean = sanitizePasswords(body && body.passwords);
    if (!clean) {
      return res.status(400).json({ error: "Format password tidak valid (kirim { passwords: { 1..31: string } })." });
    }
    try {
      await redisSet(cfg, JSON.stringify(clean));
      return res.status(200).json({ ok: true, saved: Object.keys(clean).length });
    } catch (e) {
      return res.status(502).json({ error: "Gagal menyimpan ke database." });
    }
  }

  return res.status(405).json({ error: "Method tidak didukung." });
}

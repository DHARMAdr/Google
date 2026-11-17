/* =====================================================================
   cloudflare-storage/worker.js  -  ClipCutter STORAGE server on Cloudflare (Worker + R2)
   =====================================================================
   WHAT IT IS: a Cloudflare Worker that keeps your uploaded videos in an R2 bucket
   TEMPORARILY and deletes them again. It speaks the same /api/... language as the
   ClipCutter site (js/cloud.js), so you paste its address into the site's "Cloud" box.

   WHAT IT CAN DO:   upload (in 8 MB pieces, resumable), keep, delete, purge, auto-delete after TTL_HOURS.
   WHAT IT CANNOT DO: render clips. A Worker cannot run ffmpeg. It reports canRender:false so the
                      site keeps rendering on your phone (Turbo) and only uses this for storage.

   HOW IT WORKS:
     R2 keys:  v/<id>/meta.json        (name, size, pieces, times)
               v/<id>/c/<000042>       (one 8 MB piece of the video)
     A cron trigger (see wrangler.toml) runs sweep() every hour and removes old videos.

   SECURITY: every call except /api/health needs the secret TOKEN (Bearer token). Set it with
             `wrangler secret put TOKEN`. Only origins in ALLOWED_ORIGINS may call it from a browser.

   HOW TO IMPROVE: add GET of the stored video (for use on another device), per-user folders,
                   or a Cloudflare Container running ffmpeg to make it render too.
   ===================================================================== */

const CHUNK = 8 * 1024 * 1024;          // size of one piece (the site asks for this size)
const VERSION = "storage-1.0";

const json = (data, status, cors) => new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, cors || {}) });

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin"), list = (env.ALLOWED_ORIGINS || "https://dharmadr.github.io").split(",").map((s) => s.trim());
  if (!origin || !(list.includes("*") || list.includes(origin))) return {};
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,Range", "Access-Control-Max-Age": "600" };
}

// Compare two secrets without leaking how many letters matched.
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// List every object under a prefix (R2 returns at most 1000 per page).
async function listAll(env, prefix) {
  const out = []; let cursor;
  do {
    const r = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    out.push(...r.objects); cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

const readMeta = async (env, id) => { const o = await env.BUCKET.get("v/" + id + "/meta.json"); return o ? o.json() : null; };
const writeMeta = (env, m) => env.BUCKET.put("v/" + id2(m) + "/meta.json", JSON.stringify(m));
const id2 = (m) => m.id;

async function deleteVideo(env, id) {
  const objs = await listAll(env, "v/" + id + "/");
  for (let i = 0; i < objs.length; i += 1000) await env.BUCKET.delete(objs.slice(i, i + 1000).map((o) => o.key));
  return objs.length > 0;
}

async function usedBytes(env) { return (await listAll(env, "v/")).reduce((s, o) => s + o.size, 0); }

async function state(env, m) {
  const pieces = await listAll(env, "v/" + m.id + "/c/");
  const received = pieces.map((o) => parseInt(o.key.split("/").pop(), 10)).sort((a, b) => a - b);
  return { id: m.id, name: m.name, size: m.size, chunkSize: CHUNK, totalChunks: m.totalChunks, received, complete: !!m.complete, jobs: {}, serverTime: Date.now() };
}

// Hourly clean-up: remove videos not touched for TTL_HOURS (unfinished uploads: 6 hours).
async function sweep(env) {
  const ttl = (parseFloat(env.TTL_HOURS) || 48) * 3600e3, now = Date.now();
  const metas = (await listAll(env, "v/")).filter((o) => o.key.endsWith("/meta.json"));
  let n = 0;
  for (const o of metas) {
    const m = await (await env.BUCKET.get(o.key)).json().catch(() => null);
    const id = o.key.split("/")[1];
    const age = now - (m ? m.touched || m.created || 0 : 0);
    if (!m || age > (m.complete ? ttl : 6 * 3600e3)) { await deleteVideo(env, id); n++; }
  }
  return n;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(sweep(env)); },

  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "");
    try {
      if (p === "/api/health") return json({ ok: true, app: "clipcutter-server", version: VERSION, storageOnly: true }, 200, cors);
      const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.TOKEN) return json({ error: "the server has no TOKEN secret yet (run: wrangler secret put TOKEN)" }, 500, cors);
      if (!same(auth, env.TOKEN)) return json({ error: "wrong or missing token" }, 401, cors);

      const maxBytes = (parseFloat(env.MAX_GB) || 8) * 1e9, ttlHours = parseFloat(env.TTL_HOURS) || 48;

      if (p === "/api/info" && req.method === "GET") {
        const used = await usedBytes(env);
        return json({ ok: true, version: VERSION, ffmpeg: "none (storage only)", canRender: false, titles: false, nvenc: false, cores: 0, memGB: 0, freeBytes: maxBytes - used, usedBytes: used, maxBytes, ttlHours, chunkSize: CHUNK, videos: (await listAll(env, "v/")).filter((o) => o.key.endsWith("/meta.json")).length, queue: 0 }, 200, cors);
      }
      if (p === "/api/purge" && req.method === "POST") {
        const ids = new Set((await listAll(env, "v/")).map((o) => o.key.split("/")[1]));
        for (const id of ids) await deleteVideo(env, id);
        return json({ ok: true, deleted: ids.size }, 200, cors);
      }
      if (p === "/api/videos" && req.method === "POST") {
        const b = await req.json().catch(() => ({})), size = Math.floor(+b.size);
        if (!(size > 0)) return json({ error: "size is required" }, 400, cors);
        if ((await usedBytes(env)) + size > maxBytes) return json({ error: "the storage is full (limit " + (maxBytes / 1e9).toFixed(1) + " GB). Delete videos first." }, 507, cors);
        const id = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("");
        const m = { id, name: String(b.name || "video").slice(0, 200), size, duration: +b.duration || 0, w: +b.w || 0, h: +b.h || 0, totalChunks: Math.ceil(size / CHUNK), complete: false, created: Date.now(), touched: Date.now() };
        await writeMeta(env, m);
        return json(await state(env, m), 200, cors);
      }

      const m = /^\/api\/videos\/([a-f0-9]{24})(\/.*)?$/.exec(p);
      if (!m) return json({ error: "unknown address" }, 404, cors);
      const id = m[1], sub = m[2] || "", meta = await readMeta(env, id);
      if (!meta) return json({ error: "video not found (it may have been deleted)" }, 404, cors);

      if (sub === "" && req.method === "GET") { meta.touched = Date.now(); await writeMeta(env, meta); return json(await state(env, meta), 200, cors); }
      if (sub === "" && req.method === "DELETE") return json({ ok: await deleteVideo(env, id) }, 200, cors);

      if (sub === "/chunk" && req.method === "PUT") {
        const index = parseInt(url.searchParams.get("index"), 10);
        if (!(index >= 0 && index < meta.totalChunks)) return json({ error: "bad chunk index" }, 400, cors);
        const expect = Math.min(CHUNK, meta.size - index * CHUNK), data = await req.arrayBuffer();
        if (data.byteLength !== expect) return json({ error: "chunk " + index + " has " + data.byteLength + " bytes, expected " + expect }, 400, cors);
        await env.BUCKET.put("v/" + id + "/c/" + String(index).padStart(6, "0"), data);
        return json({ ok: true, total: meta.totalChunks }, 200, cors);
      }
      if (sub === "/complete" && req.method === "POST") {
        const st = await state(env, meta);
        if (st.received.length !== meta.totalChunks) return json({ error: "missing pieces", missing: meta.totalChunks - st.received.length }, 409, cors);
        meta.complete = true; meta.touched = Date.now(); await writeMeta(env, meta);
        return json(await state(env, meta), 200, cors);
      }
      if (sub.startsWith("/jobs")) return json({ error: "this server only stores videos; it cannot render (a Worker has no ffmpeg). Use the phone's Turbo export." }, 501, cors);
      return json({ error: "unknown address" }, 404, cors);
    } catch (e) {
      return json({ error: "server error: " + (e && e.message ? e.message : e) }, 500, cors);
    }
  },
};

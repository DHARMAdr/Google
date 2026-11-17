/* =====================================================================
   cloudflare-storage/worker.js  -  ClipCutter STORAGE server on Cloudflare (Worker + R2)
   =====================================================================
   WHAT IT IS: a Cloudflare Worker that keeps your uploaded videos in an R2 bucket
   TEMPORARILY and deletes them again. It speaks the same /api/... language as the
   ClipCutter site (js/cloud.js), so you paste its address into the site's "Cloud" box.

   WHAT IT CAN DO:   upload (in 8 MB pieces, resumable), keep, delete, purge, download back.
                     PROFILES: each person has a username + 6-digit code. Their videos and finished clips
                     are kept apart. An ADMIN profile ("parent") can see every profile and its files.
                     Optional auto-delete after TTL_HOURS (default 0 = keep until you delete).
   WHAT IT CANNOT DO: render clips. A Worker cannot run ffmpeg. It reports canRender:false so the
                      site keeps rendering on your phone (Turbo) and only uses this for storage.

   HOW IT WORKS:
     R2 keys:  v/<id>/meta.json        (name, size, pieces, times)
               v/<id>/c/<000042>       (one 8 MB piece of the video)
     A cron trigger (see wrangler.toml) runs sweep() every hour and removes old videos.

   SECURITY: every call except /api/health, /api/register and /api/login needs a Bearer token:
             either a SESSION token (given at login) or the owner TOKEN secret (`wrangler secret put TOKEN`).
             The owner TOKEN is also the key that creates the ADMIN profile.
             A 6-digit code is weak by nature, so: the code is stored only as a salted PBKDF2 hash,
             5 wrong tries lock that profile for 10 minutes, and sessions expire after 30 days. Only origins in ALLOWED_ORIGINS may call it from a browser.

   HOW TO IMPROVE: add GET of the stored video (for use on another device), per-user folders,
                   or a Cloudflare Container running ffmpeg to make it render too.
   ===================================================================== */

const CHUNK = 8 * 1024 * 1024;          // size of one piece (the site asks for this size)
const VERSION = "storage-2.0";

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
const writeMeta = (env, m) => env.BUCKET.put("v/" + m.id + "/meta.json", JSON.stringify(m));

async function deleteVideo(env, id) {
  const objs = await listAll(env, "v/" + id + "/");
  for (let i = 0; i < objs.length; i += 1000) await env.BUCKET.delete(objs.slice(i, i + 1000).map((o) => o.key));
  return objs.length > 0;
}

async function usedBytes(env) { return (await listAll(env, "v/")).reduce((s, o) => s + o.size, 0); }

async function state(env, m) {
  const pieces = await listAll(env, "v/" + m.id + "/c/");
  const received = pieces.map((o) => parseInt(o.key.split("/").pop(), 10)).sort((a, b) => a - b);
  return { id: m.id, name: m.name, owner: m.owner, size: m.size, chunkSize: CHUNK, totalChunks: m.totalChunks, received, complete: !!m.complete, clips: m.clips || {}, created: m.created, jobs: {}, serverTime: Date.now() };
}

/* ---------- profiles (username + 6-digit code) ---------- */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (t) => hex(await crypto.subtle.digest("SHA-256", enc.encode(t)));
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
const cleanName = (n) => String(n || "").trim().toLowerCase();
const validName = (n) => /^[a-z0-9_]{3,20}$/.test(n);
const validPin = (p) => /^\d{6}$/.test(String(p || ""));
const readUser = async (env, name) => { const o = await env.BUCKET.get("users/" + name + ".json"); return o ? o.json() : null; };
const writeUser = (env, u) => env.BUCKET.put("users/" + u.name + ".json", JSON.stringify(u));

async function newSession(env, user) {
  const token = "cc_" + rand(24);
  await env.BUCKET.put("sessions/" + (await sha(token)), JSON.stringify({ user: user.name, expires: Date.now() + 30 * 864e5 }));
  return token;
}

// Who is calling? -> { name, role } or null.
async function whoAmI(env, auth) {
  if (!auth) return null;
  if (env.TOKEN && same(auth, env.TOKEN)) return { name: "owner", role: "admin" };           // the owner key always works
  const o = await env.BUCKET.get("sessions/" + (await sha(auth)));
  if (!o) return null;
  const s = await o.json();
  if (s.expires < Date.now()) { await env.BUCKET.delete("sessions/" + (await sha(auth))); return null; }
  const u = await readUser(env, s.user);
  if (!u) return null;
  return { name: u.name, role: u.role };
}

async function allUsers(env) {
  const out = [];
  for (const o of await listAll(env, "users/")) { const u = await (await env.BUCKET.get(o.key)).json(); out.push(u); }
  return out;
}
async function allVideoMetas(env) {
  const out = [];
  for (const o of (await listAll(env, "v/")).filter((x) => x.key.endsWith("/meta.json"))) { const m = await (await env.BUCKET.get(o.key)).json().catch(() => null); if (m) out.push(m); }
  return out;
}

// Delete videos that were never finished (6 h) and, if TTL_HOURS > 0, videos not used for that long.
async function sweep(env) {
  const ttl = (parseFloat(env.TTL_HOURS) || 0) * 3600e3, now = Date.now();
  let n = 0;
  for (const m of await allVideoMetas(env)) {
    const age = now - (m.touched || m.created || 0);
    if (age > (m.complete ? (ttl || Infinity) : 6 * 3600e3)) { await deleteVideo(env, m.id); n++; }
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
      if (p === "/api/health") return json({ ok: true, app: "clipcutter-server", version: VERSION, storageOnly: true, profiles: true }, 200, cors);
      if (!env.TOKEN) return json({ error: "the server has no TOKEN secret yet (add the secret named TOKEN)" }, 500, cors);

      /* ----- sign up / log in (no token needed) ----- */
      if ((p === "/api/register" || p === "/api/login") && req.method === "POST") {
        const b = await req.json().catch(() => ({})), name = cleanName(b.username), pin = String(b.pin || "");
        if (!validName(name)) return json({ error: "username: 3-20 letters, numbers or _" }, 400, cors);
        if (!validPin(pin)) return json({ error: "the code must be exactly 6 digits" }, 400, cors);
        if (p === "/api/register") {
          if (await readUser(env, name)) return json({ error: "that username is taken" }, 409, cors);
          const isAdmin = b.ownerKey && same(String(b.ownerKey), env.TOKEN);
          if (!isAdmin && String(env.OPEN_SIGNUP || "true") === "false") return json({ error: "sign-up is closed. Ask the admin to create your profile." }, 403, cors);
          const salt = rand(16), u = { name, role: isAdmin ? "admin" : "child", salt, hash: await pinHash(pin, salt), fails: 0, lockUntil: 0, created: Date.now(), lastSeen: Date.now() };
          await writeUser(env, u);
          return json({ ok: true, token: await newSession(env, u), user: u.name, role: u.role }, 200, cors);
        }
        const u = await readUser(env, name);
        if (u && u.lockUntil > Date.now()) return json({ error: "too many wrong codes. Try again in " + Math.ceil((u.lockUntil - Date.now()) / 60000) + " min." }, 429, cors);
        if (!u || (await pinHash(pin, u.salt)) !== u.hash) {
          if (u) { u.fails = (u.fails || 0) + 1; if (u.fails >= 5) { u.fails = 0; u.lockUntil = Date.now() + 10 * 60000; } await writeUser(env, u); }
          return json({ error: "wrong username or code" }, 401, cors);
        }
        u.fails = 0; u.lastSeen = Date.now(); await writeUser(env, u);
        return json({ ok: true, token: await newSession(env, u), user: u.name, role: u.role }, 200, cors);
      }

      /* ----- everything else needs a session (or the owner key) ----- */
      const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const me = await whoAmI(env, auth);
      if (!me) return json({ error: "wrong or missing token (log in again)" }, 401, cors);
      const isAdmin = me.role === "admin";

      if (p === "/api/logout" && req.method === "POST") { await env.BUCKET.delete("sessions/" + (await sha(auth))); return json({ ok: true }, 200, cors); }
      if (p === "/api/me") return json({ ok: true, user: me.name, role: me.role }, 200, cors);

      const maxBytes = (parseFloat(env.MAX_GB) || 8) * 1e9, ttlHours = parseFloat(env.TTL_HOURS) || 0;

      if (p === "/api/info" && req.method === "GET") {
        const used = await usedBytes(env), metas = await allVideoMetas(env), mine = isAdmin ? metas : metas.filter((m) => m.owner === me.name);
        return json({ ok: true, version: VERSION, user: me.name, role: me.role, ffmpeg: "none (storage only)", canRender: false, titles: false, nvenc: false, cores: 0, memGB: 0, freeBytes: maxBytes - used, usedBytes: used, maxBytes, ttlHours, chunkSize: CHUNK, videos: mine.length, queue: 0 }, 200, cors);
      }

      /* ----- admin ("parent") area ----- */
      if (p.startsWith("/api/admin")) {
        if (!isAdmin) return json({ error: "admin only" }, 403, cors);
        if (p === "/api/admin/users" && req.method === "GET") {
          const metas = await allVideoMetas(env), users = await allUsers(env);
          return json({ users: users.map((u) => { const mv = metas.filter((m) => m.owner === u.name); return { name: u.name, role: u.role, created: u.created, lastSeen: u.lastSeen, videos: mv.length, clips: mv.reduce((n, m) => n + Object.keys(m.clips || {}).length, 0), bytes: mv.reduce((n, m) => n + (m.size || 0) + Object.values(m.clips || {}).reduce((x, c) => x + (c.size || 0), 0), 0) }; }) }, 200, cors);
        }
        const am = /^\/api\/admin\/users\/([a-z0-9_]{3,20})(\/videos|\/pin)?$/.exec(p);
        if (am) {
          const uname = am[1], u = await readUser(env, uname);
          if (!u) return json({ error: "no such profile" }, 404, cors);
          if (am[2] === "/videos" && req.method === "GET") { const out = []; for (const m of (await allVideoMetas(env)).filter((x) => x.owner === uname)) out.push(await state(env, m)); return json({ user: uname, videos: out }, 200, cors); }
          if (am[2] === "/pin" && req.method === "POST") { const b = await req.json().catch(() => ({})); if (!validPin(b.pin)) return json({ error: "the code must be exactly 6 digits" }, 400, cors); u.salt = rand(16); u.hash = await pinHash(String(b.pin), u.salt); u.fails = 0; u.lockUntil = 0; await writeUser(env, u); return json({ ok: true }, 200, cors); }
          if (!am[2] && req.method === "DELETE") {
            if (u.role === "admin") return json({ error: "an admin profile cannot be deleted here" }, 400, cors);
            for (const m of (await allVideoMetas(env)).filter((x) => x.owner === uname)) await deleteVideo(env, m.id);
            await env.BUCKET.delete("users/" + uname + ".json");
            return json({ ok: true }, 200, cors);
          }
        }
        return json({ error: "unknown address" }, 404, cors);
      }

      if (p === "/api/purge" && req.method === "POST") {
        const mine = (await allVideoMetas(env)).filter((m) => isAdmin ? (url.searchParams.get("all") === "1" || m.owner === me.name) : m.owner === me.name);
        for (const m of mine) await deleteVideo(env, m.id);
        return json({ ok: true, deleted: mine.length }, 200, cors);
      }
      if (p === "/api/videos" && req.method === "GET") {
        const out = []; for (const m of (await allVideoMetas(env)).filter((x) => isAdmin || x.owner === me.name)) out.push(await state(env, m));
        return json({ videos: out }, 200, cors);
      }
      if (p === "/api/videos" && req.method === "POST") {
        const b = await req.json().catch(() => ({})), size = Math.floor(+b.size);
        if (!(size > 0)) return json({ error: "size is required" }, 400, cors);
        if ((await usedBytes(env)) + size > maxBytes) return json({ error: "the storage is full (limit " + (maxBytes / 1e9).toFixed(1) + " GB). Delete videos first." }, 507, cors);
        const id = rand(12);
        const m = { id, owner: me.name, name: String(b.name || "video").slice(0, 200), size, duration: +b.duration || 0, w: +b.w || 0, h: +b.h || 0, totalChunks: Math.ceil(size / CHUNK), complete: false, clips: {}, created: Date.now(), touched: Date.now() };
        await writeMeta(env, m);
        return json(await state(env, m), 200, cors);
      }

      const m = /^\/api\/videos\/([a-f0-9]{24})(\/.*)?$/.exec(p);
      if (!m) return json({ error: "unknown address" }, 404, cors);
      const id = m[1], sub = m[2] || "", meta = await readMeta(env, id);
      if (!meta || (!isAdmin && meta.owner !== me.name)) return json({ error: "video not found (it may have been deleted)" }, 404, cors);

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
      // Download the original video back (to continue on another phone).
      if (sub === "/file" && req.method === "GET") {
        if (!meta.complete) return json({ error: "the upload is not finished" }, 409, cors);
        const keys = (await listAll(env, "v/" + id + "/c/")).map((o) => o.key).sort();
        let i = 0;
        const body = new ReadableStream({ async pull(c) { if (i >= keys.length) return c.close(); const o = await env.BUCKET.get(keys[i++]); c.enqueue(new Uint8Array(await o.arrayBuffer())); } });
        return new Response(body, { headers: Object.assign({ "Content-Type": "application/octet-stream", "Content-Length": String(meta.size) }, cors) });
      }
      // Finished clips (Shorts) made on the phone are kept here too.
      const cm = /^\/clips\/([0-9a-z_-]{1,20})(\/file)?$/.exec(sub);
      if (cm) {
        const cid = cm[1], key = "v/" + id + "/clip/" + cid;
        if (!cm[2] && req.method === "PUT") {
          const data = await req.arrayBuffer();
          if (data.byteLength > 95 * 1024 * 1024) return json({ error: "clip too large for one request (95 MB max)" }, 413, cors);
          await env.BUCKET.put(key, data);
          const m2 = await readMeta(env, id); m2.clips = m2.clips || {};
          m2.clips[cid] = { name: String(url.searchParams.get("name") || cid).slice(0, 120), size: data.byteLength, at: Date.now() };
          await writeMeta(env, m2);
          return json({ ok: true }, 200, cors);
        }
        if (cm[2] && req.method === "GET") {
          const o = await env.BUCKET.get(key);
          if (!o) return json({ error: "clip not found" }, 404, cors);
          return new Response(await o.arrayBuffer(), { headers: Object.assign({ "Content-Type": "video/mp4" }, cors) });
        }
        if (!cm[2] && req.method === "DELETE") { await env.BUCKET.delete(key); const m2 = await readMeta(env, id); if (m2 && m2.clips) { delete m2.clips[cid]; await writeMeta(env, m2); } return json({ ok: true }, 200, cors); }
      }
      if (sub.startsWith("/jobs")) return json({ error: "this server only stores videos; it cannot render (a Worker has no ffmpeg). Use the phone's Turbo export." }, 501, cors);
      return json({ error: "unknown address" }, 404, cors);
    } catch (e) {
      return json({ error: "server error: " + (e && e.message ? e.message : e) }, 500, cors);
    }
  },
};

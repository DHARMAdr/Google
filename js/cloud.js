/* =====================================================================
   js/cloud.js  -  talks to YOUR optional ClipCutter cloud server (see /server)
   =====================================================================
   WHY THIS FILE EXISTS
     The phone is slow at video rendering and the page must stay open. If you run the small server from
     the /server folder (on your own Cloudflare Tunnel, VPS or PC), the site can send a video there once,
     ask the server to render the clips with real ffmpeg, and download the finished files later, even if
     you closed the page in between.

   THE RULES THIS FILE FOLLOWS
     1. OFF by default. Nothing is sent anywhere until you fill in the server address + token.
     2. A video is sent to the server only when you pick "Cloud server" for export (or turn on
        "upload new videos automatically").
     3. When you delete a video on the site, it is deleted on the server too. If the server cannot be
        reached at that moment, the delete is remembered and retried automatically, later, until it works.
     4. If the server fails, the site renders on your device instead (app.js does the fallback).

   HOW IT WORKS
     - Uploads are cut into 8 MB pieces, three at a time, each retried with a growing pause. If the page
       closes halfway, the next upload asks the server which pieces it already has and sends the rest.
     - Two addresses can be given (main + backup / proxy). The fastest one that answers is used, and if it
       fails the other one is tried automatically.
     - The token is sent in an Authorization header and kept only in this browser (localStorage).

   HOW TO IMPROVE: upload only the clip parts (smaller), add a progress bar per piece, add several
   servers at once and upload to the fastest.
   ===================================================================== */

const Cloud = (function () {
  "use strict";
  const KEY = "cloud", DEL_KEY = "cloudDeletes";
  let cfg = Object.assign({ url: "", backup: "", token: "", auto: false }, store.get(KEY, {}));
  let active = "";                                           // the address that answered fastest last time

  const norm = (u) => String(u || "").trim().replace(/\/+$/, "");
  const enabled = () => !!(norm(cfg.url) && cfg.token);
  const getConfig = () => Object.assign({}, cfg);
  function setConfig(c) { cfg = Object.assign(cfg, c); store.set(KEY, cfg); active = ""; }
  const bases = () => [norm(cfg.url), norm(cfg.backup)].filter(Boolean);

  class CloudError extends Error { constructor(msg, status) { super(msg); this.name = "CloudError"; this.status = status; } }

  async function timed(url, opts, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 30000);
    try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); }
    finally { clearTimeout(t); }
  }

  // One request. Tries the best address first and falls back to the other one on network trouble.
  async function call(method, path, o) {
    o = o || {};
    let list = bases();
    if (!list.length) throw new CloudError("No server address is set.", 0);
    if (active && list.includes(active)) list = [active].concat(list.filter((b) => b !== active));
    let lastErr = null;
    for (const base of list) {
      try {
        const headers = Object.assign({ Authorization: "Bearer " + cfg.token }, o.json ? { "Content-Type": "application/json" } : {}, o.headers || {});
        const res = await timed(base + path, { method, headers, body: o.json ? JSON.stringify(o.json) : o.body }, o.timeout);
        if ([502, 503, 504].includes(res.status) && list.length > 1) { lastErr = new CloudError("server answered " + res.status, res.status); continue; }
        active = base;
        if (o.raw) return res;
        let data = null; try { data = await res.json(); } catch (e) { /* not json */ }
        if (!res.ok) throw new CloudError((data && data.error) || ("server answered " + res.status + ([404, 405].includes(res.status) ? " - this address is NOT a ClipCutter server (it is some other app or Worker). A Cloudflare Worker cannot run ffmpeg; see the Cloud help." : "")), res.status);
        return data;
      } catch (e) {
        if (e instanceof CloudError && e.status !== 0) throw e;                 // a real answer from the server: do not try the other one
        lastErr = e.name === "AbortError" ? new CloudError("the server did not answer in time", 0) : e;
      }
    }
    throw new CloudError("Could not reach the server: " + errText(lastErr) + (/^http:/.test(bases()[0] || "") && location.protocol === "https:" ? " (this page is https, so the server address must be https too)" : ""), 0);
  }

  // Test every address: speed + details. Used by the "Test" button.
  async function test() {
    const out = { ok: false, results: [], info: null };
    for (const base of bases()) {
      const t0 = performance.now();
      try {
        // First ask who is there. Only a real ClipCutter server answers /api/health with app "clipcutter-server".
        try {
          const h = await timed(base + "/api/health", {}, 12000);
          let hj = null; try { hj = await h.json(); } catch (e) { /* not json */ }
          if (!hj || hj.app !== "clipcutter-server") { out.results.push({ base, ok: false, error: "this address is NOT a ClipCutter server (answered " + h.status + "). It is another app/Worker. Put the address of the ClipCutter server here (see README: server)." }); continue; }
        } catch (e) { /* unreachable: the normal request below reports it */ }
        const res = await timed(base + "/api/info", { headers: { Authorization: "Bearer " + cfg.token } }, 12000);
        const ms = Math.round(performance.now() - t0);
        if (res.status === 401) out.results.push({ base, ok: false, ms, error: "the address works but the token is wrong" });
        else if (!res.ok) out.results.push({ base, ok: false, ms, error: "server answered " + res.status });
        else { const info = await res.json(); out.results.push({ base, ok: true, ms, info }); if (!out.info) out.info = info; }
      } catch (e) {
        out.results.push({ base, ok: false, error: (e.name === "AbortError" ? "no answer within 12 s" : errText(e)) + (/^http:/.test(base) && location.protocol === "https:" ? " (https page cannot call an http server)" : "") });
      }
    }
    const good = out.results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
    if (good.length) { out.ok = true; active = good[0].base; }
    if (out.info) { try { store.set("cloudCanRender", out.info.canRender !== false); } catch (e) { /* ignore */ } }   // storage-only servers (Cloudflare R2) cannot render
    return out;
  }

  /* ---------- upload ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Send the video (resumes automatically). onProgress(fraction, secondsLeft). ctl.cancel stops it.
  async function upload(v, onProgress, ctl) {
    ctl = ctl || {};
    const t0 = performance.now();
    let st = null;
    // Is the earlier upload still on the server?
    if (v.remote && v.remote.id) {
      try { st = await call("GET", "/api/videos/" + v.remote.id); } catch (e) { if (e.status === 404) { v.remote = null; } else throw e; }
    }
    if (!st) {
      st = await call("POST", "/api/videos", { json: { name: v.name, size: v.file.size, duration: v.duration, w: v.w, h: v.h } });
      v.remote = { id: st.id, complete: false, pending: [], options: null };
    }
    if (st.complete && v.remote) { v.remote.complete = true; return v.remote; }
    const cs = st.chunkSize, total = st.totalChunks, have = new Set(st.received || []);
    const todo = []; for (let i = 0; i < total; i++) if (!have.has(i)) todo.push(i);
    let sent = have.size * cs, inflight = 0, failed = null;
    const size = v.file.size;
    const report = () => { const f = Math.min(1, sent / size), el = (performance.now() - t0) / 1000; onProgress && onProgress(f, f > 0.02 ? el / f - el : 0); };
    report();

    async function worker() {
      while (todo.length && !failed) {
        if (ctl.cancel) throw new Error("cancelled");
        const i = todo.shift();
        const blob = v.file.slice(i * cs, Math.min(size, (i + 1) * cs));
        let ok = false;
        for (let attempt = 0; attempt < 6 && !ok; attempt++) {
          if (ctl.cancel) throw new Error("cancelled");
          try { await call("PUT", "/api/videos/" + v.remote.id + "/chunk?index=" + i, { body: blob, timeout: 180000 }); ok = true; }
          catch (e) {
            if (e.status === 404 || e.status === 401 || e.status === 507) throw e;      // not worth retrying
            if (attempt === 5) throw e;
            await sleep(1000 * Math.pow(2, attempt));                                   // 1, 2, 4, 8, 16 s
          }
        }
        sent += blob.size; report();
      }
    }
    try { await Promise.all([worker(), worker(), worker()]); }
    catch (e) { failed = e; throw e; }
    await call("POST", "/api/videos/" + v.remote.id + "/complete");
    v.remote.complete = true;
    onProgress && onProgress(1, 0);
    return v.remote;
  }

  /* ---------- rendering jobs ---------- */
  const submit = (v, clips, options) => call("POST", "/api/videos/" + v.remote.id + "/jobs", { json: { clips: clips.map((c) => ({ id: String(c.id), start: c.start, end: c.end, label: c.label || "" })), options } });
  const jobs = (v) => call("GET", "/api/videos/" + v.remote.id + "/jobs");
  const cancelJobs = (v) => call("POST", "/api/videos/" + v.remote.id + "/jobs/cancel");
  const status = (v) => call("GET", "/api/videos/" + v.remote.id);

  // Download a finished clip as a Blob. Resumes if the connection breaks.
  async function download(v, clipId, expectedSize, onProgress) {
    const chunks = []; let got = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await call("GET", "/api/videos/" + v.remote.id + "/clips/" + clipId + "/file", { raw: true, headers: got ? { Range: "bytes=" + got + "-" } : {}, timeout: 120000 });
        if (!res.ok && res.status !== 206) throw new CloudError("download failed (" + res.status + ")", res.status);
        const reader = res.body.getReader();
        for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); got += r.value.length; onProgress && onProgress(expectedSize ? got / expectedSize : 0); }
        if (!expectedSize || got >= expectedSize) return new Blob(chunks, { type: "video/mp4" });
      } catch (e) { if (e.status === 404) throw e; await sleep(1000 * (attempt + 1)); }
    }
    throw new CloudError("the download kept breaking", 0);
  }

  /* ---------- deleting (with automatic retry) ---------- */
  const pendingDeletes = () => store.get(DEL_KEY, []);
  function remember(id) { const l = pendingDeletes(); if (!l.includes(id)) { l.push(id); store.set(DEL_KEY, l); } }

  // Delete a video on the server. Never throws: if it cannot be done now it is remembered and retried.
  async function remove(v) {
    const id = v.remote && v.remote.id;
    if (!id) return true;
    v.remote = null;
    if (!enabled()) { remember(id); return false; }
    try { await call("DELETE", "/api/videos/" + id, { timeout: 20000 }); return true; }
    catch (e) { if (e.status === 404) return true; remember(id); console.warn("Server delete postponed:", errText(e)); return false; }
  }
  async function flushDeletes() {
    if (!enabled()) return;
    const left = [];
    for (const id of pendingDeletes()) {
      try { await call("DELETE", "/api/videos/" + id, { timeout: 20000 }); }
      catch (e) { if (e.status !== 404) left.push(id); }
    }
    store.set(DEL_KEY, left);
  }
  async function purge() { return call("POST", "/api/purge"); }

  const canRender = () => { try { return store.get("cloudCanRender", true) !== false; } catch (e) { return true; } };
  return { canRender, enabled, getConfig, setConfig, test, upload, submit, jobs, cancelJobs, status, download, remove, flushDeletes, purge, pendingDeletes, CloudError };
})();

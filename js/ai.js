/* =====================================================================
   js/ai.js  -  the AI REFEREE (v5.9): an independent "second pair of eyes" that really LOOKS at the game
   =====================================================================
   WHY IT EXISTS
     The picture-matching methods never saw the real game, so they sometimes picked rows where YOU were killed.
     A vision AI (Claude) can actually READ a kill-feed picture: "who killed whom, which row is mine?".

   HOW IT WORKS (plain words)
     1. The normal scan finds MOMENTS where something could have happened: new kill-feed rows (live fights only)
        and, as a backup, bursts of real gunfire.
     2. For every moment the site cuts a small picture of the kill-feed corner out of the video (like a screenshot).
     3. The pictures are sent in small batches to Claude with a clear question:
        "Read every row. Who is the killer, who is the victim? Is the killer the main player (name X / highlighted row)?"
     4. Claude answers with JSON. Only rows where the MAIN PLAYER IS THE KILLER become kills (APPROVED, with the
        AI's reading as proof). Rows where you were the victim are rejected and written to the report.
     5. The answers are saved in the browser (cache), so running again costs nothing.

   COST / PRIVACY
     Only small cut-outs of the kill feed are sent (not the whole video), about 6 per request. A 40-minute video
     needs roughly 20-60 requests with the small model. Two ways to connect:
       a) the Worker route  (/api/ai): your Anthropic key is a secret on your Cloudflare Worker - best;
       b) a key pasted into the page (kept only in this browser; the browser sends it straight to Anthropic).

   HOW TO IMPROVE: send 2 pictures per moment (before / after) to see the NEW row, send the crosshair area to confirm
     the shot, let the AI also rate how exciting the play is, and let it read the round timer to skip buy phases.
   ===================================================================== */
const AI = (function () {
  "use strict";

  const MODELS = { "claude-haiku-5-5": "Haiku 5.5 (cheap, fast - recommended)", "claude-sonnet-5-5": "Sonnet 5.5 (smarter, costs more)" };
  const cfg = () => ({ key: store.get("ai.key", "") || "", name: store.get("ai.name", "") || "", model: store.get("ai.model", "claude-haiku-5-5") || "claude-haiku-5-5" });
  const useWorker = () => typeof Cloud !== "undefined" && Cloud.enabled() && Cloud.profile().loggedIn && !cfg().key;

  /* ---- one request to Claude (direct with a key, or through the Worker) ---- */
  async function ask(body) {
    const c = cfg(); body = Object.assign({ model: c.model, max_tokens: 1800 }, body);
    let data;
    if (c.key) {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(body) });
      data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("Anthropic answered " + res.status + ": " + ((data && data.error && data.error.message) || "unknown error"));
    } else if (useWorker()) data = await Cloud.ai(body);
    else throw new Error("No AI connection: paste an Anthropic API key, or log in to a server that has the ANTHROPIC_API_KEY secret.");
    return ((data && data.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  function parseJson(text) {
    const a = text.indexOf("["), b = text.lastIndexOf("]");
    if (a < 0 || b < a) throw new Error("the AI did not answer with JSON");
    return JSON.parse(text.slice(a, b + 1));
  }

  /* ---- cut kill-feed pictures out of the video ---- */
  async function openVideo(v) {
    const el = document.createElement("video"); el.muted = true; el.preload = "auto"; el.playsInline = true;
    el.src = v.url || URL.createObjectURL(v.file);
    await new Promise((res, rej) => { el.onloadeddata = res; el.onerror = () => rej(new Error("the browser cannot show this video for the AI")); setTimeout(() => rej(new Error("video did not load")), 20000); });
    return el;
  }
  async function seek(el, t) {
    await new Promise((res) => { const done = () => { el.removeEventListener("seeked", done); res(); }; el.addEventListener("seeked", done); el.currentTime = Math.min(Math.max(0, t), (el.duration || t) - 0.05); setTimeout(done, 6000); });
  }
  function crop(el, reg) {
    const W = el.videoWidth, H = el.videoHeight, x = Math.max(0, reg.x) * W, y = Math.max(0, reg.y) * H, w = Math.min(1 - reg.x, reg.w) * W, h = Math.min(1 - reg.y, reg.h) * H;
    const sc = Math.min(2.5, 640 / w), c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    c.getContext("2d").drawImage(el, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82).split(",")[1];
  }

  /* ---- which moments are worth showing to the AI? ---- */
  function candidates(an, max) {
    const out = [];
    const rows = (an.rows || []).slice().sort((a, b) => a.t - b.t);
    for (const r of rows) {
      if (typeof Referee !== "undefined" && !Referee.live(an, r.t)) continue;           // lobby / buy phase never goes to the AI
      if (!out.length || r.t - out[out.length - 1].t >= 1.2) out.push({ t: r.t, src: "row" });
    }
    // backup: bursts of real gunfire (in case the kill-feed rows were missed)
    const shots = (an.onsets || []).filter((o) => o.s >= 1.2).map((o) => o.t).sort((a, b) => a - b);
    for (let i = 0; i < shots.length;) {
      let j = i; while (j + 1 < shots.length && shots[j + 1] - shots[j] <= 1.5) j++;
      if (j - i + 1 >= 4) { const t = shots[j] + 1.0; if (!out.some((o) => Math.abs(o.t - t) < 3)) out.push({ t, src: "sound" }); }
      i = j + 1;
    }
    out.sort((a, b) => a.t - b.t);
    if (out.length > max) { const keep = out.filter((o) => o.src === "row"); return (keep.length > max ? keep.slice(0, max) : keep.concat(out.filter((o) => o.src !== "row").slice(0, max - keep.length))).sort((a, b) => a.t - b.t); }
    return out;
  }

  const SYSTEM = "You are a precise analyst of first-person shooter gameplay (mainly Valorant). Each image is a crop of the KILL FEED in the top-right corner of the screen. " +
    "Every kill-feed row reads: [killer name, with an agent icon] [weapon icon] [victim name, with an agent icon]; the KILLER is on the LEFT of the weapon icon, the VICTIM on the RIGHT. " +
    "Rows that involve the main player (the person who recorded the video) are usually drawn with a highlighted / lighter / outlined box, teammates and enemies are plain. " +
    "Be strict: if you cannot read a name or are unsure, say so with low confidence. Never guess. Answer ONLY with a JSON array, no other text.";

  async function judgeBatch(items, name) {
    const content = [];
    content.push({ type: "text", text: (name ? "The main player's in-game name is \"" + name + "\" (the tag after # may be missing; compare loosely but carefully)." : "The main player's name is unknown: use the highlighted row box as the sign of the main player.") +
      " For each image return one object: {\"i\": image number, \"rows\": [{\"killer\": text or null, \"victim\": text or null, \"mine\": \"killer\" | \"victim\" | \"none\" | \"unsure\"}], \"own_kill\": true/false (the main player is the KILLER of a row), \"own_death\": true/false (the main player is the VICTIM of a row), \"conf\": 0 to 1}. Return a JSON array with exactly " + items.length + " objects." });
    items.forEach((it, k) => { content.push({ type: "text", text: "Image " + (k + 1) + ":" }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: it.b64 } }); });
    const text = await ask({ system: SYSTEM, messages: [{ role: "user", content }] });
    return parseJson(text);
  }

  /* ---- the whole job ----
     v: the video, an: the analysis (needs an.rows / an.onsets), opts: {region, name, onProgress, cancel}.
     Returns { ok, events, stats, log } - events have the same shape Hunter.finish() expects. */
  async function verify(v, an, opts) {
    const c = cfg(), say = (f, t) => { try { opts.onProgress && opts.onProgress(f, t); } catch (e) { /* ignore */ } };
    const stats = { mode: "ai", model: c.model, candidates: 0, kills: 0, deaths: 0, reasons: {}, requests: 0, failed: 0 };
    const list = candidates(an, 160); stats.candidates = list.length;
    if (!list.length) return { ok: false, reason: "no candidate moments (no live fights found)", stats, events: [] };
    const cacheKey = "ai|" + [v.name, v.size || (v.file && v.file.size) || 0, Math.round(v.duration || 0), c.model, c.name.toLowerCase(), list.length].join("|");
    if (typeof Persist !== "undefined") { const hit = await Persist.cacheGet(cacheKey); if (hit && hit.events) { hit.stats = Object.assign({}, hit.stats, { fromCache: true }); return Object.assign({ ok: true }, hit); } }

    say(0.02, "AI: cutting " + list.length + " kill-feed pictures out of the video...");
    const el = await openVideo(v), shots = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (opts.cancel && opts.cancel()) throw new Error(Engine.CANCEL);
        await seek(el, list[i].t + 0.6);
        shots.push({ t: list[i].t, src: list[i].src, b64: crop(el, opts.region) });
        if (i % 4 === 0) say(0.02 + 0.28 * i / list.length, "AI: picture " + (i + 1) + "/" + list.length + "...");
      }
    } finally { try { el.removeAttribute("src"); el.load(); } catch (e) { /* ignore */ } }

    const BATCH = 6, batches = []; for (let i = 0; i < shots.length; i += BATCH) batches.push(shots.slice(i, i + BATCH));
    const events = [], log = []; let done = 0, next = 0;
    const worker = async () => {
      while (next < batches.length) {
        if (opts.cancel && opts.cancel()) return;
        const b = batches[next++]; let res = null, err = null;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try { stats.requests++; res = await judgeBatch(b, c.name); } catch (e) { err = e; if (/401|403|invalid x-api-key|not enabled|501/i.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
        }
        if (!res) { stats.failed++; log.push("batch failed: " + (err && err.message)); }
        else b.forEach((sh, k) => {
          const r = res.find((x) => +x.i === k + 1) || res[k] || {}, conf = Math.max(0, Math.min(1, +r.conf || 0));
          const rows = (r.rows || []).map((q) => (q.killer || "?") + " > " + (q.victim || "?") + " [" + q.mine + "]").join(" ; ");
          if (r.own_kill && conf >= 0.5) { events.push({ t: sh.t, conf: 0.6 + 0.4 * conf, kind: "kill", side: "killer", why: "AI read the kill feed: " + rows + " (confidence " + Math.round(conf * 100) + "%)" }); stats.kills++; }
          else if (r.own_death) { events.push({ t: sh.t, conf: 0.1, kind: "feed", why: "AI: you were the VICTIM - " + rows }); stats.deaths++; }
          else events.push({ t: sh.t, conf: 0.1, kind: "feed", why: "AI: not your kill - " + (rows || "no readable row") });
        });
        done++; say(0.3 + 0.68 * done / batches.length, "AI: asked Claude about " + Math.min(shots.length, done * BATCH) + "/" + shots.length + " moments (" + stats.kills + " of your kills so far)...");
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (opts.cancel && opts.cancel()) throw new Error(Engine.CANCEL);
    if (stats.failed === batches.length) return { ok: false, reason: log[0] || "every AI request failed", stats, events: [] };
    const out = { events, stats, log };
    if (typeof Persist !== "undefined" && !stats.failed) await Persist.cachePut(cacheKey, out);
    return Object.assign({ ok: true }, out);
  }

  // Quick connection test (one tiny question, no picture).
  async function test() {
    const t = await ask({ max_tokens: 30, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    return t.trim().slice(0, 40);
  }

  return { verify, test, cfg, MODELS, useWorker };
})();

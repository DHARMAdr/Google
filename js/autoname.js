/* =====================================================================
   js/autoname.js  -  AUTOMATIC "which kill-feed name is MINE?"  (v5.3)
   =====================================================================
   WHY IT EXISTS
     "Teach it my name" worked, but you had to find your own kill frame by frame. In a 36-minute
     video that is painful. This file finds your name BY ITSELF, so no picking is needed.

   THE IDEA (plain words)
     1. While the engine scans the video it keeps a tiny picture of every NEW kill-feed row
        (engine.js, 'collect' option -> an.rows).
     2. YOUR name shows up again and again in those rows (every one of your kills), and each time
        you were shooting right before it (loud gunshots in the sound). Teammates' and enemies'
        names appear too, but not together with YOUR gunfire so reliably.
     3. So we cut small pieces out of the rows, and for every piece count: "in how many OTHER rows
        does this exact piece show up, and how often was there gunfire of mine just before?"
        The piece that shows up most, always with gunfire, is your name (or your own weapon icon -
        both mean "my kill").
     4. Every row that contains that piece = one kill of yours. Rows followed by a view switch
        (the camera jumps = you died) are dropped.

   HONEST LIMITS
     - No text reading (no OCR): it compares pictures, so it needs the same size and look each time.
     - It needs at least 3 kills in the video to see a pattern. Fewer -> it says so and the older
       clue method is used instead.
     - If it picks the wrong thing, use "Teach it my name" once: that always wins over this.

   HOW TO IMPROVE: also learn the colour of the highlighted "my row" box, read the text with OCR,
     keep names of several accounts, use the spectator/killcam icon to separate deaths.
   ===================================================================== */
const AutoName = (function () {
  "use strict";

  const DT = Engine.DT, KEY = "autoname";
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  /* ---------- picture matching (normalised cross-correlation on every 2nd pixel) ---------- */
  // A candidate = a piece of a row, prepared for fast matching.
  function prepare(patch, w, x0, pw, ph) {
    const nx = Math.ceil(pw / 2), ny = Math.ceil(ph / 2), z = new Float32Array(nx * ny);
    let sum = 0, k = 0;
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++, k++) { z[k] = patch[(ty * 2) * w + x0 + tx * 2]; sum += z[k]; }
    const mean = sum / z.length; let ss = 0;
    for (let q = 0; q < z.length; q++) { z[q] -= mean; ss += z[q] * z[q]; }
    return { pw, ph, nx, ny, z, ss, x0 };
  }
  // Score of candidate C at one position (x, dy) in the row picture.
  function nccAt(C, Y, W, x, dy, n) {
    let sI = 0, sII = 0, sIT = 0, k = 0;
    for (let ty = 0; ty < C.ny; ty++) {
      let idx = (dy + ty * 2) * W + x;
      for (let tx = 0; tx < C.nx; tx++, k++, idx += 2) { const iv = Y[idx]; sI += iv; sII += iv * iv; sIT += iv * C.z[k]; }
    }
    const varI = sII - (sI * sI) / n;
    return varI < n * 60 ? -1 : sIT / Math.sqrt(varI * C.ss);
  }
  // Best score of candidate C anywhere in the row picture. Two steps (fast): a coarse search
  // (every 3rd pixel across, every 2nd line down), then a fine search around the best spot.
  // The row bands are cut slightly differently each time, so up/down shifts of a few pixels must be allowed.
  function bestMatch(C, row, stop) {
    const W = row.w, H = row.h, Y = row.patch, n = C.nx * C.ny, maxDy = H - C.ph;
    if (maxDy < 0) return -1;
    let best = -1, bx = 0, by = 0;
    for (let dy = 0; dy <= maxDy; dy += 2) for (let x = 0; x + C.pw <= W; x += 3) {
      const v = nccAt(C, Y, W, x, dy, n);
      if (v > best) { best = v; bx = x; by = dy; }
    }
    if (best < 0.3) return best;
    for (let dy = Math.max(0, by - 1); dy <= Math.min(maxDy, by + 1); dy++) for (let x = Math.max(0, bx - 2); x <= Math.min(W - C.pw, bx + 2); x++) {
      const v = nccAt(C, Y, W, x, dy, n);
      if (v > best) best = v;
    }
    return best;
  }
  function textiness(patch, w, x0, pw, ph) {                // how much ink (sharp changes) a piece has
    let e = 0, mn = 255, mx = 0;
    for (let y = 0; y < ph; y++) for (let x = 1; x < pw; x++) {
      const a = patch[y * w + x0 + x], b = patch[y * w + x0 + x - 1], d = a - b;
      if (d > 50 || d < -50) e++;
      if (a < mn) mn = a; if (a > mx) mx = a;
    }
    return mx - mn < 60 ? 0 : e / (pw * ph);
  }

  // Own gunfire just before time t (same idea as Hunter's shotsBefore).
  function gunBefore(onsets, t) {
    let n = 0;
    for (const o of onsets) { if (o.t > t + 0.25) break; if (o.t >= t - 2.4) n++; }
    return n;
  }

  // Count separate events (rows closer than 1.5 s are the same kill-feed line seen twice).
  function distinct(times) {
    const s = times.slice().sort((a, b) => a - b), out = [];
    for (const t of s) if (!out.length || t - out[out.length - 1] >= 1.5) out.push(t);
    return out;
  }

  /* ---------- the main routine ----------
     an      : the analysis (needs an.rows, an.onsets, an.ch.cut)
     progress: function(fraction, text)
     Returns { ok, reason, events, stats, learned } - events are in the same shape Hunter.finish() expects. */
  async function run(an, progress) {
    const say = (f, t) => { try { progress && progress(f, t); } catch (e) { /* ignore */ } };
    const stats = { mode: "auto-name", candidates: 0, kills: 0, reasons: {}, rows: 0 };
    let rows = (an.rows || []).slice().sort((a, b) => a.t - b.t);
    // Merge rows that are really the same line seen in consecutive samples: keep the one with the most new text.
    const merged = [];
    for (const r of rows) {
      const last = merged[merged.length - 1];
      if (last && r.t - last.t < 0.8) { if (r.grow > last.grow) merged[merged.length - 1] = r; } else merged.push(r);
    }
    rows = merged; stats.rows = rows.length;
    if (rows.length < 3) return { ok: false, reason: "only " + rows.length + " new kill-feed row(s) were seen - not enough to learn your name", stats };
    const onsets = (an.onsets || []).slice().sort((a, b) => a.t - b.t), cutAt = (t) => {
      for (let k = Math.max(0, Math.round((t - 0.3) / DT)); k <= Math.min(an.N - 1, Math.round((t + 2.5) / DT)); k++) if (an.ch.cut[k] > 0) return true;
      return false;
    };
    rows.forEach((r) => { r.gun = an.audioOk ? gunBefore(onsets, r.t + 0.2) : 0; r.death = cutAt(r.t); });
    const alive = rows.filter((r) => !r.death);
    const gunRows = alive.filter((r) => r.gun >= 2);
    const baseRate = alive.length ? gunRows.length / alive.length : 0;
    if (gunRows.length < 3) return { ok: false, reason: "fewer than 3 kill-feed rows came right after your own gunfire", stats };

    // 1) candidate pieces: from the rows that follow gunfire (strongest first), plus the name learned earlier.
    const seeds = gunRows.slice().sort((a, b) => (b.gun * 2 + b.grow) - (a.gun * 2 + a.grow)).slice(0, 36);
    const cands = [];
    const saved = store.get(KEY, null);
    if (saved && saved.b64) {
      try {
        const u = atob(saved.b64), g = new Uint8Array(u.length); for (let i = 0; i < u.length; i++) g[i] = u.charCodeAt(i);
        cands.push(Object.assign(prepare(g, saved.pw, 0, saved.pw, saved.ph), { src: "remembered", raw: g }));
      } catch (e) { /* ignore a broken saved copy */ }
    }
    for (const r of seeds) {
      const pw = Math.round(r.h * 4.2), ph = Math.max(6, r.h - 4 - (r.h % 2));
      const pieces = [];
      for (let x0 = 0; x0 + pw <= r.w; x0 += Math.round(pw / 2)) { const tx = textiness(r.patch.subarray(2 * r.w), r.w, x0, pw, ph); if (tx > 0.02) pieces.push({ x0, tx }); }
      pieces.sort((a, b) => b.tx - a.tx);
      for (const p of pieces.slice(0, 4)) {
        const raw = new Uint8Array(pw * ph); for (let y = 0; y < ph; y++) raw.set(r.patch.subarray((y + 2) * r.w + p.x0, (y + 2) * r.w + p.x0 + pw), y * pw);
        cands.push(Object.assign(prepare(raw, pw, 0, pw, ph), { src: "row@" + r.t.toFixed(0), raw }));
      }
    }
    if (!cands.length) return { ok: false, reason: "the kill-feed rows had no readable text pieces", stats };

    // 2) how often does each candidate show up among the gunfire rows?  (skip near-duplicates of pieces already counted)
    const MATCH = 0.78, compare = gunRows.slice(0, 80);
    const scored = [];
    for (let ci = 0; ci < cands.length; ci++) {
      const C = cands[ci];
      const hits = [];
      for (const r of compare) if (bestMatch(C, r, 0.95) >= MATCH) hits.push(r.t);
      const d = distinct(hits);
      scored.push({ C, n: d.length });
      if (ci % 6 === 0) { say(0.05 + 0.5 * ci / cands.length, "Looking for your name in the kill feed (" + (ci + 1) + "/" + cands.length + ")..."); await yieldUI(); }
    }
    scored.sort((a, b) => b.n - a.n);
    const top = []; for (const s of scored) { if (s.n < 3) break; top.push(s); if (top.length >= 6) break; }
    if (!top.length) return { ok: false, reason: "no picture piece came back 3 times after your gunfire", stats };

    // 3) check the best few against ALL rows: a real "mine" piece comes with gunfire almost every time and is not on every row.
    let best = null;
    for (let k = 0; k < top.length; k++) {
      const C = top[k].C, all = [], withGun = [];
      for (const r of alive) { if (bestMatch(C, r, 0.95) >= MATCH) { all.push(r.t); if (r.gun >= 1) withGun.push(r.t); } }
      const nAll = distinct(all).length, nGun = distinct(withGun).length;
      const nTotal = distinct(alive.map((r) => r.t)).length, share = nAll / Math.max(1, distinct(alive.map((r) => r.t)).length);
      const ratio = nAll ? nGun / nAll : 0;
      const ok = nGun >= 3 && (share < 0.88 || nTotal < 12) && ratio >= Math.max(0.6, baseRate * 0.8 + 0.1);
      const score = nGun * ratio * ratio;
      stats.candidates++;
      if (ok && (!best || score > best.score)) best = { C, score, nAll, nGun, ratio, share };
      say(0.55 + 0.4 * (k + 1) / top.length, "Checking the best guess " + (k + 1) + "/" + top.length + "...");
      await yieldUI();
    }
    if (!best) return { ok: false, reason: "no name piece was clearly tied to your gunfire (" + top.length + " guesses checked)", stats };

    // 4) every alive row with that piece = one of my kills. Gunfire is required unless the piece is almost always with gunfire.
    const events = [];
    for (const r of rows) {
      if (bestMatch(best.C, r, 0.95) < MATCH) continue;
      if (r.death) { events.push({ t: r.t, conf: 0.2, kind: "feed", why: "rejected: the view switched right after (probably your own death)" }); stats.reasons["your own death (view switch)"] = (stats.reasons["your own death (view switch)"] || 0) + 1; continue; }
      if (r.gun < 1 && best.ratio < 0.9) { events.push({ t: r.t, conf: 0.2, kind: "feed", why: "rejected: your name but no gunfire before" }); stats.reasons["no gunfire before"] = (stats.reasons["no gunfire before"] || 0) + 1; continue; }
      events.push({ t: r.t, conf: Math.min(1, 0.65 + 0.1 * Math.min(2, r.gun) + 0.15 * best.ratio), kind: "kill", why: "your name was found automatically in the kill feed (" + best.nGun + " matching rows, " + Math.round(best.ratio * 100) + "% after your gunfire)" });
    }
    // remember the piece for the next video of the same game
    try {
      const raw = best.C.raw; let s = ""; for (let i = 0; i < raw.length; i += 8192) s += String.fromCharCode.apply(null, raw.subarray(i, i + 8192));
      store.set(KEY, { pw: best.C.pw, ph: best.C.ph, b64: btoa(s), seen: Date.now() });
    } catch (e) { /* ignore */ }
    stats.learned = { rows: best.nAll, withGun: best.nGun, ratio: +best.ratio.toFixed(2), from: best.C.src };
    return { ok: true, events, stats };
  }

  function forget() { store.set(KEY, null); }
  return { run, forget };
})();

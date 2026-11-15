/* =====================================================================
   js/engine.js  -  the HIGHLIGHT ENGINE (the brain of ClipCutter)
   =====================================================================
   WHAT IT DOES (in plain words):
     It "watches" and "listens" to the whole video, then finds the moments
     that look like real action (kills, streaks, big plays) and builds
     ready-to-post clips around them.

   THE 5 STAGES:
     1. AUDIO SCAN   - reads EVERY audio sample, cuts it into 20 ms slices
                       and runs an FFT (a way to see which pitches are in a
                       sound). It spots gunfire-like bursts, explosions
                       (deep booms) and loudness.
     2. VISUAL SCAN  - jumps through the video frame by frame (2 to 30
                       frames per second, your choice), shrinks each frame
                       and measures: movement, flashes, red damage, scene
                       cuts, and activity in three screen boxes:
                       KILL FEED, CENTRE BANNER and HIT MARKER.
     3. CHANNELS     - everything is turned into time lines (one value per
                       0.1 second, scaled 0 to 1) so they can be compared.
     4. DETECT       - a "kill" = kill feed (or banner / hit marker) reacts
                       AND gunfire sound is close by. Kills close together
                       are grouped into a streak (double, triple...).
     5. BUILD CLIPS  - each streak gets lead-in and after-action time, is
                       fitted to the platform length, snapped to quiet
                       moments, ranked, and the best ones are returned.

   HONEST LIMITS:
     - It cannot read names or know WHO scored the kill (no text reading
       yet). It finds kill-feed activity + gunfire. Use "Calibrate" to
       draw the kill feed box exactly for your game for best accuracy.
     - Results depend on the game and recording; use Sensitivity to tune.

   HOW TO IMPROVE LATER:
     - Add OCR (read the kill feed text) to keep only YOUR kills.
     - Run the frame scan in a Web Worker with WebCodecs for more speed.
     - Train a small model on labelled kill moments.
   ===================================================================== */

const Engine = (function () {
  "use strict";

  const DT = 0.1; // the time line step: one value every 0.1 second

  // "Floors": the smallest signal we count as meaningful. They stop quiet noise being blown up to 1.0.
  const FLOORS = { killfeed: 0.008, banner: 0.008, hit: 0.025, flash: 0.04, red: 0.03, motion: 0.02, burst: 3, boom: 0.4, loud: 0.02 };

  const CANCEL = "cancelled";

  /* ---------------------------------------------------------------
     FFT: turns a short piece of sound into "how much of each pitch".
     This is the standard radix-2 version, written out so there is no
     outside library. N must be a power of two (512, 1024...).
     --------------------------------------------------------------- */
  function makeFFT(N) {
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = Math.sin((2 * Math.PI * i) / N); }
    const bits = Math.log2(N) | 0, rev = new Uint16Array(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    return function (re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= N; size *= 2) {
        const half = size / 2, step = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  // The value at a given fraction (0..1) of a sorted copy of arr (e.g. 0.95 = 95th percentile).
  function percentile(arr, q) {
    if (!arr.length) return 0;
    const s = Float32Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }

  // Scale a raw time line to 0..1. We divide by the 98.5th percentile OR the floor, whichever is bigger.
  function scaleTo01(raw, floor) {
    const top = Math.max(floor, percentile(raw, 0.985));
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.min(1, raw[i] / top);
    return out;
  }

  // Blur a time line a little (running average of +/- r steps).
  function smoothArr(arr, r) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(arr.length - 1, i + r); k++) { s += arr[k]; n++; }
      out[i] = s / n;
    }
    return out;
  }

  // Biggest value of arr between two times (seconds).
  function maxBetween(arr, t0, t1) {
    const a = clamp(Math.floor(t0 / DT), 0, arr.length - 1), b = clamp(Math.ceil(t1 / DT), 0, arr.length - 1);
    let m = 0;
    for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  /* ===============================================================
     STAGE 1: AUDIO SCAN
     =============================================================== */
  async function audioScan(file, ctl, progress) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("This browser cannot read audio.");
    // 16 kHz is plenty for gunshots and speech, and keeps memory small.
    let ac;
    try { ac = new Ctx({ sampleRate: 16000 }); } catch (e) { ac = new Ctx(); }
    let buf;
    try { buf = await ac.decodeAudioData(await file.arrayBuffer()); }
    finally { if (ac.close) ac.close(); }

    const sr = buf.sampleRate;
    const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const N = sr >= 32000 ? 1024 : 512;               // FFT size
    const hop = Math.round(sr * 0.02);                // a new slice every 20 ms
    const nF = Math.max(1, Math.floor((c0.length - N) / hop));
    const binHz = sr / N;
    const bin = (f) => Math.min(N / 2 - 1, Math.max(1, Math.round(f / binHz)));
    const bLow0 = bin(50), bLow1 = bin(300), bHf0 = bin(1500), bHf1 = bin(7500);

    const fft = makeFFT(N), re = new Float32Array(N), im = new Float32Array(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann window
    const prev = new Float32Array(N / 2);

    const rms = new Float32Array(nF), low = new Float32Array(nF), hflux = new Float32Array(nF);

    for (let f = 0; f < nF; f++) {
      const s0 = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const x = c1 ? (c0[s0 + i] + c1[s0 + i]) * 0.5 : c0[s0 + i];
        e += x * x;
        re[i] = x * win[i]; im[i] = 0;
      }
      rms[f] = Math.sqrt(e / N);
      fft(re, im);

      let lowE = 0, hf = 0;
      for (let k = 1; k < N / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * (2 / N);
        const c = Math.log(1 + m * 100);                       // squash so loud sounds do not hide quiet ones
        if (k >= bLow0 && k <= bLow1) lowE += m * m;
        if (k >= bHf0 && k <= bHf1) { const d = c - prev[k]; if (d > 0) hf += d; } // only count NEW energy = onsets
        prev[k] = c;
      }
      low[f] = Math.sqrt(lowE);
      hflux[f] = hf;

      if (f % 3000 === 0) {
        progress && progress(f / nF);
        if (ctl.cancel) throw new Error(CANCEL);
        await tick();
      }
    }
    return { dtF: hop / sr, nF, rms, low, hflux, sr };
  }

  // Find sudden sharp sounds (shots, hits). Returns [{t, s}] = time and strength.
  function pickOnsets(a) {
    const { hflux, dtF } = a, n = hflux.length;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + hflux[i];
    const mean = pre[n] / n;
    const med = percentile(hflux, 0.5);
    const W = Math.max(2, Math.round(0.5 / dtF));
    const out = [];
    for (let i = 2; i < n - 2; i++) {
      const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1);
      const base = (pre[hi] - pre[lo]) / (hi - lo);
      const v = hflux[i];
      if (v > base * 1.8 + med * 0.5 && v > mean * 1.5 && v >= hflux[i - 1] && v > hflux[i + 1] && v >= hflux[i - 2]) {
        out.push({ t: i * dtF + 0.016, s: clamp((v - base) / (base + med + 1e-6), 0, 8) });
      }
    }
    return out;
  }

  /* ===============================================================
     STAGE 2: VISUAL SCAN (frame by frame)
     =============================================================== */
  // Turn a region in fractions (0..1) into pixel numbers for our small analysis picture.
  function rectPx(r, W, H) {
    const x0 = clamp(Math.round(r.x * W), 0, W - 2), y0 = clamp(Math.round(r.y * H), 0, H - 2);
    const x1 = clamp(Math.round((r.x + r.w) * W), x0 + 2, W), y1 = clamp(Math.round((r.y + r.h) * H), y0 + 2, H);
    return { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) };
  }

  async function visualScan(v, opts, ctl, progress) {
    const vid = document.createElement("video");
    vid.muted = true; vid.preload = "auto"; vid.playsInline = true; vid.src = v.url;
    await whenLoaded(vid, 30000);

    const fps = opts.fps, step = 1 / fps;
    const total = Math.max(1, Math.floor((v.duration - 0.05) * fps));
    const H = opts.height || 108;
    const W = Math.max(16, Math.round((H * (vid.videoWidth / vid.videoHeight)) / 2) * 2);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });

    // Each box (kill feed, banner, hit marker) is read from the FULL-SIZE frame at higher detail than the
    // whole-frame picture, because small text turns to mush when the picture is shrunk too much.
    const regs = {};
    Object.keys(opts.regions || {}).forEach((k) => {
      const r = opts.regions[k];
      const rw = clamp(Math.round(opts.regionWidth || 240), 64, 480);
      const rh = clamp(Math.round((rw * (r.h * vid.videoHeight)) / Math.max(1, r.w * vid.videoWidth)), 24, 240);
      const c = document.createElement("canvas"); c.width = rw; c.height = rh;
      regs[k] = { r, w: rw, h: rh, area: rw * rh, g: c.getContext("2d", { willReadFrequently: true }), Y: new Uint8Array(rw * rh) };
    });
    const regNames = Object.keys(regs);

    const n = W * H;
    let prevY = new Uint8Array(n), curY = new Uint8Array(n);
    let prevHist = null;
    // We remember the PREVIOUS sample of each box. A kill-feed line or hit marker appearing is a sudden
    // step up compared with the sample before it, so "rise" = how much it went up in one step.
    const last = {}; regNames.forEach((k) => (last[k] = { edge: 0, white: 0, init: false }));
    let lastRed = 0, redInit = false;

    const out = { t: new Float32Array(total), motion: new Float32Array(total), flash: new Float32Array(total),
                  red: new Float32Array(total), cut: new Uint8Array(total), pulse: {} };
    regNames.forEach((k) => (out.pulse[k] = new Float32Array(total)));

    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (ctl.cancel) throw new Error(CANCEL);
      const t = Math.min(v.duration - 0.03, i * step + 0.001);
      await seekTo(vid, t);
      g.drawImage(vid, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;

      // ---- whole-frame numbers ----
      const hist = new Uint16Array(16);
      let sumAbs = 0, flashN = 0, redN = 0;
      for (let k = 0, p = 0; k < n; k++, p += 4) {
        const r = px[p], gg = px[p + 1], b = px[p + 2];
        const y = (77 * r + 150 * gg + 29 * b) >> 8;     // brightness of this pixel
        curY[k] = y; hist[y >> 4]++;
        if (i > 0) { const d = y - prevY[k]; sumAbs += d < 0 ? -d : d; if (d > 50) flashN++; }
        if (r > 150 && gg < 90 && b < 90) redN++;
      }
      const motion = i > 0 ? sumAbs / (n * 255) : 0;
      let cut = 0;
      if (prevHist) { let hd = 0; for (let k = 0; k < 16; k++) hd += Math.abs(hist[k] - prevHist[k]); cut = hd / (2 * n) > 0.45 ? 1 : 0; }
      const redFrac = redN / n;
      const redRise = redInit ? Math.max(0, redFrac - lastRed - 0.003) : 0;
      lastRed = redFrac; redInit = true;

      // ---- region numbers (kill feed, banner, hit marker) ----
      const flashFrac = i > 0 ? flashN / n : 0;
      // The whole screen changed (scene cut, big camera whip, full-screen flash): do not trust region clues.
      const hugeChange = cut === 1 || motion > 0.30 || flashFrac > 0.25;
      for (const name of regNames) {
        const R = regs[name], r = R.r;
        R.g.drawImage(vid, r.x * vid.videoWidth, r.y * vid.videoHeight, r.w * vid.videoWidth, r.h * vid.videoHeight, 0, 0, R.w, R.h);
        const rp = R.g.getImageData(0, 0, R.w, R.h).data, Yr = R.Y;
        let edge = 0, white = 0;
        for (let y = 0; y < R.h; y++) {
          for (let x = 0, idx = y * R.w; x < R.w; x++, idx++) {
            const q = idx * 4;
            const y0 = (77 * rp[q] + 150 * rp[q + 1] + 29 * rp[q + 2]) >> 8;
            Yr[idx] = y0;
            if (x > 0) { const gx = y0 - Yr[idx - 1]; if (gx > 60 || gx < -60) edge++; }   // sharp, high-contrast edge = text-like
            if (y0 > 215) white++;                                                          // very bright pixel
          }
        }
        const ed = edge / R.area, wh = white / R.area, L = last[name];
        let rise = 0;
        if (L.init) {
          const re = Math.max(0, ed - L.edge - 0.002);          // new sharp edges (text-like) since the last sample
          const rw = Math.max(0, wh - L.white - 0.004);         // new very-bright pixels since the last sample
          // Text lines are found by their edges. The hit marker is a bright flash, so it uses brightness.
          rise = name === "hit" ? rw + 0.5 * re : re;
        }
        L.edge = ed; L.white = wh; L.init = true;
        out.pulse[name][i] = hugeChange ? 0 : rise;
      }

      out.t[i] = t; out.motion[i] = motion; out.flash[i] = flashFrac; out.red[i] = redRise; out.cut[i] = cut;
      const tmp = prevY; prevY = curY; curY = tmp; prevHist = hist;

      if (i % 5 === 0) {
        const done = (i + 1) / total, el = (performance.now() - t0) / 1000;
        progress && progress(done, el / done - el);       // fraction + estimated seconds left
        await tick();
      }
    }
    vid.removeAttribute("src"); vid.load();
    return out;
  }

  /* ===============================================================
     STAGE 3: CHANNELS (everything on one 0.1 s time line, scaled 0..1)
     =============================================================== */
  function buildChannels(v, au, vis, fpsUsed) {
    const nG = Math.ceil(v.duration / DT);
    const raw = { killfeed: new Float32Array(nG), banner: new Float32Array(nG), hit: new Float32Array(nG),
                  flash: new Float32Array(nG), red: new Float32Array(nG), motion: new Float32Array(nG),
                  cut: new Float32Array(nG), burst: new Float32Array(nG), boom: new Float32Array(nG), loud: new Float32Array(nG) };

    if (vis) {
      for (let i = 0; i < vis.t.length; i++) {
        const j = Math.min(nG - 1, Math.floor(vis.t[i] / DT));
        raw.motion[j] = Math.max(raw.motion[j], vis.motion[i]);
        raw.flash[j] = Math.max(raw.flash[j], vis.flash[i]);
        raw.red[j] = Math.max(raw.red[j], vis.red[i]);
        raw.cut[j] = Math.max(raw.cut[j], vis.cut[i]);
        for (const k of Object.keys(vis.pulse)) raw[k][j] = Math.max(raw[k][j], vis.pulse[k][i]);
      }
      // At low frame rates a clue lasts longer than one sample, so hold motion over empty cells.
      if (fpsUsed < 10) {
        const hold = Math.ceil(1 / fpsUsed / DT);
        let last = 0, since = 999;
        for (let j = 0; j < nG; j++) { if (raw.motion[j] > 0) { last = raw.motion[j]; since = 0; } else if (since < hold) { raw.motion[j] = last; since++; } }
      }
    }

    let onsets = [];
    if (au) {
      onsets = pickOnsets(au);
      for (const o of onsets) raw.burst[Math.min(nG - 1, Math.floor(o.t / DT))] += o.s;
      raw.burst = smoothArr(raw.burst, 1).map((x) => x * 3);       // a burst of shots spreads over ~0.3 s
      const per = Math.max(1, Math.round(DT / au.dtF));
      const lowBase = 50; // 1 second of history
      for (let f = 0; f < au.nF; f++) {
        const j = Math.min(nG - 1, Math.floor((f * au.dtF) / DT));
        raw.loud[j] = Math.max(raw.loud[j], au.rms[f]);
        let s = 0, c = 0;
        for (let k = Math.max(0, f - lowBase); k < f; k++) { s += au.low[k]; c++; }
        const rise = au.low[f] - (c ? s / c : 0);
        if (rise > 0) raw.boom[j] = Math.max(raw.boom[j], rise);
      }
    }

    const ch = {};
    for (const k of Object.keys(raw)) ch[k] = k === "cut" ? raw[k] : scaleTo01(raw[k], FLOORS[k] || 1e-6);
    ch.loud = smoothArr(ch.loud, 2);
    return { nG, ch, onsets };
  }

  /* ===============================================================
     THE MAIN ENTRY: analyse a video
     opts: { fps, regions, profile, useAudio, useVisual }
     =============================================================== */
  async function analyse(v, opts, ctl, progress) {
    ctl = ctl || {};
    const t0 = performance.now();
    let au = null, vis = null, audioOk = false;

    if (opts.useAudio !== false) {
      progress && progress(0.02, "Listening to every audio sample...");
      try {
        if (v.file.size > 1.5e9) throw new Error("file too big to decode audio");
        au = await audioScan(v.file, ctl, (f) => progress && progress(0.02 + 0.23 * f, "Listening to every audio sample..."));
        audioOk = true;
      } catch (e) {
        if (e.message === CANCEL) throw e;
        console.warn("Audio scan skipped:", e);
        au = null;
      }
    }

    if (opts.useVisual !== false) {
      vis = await visualScan(v, opts, ctl, (f, eta) =>
        progress && progress(0.25 + 0.7 * f, "Watching frames... " + Math.round(f * 100) + "%" + (eta > 1 ? "  (about " + fmt(eta) + " left)" : "")));
    }

    progress && progress(0.96, "Building time lines...");
    const chData = buildChannels(v, au, vis, opts.fps);

    // Per-second values used by the Classic mode.
    const secs = Math.ceil(v.duration);
    const loudSec = new Float32Array(secs), motionSec = new Float32Array(secs);
    for (let s = 0; s < secs; s++) { loudSec[s] = avg(chData.ch.loud, s * 10, s * 10 + 10); motionSec[s] = avg(chData.ch.motion, s * 10, s * 10 + 10); }

    return {
      dt: DT, N: chData.nG, ch: chData.ch, onsets: chData.onsets, audioOk,
      hasVisual: !!vis, fps: opts.fps, regions: opts.regions || {}, profileId: opts.profile,
      loudSec, motionSec, seconds: (performance.now() - t0) / 1000, duration: v.duration
    };
  }

  /* ===============================================================
     STAGE 4: DETECT kills / peaks and group them into streaks
     params: { profile, sens }
     =============================================================== */
  function detect(an, params) {
    const prof = PROFILES[params.profile] || PROFILES.auto;
    const sens = params.sens || 1;                      // above 1 = more events, below 1 = fewer
    const { N, ch } = an, w = prof.w;
    const events = [];

    // Combined "excitement" line E(t) for every profile (used for ranking + non-shooter peaks).
    const E = new Float32Array(N);
    const wsum = Object.keys(w).reduce((s, k) => s + w[k], 0) || 1;
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (const k of Object.keys(w)) if (w[k] && ch[k]) s += w[k] * ch[k][j];
      E[j] = s / wsum;
    }
    const Es = smoothArr(E, 2);
    const Emax = Math.max(1e-6, percentile(Es, 0.995));
    for (let j = 0; j < N; j++) Es[j] = Math.min(1, Es[j] / Emax);

    // ---- KILLS: screen clue (feed / banner / hit) + gunfire sound close by ----
    if (prof.feed && an.hasVisual) {
      // A kill makes several clues within ~0.5 s (hit marker, feed line, banner). We look at each clue's biggest
      // value in a small neighbourhood and add them up, so clues that agree reinforce each other.
      const dil = (arr, j, r) => { let m = 0; for (let k = Math.max(0, j - r); k <= Math.min(N - 1, j + r); k++) if (arr[k] > m) m = arr[k]; return m; };
      const V = new Float32Array(N);
      for (let j = 0; j < N; j++) {
        V[j] = Math.min(1.2, dil(ch.killfeed, j, 2) * w.killfeed + dil(ch.banner, j, 3) * w.banner * 0.6 + dil(ch.hit, j, 3) * w.hit * 0.4);
      }
      const thr = 0.28 / sens;
      const A = new Float32Array(N);
      for (let j = 0; j < N; j++) A[j] = Math.min(1, 0.75 * (ch.burst[j] || 0) + 0.45 * (ch.boom[j] || 0));

      const cand = [];
      for (let j = 0; j < N; j++) {
        if (V[j] < thr) continue;
        let isMax = true;
        for (let k = Math.max(0, j - 4); k <= Math.min(N - 1, j + 4); k++) if (V[k] > V[j] || (V[k] === V[j] && k < j)) { isMax = false; break; }
        if (isMax) cand.push(j);
      }
      cand.sort((a, b) => V[b] - V[a]);
      const used = [];
      for (const j of cand) {
        const t = j * DT;
        if (used.some((u) => Math.abs(u - t) < 0.9)) continue;     // one kill per 0.9 s at most
        used.push(t);
        const sup = an.audioOk ? maxBetween(A, t - 1.3, t + 0.6) : 0;
        let conf = an.audioOk ? 0.62 * Math.min(1, V[j]) + 0.38 * sup : Math.min(1, V[j]);
        const noGun = an.audioOk && sup < 0.15;                   // feed moved but no gunfire nearby
        if (noGun) conf *= 0.55;
        conf = Math.min(1, conf * (0.85 + 0.15 * sens));
        if (conf < 0.28) continue;
        // "feed" = a kill-feed line without gunfire (maybe a teammate or a spectated kill). Shown, but never builds a streak.
        events.push({ t, conf, kind: noGun ? "feed" : "kill", why: noGun ? "feed reacted, no gunfire" : "feed/hit reacted" + (an.audioOk ? " + gunfire" : "") });
      }
    }

    // ---- PEAKS: moments where overall excitement is high (all profiles) ----
    {
      const thr = Math.max(0.35, percentile(Es, prof.feed ? 0.96 : 0.92)) / sens;
      const cand = [];
      for (let j = 2; j < N - 2; j++) if (Es[j] >= thr && Es[j] >= Es[j - 1] && Es[j] > Es[j + 1] && Es[j] >= Es[j - 2]) cand.push(j);
      cand.sort((a, b) => Es[b] - Es[a]);
      const used = [];
      for (const j of cand) {
        const t = j * DT;
        if (used.some((u) => Math.abs(u - t) < 2.5)) continue;
        used.push(t);
        if (prof.feed && events.some((e) => e.kind === "kill" && Math.abs(e.t - t) < 4)) continue;  // already covered by a kill
        events.push({ t, conf: Math.min(1, Es[j]) * (prof.feed ? 0.6 : 1), kind: "peak", why: "intense moment" });
      }
    }

    events.sort((a, b) => a.t - b.t);

    // ---- group into streaks (events closer than "gap" seconds belong together) ----
    const gap = params.gap || prof.gap;
    const scenes = [];
    // Kills group with kills, peaks group with peaks, so a loud decoy never gets glued onto a real streak.
    for (const kind of ["kill", "peak"]) {
      let cur = null;
      for (const e of events) {
        if (e.kind !== kind) continue;
        if (cur && e.t - cur.events[cur.events.length - 1].t <= gap) cur.events.push(e);
        else { cur = { events: [e] }; scenes.push(cur); }
      }
    }
    scenes.sort((a, b) => a.events[0].t - b.events[0].t);
    scenes.forEach((s) => {
      const kills = s.events.filter((e) => e.kind === "kill");
      s.kills = kills.length;
      s.first = s.events[0].t; s.last = s.events[s.events.length - 1].t;
      let score = 0;
      const sorted = [...s.events].sort((a, b) => a.t - b.t);
      sorted.forEach((e, idx) => { score += e.conf * (e.kind === "kill" ? 1 + 0.4 * idx : 1); });
      s.score = score;
      s.conf = Math.max(...s.events.map((e) => e.conf));
      const n = s.kills;
      s.label = n >= 5 ? "Multi-kill x" + n : n === 4 ? "Quad kill" : n === 3 ? "Triple kill" : n === 2 ? "Double kill" : n === 1 ? "Kill" : "Intense moment";
    });
    return { events, scenes, E: Es };
  }

  /* ===============================================================
     STAGE 5: BUILD CLIPS (windows, merge, snap, rank)
     params: { maxLen, minLen, fixedLen (0 = auto), pre, post, count, snap }
     =============================================================== */
  function quietPoint(an, t, range, side) {
    // Find the quietest 0.1 s cell near t, so we do not cut in the middle of a shot or word.
    const lo = clamp(Math.floor((t - (side === "after" ? 0 : range)) / DT), 0, an.N - 1);
    const hi = clamp(Math.ceil((t + (side === "before" ? 0 : range)) / DT), 0, an.N - 1);
    let best = clamp(Math.round(t / DT), 0, an.N - 1), bv = Infinity;
    for (let j = lo; j <= hi; j++) { const v = (an.ch.loud[j] || 0) + 0.5 * (an.ch.burst[j] || 0); if (v < bv) { bv = v; best = j; } }
    return best * DT;
  }

  function buildClips(an, det, params) {
    const dur = an.duration;
    const maxLen = Math.min(params.maxLen || 59, dur);
    const minLen = Math.min(params.minLen || 12, maxLen);
    const fixed = params.fixedLen ? Math.min(params.fixedLen, dur) : 0;
    const pre = params.pre, post = params.post;

    // 1) a natural window (lead-in + action + after-action) around every streak
    const cap = fixed || maxLen;
    let wins = det.scenes.map((s) => ({ start: s.first - pre, end: s.last + post, scenes: [s] }));

    // 2) merge windows that overlap, if the result still fits the length limit
    wins.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      // Only merge windows of the same kind (kill windows with kill windows), so a loud decoy is not glued onto a kill.
      const sameKind = last && (last.scenes[0].kills > 0) === (w.scenes[0].kills > 0);
      if (last && sameKind && w.start < last.end && Math.max(last.end, w.end) - Math.min(last.start, w.start) <= cap) {
        last.start = Math.min(last.start, w.start); last.end = Math.max(last.end, w.end); last.scenes.push(...w.scenes);
      } else merged.push(w);
    }

    // 2b) stretch short windows to the wanted length, trim long ones to the best-scoring part
    merged.forEach((w) => {
      const want = fixed || minLen;
      if (w.end - w.start < want) { const extra = want - (w.end - w.start); w.start -= extra * 0.6; w.end += extra * 0.4; }
      if (w.end - w.start > cap) {
        const evs = w.scenes.flatMap((s) => s.events);
        let bestS = w.start, bestV = -1;
        for (let st = w.start; st + cap <= w.end + 0.001; st += 0.5) {
          let v = 0; evs.forEach((e) => { if (e.t >= st + 0.5 && e.t <= st + cap - 0.5) v += e.conf; });
          if (v > bestV) { bestV = v; bestS = st; }
        }
        w.start = bestS; w.end = bestS + cap;
      }
    });

    // 3) fit inside the video, snap to quiet moments, never cut away the action itself
    const clips = merged.map((w) => {
      const evs = w.scenes.flatMap((s) => s.events).sort((a, b) => a.t - b.t);
      let start = clamp(w.start, 0, dur), end = clamp(w.end, 0, dur);
      if (!fixed && params.snap !== false) {
        const s2 = quietPoint(an, start, 1.0, "both"), e2 = quietPoint(an, end, 1.2, "both");
        if (s2 <= evs[0].t - 1.5) start = s2;
        if (e2 >= evs[evs.length - 1].t + 1.5) end = e2;
      }
      if (fixed) { // keep the exact length even after clamping at the video edges
        if (end - start < fixed) { if (start <= 0) end = Math.min(dur, start + fixed); else start = Math.max(0, end - fixed); }
      }
      const kills = evs.filter((e) => e.kind === "kill").length;
      const score = w.scenes.reduce((s, x) => s + x.score, 0);
      const label = kills >= 5 ? "Multi-kill x" + kills : kills === 4 ? "Quad kill" : kills === 3 ? "Triple kill" : kills === 2 ? "Double kill" : kills === 1 ? "Kill" : "Intense moment";
      const why = kills ? kills + " kill(s): kill-feed/hit activity" + (an.audioOk ? " + gunfire sound" : "") : "High sound + action energy";
      return { start, end, score, conf: Math.max(...evs.map((e) => e.conf)), kills, label, why, events: evs.map((e) => ({ t: e.t, conf: e.conf, kind: e.kind })) };
    });

    // 4) rank, remove overlaps with better clips, keep the best N
    clips.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of clips) {
      if (picked.length >= (params.count || 6)) break;
      if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
      if (picked.length && c.score < picked[0].score * (params.minRel || 0.25) && c.conf < 0.6) continue;   // far weaker than the best and not a clear kill: skip
      picked.push(c);
    }
    const top = picked.length ? picked[0].score : 1;
    picked.forEach((c, i) => { c.rank = i + 1; c.score01 = c.score / top; });
    return picked;
  }

  /* ===============================================================
     CLASSIC MODE (the first version's method, kept on purpose)
     Best windows by (sound + motion), fixed length, no overlap.
     =============================================================== */
  function classic(an, params) {
    const weight = an.audioOk ? params.focus : 0;
    const secs = an.loudSec.length;
    const mixed = Array.from(an.loudSec, (a, i) => weight * a + (1 - weight) * (an.motionSec[i] || 0));
    const score = smooth(mixed, 2);
    const length = Math.min(Math.round(params.length), secs);
    const prefix = [0]; score.forEach((s, i) => prefix.push(prefix[i] + s));
    const wins = [];
    for (let st = 0; st + length <= secs; st++) wins.push({ start: st, mean: (prefix[st + length] - prefix[st]) / length });
    wins.sort((a, b) => b.mean - a.mean);
    const chosen = [];
    for (const w of wins) {
      if (chosen.length >= params.count) break;
      if (!chosen.some((c) => w.start < c.start + length && w.start + length > c.start)) chosen.push(w);
    }
    const out = chosen.map((c) => {
      let start = c.start, end = c.start + length;
      if (params.snap > 0 && an.audioOk) {
        const s2 = quietPoint(an, start, params.snap, "both"), e2 = quietPoint(an, end, params.snap, "both");
        if (e2 - s2 >= length * 0.7) { start = s2; end = e2; }
      }
      end = Math.min(end, an.duration);
      const a = avg(an.loudSec, c.start, c.start + length), m = avg(an.motionSec, c.start, c.start + length);
      let why = "Strong overall energy";
      if (a > m * 1.3) why = "Loud / lively audio"; else if (m > a * 1.3) why = "Lots of visual action";
      return { start, end, score: c.mean, conf: c.mean, kills: 0, label: "Moment", why, events: [] };
    });
    const top = out.length ? Math.max(...out.map((c) => c.score)) : 1;
    out.sort((a, b) => b.score - a.score).forEach((c, i) => { c.rank = i + 1; c.score01 = c.score / top; });
    return out;
  }

  /* A small preview picture of the video (used in the library list). */
  async function thumbnail(v) {
    const vid = document.createElement("video");
    vid.muted = true; vid.preload = "auto"; vid.src = v.url;
    await whenLoaded(vid, 15000);
    await seekTo(vid, Math.min(v.duration * 0.1, 3));
    const cv = document.createElement("canvas"); cv.width = 160; cv.height = Math.round((160 * vid.videoHeight) / vid.videoWidth) || 90;
    cv.getContext("2d").drawImage(vid, 0, 0, cv.width, cv.height);
    vid.removeAttribute("src"); vid.load();
    return cv.toDataURL("image/jpeg", 0.7);
  }

  return { analyse, detect, buildClips, classic, thumbnail, DT, CANCEL, quietPoint };
})();

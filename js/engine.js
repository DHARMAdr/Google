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
  // Get the sound as numbers. Plan A: the browser's decoder. Plan B (self-healing): ffmpeg decodes it,
  // which also handles audio codecs the browser does not know (AC-3, DTS...).
  async function decodeAudio(v, rec, progress) {
    const file = v.file;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const s0 = performance.now();
    try {
      if (v.noPlay) throw new Error("skipped: the browser cannot decode this format");
      if (!Ctx) throw new Error("This browser cannot read audio.");
      let ac;
      try { ac = new Ctx({ sampleRate: 16000 }); } catch (e) { ac = new Ctx(); }   // 16 kHz is plenty for gunshots and speech
      try { return await ac.decodeAudioData(await file.arrayBuffer()); }
      finally { if (ac.close) ac.close(); }
    } catch (e) {
      rec.attempts.push({ step: "audio", strategy: "browser decodeAudioData", ok: false, error: errText(e), ms: Math.round(performance.now() - s0) });
      console.warn("Browser audio decode failed, trying ffmpeg:", e);
    }
    stageMark("analyse:audio", "ffmpeg fallback");
    const s1 = performance.now();
    progress && progress("Listening (compatibility decoder)...");
    const pcm = await Exporter.decodeAudioPCM(v, (t) => progress && progress(t));      // throws if it fails too
    rec.attempts.push({ step: "audio", strategy: "ffmpeg PCM decode", ok: true, ms: Math.round(performance.now() - s1) });
    return { sampleRate: 16000, numberOfChannels: 1, length: pcm.length, getChannelData: () => pcm };
  }

  async function audioScan(v, ctl, progress, rec) {
    stageMark("analyse:audio", "decoding");
    const buf = await decodeAudio(v, rec, progress);

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

  /* ---------------------------------------------------------------
     TWO-STAGE SPEED-UP: from the sound alone, find the short stretches that contain gunfire.
     A kill cannot happen without a shot, so the picture only has to be watched around those
     stretches. Returns [[from, to], ...] in seconds, or null when the whole video must be watched
     (little to save, or the sound is useless).
     WHY: reading pictures is the slow part (minutes), reading sound is fast (seconds).
     HOW TO IMPROVE: use a stricter shot test (only loud, close shots) to skip even more.   */
  function audioWindows(au, dur, before, after) {
    const all = pickOnsets(au);
    if (all.length < 3) return null;
    // Real games have gunfire almost everywhere. Keep only the strongest shots (and narrower windows) until at most ~55% of the video is watched.
    for (const [minS, bef, aft] of [[1.0, before, after], [2.0, before, after], [3.0, before * 0.8, after * 0.8], [4.0, before * 0.65, after * 0.7], [5.0, before * 0.55, after * 0.6]]) {
      const win = [];
      for (const o of all) {
        if (o.s < minS) continue;
        const a = Math.max(0, o.t - bef), b = Math.min(dur, o.t + aft), last = win[win.length - 1];
        if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b); else win.push([a, b]);
      }
      const covered = win.reduce((s, w) => s + (w[1] - w[0]), 0);
      if (win.length && covered <= dur * 0.55) return win;
    }
    return null;                                              // even the strongest shots cover too much: watch everything
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

  /* ---------------------------------------------------------------
     FRAME SOURCES  (the self-healing part)
     ---------------------------------------------------------------
     WHY: the normal way to read a picture is: put the video in a <video>, copy a frame onto a
     <canvas>, call getImageData. Some browsers / devices mark that canvas as "tainted" (cross-origin
     data) and then getImageData throws a SecurityError. Instead of giving up, we keep a LIST of
     different ways to get the same pixels and move down the list when one fails:

        1. "browser"  - the normal <video> + canvas way (fast).
        2. "memory"   - copy the file into memory first and play THAT copy. A fresh in-memory blob
                        has no foreign origin, which fixes many tainted-canvas cases.
        3. "ffmpeg"   - decode the file ourselves with ffmpeg (WebAssembly) and receive plain
                        numbers. Numbers can never be tainted, so this always works (slower).

     Every source has the same three functions:  open() , grab(i, t) , close().
     grab() returns { px: whole picture RGBA, rp: { regionName: RGBA } }.                        */
  function stageMark(name, info) { try { if (typeof Diag !== "undefined") Diag.stage(name, info); } catch (e) { /* ignore */ } }

  // Wait only for the video's header (size + length). Mobile Chrome often refuses to load more than
  // that until you seek or play, which made the old "wait for the first picture" step hang for 30 s.
  function whenMeta(video, ms) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 1) { resolve(); return; }
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); const me = video.error; reject(new Error("The browser cannot open this video" + (me ? " (media error " + me.code + (me.message ? ": " + me.message : "") + ")" : "") + ".")); };
      const cleanup = () => { video.removeEventListener("loadedmetadata", ok); video.removeEventListener("error", bad); clearTimeout(timer); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("The video header did not load within " + Math.round((ms || 20000) / 1000) + " s.")); }, ms || 20000);
      video.addEventListener("loadedmetadata", ok); video.addEventListener("error", bad);
      try { video.load(); } catch (e) { /* ignore */ }
    });
  }

  // Copies the current picture of a <video> into numbers (the whole frame, plus each small box at full detail).
  function makePixelReader(geom) {
    const cv = document.createElement("canvas"); cv.width = geom.W; cv.height = geom.H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    const rg = {};
    Object.keys(geom.regs).forEach((k) => {
      const R = geom.regs[k], c = document.createElement("canvas"); c.width = R.w; c.height = R.h;
      rg[k] = c.getContext("2d", { willReadFrequently: true });
    });
    return function read(vid) {
      g.drawImage(vid, 0, 0, geom.W, geom.H);
      const px = g.getImageData(0, 0, geom.W, geom.H).data;            // <-- a tainted canvas throws HERE
      const rp = {};
      for (const k of Object.keys(geom.regs)) {
        const R = geom.regs[k], r = R.r;
        rg[k].drawImage(vid, r.x * vid.videoWidth, r.y * vid.videoHeight, r.w * vid.videoWidth, r.h * vid.videoHeight, 0, 0, R.w, R.h);
        rp[k] = rg[k].getImageData(0, 0, R.w, R.h).data;
      }
      return { px, rp };
    };
  }

  /* "seek" source: jump to every sample time (slow on phones, but works everywhere).
     "stream" source: just PLAY the video fast (up to 16x, muted) and grab the picture whenever the
     time reaches the next sample. No seeking, uses the phone's hardware decoder, 5-20x faster.
     Several stream sources can run at once, each on its own part of the video.                    */
  function makeVideoSource(v, geom, label, makeUrl, mode, o) {
    o = o || {};
    let vid = null, handle = null, read = null, box = null;
    // state for the stream mode
    let want = null, active = false, rate = o.rate || 4, maxRate = o.rate || 4, lastFrameAt = 0, timer = null, ctl = o.ctl || {};
    const step = 1 / (o.fps || 5);

    function failWant(err) { if (want) { const w = want; want = null; w.reject(err); } }
    function capture(mt) {
      const fr = read(vid);
      return { px: fr.px, rp: fr.rp, mt };
    }
    function onFrame(now, meta) {
      if (!active) return;
      vid.requestVideoFrameCallback(onFrame);
      lastFrameAt = performance.now();
      if (want && meta.mediaTime >= want.t - 0.0005) {
        const w = want; want = null;
        try {
          const fr = capture(meta.mediaTime);
          // Speed control: if we are getting samples later than half a step, slow down a little; if comfortably early, speed up.
          const late = meta.mediaTime - w.t;
          if (late > step * 0.6) rate = Math.max(1, rate * 0.75); else if (late < step * 0.25 && rate < maxRate) rate = Math.min(maxRate, rate * 1.1);
          if (Math.abs(vid.playbackRate - rate) > 0.05) vid.playbackRate = rate;
          w.resolve(fr);
        } catch (e) { w.reject(e); }
      }
    }

    return {
      name: label,
      async open(startIdx) {
        handle = await makeUrl();
        vid = document.createElement("video");
        vid.muted = true; vid.defaultMuted = true; vid.preload = "auto"; vid.playsInline = true; vid.setAttribute("playsinline", ""); vid.setAttribute("muted", "");
        if (mode === "stream") {
          // The element must be really "on the page" (tiny + almost invisible) or phones stop delivering frames.
          box = document.createElement("div");
          box.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.02;pointer-events:none;z-index:-1";
          vid.style.cssText = "width:2px;height:2px"; box.appendChild(vid); document.body.appendChild(box);
        }
        vid.src = handle.url;
        await whenMeta(vid, 25000);
        if (!vid.videoWidth) throw new Error("The browser can read the sound of this video but cannot decode its picture.");
        read = makePixelReader(geom);
        if (mode === "stream") {
          if (!("requestVideoFrameCallback" in vid)) throw new Error("requestVideoFrameCallback is not supported");
          const t0 = Math.max(0, (startIdx || 0) * step);
          await seekTo(vid, t0);
          vid.playbackRate = rate; active = true; lastFrameAt = performance.now();
          vid.requestVideoFrameCallback(onFrame);
          await vid.play();                                            // may be refused: then the next source is tried
          // Watchdog: if no new picture arrives for 12 s (hidden tab excluded) the source is declared stuck.
          timer = setInterval(() => {
            if (!want) { lastFrameAt = performance.now(); return; }
            if (ctl.cancel) return failWant(new Error(CANCEL));
            if (document.hidden) { lastFrameAt = performance.now(); return; }
            if (vid.paused && !vid.ended) vid.play().catch(() => {});
            if (performance.now() - lastFrameAt > 12000) failWant(new Error("Video playback stalled (no pictures for 12 s)."));
          }, 1000);
          vid.addEventListener("ended", () => { if (want) { const w = want; want = null; try { w.resolve(capture(vid.currentTime)); } catch (e) { w.reject(e); } } });
        }
      },
      async grab(i, t) {
        if (mode === "stream") return new Promise((resolve, reject) => { want = { t, resolve, reject }; });
        await seekTo(vid, t);
        return read(vid);
      },
      close() {
        active = false; clearInterval(timer);
        try { if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); } } catch (e) { /* ignore */ }
        try { box && box.remove(); } catch (e) { /* ignore */ }
        try { handle && handle.revoke && handle.revoke(); } catch (e) { /* ignore */ }
        vid = null;
      }
    };
  }

  function makeFFmpegSource(v, geom, fps, progress) {
    let frames = null, first = 0, count = 0;
    // One chunk is decoded at a time so memory stays small (about 50 MB per chunk).
    const perFrame = geom.W * geom.H * 4 + Object.keys(geom.regs).reduce((s, k) => s + geom.regs[k].w * geom.regs[k].h * 4, 0);
    const chunkSec = Math.max(4, Math.min(60, Math.floor(50e6 / (perFrame * fps))));
    return {
      name: "ffmpeg",
      async open() { await Exporter.loadEngine((t) => progress && progress(t)); },
      async grab(i, t) {
        if (!frames || i < first || i >= first + count) {
          const start = Math.max(0, i / fps);
          const specs = [{ w: geom.W, h: geom.H, crop: null }].concat(Object.keys(geom.regs).map((k) => ({ w: geom.regs[k].w, h: geom.regs[k].h, crop: geom.regs[k].r })));
          progress && progress("Compatibility mode: decoding with ffmpeg from " + fmt(start) + "...");
          frames = await Exporter.extractFrames(v, specs, start, Math.min(chunkSec, v.duration - start + 0.5), fps);
          first = i; count = frames[0].length;
          if (!count) throw new Error("ffmpeg returned no frames at " + start.toFixed(1) + " s");
        }
        const j = Math.min(count - 1, i - first), rp = {};
        Object.keys(geom.regs).forEach((k, n) => (rp[k] = frames[n + 1][Math.min(frames[n + 1].length - 1, j)]));
        return { px: frames[0][j], rp };
      },
      close() { frames = null; try { Exporter.unmountVideo(v); } catch (e) { /* ignore */ } }
    };
  }

  // The memory source needs a blob URL made from a COPY of the file's bytes.
  async function memoryURL(v) {
    if (v.file.size > 6e8) throw new Error("file too big (" + Math.round(v.file.size / 1048576) + " MB) to copy into memory");
    const buf = await v.file.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: v.file.type || "video/mp4" }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  /* ---------------------------------------------------------------
     THE PER-SAMPLE MATH, kept in one small object so every segment of the video can have its own.
     step(i, t, frame, write): turns one picture into the numbers (motion, flash, red, region pulses).
     write=false is used for the "priming" sample: it only fills the "previous picture" memory.      */
  /* ---------------------------------------------------------------
     NAME TEMPLATE (the "Teach it my name" feature)
     The user draws a box around THEIR OWN name (+ agent icon) in one kill-feed line. We keep that
     little picture (gray values) and look for it in the kill-feed area of every sampled frame.
     Own kills show the same name, so this recognises "my kill" without reading any text (no OCR).
     How: normalised cross-correlation (NCC) = "how much does this patch look like the template",
     1 = identical, 0 = unrelated. Done on every 2nd pixel and every 2nd position to stay fast.
     HOW TO IMPROVE: also match colour, several scales (if the video resolution changes), use OCR.
     --------------------------------------------------------------- */
  const MATCH_MIN = 0.55;                                   // NCC needed to say "my name is here"
  function scaleTemplate(tpl, s) {
    const w = Math.max(6, Math.round(tpl.w * s)), h = Math.max(4, Math.round(tpl.h * s));
    const a = document.createElement("canvas"); a.width = tpl.w; a.height = tpl.h;
    const ag = a.getContext("2d"), id = ag.createImageData(tpl.w, tpl.h);
    for (let k = 0; k < tpl.gray.length; k++) { id.data[4 * k] = id.data[4 * k + 1] = id.data[4 * k + 2] = tpl.gray[k]; id.data[4 * k + 3] = 255; }
    ag.putImageData(id, 0, 0);
    const b = document.createElement("canvas"); b.width = w; b.height = h;
    const bg = b.getContext("2d", { willReadFrequently: true }); bg.imageSmoothingEnabled = true; bg.imageSmoothingQuality = "high";
    bg.drawImage(a, 0, 0, w, h);
    const d = bg.getImageData(0, 0, w, h).data;
    const nx = Math.ceil(w / 2), ny = Math.ceil(h / 2), z = new Float32Array(nx * ny);
    let sum = 0;
    for (let ty = 0, k = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++, k++) { z[k] = d[4 * ((ty * 2) * w + tx * 2)]; sum += z[k]; }
    const mean = sum / z.length; let ss = 0;
    for (let k = 0; k < z.length; k++) { z[k] -= mean; ss += z[k] * z[k]; }
    return { w, h, nx, ny, z, ss: Math.max(ss, 1e-6) };
  }
  // Slide the template over the region picture. Returns the best score and how many separate lines match.
  function matchTemplate(Y, W, H, T) {
    const n = T.nx * T.ny, rowBest = new Float32Array(H).fill(-1);
    for (let y = 0; y + T.h <= H; y += 2) {
      let best = -1;
      for (let x = 0; x + T.w <= W; x += 2) {
        let sI = 0, sII = 0, sIT = 0, k = 0;
        for (let ty = 0; ty < T.ny; ty++) {
          let idx = (y + ty * 2) * W + x;
          for (let tx = 0; tx < T.nx; tx++, k++, idx += 2) { const iv = Y[idx]; sI += iv; sII += iv * iv; sIT += iv * T.z[k]; }
        }
        const varI = sII - (sI * sI) / n;
        if (varI < n * 80) continue;                         // flat patch: no text here
        const ncc = sIT / Math.sqrt(varI * T.ss);
        if (ncc > best) best = ncc;
      }
      rowBest[y] = best;
    }
    let count = 0, top = -1;
    for (let rep = 0; rep < 5; rep++) {                      // pick the best line, hide its neighbours, repeat
      let by = -1, bv = MATCH_MIN;
      for (let y = 0; y < H; y++) if (rowBest[y] >= bv) { bv = rowBest[y]; by = y; }
      if (by < 0) break;
      if (rep === 0) top = bv;
      count++;
      for (let y = Math.max(0, by - T.h); y <= Math.min(H - 1, by + T.h); y++) rowBest[y] = -1;
    }
    return { best: top, count };
  }

  function makeProcessor(geom, regs, regNames, out, tpl) {
    const n = geom.W * geom.H;
    let T = null;
    if (tpl && regs.killfeed) T = scaleTemplate(tpl, regs.killfeed.w / (regs.killfeed.r.w * tpl.vw));
    let prevY = new Uint8Array(n), curY = new Uint8Array(n), prevHist = null, havePrev = false, lastRed = 0, redInit = false;
    const last = {}, Ybuf = {};
    regNames.forEach((k) => { last[k] = { edge: 0, white: 0, init: false }; Ybuf[k] = new Uint8Array(regs[k].w * regs[k].h); });
    return function step(i, t, fr, write) {
      const px = fr.px;
      const hist = new Uint16Array(16);
      let sumAbs = 0, flashN = 0, redN = 0;
      for (let k = 0, p = 0; k < n; k++, p += 4) {
        const r = px[p], gg = px[p + 1], b = px[p + 2];
        const y = (77 * r + 150 * gg + 29 * b) >> 8;     // brightness of this pixel
        curY[k] = y; hist[y >> 4]++;
        if (havePrev) { const d = y - prevY[k]; sumAbs += d < 0 ? -d : d; if (d > 50) flashN++; }
        if (r > 150 && gg < 90 && b < 90) redN++;
      }
      const motion = havePrev ? sumAbs / (n * 255) : 0;
      let cut = 0;
      if (prevHist) { let hd = 0; for (let k = 0; k < 16; k++) hd += Math.abs(hist[k] - prevHist[k]); cut = hd / (2 * n) > 0.45 ? 1 : 0; }
      const redFrac = redN / n;
      const redRise = redInit ? Math.max(0, redFrac - lastRed - 0.003) : 0;
      lastRed = redFrac; redInit = true;
      const flashFrac = havePrev ? flashN / n : 0;
      // The whole screen changed (scene cut, big camera whip, full-screen flash): do not trust region clues.
      const hugeChange = cut === 1 || motion > 0.30 || flashFrac > 0.25;
      for (const name of regNames) {
        const R = regs[name], rp = fr.rp[name], Yr = Ybuf[name];
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
          rise = name === "hit" ? rw + 0.5 * re : re;           // text by edges, hit marker by brightness
        }
        L.edge = ed; L.white = wh; L.init = true;
        if (write) out.pulse[name][i] = hugeChange ? 0 : rise;
        if (write && T && name === "killfeed" && R.w >= T.w && R.h >= T.h) { const m = matchTemplate(Yr, R.w, R.h, T); out.mine[i] = m.best; out.mineN[i] = m.count; }
      }
      if (write) { out.mask[i] = 1; out.t[i] = t; out.motion[i] = motion; out.flash[i] = flashFrac; out.red[i] = redRise; out.cut[i] = cut; }
      const tmp = prevY; prevY = curY; curY = tmp; prevHist = hist; havePrev = true;
    };
  }

  /* ---------------------------------------------------------------
     visualScan: the manager.
       1. Split the video into N parts, N chosen from THIS device (CPU cores and memory).
       2. Try the fast "stream" reader on every part at the same time.
       3. Any part that failed or is unfinished is finished by the slower readers in a chain
          (seek -> memory copy (only if no safe copy exists) -> ffmpeg), RESUMING where it stopped.
       4. If nothing works, analyse() falls back to sound only.                                       */
  function deviceWorkers(total) {
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
    let n = Math.floor(cores / 2);
    if (mem <= 2) n = 1;
    n = Math.max(1, Math.min(3, n));
    if (total < 150) n = 1;
    return n;
  }

  async function visualScan(v, opts, ctl, progress, rec) {
    rec = rec || { attempts: [] };
    const fps = opts.fps, step = 1 / fps;
    const total = Math.max(1, Math.floor((v.duration - 0.05) * fps));
    const H = opts.height || 108;
    // Picture sizes come from the info read when the video was added (v.w / v.h).
    const W = Math.max(16, Math.round((H * (v.w / v.h)) / 2) * 2);
    const regs = {};
    Object.keys(opts.regions || {}).forEach((k) => {
      const r = opts.regions[k];
      const rw = clamp(Math.round(opts.regionWidth || 240), 64, 480);
      const rh = clamp(Math.round((rw * (r.h * v.h)) / Math.max(1, r.w * v.w)), 24, 240);
      regs[k] = { r, w: rw, h: rh, area: rw * rh };
    });
    const regNames = Object.keys(regs), geom = { W, H, regs };
    const out = { t: new Float32Array(total), motion: new Float32Array(total), flash: new Float32Array(total),
                  red: new Float32Array(total), cut: new Uint8Array(total), mask: new Uint8Array(total), mine: new Float32Array(total).fill(-1), mineN: new Uint8Array(total), hasTpl: !!opts.tpl, pulse: {} };
    regNames.forEach((k) => (out.pulse[k] = new Float32Array(total)));
    v.deadSources = v.deadSources || {};
    const t0 = performance.now();
    const tOf = (i) => Math.min(v.duration - 0.03, i * step + 0.001);

    // ---- the parts ----
    const N = v.noPlay || v.deadSources.stream ? 0 : deviceWorkers(total);
    const segs = [];                                   // { a, b, cur }  (cur = next sample to do)
    const parts = Math.max(1, N);
    if (opts.windows && opts.windows.length) {
      // TWO-STAGE MODE: only the short windows around gunfire are watched. Everything else is skipped (much faster).
      for (const w of opts.windows) {
        const a = clamp(Math.floor(w[0] * fps), 0, total - 1), b = clamp(Math.ceil(w[1] * fps), a + 1, total);
        segs.push({ a, b, cur: a, err: null });
      }
      rec.windowed = segs.length;
    } else {
      for (let k = 0; k < parts; k++) segs.push({ a: Math.floor((total * k) / parts), b: Math.floor((total * (k + 1)) / parts), cur: Math.floor((total * k) / parts), err: null });
    }
    rec.workers = N;
    const need = Math.max(1, segs.reduce((s, g) => s + (g.b - g.a), 0));      // how many samples we really have to read
    const doneCount = () => segs.reduce((s, g) => s + (g.cur - g.a), 0);
    let lastTick = 0;
    const report = async (force) => {
      const now = performance.now();
      if (!force && now - lastTick < 250) return;
      lastTick = now;
      const done = doneCount() / need, el = (now - t0) / 1000;
      progress && progress(done, done > 0.01 ? el / done - el : 0);
      await tick();
    };

    // Run one part with one source from seg.cur to seg.b. Throws when the source breaks (seg.cur stays correct).
    async function runSeg(seg, src, label) {
      stageMark("analyse:frames", label + " samples " + seg.cur + "-" + seg.b + "/" + total);
      const proc = makeProcessor(geom, regs, regNames, out, opts.tpl);
      let first = true;
      try {
        // PRIMING: look at the sample just before, only to fill the "previous picture" memory, so a restart leaves no gap.
        const startAt = seg.cur > 0 ? seg.cur - 1 : 0;
        await src.open(startAt);
        for (let i = startAt; i < seg.b; i++) {
          if (ctl.cancel) throw new Error(CANCEL);
          const fr = await src.grab(i, tOf(i));
          const prime = (i < seg.cur);
          proc(i, prime ? 0 : (fr.mt !== undefined ? Math.min(v.duration, fr.mt) : tOf(i)), fr, !prime);
          if (!prime) { seg.cur = i + 1; await report(false); }
          first = false;
        }
      } finally { try { src.close(); } catch (e) { /* ignore */ } }
    }

    // ---- stage 1: fast stream readers, all parts at once ----
    if (N > 0) {
      const rate = clamp(0.4 * 60 * step, 1, 8);       // about 0.4 samples per screen refresh (at most 8x) so no sample is skipped
      const s0 = performance.now();
      const queue = segs.slice();
      await Promise.all(Array.from({ length: N }, (_, k) => (async () => {
        while (queue.length) {
          const seg = queue.shift();
          try {
            await runSeg(seg, makeVideoSource(v, geom, "stream", async () => ({ url: v.url }), "stream", { rate, fps, ctl }), "stream#" + k);
          } catch (e) {
            if (e && e.message === CANCEL) throw e;
            seg.err = e;
            rec.attempts.push({ step: "frames", strategy: "stream#" + k + " (fast playback)", ok: false, error: errText(e), ms: Math.round(performance.now() - s0), note: "stopped at sample " + seg.cur + " of " + seg.b });
            console.warn("Stream reader " + k + " failed:", e);
            if (seg.cur === seg.a && !segs.some((g) => g.cur > g.a)) { queue.length = 0; break; }   // never worked at all: stop trying, the chain below takes over
          }
        }
      })()));
      // The readers worked, then stalled (a phone can run out of video decoders when 3 play at once).
      // Before giving up on the fast reader, retry the unfinished parts ONE AT A TIME at a gentler speed.
      if (segs.some((g) => g.cur > g.a) && segs.some((g) => g.cur < g.b)) {
        for (const slow of [rate * 0.5, Math.max(1, rate * 0.25)]) {
          const pending = segs.filter((g) => g.cur < g.b);
          if (!pending.length) break;
          progress && progress(doneCount() / need, 0, "Fast reader stalled - retrying slower, one part at a time...");
          await new Promise((r) => setTimeout(r, 1500));
          for (const seg of pending) {
            const before = seg.cur;
            try { await runSeg(seg, makeVideoSource(v, geom, "stream", async () => ({ url: v.url }), "stream", { rate: Math.max(1, slow), fps, ctl }), "stream-retry"); }
            catch (e) {
              if (e && e.message === CANCEL) throw e;
              rec.attempts.push({ step: "frames", strategy: "stream retry at " + slow.toFixed(1) + "x", ok: false, error: errText(e), note: "moved from sample " + before + " to " + seg.cur });
              if (seg.cur === before) break;                 // no progress at all: try an even gentler speed
            }
          }
        }
      }
      if (segs.every((g) => g.cur >= g.b)) {
        rec.frameSource = "stream x" + N;
        rec.attempts.push({ step: "frames", strategy: "stream x" + N + " (fast playback, " + N + " parts at once)", ok: true, ms: Math.round(performance.now() - s0) });
        return out;
      }
      if (segs.every((g) => g.cur === g.a)) v.deadSources.stream = true;     // it never worked here: do not try again for this video
      rec.attempts.push({ step: "frames", strategy: "stream x" + N, ok: false, note: "unfinished parts are finished by slower readers" });
    }

    // ---- stage 2: slower readers in a chain, resuming each unfinished part ----
    const chainDef = [
      { name: "seek", make: () => makeVideoSource(v, geom, "seek", async () => ({ url: v.url }), "seek", { ctl }) },
      { name: "memory", make: () => makeVideoSource(v, geom, "memory", () => memoryURL(v), "seek", { ctl }) },
      { name: "ffmpeg", make: () => makeFFmpegSource(v, geom, fps, (t) => progress && progress(doneCount() / need, 0, t)) }
    ];
    let lastErr = null;
    for (const seg of segs) {
      while (seg.cur < seg.b) {
        const cand = chainDef.find((c) => !v.deadSources[c.name] && !(v.noPlay && c.name !== "ffmpeg") && !(c.name === "memory" && v.file.size > 6e8));
        if (!cand) {
          const err = new Error("Every way of reading video pictures failed. Last error: " + (lastErr ? lastErr.message : (seg.err && seg.err.message)));
          err.name = "FrameReadError"; err.attempts = rec.attempts; err.cause = lastErr || seg.err;
          throw err;
        }
        const s0 = performance.now(), from = seg.cur;
        progress && progress(doneCount() / need, 0, cand.name === "seek" ? undefined : "Switching to the " + cand.name + " reader...");
        try {
          await runSeg(seg, cand.make(), cand.name);
          rec.attempts.push({ step: "frames", strategy: cand.name, ok: true, ms: Math.round(performance.now() - s0), note: "samples " + from + "-" + seg.b });
          rec.frameSource = rec.frameSource || cand.name;
        } catch (e) {
          if (e && e.message === CANCEL) throw e;
          lastErr = e instanceof Error ? e : new Error(errText(e));
          v.deadSources[cand.name] = true;
          rec.attempts.push({ step: "frames", strategy: cand.name, ok: false, error: errText(e), ms: Math.round(performance.now() - s0), note: "failed at sample " + seg.cur + " of " + total });
          console.warn("Frame source '" + cand.name + "' failed at sample " + seg.cur + ":", e);
        }
      }
    }
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

    let mineA = null, mineC = null;
    if (vis && vis.hasTpl) { mineA = new Float32Array(nG).fill(-1); mineC = new Uint8Array(nG); }
    if (vis) {
      for (let i = 0; i < vis.t.length; i++) {
        if (vis.mask && !vis.mask[i]) continue;          // two-stage mode: this sample was skipped on purpose
        const j = Math.min(nG - 1, Math.floor(vis.t[i] / DT));
        raw.motion[j] = Math.max(raw.motion[j], vis.motion[i]);
        raw.flash[j] = Math.max(raw.flash[j], vis.flash[i]);
        raw.red[j] = Math.max(raw.red[j], vis.red[i]);
        raw.cut[j] = Math.max(raw.cut[j], vis.cut[i]);
        if (mineA) { mineA[j] = Math.max(mineA[j], vis.mine[i]); mineC[j] = Math.max(mineC[j], vis.mineN[i]); }
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
    if (mineA) {                                       // name-match lines: keep the value for the whole gap between two samples
      const hold = Math.max(1, Math.ceil(1 / fpsUsed / DT)); let lastM = -1, lastC = 0, since = 999;
      for (let j = 0; j < nG; j++) { if (mineA[j] >= 0) { lastM = mineA[j]; lastC = mineC[j]; since = 0; } else if (since < hold) { mineA[j] = lastM; mineC[j] = lastC; since++; } }
      ch.mine = mineA; ch.mineN = mineC;
    }
    return { nG, ch, onsets };
  }

  /* ===============================================================
     THE MAIN ENTRY: analyse a video
     opts: { fps, regions, profile, useAudio, useVisual }
     =============================================================== */
  async function analyse(v, opts, ctl, progress) {
    ctl = ctl || {};
    const t0 = performance.now();
    const rec = { attempts: [], notes: [] };            // everything the self-healing code tried (goes into reports)
    let au = null, vis = null, audioOk = false, partial = false;

    if (opts.useAudio !== false) {
      progress && progress(0.02, "Listening to every audio sample...");
      try {
        if (v.file.size > 1.5e9) throw new Error("file too big to decode audio");
        au = await audioScan(v, ctl, (f) => progress && progress(typeof f === "number" ? 0.02 + 0.23 * f : 0.02, typeof f === "string" ? f : "Listening to every audio sample..."), rec);
        audioOk = true;
      } catch (e) {
        if (e.message === CANCEL) throw e;
        console.warn("Audio scan skipped:", e);
        rec.attempts.push({ step: "audio", strategy: "give up on sound", ok: false, error: errText(e) });
        rec.notes.push("The sound could not be read, so the picture alone was used.");
        au = null;
      }
    }

    let windows = null;
    if (opts.hunt && au && opts.useVisual !== false && v.duration > 90) {
      windows = audioWindows(au, v.duration, 3.2, 2.4);
      if (windows) rec.notes.push("Two-stage mode: only " + Math.round(windows.reduce((s, w) => s + w[1] - w[0], 0)) + " s of " + Math.round(v.duration) + " s around gunfire was watched.");
    }
    if (opts.useVisual !== false) {
      try {
        vis = await visualScan(v, windows ? Object.assign({}, opts, { windows }) : opts, ctl, (f, eta, text) =>
          progress && progress(0.25 + 0.7 * f, text || ("Watching frames... " + Math.round(f * 100) + "%" + (eta > 1 ? "  (about " + fmt(eta) + " left)" : ""))), rec);
      } catch (e) {
        if (e.message === CANCEL) throw e;
        // LAST RESORT: pictures cannot be read at all. If we have sound, finish with sound only and say so.
        if (au) {
          partial = true; vis = null;
          rec.attempts.push({ step: "frames", strategy: "sound-only analysis", ok: true, note: "pictures unreadable, using audio only" });
          rec.notes.push("Pictures could not be read by any method, so the result uses SOUND ONLY (no kill-feed / banner clues).");
          stageMark("analyse:audio-only", "visual scan gave up");
        } else { e.attempts = rec.attempts; throw e; }
      }
    }

    progress && progress(0.96, "Building time lines...");
    const chData = buildChannels(v, au, vis, opts.fps);

    // Per-second values used by the Classic mode.
    const secs = Math.ceil(v.duration);
    const loudSec = new Float32Array(secs), motionSec = new Float32Array(secs);
    for (let s = 0; s < secs; s++) { loudSec[s] = avg(chData.ch.loud, s * 10, s * 10 + 10); motionSec[s] = avg(chData.ch.motion, s * 10, s * 10 + 10); }

    return {
      dt: DT, N: chData.nG, ch: chData.ch, onsets: chData.onsets, audioOk,
      hasVisual: !!vis, partial, windowed: !!windows, hasTemplate: !!(opts.tpl && vis), recovery: rec, fps: opts.fps, regions: opts.regions || {}, profileId: opts.profile,
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
      if (w.end - w.start < want) { const extra = want - (w.end - w.start); w.start -= extra * 0.25; w.end += extra * 0.75; }   // stretch mostly AFTER the kill: never pull in the waiting time before it
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
    // A tainted canvas refuses toDataURL too. The picture is only decoration, so we just skip it.
    try { return cv.toDataURL("image/jpeg", 0.7); }
    catch (e) { console.warn("Thumbnail skipped (canvas is protected):", e.message); return ""; }
  }

  return { analyse, detect, buildClips, classic, thumbnail, DT, CANCEL, quietPoint };
})();

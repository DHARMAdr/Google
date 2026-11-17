/* =====================================================================
   js/montage.js  -  the MONTAGE program (joins clips into one video)
   =====================================================================
   WHAT IT DOES:
     1. Lists clips: the finished ones the main page saved in this browser
        (Persist), and/or video files you pick.
     2. Each clip has its own trim start/end (sliders + "use current time" buttons).
     3. Export: every clip is played once, its pictures are painted on one canvas in the
        chosen shape and sent to the phone/PC video chip (WebCodecs VideoEncoder, H.264).
        The sound of each clip is decoded, cut, joined and encoded to AAC (AudioEncoder).
        mp4-muxer packs everything into one MP4.
   WHY SEPARATE: it only reads what the main page saved, so it cannot break the main site.
   HONEST LIMITS: export runs about as long as the final video (each clip plays once);
     keep the tab open and the screen on. Needs Chrome/Edge (WebCodecs).
   HOW TO IMPROVE: cross-fades, background music, per-clip titles, drag-and-drop order,
     faster-than-real-time decoding with WebCodecs VideoDecoder.
   ===================================================================== */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const errText = (e) => (e && (e.message || e.name)) ? (e.name && e.name !== "Error" ? e.name + ": " : "") + (e.message || "") : String(e);

  let clips = [], seq = 1, cancelled = false, busy = false, lastUrl = null;

  const setStatus = (t, err) => { $("mStatus").textContent = t; $("mStatus").className = err ? "status err" : "status"; };

  /* ---------- adding clips ---------- */
  function addBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.src = url;
    v.onloadedmetadata = () => {
      const c = { id: seq++, name, blob, url, dur: v.duration, w: v.videoWidth, h: v.videoHeight, start: 0, end: v.duration };
      if (!isFinite(c.dur) || !c.w) { setStatus("Could not open " + name + " (format not supported by this browser).", true); URL.revokeObjectURL(url); return; }
      clips.push(c); render();
    };
    v.onerror = () => { setStatus("Could not open " + name + ".", true); URL.revokeObjectURL(url); };
  }

  $("pickBtn").onclick = () => $("pick").click();
  $("pick").onchange = (e) => { [...e.target.files].forEach((f) => addBlob(f, f.name)); e.target.value = ""; };
  $("loadSaved").onclick = async () => {
    try {
      const recs = await Persist.all(); let n = 0;
      for (const r of recs) for (const o of (r.outs || [])) {
        try { addBlob(await Persist.loadExport(o.file), o.name || o.file); n++; } catch (e) { console.warn("Missing saved clip", o.file, e); }
      }
      setStatus(n ? "Added " + n + " finished clip(s)." : "No finished clips are saved in this browser yet. Export clips on the main page first, or add files from your device.", !n);
    } catch (e) { setStatus("Could not read saved clips: " + errText(e), true); }
  };

  /* ---------- the clip list ---------- */
  function render() {
    const box = $("list"); box.innerHTML = "";
    clips.forEach((c, i) => {
      const d = document.createElement("div"); d.className = "mclip";
      d.innerHTML = '<b>' + (i + 1) + '. </b><span></span><video controls playsinline preload="metadata"></video>' +
        '<div class="row"><label>Start</label><input type="range" class="s" min="0" max="' + c.dur + '" step="0.05"><input type="number" class="sn" step="0.1" min="0"><button class="ghost small ss">Use current time</button></div>' +
        '<div class="row"><label>End</label><input type="range" class="e" min="0" max="' + c.dur + '" step="0.05"><input type="number" class="en" step="0.1" min="0"><button class="ghost small es">Use current time</button></div>' +
        '<div class="row"><span class="len"></span><button class="ghost small up">Move up</button><button class="ghost small dn">Move down</button><button class="ghost small rm">Remove</button></div>';
      d.querySelector("span").textContent = c.name;
      const vid = d.querySelector("video"); vid.src = c.url;
      const s = d.querySelector(".s"), e = d.querySelector(".e"), sn = d.querySelector(".sn"), en = d.querySelector(".en"), len = d.querySelector(".len");
      const show = () => { s.value = sn.value = c.start.toFixed(2); e.value = en.value = c.end.toFixed(2); len.textContent = "Length: " + (c.end - c.start).toFixed(1) + " s"; total(); };
      const setS = (x) => { c.start = clamp(+x || 0, 0, c.end - 0.3); vid.currentTime = c.start; show(); };
      const setE = (x) => { c.end = clamp(+x || 0, c.start + 0.3, c.dur); vid.currentTime = Math.max(c.start, c.end - 0.5); show(); };
      s.oninput = () => setS(s.value); sn.onchange = () => setS(sn.value);
      e.oninput = () => setE(e.value); en.onchange = () => setE(en.value);
      d.querySelector(".ss").onclick = () => setS(vid.currentTime);
      d.querySelector(".es").onclick = () => setE(vid.currentTime);
      // preview only the trimmed part
      vid.ontimeupdate = () => { if (vid.currentTime >= c.end) { vid.pause(); vid.currentTime = c.start; } };
      vid.onplay = () => { if (vid.currentTime < c.start || vid.currentTime >= c.end - 0.05) vid.currentTime = c.start; };
      d.querySelector(".up").onclick = () => { if (i > 0) { [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]]; render(); } };
      d.querySelector(".dn").onclick = () => { if (i < clips.length - 1) { [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]]; render(); } };
      d.querySelector(".rm").onclick = () => { URL.revokeObjectURL(c.url); clips.splice(i, 1); render(); };
      box.appendChild(d); show();
    });
    total();
  }
  function total() {
    const t = clips.reduce((s, c) => s + (c.end - c.start), 0);
    $("total").textContent = clips.length ? clips.length + " clip(s), total " + t.toFixed(1) + " s" : "No clips yet.";
    $("go").disabled = busy || !clips.length;
  }

  /* ---------- export ---------- */
  function paint(g, small, sg, vid, W, H, fit) {
    const vw = vid.videoWidth, vh = vid.videoHeight;
    if (fit === "fill") { const sc = Math.max(W / vw, H / vh), dw = vw * sc, dh = vh * sc; g.drawImage(vid, (W - dw) / 2, (H - dh) / 2, dw, dh); return; }
    if (fit === "blur") {
      const sc = Math.max(small.width / vw, small.height / vh);
      sg.drawImage(vid, (small.width - vw * sc) / 2, (small.height - vh * sc) / 2, vw * sc, vh * sc);
      g.imageSmoothingEnabled = true; g.drawImage(small, 0, 0, W, H);
      g.fillStyle = "rgba(0,0,0,.3)"; g.fillRect(0, 0, W, H);
    } else { g.fillStyle = "#000"; g.fillRect(0, 0, W, H); }
    const sf = Math.min(W / vw, H / vh);
    g.drawImage(vid, (W - vw * sf) / 2, (H - vh * sf) / 2, vw * sf, vh * sf);
  }

  async function pickVideoConfig(W, H, fps, bitrate) {
    for (const hw of ["prefer-hardware", "no-preference"])
      for (const codec of ["avc1.64002A", "avc1.4D002A", "avc1.640033", "avc1.42002A"]) {
        const cfg = { codec, width: W, height: H, bitrate: Math.round(bitrate), framerate: fps, hardwareAcceleration: hw, latencyMode: "quality", avc: { format: "avc" } };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config || cfg; } catch (e) { /* try next */ }
      }
    throw new Error("This device has no usable H.264 encoder.");
  }

  // Cut one clip's sound (start..end) and push it into the audio encoder at time `offset`.
  async function encodeAudio(c, offset, fade, aenc, SR, sink) {
    const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    let buf;
    try { buf = await ac.decodeAudioData(await c.blob.arrayBuffer()); } catch (e) { return false; } finally { ac.close && ac.close(); }
    const a = Math.floor(c.start * SR), n = Math.min(buf.length - a, Math.floor((c.end - c.start) * SR));
    if (n <= 0) return false;
    const ch = [buf.getChannelData(0).slice(a, a + n), (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(a, a + n)];
    const fs = Math.floor(fade * SR);
    if (fs > 0) for (let k = 0; k < Math.min(fs, n); k++) { const g = k / fs; for (const x of ch) { x[k] *= g; x[n - 1 - k] *= g; } }
    if (!aenc) {                                       // no AAC encoder in this browser: keep plain numbers, ffmpeg makes the AAC later
      const pcm = new Int16Array(n * 2);
      for (let k = 0; k < n; k++) { pcm[2 * k] = clamp(ch[0][k], -1, 1) * 32767; pcm[2 * k + 1] = clamp(ch[1][k], -1, 1) * 32767; }
      sink.push({ at: Math.round(offset * SR), pcm });
      return true;
    }
    const CH = SR;                                    // 1 second per piece
    for (let p = 0; p < n; p += CH) {
      const m = Math.min(CH, n - p), data = new Float32Array(m * 2);
      data.set(ch[0].subarray(p, p + m), 0); data.set(ch[1].subarray(p, p + m), m);       // "planar": left block, then right block
      const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((offset + p / SR) * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    return true;
  }

  async function run() {
    if (!window.VideoEncoder) throw new Error("This browser has no WebCodecs. Use Chrome or Edge.");
    const shape = $("shape").value, fit = $("fit").value, fade = parseFloat($("fade").value), bpp = parseFloat($("qual").value);
    const [W, H] = shape === "v" ? [1080, 1920] : shape === "h" ? [1920, 1080] : [1080, 1080];
    const FPS = 30, SR = 48000, t0 = performance.now();
    const totalLen = clips.reduce((s, c) => s + (c.end - c.start), 0);

    const cfg = await pickVideoConfig(W, H, FPS, clamp(W * H * FPS * bpp, 2e6, 40e6));
    const mod = await import(new URL("vendor/mp4-muxer/mp4-muxer.mjs", document.baseURI).href);
    let audioOk = !!window.AudioEncoder;
    if (audioOk) { try { audioOk = (await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate: 128000 })).supported; } catch (e) { audioOk = false; } }
    const muxer = new mod.Muxer({ target: new mod.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H },
      audio: audioOk ? { codec: "aac", numberOfChannels: 2, sampleRate: SR } : undefined, fastStart: "in-memory", firstTimestampBehavior: "offset" });
    let encErr = null;
    const venc = new VideoEncoder({ output: (ch, m) => { try { if (Number.isFinite(ch.duration) && ch.duration >= 0) muxer.addVideoChunk(ch, m); else { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); muxer.addVideoChunkRaw(d, ch.type, ch.timestamp, Math.round(1e6 / FPS), m); } } catch (e) { encErr = e; } }, error: (e) => { encErr = e; } });
    venc.configure(cfg);
    let aenc = null;
    const sink = [];                                  // sound pieces when the browser cannot encode AAC itself
    if (audioOk) {
      aenc = new AudioEncoder({ output: (ch, m) => { try { muxer.addAudioChunk(ch, m); } catch (e) { encErr = e; } }, error: (e) => { encErr = e; } });
      aenc.configure({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate: 128000 });
    }

    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { alpha: false });
    const small = document.createElement("canvas"); small.width = even(W / 12); small.height = even(H / 12);
    const sg = small.getContext("2d", { alpha: false });
    let offset = 0, frames = 0, silent = 0;

    try {
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i], dur = c.end - c.start;
        setStatus("Clip " + (i + 1) + " of " + clips.length + ": encoding (plays once)...");
        if (!(await encodeAudio(c, offset, Math.min(fade, dur / 3), aenc, SR, sink))) silent++;
        const vid = document.createElement("video");
        vid.muted = true; vid.playsInline = true; vid.preload = "auto"; vid.setAttribute("playsinline", ""); vid.src = c.url;
        const box = document.createElement("div");
        box.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.02;pointer-events:none;z-index:-1";
        box.appendChild(vid); document.body.appendChild(box);
        try {
          await new Promise((res, rej) => { vid.onloadedmetadata = res; vid.onerror = () => rej(new Error("Cannot open " + c.name)); vid.load(); });
          await new Promise((res) => { vid.onseeked = res; vid.currentTime = c.start; });
          await new Promise((resolve, reject) => {
            let done = false, lastCb = performance.now();
            const finish = (e) => { if (done) return; done = true; clearInterval(watch); e ? reject(e) : resolve(); };
            const watch = setInterval(() => {
              if (cancelled) return finish(new Error("cancelled"));
              if (document.hidden) { lastCb = performance.now(); return; }
              if (vid.paused && !vid.ended && venc.encodeQueueSize < 3) vid.play().catch(() => {});
              if (performance.now() - lastCb > 15000) finish(new Error("Playback stalled (no pictures for 15 s)."));
            }, 1000);
            const cb = (now, meta) => {
              if (done) return; lastCb = performance.now();
              if (encErr) return finish(encErr);
              const mt = meta.mediaTime;
              if (mt >= c.end - 0.0005) return finish();
              vid.requestVideoFrameCallback(cb);
              if (mt < c.start - 0.002) return;
              const t = mt - c.start;
              try {
                paint(g, small, sg, vid, W, H, fit);
                if (fade > 0) { const f = Math.min(fade, dur / 3), a = t < f ? 1 - t / f : t > dur - f ? 1 - (dur - t) / f : 0; if (a > 0) { g.fillStyle = "rgba(0,0,0," + Math.min(1, a) + ")"; g.fillRect(0, 0, W, H); } }
                const fr = new VideoFrame(cv, { timestamp: Math.round((offset + t) * 1e6), duration: Math.round(1e6 / FPS) });
                venc.encode(fr, { keyFrame: frames % (FPS * 2) === 0 }); fr.close(); frames++;
                if (frames % 8 === 0) { const f = (offset + t) / totalLen; $("mBar").style.width = Math.round(f * 95) + "%"; }
                if (venc.encodeQueueSize > 12) { vid.pause(); const back = () => { if (venc.encodeQueueSize <= 3) { venc.removeEventListener("dequeue", back); vid.play().catch(() => {}); } }; venc.addEventListener("dequeue", back); }
              } catch (e) { finish(e); }
            };
            vid.addEventListener("ended", () => finish());
            vid.requestVideoFrameCallback(cb);
            vid.play().catch((e) => finish(e));
          });
        } finally { try { vid.pause(); vid.removeAttribute("src"); vid.load(); box.remove(); } catch (e) { /* ignore */ } }
        offset += dur;
        if (cancelled) throw new Error("cancelled");
      }
      await venc.flush(); if (aenc) await aenc.flush();
      if (encErr) throw encErr;
      if (!frames) throw new Error("No pictures were produced.");
    } finally {
      try { venc.state !== "closed" && venc.close(); } catch (e) { /* ignore */ }
      try { aenc && aenc.state !== "closed" && aenc.close(); } catch (e) { /* ignore */ }
    }
    muxer.finalize();
    let bytes = new Uint8Array(muxer.target.buffer), soundBy = audioOk ? "browser" : "none";
    if (!audioOk && sink.length && typeof Exporter !== "undefined") {
      // FALLBACK: build one WAV with all the sound, let ffmpeg turn it into AAC and join it to the picture without re-encoding the picture.
      try {
        setStatus("Adding the sound (compatibility mode)...");
        const total = Math.ceil(totalLen * SR), wav = new Uint8Array(44 + total * 4), dv = new DataView(wav.buffer);
        const txt = (o, t) => { for (let k = 0; k < t.length; k++) wav[o + k] = t.charCodeAt(k); };
        txt(0, "RIFF"); dv.setUint32(4, 36 + total * 4, true); txt(8, "WAVEfmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
        dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); txt(36, "data"); dv.setUint32(40, total * 4, true);
        const body = new Int16Array(wav.buffer, 44, total * 2);
        for (const piece of sink) body.set(piece.pcm.subarray(0, Math.max(0, Math.min(piece.pcm.length, (total - piece.at) * 2))), piece.at * 2);
        const ff = await Exporter.loadEngine((t) => setStatus(t));
        await ff.writeFile("/v.mp4", bytes); await ff.writeFile("/a.wav", wav);
        const code = await ff.exec(["-hide_banner", "-i", "/v.mp4", "-i", "/a.wav", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", "/out.mp4"]);
        if (code === 0) { bytes = await ff.readFile("/out.mp4"); soundBy = "ffmpeg"; }
        for (const f of ["/v.mp4", "/a.wav", "/out.mp4"]) { try { await ff.deleteFile(f); } catch (e) { /* ignore */ } }
      } catch (e) { console.warn("Montage: sound step failed, video only:", e); }
    }
    return { blob: new Blob([bytes], { type: "video/mp4" }), seconds: (performance.now() - t0) / 1000, silent, audioOk: soundBy !== "none", frames };
  }

  $("go").onclick = async () => {
    if (busy || !clips.length) return;
    busy = true; cancelled = false; $("go").disabled = true; $("stop").hidden = false; $("result").innerHTML = ""; $("mBar").style.width = "1%";
    try { if (navigator.wakeLock) await navigator.wakeLock.request("screen").catch(() => {}); } catch (e) { /* optional */ }
    try {
      const r = await run();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(r.blob);
      const name = "montage_" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".mp4";
      $("result").innerHTML = '<video controls playsinline style="width:100%;max-height:420px;background:#000;border-radius:8px" src="' + lastUrl + '"></video>' +
        '<p><a class="dl" href="' + lastUrl + '" download="' + name + '">Download ' + name + " (" + (r.blob.size / 1048576).toFixed(1) + " MB)</a></p>";
      $("mBar").style.width = "100%";
      setStatus("Done in " + Math.round(r.seconds) + " s." + (!r.audioOk ? " This browser cannot encode sound, so the video has no sound." : r.silent ? " " + r.silent + " clip(s) had no readable sound." : ""));
    } catch (e) {
      $("mBar").style.width = "0%";
      setStatus(e.message === "cancelled" ? "Cancelled." : "Export failed: " + errText(e), e.message !== "cancelled");
    } finally { busy = false; $("stop").hidden = true; total(); }
  };
  $("stop").onclick = () => { cancelled = true; };
  window.addEventListener("beforeunload", (e) => { if (busy) { e.preventDefault(); e.returnValue = ""; } });
})();

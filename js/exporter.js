/* =====================================================================
   js/exporter.js  -  turns a clip into a real video file
   =====================================================================
   THREE WAYS TO EXPORT (pick one in the site):

   1. "hq"   - BEST QUALITY. Uses ffmpeg (a professional video tool that we
               run inside your browser through WebAssembly). It decodes every
               frame of the original, crops/scales it, and encodes real H.264
               video with a very high quality setting (CRF 16-20), keeps the
               original frame rate and re-encodes audio as AAC.
               It does NOT run in real time, so the picture is not dropped or
               blurred like a screen recording. It takes longer than the clip.

   2. "copy" - ORIGINAL QUALITY, INSTANT. Cuts the file without re-encoding
               (stream copy). Zero quality loss, takes a second. The shape
               stays the same as the original (no 9:16 crop) and the cut
               starts at the nearest keyframe (can be ~1-2 s early).

   3. "fast" - REAL-TIME RECORDER (the first version's method). Plays the clip
               and records it. Quick to set up but the quality is lower.
               Use it only for quick previews.

   WHY ffmpeg AND NOT THE BROWSER'S OWN RECORDER?
     A browser recorder re-captures the screen picture in real time with a
     small bit rate, which softens details and can drop frames. ffmpeg works
     on the real decoded frames, so the output stays sharp.

   HOW TO IMPROVE LATER:
     - Use WebCodecs (hardware H.264 encoder) for much faster exports.
     - Use the multi-threaded ffmpeg core (needs special server headers).
   ===================================================================== */

// make() builds ONE independent export engine (its own ffmpeg). The page keeps a main one and can
// start extra ones (Exporter.spawn) to export several clips at the same time on a many-core device.
const Exporter = (function () {
  "use strict";
  function make() {

  let ff = null;               // the running ffmpeg instance
  let loading = null;          // a promise while ffmpeg is still loading
  const mounts = new Map();    // video id -> folder where the file is mounted inside ffmpeg
  let cancelled = false;
  const logBuf = [];           // last lines ffmpeg printed (goes into the error report)

  // Places to load ffmpeg's core from: your own site first, then public CDNs as a back-up.
  const CORE_BASES = [
    new URL("vendor/ffmpeg/core/", document.baseURI).href,
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/",
    "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/"
  ];

  /* ---------- sizes ---------- */
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  // Output picture size for the chosen shape and resolution.
  function outSize(o, vw, vh) {
    // Never blow a small video up: asking for 1080 from a 768x480 file only costs time, not quality.
    const base = Math.min(parseInt(o.res, 10) || 1080, Math.max(720, o.shape === "16:9" ? vh : vw));   // width for vertical shapes, height for landscape
    if (o.shape === "original") return [even(vw), even(vh)];
    if (o.shape === "9:16") return [even(base), even((base * 16) / 9)];
    if (o.shape === "4:5") return [even(base), even((base * 5) / 4)];
    if (o.shape === "1:1") return [even(base), even(base)];
    return [even((base * 16) / 9), even(base)];          // 16:9
  }

  /* ---------- title picture (a transparent PNG drawn with canvas) ---------- */
  function drawTitleOn(g, text, W, H) {
    const size = Math.round(Math.min(W, H) * 0.07);
    g.font = "800 " + size + "px system-ui, 'Segoe UI', Arial, sans-serif";
    g.textAlign = "center"; g.textBaseline = "top";
    const maxW = W * 0.9, words = text.split(/\s+/), lines = [];
    let line = "";
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (g.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    });
    lines.push(line);
    lines.slice(0, 3).forEach((l, i) => {
      const y = H * 0.06 + i * size * 1.2;
      g.lineWidth = size * 0.16; g.strokeStyle = "rgba(0,0,0,.85)"; g.lineJoin = "round";
      g.strokeText(l, W / 2, y);                         // dark outline so it reads on any picture
      g.fillStyle = "#fff"; g.fillText(l, W / 2, y);
    });
  }

  async function titlePng(text, W, H) {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    drawTitleOn(c.getContext("2d"), text, W, H);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* ---------- ffmpeg loading ---------- */
  async function blobURL(url, type, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    const total = +res.headers.get("content-length") || 0;
    if (!res.body || !onProgress || !total) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onProgress(got / total);
    }
    return URL.createObjectURL(new Blob(parts, { type }));
  }

  async function loadEngine(onStatus) {
    if (ff) return ff;
    if (loading) return loading;
    loading = (async () => {
      const mod = await import(new URL("vendor/ffmpeg/index.js", document.baseURI).href);
      let lastErr = null;
      for (const base of CORE_BASES) {
        const inst = new mod.FFmpeg();
        try {
          onStatus && onStatus("Loading the export engine (first time only, about 30 MB)...");
          const coreURL = await blobURL(base + "ffmpeg-core.js", "text/javascript");
          const wasmURL = await blobURL(base + "ffmpeg-core.wasm", "application/wasm",
            (f) => onStatus && onStatus("Loading the export engine... " + Math.round(f * 100) + "%"));
          await inst.load({ coreURL, wasmURL });
          // Keep ffmpeg's own messages: they are the best clue when something fails.
          inst.on("log", ({ message }) => { logBuf.push(String(message).slice(0, 300)); if (logBuf.length > 120) logBuf.shift(); });
          ff = inst;
          return ff;
        } catch (e) { lastErr = e; try { inst.terminate(); } catch (x) { /* ignore */ } }
      }
      throw new Error("Could not load the export engine (" + (lastErr && lastErr.message) + "). Check your internet connection and try again, or use the Fast recorder.");
    })();
    try { return await loading; } finally { loading = null; }
  }

  // Make the user's file visible inside ffmpeg WITHOUT copying it into memory (WORKERFS mount).
  async function mountVideo(v) {
    if (mounts.has(v.id)) return mounts.get(v.id);
    const dir = "/in" + v.id;
    await ff.createDir(dir);
    const ext = (v.name.match(/\.([a-z0-9]+)$/i) || [0, "mp4"])[1].toLowerCase();
    await ff.mount("WORKERFS", { blobs: [{ name: "src." + ext, data: v.file }] }, dir);
    const info = { path: dir + "/src." + ext, ext };
    mounts.set(v.id, info);
    return info;
  }

  async function unmountVideo(v) {
    if (!ff || !mounts.has(v.id)) return;
    try { await ff.unmount("/in" + v.id); await ff.deleteDir("/in" + v.id); } catch (e) { /* ignore */ }
    mounts.delete(v.id);
  }

  /* ---------- building the ffmpeg command ---------- */
  function buildArgs(v, clip, o, src, W, H, hasTitle) {
    const dur = clip.end - clip.start;
    const speed = o.speed || 1;
    const outDur = dur / speed;
    const args = ["-hide_banner", "-ss", clip.start.toFixed(3), "-t", dur.toFixed(3), "-i", src.path];
    if (hasTitle) args.push("-loop", "1", "-framerate", "30", "-i", "/title.png");

    // ----- picture -----
    const pre = [];
    if (speed !== 1) pre.push("setpts=PTS/" + speed);
    if (o.fps && o.fps !== "src") pre.push("fps=" + o.fps);
    let g = "[0:v]" + (pre.join(",") || "null") + "[src];";
    const px = (o.posX ?? 0.5), py = (o.posY ?? 0.5);
    if (o.shape === "original") {
      g += "[src]null[v0];";
    } else if (o.fit === "fill") {
      g += `[src]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:(iw-ow)*${px}:(ih-oh)*${py}[v0];`;
    } else if (o.fit === "fit") {
      g += `[src]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[v0];`;
    } else { // blur: whole picture sharp in the middle, blurred copy behind it
      g += `[src]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${even(W / 12)}:${even(H / 12)},boxblur=2:1,scale=${W}:${H}[bg];` +
           `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v0];`;
    }
    let last = "v0";
    if (o.fade > 0) {
      const f = Math.min(o.fade, outDur / 3);
      g += `[${last}]fade=t=in:st=0:d=${f},fade=t=out:st=${Math.max(0, outDur - f).toFixed(3)}:d=${f}[v1];`; last = "v1";
    }
    if (hasTitle) {
      const till = o.titleSecs > 0 ? `between(t,0,${o.titleSecs})` : "1";
      g += `[${last}][1:v]overlay=0:0:enable='${till}':shortest=1[v2];`; last = "v2";
    }
    g += `[${last}]format=yuv420p[vout]`;
    args.push("-filter_complex", g, "-map", "[vout]");

    // ----- sound -----
    if (o.mute) args.push("-an");
    else {
      const af = [];
      if (speed !== 1) af.push("atempo=" + speed);
      if (o.loud) af.push("loudnorm=I=-14:TP=-1.5:LRA=11");
      if (o.fade > 0) { const f = Math.min(o.fade, outDur / 3); af.push(`afade=t=in:st=0:d=${f}`, `afade=t=out:st=${Math.max(0, outDur - f).toFixed(3)}:d=${f}`); }
      args.push("-map", "0:a?");
      if (af.length) args.push("-af", af.join(","));
      args.push("-c:a", "aac", "-b:a", "256k", "-ar", "48000");
    }

    // ----- encoder: low CRF number = higher quality (16 is visually lossless for most videos) -----
    const preset = { max: ["veryfast", "16"], high: ["superfast", "18"], quick: ["ultrafast", "20"] }[o.preset] || ["superfast", "18"];
    args.push("-c:v", "libx264", "-preset", preset[0], "-crf", preset[1], "-profile:v", "high", "-pix_fmt", "yuv420p",
              "-movflags", "+faststart", "-t", outDur.toFixed(3), "/out.mp4");
    return { args, outDur };
  }

  /* ---------- HQ + COPY export through ffmpeg ---------- */
  async function exportFF(v, clip, o, onProgress, onStatus) {
    cancelled = false;
    await loadEngine(onStatus);
    const src = await mountVideo(v);
    const dur = clip.end - clip.start;
    const t0 = performance.now();
    let outName = "/out.mp4", ext = "mp4", args, outDur = dur;

    const onLog = ({ message }) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) {
        const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
        const f = Math.min(1, sec / outDur), el = (performance.now() - t0) / 1000;
        onProgress && onProgress(f, f > 0.03 ? el / f - el : 0);
      }
    };
    ff.on("log", onLog);
    try {
      if (o.engine === "copy") {
        ext = ["webm", "mkv"].includes(src.ext) ? src.ext : "mp4";
        outName = "/out." + ext;
        args = ["-hide_banner", "-ss", clip.start.toFixed(3), "-t", dur.toFixed(3), "-i", src.path, "-map", "0:v:0", "-map", "0:a?",
                "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outName];
      } else {
        const [W, H] = outSize(o, v.w, v.h);
        let hasTitle = false;
        if (o.title && clip.label) {
          await ff.writeFile("/title.png", await titlePng(clip.label, W, H));
          hasTitle = true;
        }
        const b = buildArgs(v, clip, o, src, W, H, hasTitle);
        args = b.args; outDur = b.outDur;
      }
      onStatus && onStatus(o.engine === "copy" ? "Cutting (no re-encoding)..." : "Encoding in high quality...");
      const code = await ff.exec(args);
      if (cancelled) throw new Error("cancelled");
      if (code !== 0) throw new Error("The export engine failed (code " + code + "). Try a different quality or the Fast recorder.");
      const data = await ff.readFile(outName);
      try { await ff.deleteFile(outName); } catch (e) { /* ignore */ }
      if (!data || !data.length) throw new Error("The export came out empty.");
      onProgress && onProgress(1, 0);
      return { blob: new Blob([data.buffer], { type: ext === "mp4" ? "video/mp4" : "video/" + ext }), ext };
    } catch (e) {
      if (cancelled) throw new Error("cancelled");
      throw e;
    } finally {
      try { ff && ff.off("log", onLog); } catch (e) { /* ignore */ }
    }
  }


  /* ---------- SELF-HEALING HELPERS (used by engine.js when the browser cannot read pixels) ----------
     WHY: if the browser refuses to let the page read pixels from a <video> (a "tainted canvas"),
     we do not need the browser at all. ffmpeg can decode the file itself and hand us the raw
     pixels as plain numbers, which can never be "tainted". It is slower but it always works.   */

  // Decode a stretch of video into raw RGBA pictures.
  //   specs: [{ w, h, crop: {x,y,w,h} | null }]  one entry per picture we want per frame
  //   returns: array (one per spec) of arrays of Uint8Array frames.
  async function extractFrames(v, specs, start, dur, fps, onStatus) {
    await loadEngine(onStatus);
    const src = await mountVideo(v);
    const n = specs.length;
    let fc = "[0:v]fps=" + fps + ",split=" + n + specs.map((_, i) => "[s" + i + "]").join("") + ";";
    fc += specs.map((sp, i) => {
      const crop = sp.crop ? "crop=w=iw*" + sp.crop.w.toFixed(5) + ":h=ih*" + sp.crop.h.toFixed(5) + ":x=iw*" + sp.crop.x.toFixed(5) + ":y=ih*" + sp.crop.y.toFixed(5) + "," : "";
      return "[s" + i + "]" + crop + "scale=" + sp.w + ":" + sp.h + ":flags=area,format=rgba[o" + i + "]";
    }).join(";");
    const args = ["-hide_banner", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", src.path, "-an", "-filter_complex", fc];
    specs.forEach((_, i) => args.push("-map", "[o" + i + "]", "-f", "rawvideo", "-pix_fmt", "rgba", "/fr" + i + ".rgba"));
    const code = await ff.exec(args);
    if (code !== 0) throw new Error("ffmpeg could not decode the video frames (code " + code + ")");
    const result = [];
    for (let i = 0; i < n; i++) {
      const data = await ff.readFile("/fr" + i + ".rgba");
      try { await ff.deleteFile("/fr" + i + ".rgba"); } catch (e) { /* ignore */ }
      const size = specs[i].w * specs[i].h * 4, frames = [];
      for (let o = 0; o + size <= data.length; o += size) frames.push(data.subarray(o, o + size));
      result.push(frames);
    }
    return result;
  }

  // Decode the audio track to 16 kHz mono numbers (used when decodeAudioData cannot read the audio).
  async function decodeAudioPCM(v, onStatus) {
    await loadEngine(onStatus);
    const src = await mountVideo(v);
    const code = await ff.exec(["-hide_banner", "-i", src.path, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "/pcm.raw"]);
    if (code !== 0) throw new Error("ffmpeg could not read an audio track (code " + code + ")");
    const data = await ff.readFile("/pcm.raw");
    try { await ff.deleteFile("/pcm.raw"); } catch (e) { /* ignore */ }
    if (!data || data.length < 3200) throw new Error("the video has no usable audio track");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const f = new Float32Array(Math.floor(data.length / 2));
    for (let i = 0; i < f.length; i++) f[i] = view.getInt16(i * 2, true) / 32768;
    return f;
  }


  /* ---------- FORMAT HELPERS for videos the browser cannot play (HEVC, MKV, AVI, MOV variants...) ---------- */

  // Read length and picture size by asking ffmpeg to describe the file (it prints the info in its log).
  async function probeInfo(v, onStatus) {
    await loadEngine(onStatus);
    const src = await mountVideo(v);
    const lines = [];
    const on = ({ message }) => lines.push(message);
    ff.on("log", on);
    try { await ff.exec(["-hide_banner", "-i", src.path]); }          // exits with an error code because there is no output file: that is fine
    finally { try { ff.off("log", on); } catch (e) { /* ignore */ } }
    const text = lines.join("\n");
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    const vl = lines.find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
    if (!vl) throw new Error("ffmpeg found no video picture in this file");
    const m = /[ ,](\d{2,5})x(\d{2,5})[ ,\[]/.exec(vl.replace(/(?<![0-9A-Za-z])0x[0-9a-f]+/gi, ""));
    let w = m ? +m[1] : 0, h = m ? +m[2] : 0;
    const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text);
    if (rot && Math.abs(Math.round(+rot[1] / 90)) % 2 === 1) { const t = w; w = h; h = t; }   // phone video stored sideways
    const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
    if (!w || !h || !duration) throw new Error("ffmpeg could not read the length / size (" + (vl || "").slice(0, 120) + ")");
    return { duration, w, h, codec: ((/Video:\s*([a-z0-9_]+)/i.exec(vl) || [])[1]) || "?", info: vl.trim().slice(0, 200) };
  }

  // Make a small, easy-to-play copy (480p H.264) so the preview player works. Only used for the preview.
  async function makeProxy(v, onProgress, onStatus) {
    await loadEngine(onStatus);
    const src = await mountVideo(v);
    const t0 = performance.now();
    const on = ({ message }) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) { const f = Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / v.duration), el = (performance.now() - t0) / 1000; onProgress && onProgress(f, f > 0.02 ? el / f - el : 0); }
    };
    ff.on("log", on);
    try {
      const code = await ff.exec(["-hide_banner", "-i", src.path, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:'min(480,ih)',format=yuv420p", "-r", "24",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-b:a", "80k", "-ac", "2", "-movflags", "+faststart", "/proxy.mp4"]);
      if (code !== 0) throw new Error("ffmpeg could not make a preview copy (code " + code + ")");
      const data = await ff.readFile("/proxy.mp4");
      try { await ff.deleteFile("/proxy.mp4"); } catch (e) { /* ignore */ }
      return new File([data.buffer], "preview.mp4", { type: "video/mp4" });
    } finally { try { ff.off("log", on); } catch (e) { /* ignore */ } }
  }

  // One small JPEG picture (used for the library thumbnail of unplayable videos).
  async function thumbFF(v, atSec) {
    const fr = await extractFrames(v, [{ w: 160, h: Math.max(2, Math.round((160 * v.h) / v.w / 2) * 2), crop: null }], atSec, 1, 1);
    const f = fr[0][0]; if (!f) return "";
    const w = 160, h = Math.max(2, Math.round((160 * v.h) / v.w / 2) * 2), c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(f.buffer, f.byteOffset, w * h * 4), w, h), 0, 0);
    return c.toDataURL("image/jpeg", 0.7);
  }

  const getLog = () => logBuf.slice();

  // Stop an export that is running (kills the ffmpeg worker; it reloads next time).
  function cancel() {
    cancelled = true;
    if (ff) { try { ff.terminate(); } catch (e) { /* ignore */ } ff = null; mounts.clear(); }
  }

  /* ---------- FAST export (real-time recorder, the first version's method) ---------- */
  async function exportFast(v, clip, o, onProgress, onStatus, ctl, hiddenVideo) {
    if (!window.MediaRecorder) throw new Error("This browser cannot record video. Use Chrome, Edge or Firefox on a computer.");
    const ev = hiddenVideo;
    ev.src = v.url;
    await whenLoaded(ev);
    let [W, H] = outSize(o, ev.videoWidth, ev.videoHeight);
    if (o.shape === "original") { const f = Math.min(1, 1920 / Math.max(W, H)); W = even(W * f); H = even(H * f); }
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d");
    const fps = o.fps === "30" ? 30 : 60;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctx(); await ac.resume();
    const tracks = [...canvas.captureStream(fps).getVideoTracks()];
    let gain = null;
    if (!o.mute) {
      const srcNode = ac.createMediaElementSource(ev);
      gain = ac.createGain();
      const dest = ac.createMediaStreamDestination();
      srcNode.connect(gain); gain.connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    const stream = new MediaStream(tracks);
    // Only accept MP4 when it is really H.264 + AAC (the format Instagram and YouTube like). Plain "video/mp4" can
    // silently give VP9 + Opus inside an .mp4 file, which some apps reject, so it is NOT in this list.
    const types = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2",
                   "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const bitrate = clamp(Math.round(W * H * fps * 0.12), 6e6, 25e6);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const total = clip.end - clip.start, speed = o.speed || 1, fadeMedia = (o.fade || 0) * speed;
    let cancelledFast = false;
    try {
      await seekTo(ev, clip.start);
      ev.playbackRate = speed;
      rec.start(250);
      await ev.play();
      onStatus && onStatus("Recording in real time... keep this tab open.");
      await new Promise((resolve) => {
        function loop() {
          if (ctl.cancel) { cancelledFast = true; resolve(); return; }
          drawFrameFast(g, ev, W, H, o);
          let dark = 0;
          if (fadeMedia > 0) {
            const t = ev.currentTime - clip.start, left = clip.end - ev.currentTime;
            dark = clamp(Math.max(1 - t / fadeMedia, 1 - left / fadeMedia, 0), 0, 1);
          }
          if (dark > 0) { g.fillStyle = "rgba(0,0,0," + dark + ")"; g.fillRect(0, 0, W, H); }
          if (gain) gain.gain.value = 1 - dark;
          const tt = ev.currentTime - clip.start;
          if (o.title && clip.label && (!(o.titleSecs > 0) || tt / speed <= o.titleSecs)) drawTitleOn(g, clip.label, W, H);
          onProgress && onProgress(clamp(tt / total, 0, 1), 0);
          if (ev.currentTime >= clip.end || ev.ended) { resolve(); return; }
          requestAnimationFrame(loop);
        }
        loop();
      });
    } finally {
      ev.pause(); ev.playbackRate = 1;
      if (rec.state !== "inactive") await new Promise((res) => { rec.onstop = res; rec.stop(); });
      ac.close();
    }
    if (cancelledFast) throw new Error("cancelled");
    const blob = new Blob(chunks, { type: mime || "video/webm" });
    if (!blob.size) throw new Error("The recording came out empty. Try Chrome or Edge.");
    onProgress && onProgress(1, 0);
    return { blob, ext };
  }

  // Draw one video frame on the canvas in the chosen way (Fast recorder only).
  function drawFrameFast(g, ev, W, H, o) {
    const vw = ev.videoWidth, vh = ev.videoHeight;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    if (o.shape === "original") { g.drawImage(ev, 0, 0, W, H); return; }
    if (o.fit === "fill") {
      const s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
      g.drawImage(ev, (W - dw) * (o.posX ?? 0.5), (H - dh) * (o.posY ?? 0.5), dw, dh); return;
    }
    if (o.fit === "blur") {
      const sc = Math.max(W / vw, H / vh);
      g.filter = "blur(28px) brightness(.7)";
      g.drawImage(ev, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
      g.filter = "none";
    }
    const sf = Math.min(W / vw, H / vh);
    g.drawImage(ev, (W - vw * sf) / 2, (H - vh * sf) / 2, vw * sf, vh * sf);
  }

  /* ---------- ZIP (so you can download every clip in one file) ---------- */
  // "Store" zip (no compression - videos are already compressed). Written by hand, no library needed.
  let crcTable = null;
  function crc32(buf) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cenSize = central.reduce((s, p) => s + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  /* ---------- the one function the site calls ---------- */
  async function exportClip(v, clip, o, handlers) {
    const h = handlers || {};
    if (o.engine === "fast") return exportFast(v, clip, o, h.progress, h.status, h.ctl || {}, h.hiddenVideo);
    return exportFF(v, clip, o, h.progress, h.status);
  }

  return { exportClip, cancel, unmountVideo, makeZip, outSize, loadEngine, extractFrames, decodeAudioPCM, getLog, probeInfo, makeProxy, thumbFF };
  }
  const main = make();
  main.spawn = make;
  return main;
})();

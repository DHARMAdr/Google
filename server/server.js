/* =====================================================================
   server/server.js  -  the OPTIONAL ClipCutter cloud server
   =====================================================================
   WHY THIS FILE EXISTS
     A phone has to do all the heavy video work itself and the page must stay open. This small
     server can do the rendering instead, with the real, native ffmpeg (many times faster than
     ffmpeg inside a browser). You upload a video ONCE, press export, and the server keeps rendering
     even if you close the page. Later you open the page again and download the finished clips.

   WHAT IT DOES (the whole API, all under /api):
     GET    /api/health                      who am I (no password needed, only says "ok")
     GET    /api/info                        details: ffmpeg version, cores, free disk (needs token)
     POST   /api/videos                      start an upload  -> returns a video id + chunk size
     GET    /api/videos/:id                  upload / render state (used to RESUME a broken upload)
     PUT    /api/videos/:id/chunk?index=N    upload one 8 MB piece (pieces can arrive in any order)
     POST   /api/videos/:id/complete         check the upload is whole
     POST   /api/videos/:id/jobs             render these clips with these options
     GET    /api/videos/:id/jobs             progress of every clip
     POST   /api/videos/:id/jobs/cancel      stop rendering
     GET    /api/videos/:id/clips/:cid/file  download a finished clip (supports resume / Range)
     DELETE /api/videos/:id                  DELETE EVERYTHING of that video (source + clips)
     POST   /api/purge                       delete every video on the server

   PRIVACY / CLEAN-UP RULES
     - Nothing is kept longer than needed: the site deletes a video from the server the moment you
       clear it on the site. If the site could not (you were offline), it retries later.
     - Safety net: anything not touched for TTL_HOURS (default 48) is removed automatically.

   HOW TO RUN (needs Node 18+ and ffmpeg installed):
       TOKEN=choose-a-long-secret node server.js
     Settings (environment variables), all optional except TOKEN:
       PORT=8787  DATA_DIR=./data  ALLOWED_ORIGINS=https://dharmadr.github.io  MAX_GB=4  TTL_HOURS=48
       FFMPEG=ffmpeg  FONT=/path/to/bold.ttf (for video titles)

   HOW IT WORKS: plain Node (no libraries). Uploaded pieces are written straight into a pre-sized
   file at the right position. Rendering runs ONE clip at a time through a queue, because native
   x264 already uses every CPU core by itself.

   HOW TO IMPROVE: add GPU encoding (-c:v h264_nvenc) when the machine has an NVIDIA card; render
   several clips at once on machines with many cores; store files in R2/S3 instead of local disk.
   ===================================================================== */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const os = require("os"), { spawn, spawnSync } = require("child_process");

/* ---------- settings ---------- */
const PORT = +process.env.PORT || 8787;
const DATA = path.resolve(process.env.DATA_DIR || "./data");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const MAX_BYTES = (+process.env.MAX_GB || 4) * 1e9;            // total upload allowance of the whole server
const TTL_MS = (+process.env.TTL_HOURS || 48) * 3600e3;        // forget videos nobody touched for this long
const CHUNK = 8 * 1024 * 1024;                                  // upload piece size (8 MB: fits free CDN body limits)
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://dharmadr.github.io,http://localhost:8766,http://localhost:8000").split(",").map((s) => s.trim());
let TOKEN = process.env.TOKEN || "";
if (!TOKEN) { TOKEN = crypto.randomBytes(18).toString("hex"); console.log("No TOKEN given, using a random one for this run: " + TOKEN); }
const VERSION = "1.0.0";

fs.mkdirSync(path.join(DATA, "videos"), { recursive: true });

/* ---------- small helpers ---------- */
const ID_RE = /^[a-f0-9]{24}$/, CID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const vdir = (id) => path.join(DATA, "videos", id);
const num = (x, lo, hi, d) => { x = parseFloat(x); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function readMeta(id) { try { return JSON.parse(fs.readFileSync(path.join(vdir(id), "meta.json"), "utf8")); } catch (e) { return null; } }
function writeMeta(m) { fs.writeFileSync(path.join(vdir(m.id), "meta.json.tmp"), JSON.stringify(m)); fs.renameSync(path.join(vdir(m.id), "meta.json.tmp"), path.join(vdir(m.id), "meta.json")); }
function touch(m) { m.touched = Date.now(); writeMeta(m); }
function dirSize(d) { let t = 0; try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); t += f.isDirectory() ? dirSize(p) : fs.statSync(p).size; } } catch (e) { /* gone */ } return t; }
function usedBytes() { return dirSize(path.join(DATA, "videos")); }
function allIds() { try { return fs.readdirSync(path.join(DATA, "videos")).filter((n) => ID_RE.test(n)); } catch (e) { return []; } }

function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, extra || {}));
  res.end(body);
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes("*") || ORIGINS.includes(o))) {
    res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range,Accept-Ranges,Content-Length");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

/* ---------- finding ffmpeg and a bold font (for titles) ---------- */
const ff = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" });
const HAVE_FFMPEG = ff.status === 0;
const FFMPEG_VERSION = HAVE_FFMPEG ? (ff.stdout.split("\n")[0] || "").slice(0, 60) : "NOT FOUND";
if (!HAVE_FFMPEG) console.warn("WARNING: ffmpeg was not found. Uploads work but rendering will fail. Install ffmpeg or set FFMPEG=/path.");
const FONT = [process.env.FONT, "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"].filter(Boolean).find((f) => { try { return fs.existsSync(f); } catch (e) { return false; } });
const ENCODERS = HAVE_FFMPEG ? spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "" : "";
const HAVE_NVENC = /h264_nvenc/.test(ENCODERS) && process.env.USE_NVENC === "1";

/* =====================================================================
   RENDERING
   ===================================================================== */
function outSize(o, vw, vh) {
  const base = Math.min(parseInt(o.res, 10) || 1080, Math.max(720, o.shape === "16:9" ? vh : vw));   // never blow a small video up
  if (o.shape === "original") return [even(vw), even(vh)];
  if (o.shape === "9:16") return [even(base), even((base * 16) / 9)];
  if (o.shape === "4:5") return [even(base), even((base * 5) / 4)];
  if (o.shape === "1:1") return [even(base), even(base)];
  return [even((base * 16) / 9), even(base)];
}

// Clean the options that came from the browser. Only known keys, only numbers / fixed words: nothing from the
// browser is ever pasted into a command as text.
function cleanOptions(o) {
  o = o || {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    engine: pick(o.engine, ["cloud", "copy"], "cloud"),
    shape: pick(o.shape, ["9:16", "4:5", "1:1", "16:9", "original"], "9:16"),
    fit: pick(o.fit, ["blur", "fill", "fit"], "blur"),
    res: String(pick(String(o.res), ["1080", "720", "540"], "1080")),
    fps: o.fps === "src" || o.fps === undefined ? "src" : String(num(o.fps, 10, 60, 30)),
    speed: num(o.speed, 0.5, 2, 1), fade: num(o.fade, 0, 2, 0),
    posX: num(o.posX, 0, 1, 0.5), posY: num(o.posY, 0, 1, 0.5),
    title: !!o.title, titleSecs: num(o.titleSecs, 0, 30, 3), mute: !!o.mute, loud: !!o.loud,
    preset: pick(o.preset, ["max", "high", "quick"], "high")
  };
}

function wrapTitle(text, W, size) {
  const maxChars = Math.max(8, Math.floor((W * 0.9) / (size * 0.58)));
  const words = String(text).replace(/[\r\n]+/g, " ").trim().split(/\s+/), lines = [];
  let line = "";
  for (const w of words) { const t = line ? line + " " + w : w; if (t.length > maxChars && line) { lines.push(line); line = w; } else line = t; }
  lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function buildArgs(meta, clip, o, src, outFile, titleFile) {
  const dur = clip.end - clip.start, speed = o.speed, outDur = dur / speed;
  const args = ["-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-nostats", "-ss", clip.start.toFixed(3), "-t", dur.toFixed(3), "-i", src];
  if (o.engine === "copy") {
    args.push("-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outFile);
    return { args, outDur: dur };
  }
  const [W, H] = outSize(o, meta.w || 1280, meta.h || 720);
  const pre = [];
  if (speed !== 1) pre.push("setpts=PTS/" + speed);
  if (o.fps !== "src") pre.push("fps=" + o.fps);
  let g = "[0:v]" + (pre.join(",") || "null") + "[src];";
  if (o.shape === "original") g += "[src]null[v0];";
  else if (o.fit === "fill") g += `[src]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:(iw-ow)*${o.posX}:(ih-oh)*${o.posY}[v0];`;
  else if (o.fit === "fit") g += `[src]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black[v0];`;
  else g += `[src]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${even(W / 12)}:${even(H / 12)},boxblur=2:1,scale=${W}:${H}[bg];` +
            `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v0];`;
  let last = "v0";
  if (o.fade > 0) { const f = Math.min(o.fade, outDur / 3); g += `[${last}]fade=t=in:st=0:d=${f},fade=t=out:st=${Math.max(0, outDur - f).toFixed(3)}:d=${f}[v1];`; last = "v1"; }
  if (titleFile) {
    const size = Math.round(Math.min(W, H) * 0.07), till = o.titleSecs > 0 ? `:enable='between(t,0,${o.titleSecs})'` : "";
    const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    g += `[${last}]drawtext=fontfile='${esc(FONT)}':textfile='${esc(titleFile)}':fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(size * 0.08))}:bordercolor=black@0.85:line_spacing=${Math.round(size * 0.2)}:x=(w-text_w)/2:y=${Math.round(H * 0.06)}${till}[v2];`; last = "v2";
  }
  g += `[${last}]format=yuv420p[vout]`;
  args.push("-filter_complex", g, "-map", "[vout]");
  if (o.mute) args.push("-an");
  else {
    const af = [];
    if (speed !== 1) af.push("atempo=" + speed);
    if (o.loud) af.push("loudnorm=I=-14:TP=-1.5:LRA=11");
    if (o.fade > 0) { const f = Math.min(o.fade, outDur / 3); af.push(`afade=t=in:st=0:d=${f}`, `afade=t=out:st=${Math.max(0, outDur - f).toFixed(3)}:d=${f}`); }
    args.push("-map", "0:a?"); if (af.length) args.push("-af", af.join(","));
    args.push("-c:a", "aac", "-b:a", "256k", "-ar", "48000");
  }
  // Native x264 is fast, so the presets are gentler than in the browser: lower CRF = better quality.
  const pr = { max: ["medium", "16"], high: ["veryfast", "18"], quick: ["ultrafast", "21"] }[o.preset];
  if (HAVE_NVENC) args.push("-c:v", "h264_nvenc", "-preset", "p5", "-cq", pr[1], "-b:v", "0", "-profile:v", "high");
  else args.push("-c:v", "libx264", "-preset", pr[0], "-crf", pr[1], "-profile:v", "high");
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", outDur.toFixed(3), outFile);
  return { args, outDur };
}

/* ---------- the render queue (one clip at a time) ---------- */
const queue = [];                 // { id, cid }
let running = null;               // { id, cid, child }
function enqueue(id, cid) { if (!queue.some((q) => q.id === id && q.cid === cid) && !(running && running.id === id && running.cid === cid)) queue.push({ id, cid }); pump(); }

function pump() {
  if (running || !queue.length) return;
  const { id, cid } = queue.shift();
  const meta = readMeta(id);
  if (!meta || !meta.jobs[cid] || meta.jobs[cid].status !== "queued") return pump();
  const job = meta.jobs[cid];
  const dir = vdir(id), outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, cid + ".mp4"), tmp = path.join(outDir, cid + ".part.mp4");
  let titleFile = null;
  const o = meta.options;
  if (o.title && job.label && FONT && o.engine !== "copy") { titleFile = path.join(dir, "title_" + cid + ".txt"); const [W, H] = outSize(o, meta.w || 1280, meta.h || 720); fs.writeFileSync(titleFile, wrapTitle(job.label, W, Math.round(Math.min(W, H) * 0.07))); }
  const b = buildArgs(meta, job, o, path.join(dir, meta.source), tmp, titleFile);
  job.status = "running"; job.progress = 0; job.startedAt = Date.now(); touch(meta);
  const child = spawn(FFMPEG, b.args, { stdio: ["ignore", "pipe", "pipe"] });
  running = { id, cid, child };
  let errTail = "", buf = "", lastSave = 0;
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-1500); });
  child.stdout.on("data", (d) => {
    buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
      if (m && Date.now() - lastSave > 1000) {
        lastSave = Date.now();
        const m2 = readMeta(id); if (m2 && m2.jobs[cid]) { m2.jobs[cid].progress = Math.min(0.99, +m[1] / 1e6 / b.outDur); writeMeta(m2); }
      }
    }
  });
  const done = (code) => {
    running = null;
    const m2 = readMeta(id);
    if (m2 && m2.jobs[cid] && m2.jobs[cid].status === "running") {
      const j = m2.jobs[cid];
      if (code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, outFile); j.status = "done"; j.progress = 1; j.size = fs.statSync(outFile).size; j.finishedAt = Date.now(); }
      else { j.status = "error"; j.error = "ffmpeg failed (code " + code + "): " + errTail.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400); try { fs.unlinkSync(tmp); } catch (e) { /* none */ } }
      touch(m2);
    }
    try { titleFile && fs.unlinkSync(titleFile); } catch (e) { /* none */ }
    pump();
  };
  child.on("error", (e) => { errTail = e.message; done(-1); });
  child.on("close", done);
}

/* ---------- removing videos ---------- */
function deleteVideo(id) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
  if (running && running.id === id) { try { running.child.kill("SIGKILL"); } catch (e) { /* ignore */ } }
  try { fs.rmSync(vdir(id), { recursive: true, force: true }); return true; } catch (e) { return false; }
}
// Safety net: forget videos that nobody touched for TTL_HOURS (for example the site could not delete them).
function janitor() {
  for (const id of allIds()) { const m = readMeta(id); if (!m || Date.now() - (m.touched || m.created || 0) > TTL_MS) { if (!(running && running.id === id)) deleteVideo(id); } }
}
setInterval(janitor, 3600e3); janitor();
// After a restart: jobs that were "running" go back to the queue.
for (const id of allIds()) { const m = readMeta(id); if (!m) continue; let ch = false; for (const cid of Object.keys(m.jobs || {})) if (m.jobs[cid].status === "running") { m.jobs[cid].status = "queued"; ch = true; } if (ch) writeMeta(m); for (const cid of Object.keys(m.jobs || {})) if (m.jobs[cid].status === "queued") enqueue(id, cid); }

/* =====================================================================
   HTTP
   ===================================================================== */
function readBody(req, limit) {
  return new Promise((res, rej) => {
    const parts = []; let n = 0;
    req.on("data", (d) => { n += d.length; if (n > limit) { rej(new Error("body too large")); req.destroy(); } else parts.push(d); });
    req.on("end", () => res(Buffer.concat(parts))); req.on("error", rej);
  });
}
const publicState = (m) => ({
  id: m.id, name: m.name, size: m.size, chunkSize: CHUNK, totalChunks: m.totalChunks, received: m.received, complete: m.complete,
  jobs: m.jobs, serverTime: Date.now()
});
let badAuth = 0;

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x"), p = url.pathname.replace(/\/+$/, "");
  try {
    if (p === "/api/health") return send(res, 200, { ok: true, app: "clipcutter-server", version: VERSION });
    // everything else needs the token
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    if (!safeEqual(auth, TOKEN)) { badAuth++; await new Promise((r) => setTimeout(r, Math.min(2000, badAuth * 100))); return send(res, 401, { error: "wrong or missing token" }); }
    badAuth = 0;

    if (p === "/api/info" && req.method === "GET") {
      let free = null; try { const s = fs.statfsSync(DATA); free = s.bavail * s.bsize; } catch (e) { /* old node */ }
      return send(res, 200, { ok: true, version: VERSION, ffmpeg: FFMPEG_VERSION, canRender: HAVE_FFMPEG, titles: !!FONT, nvenc: HAVE_NVENC, cores: os.cpus().length, memGB: +(os.totalmem() / 1e9).toFixed(1), freeBytes: free, usedBytes: usedBytes(), maxBytes: MAX_BYTES, ttlHours: TTL_MS / 3600e3, chunkSize: CHUNK, videos: allIds().length, queue: queue.length + (running ? 1 : 0) });
    }
    if (p === "/api/purge" && req.method === "POST") { let n = 0; for (const id of allIds()) if (deleteVideo(id)) n++; return send(res, 200, { ok: true, deleted: n }); }

    if (p === "/api/videos" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 20000)).toString() || "{}");
      const size = Math.floor(+b.size);
      if (!(size > 0)) return send(res, 400, { error: "size is required" });
      if (usedBytes() + size > MAX_BYTES) return send(res, 507, { error: "the server is full (limit " + (MAX_BYTES / 1e9).toFixed(1) + " GB). Delete videos first." });
      try { const s = fs.statfsSync(DATA); if (s.bavail * s.bsize < size * 1.5 + 2e8) return send(res, 507, { error: "not enough free disk space on the server" }); } catch (e) { /* ignore */ }
      const id = crypto.randomBytes(12).toString("hex");
      const ext = (String(b.name || "").match(/\.([a-z0-9]{1,5})$/i) || [0, "mp4"])[1].toLowerCase();
      fs.mkdirSync(vdir(id), { recursive: true });
      const source = "source." + ext;
      const fd = fs.openSync(path.join(vdir(id), source), "w"); fs.ftruncateSync(fd, size); fs.closeSync(fd);        // pre-size so pieces can land anywhere
      const meta = { id, name: String(b.name || "video").slice(0, 200), source, size, duration: num(b.duration, 0, 1e6, 0), w: Math.floor(num(b.w, 0, 16000, 0)), h: Math.floor(num(b.h, 0, 16000, 0)),
                     totalChunks: Math.ceil(size / CHUNK), received: [], complete: false, jobs: {}, options: null, created: Date.now(), touched: Date.now() };
      writeMeta(meta);
      return send(res, 200, publicState(meta));
    }

    let m = /^\/api\/videos\/([a-f0-9]{24})(\/.*)?$/.exec(p);
    if (!m) return send(res, 404, { error: "unknown address" });
    const id = m[1], sub = m[2] || "";
    const meta = readMeta(id);
    if (!meta) return send(res, 404, { error: "video not found (it may have been deleted)" });

    if (sub === "" && req.method === "GET") { touch(meta); return send(res, 200, publicState(meta)); }
    if (sub === "" && req.method === "DELETE") return send(res, 200, { ok: deleteVideo(id) });

    if (sub === "/chunk" && req.method === "PUT") {
      const index = parseInt(url.searchParams.get("index"), 10);
      if (!(index >= 0 && index < meta.totalChunks)) return send(res, 400, { error: "bad chunk index" });
      const offset = index * CHUNK, expect = Math.min(CHUNK, meta.size - offset);
      const ws = fs.createWriteStream(path.join(vdir(id), meta.source), { flags: "r+", start: offset });
      let got = 0;
      await new Promise((ok, bad) => {
        req.on("data", (d) => { got += d.length; if (got > expect) { bad(new Error("chunk too large")); req.destroy(); } });
        req.on("error", bad); ws.on("error", bad); ws.on("finish", ok); req.pipe(ws);
      });
      if (got !== expect) return send(res, 400, { error: "chunk " + index + " has " + got + " bytes, expected " + expect });
      const m2 = readMeta(id); if (!m2) return send(res, 404, { error: "video not found" });
      if (!m2.received.includes(index)) m2.received.push(index);
      m2.touched = Date.now(); writeMeta(m2);
      return send(res, 200, { ok: true, received: m2.received.length, total: m2.totalChunks });
    }
    if (sub === "/complete" && req.method === "POST") {
      if (meta.received.length !== meta.totalChunks) return send(res, 409, { error: "missing pieces", missing: meta.totalChunks - meta.received.length });
      meta.complete = true; touch(meta); return send(res, 200, publicState(meta));
    }

    if (sub === "/jobs" && req.method === "GET") { touch(meta); return send(res, 200, { jobs: meta.jobs, queue: queue.length + (running ? 1 : 0) }); }
    if (sub === "/jobs" && req.method === "POST") {
      if (!meta.complete) return send(res, 409, { error: "the upload is not finished" });
      if (!HAVE_FFMPEG) return send(res, 500, { error: "ffmpeg is not installed on the server" });
      const b = JSON.parse((await readBody(req, 200000)).toString() || "{}");
      const list = Array.isArray(b.clips) ? b.clips.slice(0, 200) : [];
      if (!list.length) return send(res, 400, { error: "no clips" });
      meta.options = cleanOptions(b.options);
      for (const c of list) {
        const cid = String(c.id);
        if (!CID_RE.test(cid)) continue;
        const start = num(c.start, 0, 1e6, NaN), end = num(c.end, 0, 1e6, NaN);
        if (!(end > start + 0.2)) continue;
        try { fs.unlinkSync(path.join(vdir(id), "out", cid + ".mp4")); } catch (e) { /* none */ }
        meta.jobs[cid] = { status: "queued", progress: 0, start, end, label: String(c.label || "").slice(0, 200), createdAt: Date.now() };
      }
      touch(meta);
      for (const cid of Object.keys(meta.jobs)) if (meta.jobs[cid].status === "queued") enqueue(id, cid);
      return send(res, 200, { ok: true, jobs: meta.jobs });
    }
    if (sub === "/jobs/cancel" && req.method === "POST") {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
      if (running && running.id === id) { try { running.child.kill("SIGKILL"); } catch (e) { /* ignore */ } }
      const m2 = readMeta(id);
      for (const cid of Object.keys(m2.jobs)) if (m2.jobs[cid].status === "queued" || m2.jobs[cid].status === "running") m2.jobs[cid].status = "cancelled";
      touch(m2); return send(res, 200, { ok: true });
    }

    m = /^\/clips\/([A-Za-z0-9_-]{1,40})\/file$/.exec(sub);
    if (m) {
      const file = path.join(vdir(id), "out", m[1] + ".mp4");
      if (req.method === "DELETE") { try { fs.unlinkSync(file); } catch (e) { /* none */ } const m2 = readMeta(id); if (m2) { delete m2.jobs[m[1]]; touch(m2); } return send(res, 200, { ok: true }); }
      if (req.method === "GET" || req.method === "HEAD") {
        let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, { error: "that clip is not finished yet" }); }
        touch(meta);
        let a = 0, z = st.size - 1, code = 200;
        const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        if (rg) { if (rg[1] !== "") { a = +rg[1]; if (rg[2] !== "") z = Math.min(z, +rg[2]); } else if (rg[2] !== "") { a = Math.max(0, st.size - +rg[2]); } code = 206; }
        if (a > z || a >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
        const h = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": z - a + 1, "Content-Disposition": 'attachment; filename="clip-' + m[1] + '.mp4"' };
        if (code === 206) h["Content-Range"] = "bytes " + a + "-" + z + "/" + st.size;
        res.writeHead(code, h);
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(file, { start: a, end: z }).pipe(res);
      }
    }
    return send(res, 404, { error: "unknown address" });
  } catch (e) {
    console.error("Request failed:", req.method, req.url, e && e.message);
    if (!res.headersSent) send(res, 500, { error: "server error: " + (e && e.message) });
    else res.end();
  }
});
server.requestTimeout = 0; server.headersTimeout = 60000;           // large uploads / downloads must not time out
server.listen(PORT, () => console.log("ClipCutter server " + VERSION + " on port " + PORT + " | data: " + DATA + " | ffmpeg: " + FFMPEG_VERSION + " | allowed origins: " + ORIGINS.join(", ")));

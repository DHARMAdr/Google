/* =====================================================================
   js/diagnostics.js  -  the ERROR REPORT system
   =====================================================================
   WHY THIS FILE EXISTS:
     When something breaks, "it failed" is not enough to fix it. This file
     collects EVERYTHING a developer (or Claude) needs, builds one complete
     report, and shows it in a pop-up with a Copy button.

   WHAT THE REPORT CONTAINS:
     1. Summary         - was it fixed automatically or not
     2. The error       - name, message, full stack trace
     3. What the app was doing - the stage and your recent clicks
     4. Automatic recovery attempts - every fix the app already tried
     5. Likely cause    - plain-English guesses made by simple rules
     6. Your video and settings (file NAME and size only, never the video)
     7. Device and browser - version, screen, memory, touch, connection...
     8. Capabilities    - which video / audio formats this browser can play
     9. Live tests      - small experiments run when the report is made
                          (for example: "can this page read canvas pixels?")
    10. Recent log      - the last console messages

   HOW IT WORKS:
     - It listens to console.log / warn / error and keeps the last 300 lines.
     - It listens to every click ("breadcrumbs") and to "stage" markers that
       the engine sets (e.g. "analyse:frames").
     - Diag.capture(error, options) is called by the app when something
       fails. window.onerror and unhandled promise errors also call it.
     - The pop-up (<dialog id="errDlg">) shows the report. Copy / Download
       buttons let you send it.

   PRIVACY:
     No video data, no file paths. Only the file name, size, type, length and
     size in pixels. You can edit the report before you send it.

   HOW TO IMPROVE:
     - Add more probes in runProbes() for new kinds of problems.
     - Add more rules in diagnose() so the "Likely cause" gets smarter.
   ===================================================================== */

const Diag = (function () {
  "use strict";

  const APP_VERSION = "4.1.0";
  const START = Date.now();
  const logs = [];            // recent console lines
  const crumbs = [];          // recent clicks and stage changes
  const reports = [];         // every report made in this visit
  let stageNow = { name: "idle", info: "", at: Date.now() };
  const stageTrail = [];      // the last stages the app went through
  let getContext = () => ({});// the app gives us a function that describes the current video / settings
  let dom = null;             // the dialog elements (set in init)
  let lastShown = 0;
  const seen = new Map();     // error text -> time, so the same error does not pop up again and again

  const MAX_LOG = 300, MAX_CRUMB = 80;
  const elapsed = () => ((Date.now() - START) / 1000).toFixed(2).padStart(7) + "s";

  /* ---------- 1. collecting console output ---------- */
  function fmtArg(a) {
    try {
      if (a instanceof Error) return a.name + ": " + a.message;
      if (typeof a === "object" && a !== null) { const s = JSON.stringify(a); return s.length > 300 ? s.slice(0, 300) + "..." : s; }
      return String(a);
    } catch (e) { return "[unprintable]"; }
  }
  function pushLog(level, msg) {
    logs.push(elapsed() + " [" + level + "] " + String(msg).slice(0, 500));
    if (logs.length > MAX_LOG) logs.shift();
  }
  ["log", "info", "warn", "error", "debug"].forEach((level) => {
    const orig = console[level] ? console[level].bind(console) : () => {};
    console[level] = function (...args) { try { pushLog(level, args.map(fmtArg).join(" ")); } catch (e) { /* never break the page */ } orig(...args); };
  });

  function crumb(text) {
    crumbs.push(elapsed() + " " + String(text).slice(0, 200));
    if (crumbs.length > MAX_CRUMB) crumbs.shift();
  }
  // Every button click is remembered, so we know the last things you did.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button,a,summary,select,input");
    if (b) crumb("click " + (b.id ? "#" + b.id : "") + " " + (b.dataset && (b.dataset.act || b.dataset.vact || b.dataset.ev) ? "[" + (b.dataset.act || b.dataset.vact || b.dataset.ev) + "]" : "") + " " + (b.textContent || "").trim().slice(0, 30));
  }, true);

  // The engine calls this when it moves to a new step: Diag.stage("analyse:frames", "browser source").
  function stage(name, info) {
    stageNow = { name, info: info || "", at: Date.now() };
    stageTrail.push(elapsed() + " " + name + (info ? " - " + info : ""));
    if (stageTrail.length > 60) stageTrail.shift();
  }

  /* ---------- 2. describing the device and browser ---------- */
  function yesNo(v) { return v ? "yes" : "no"; }

  function envSnapshot() {
    const n = navigator, s = screen, e = {};
    e["Time (local)"] = new Date().toString();
    e["Time zone"] = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone;
    e["App version"] = APP_VERSION;
    e["Page address"] = location.origin + location.pathname;
    e["Protocol"] = location.protocol;
    e["Secure context (https)"] = yesNo(window.isSecureContext);
    e["Cross-origin isolated"] = yesNo(window.crossOriginIsolated);
    e["Page is inside a frame / embedded"] = yesNo(window.top !== window);
    try { e["Frame ancestors"] = (location.ancestorOrigins && location.ancestorOrigins.length) ? [...location.ancestorOrigins].join(", ") : "none"; } catch (x) { e["Frame ancestors"] = "unreadable"; }
    e["Referrer"] = document.referrer || "none";
    e["Display mode"] = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ? "installed app (standalone)" : "browser tab";
    e["User agent"] = n.userAgent;
    e["Platform"] = n.platform;
    if (n.userAgentData) e["UA brands"] = (n.userAgentData.brands || []).map((b) => b.brand + " " + b.version).join(", ") + " | mobile=" + n.userAgentData.mobile + " | platform=" + n.userAgentData.platform;
    e["Brave browser"] = n.brave ? "yes (canvas protection may be on)" : "no / not detected";
    e["Language"] = (n.languages || [n.language]).join(", ");
    e["CPU cores"] = n.hardwareConcurrency;
    e["Device memory (GB, approx)"] = n.deviceMemory || "unknown";
    e["Touch points"] = n.maxTouchPoints;
    e["Online"] = yesNo(n.onLine);
    const c = n.connection; if (c) e["Connection"] = [c.effectiveType, c.downlink && c.downlink + " Mbps", c.saveData ? "data-saver ON" : ""].filter(Boolean).join(", ");
    e["Screen"] = s.width + "x" + s.height + " @" + (window.devicePixelRatio || 1) + "x, " + s.colorDepth + "-bit";
    e["Window"] = innerWidth + "x" + innerHeight;
    e["Tab visible"] = document.visibilityState;
    e["Service worker controlling this page"] = ("serviceWorker" in n) ? yesNo(n.serviceWorker.controller) : "not supported";
    e["Cookies enabled"] = yesNo(n.cookieEnabled);
    e["Automation (webdriver)"] = yesNo(n.webdriver);
    try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); e["localStorage works"] = "yes"; } catch (x) { e["localStorage works"] = "NO (" + x.name + ")"; }
    if (performance.memory) e["JS heap (MB) used / limit"] = Math.round(performance.memory.usedJSHeapSize / 1048576) + " / " + Math.round(performance.memory.jsHeapSizeLimit / 1048576);
    return e;
  }

  function capabilities() {
    const c = {};
    const f = (name, v) => (c[name] = yesNo(v));
    f("MediaRecorder", window.MediaRecorder); f("AudioContext", window.AudioContext || window.webkitAudioContext);
    f("OfflineAudioContext", window.OfflineAudioContext); f("WebAssembly", window.WebAssembly);
    f("SharedArrayBuffer", typeof SharedArrayBuffer !== "undefined"); f("createImageBitmap", window.createImageBitmap);
    f("WebCodecs VideoDecoder", window.VideoDecoder); f("WebCodecs VideoEncoder", window.VideoEncoder);
    f("requestVideoFrameCallback", "requestVideoFrameCallback" in HTMLVideoElement.prototype);
    f("OffscreenCanvas", window.OffscreenCanvas); f("Web Workers", window.Worker); f("Service workers", "serviceWorker" in navigator);
    f("IndexedDB", window.indexedDB); f("Clipboard API", navigator.clipboard && navigator.clipboard.writeText);
    const v = document.createElement("video");
    const types = {
      "MP4 H.264 baseline": 'video/mp4; codecs="avc1.42E01E"', "MP4 H.264 high": 'video/mp4; codecs="avc1.640028"',
      "MP4 HEVC/H.265": 'video/mp4; codecs="hvc1.1.6.L93.B0"', "MP4 AV1": 'video/mp4; codecs="av01.0.05M.08"',
      "WebM VP8": 'video/webm; codecs="vp8"', "WebM VP9": 'video/webm; codecs="vp9"', "MP4 AAC audio": 'audio/mp4; codecs="mp4a.40.2"',
      "Opus audio": 'audio/webm; codecs="opus"', "AC-3 audio": 'audio/mp4; codecs="ac-3"'
    };
    Object.keys(types).forEach((k) => (c["canPlayType " + k] = v.canPlayType(types[k]) || "NO"));
    if (window.MediaRecorder) {
      ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].forEach((t) => (c["MediaRecorder " + t] = yesNo(MediaRecorder.isTypeSupported(t))));
    }
    return c;
  }

  /* ---------- 3. live tests run when a report is made ---------- */
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out")), ms))]);

  async function runProbes(ctx) {
    const out = {};
    // Test A: can this page read canvas pixels at all (no video involved)?
    try {
      const c = document.createElement("canvas"); c.width = 8; c.height = 8;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "rgb(10,20,30)"; g.fillRect(0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data;
      const same = d[0] === 10 && d[1] === 20 && d[2] === 30;
      out["A. plain canvas read"] = same ? "OK - pixels read back exactly" : "ALTERED - read back " + d[0] + "," + d[1] + "," + d[2] + " instead of 10,20,30 (a privacy feature or extension is changing canvas data)";
    } catch (e) { out["A. plain canvas read"] = "FAILED - " + e.name + ": " + e.message + " (canvas reading is blocked in this browser)"; }

    // Test B: can we read pixels from a video made from the user's file?
    const v = ctx && ctx.videoObj;
    if (v && v.file) {
      try {
        const url = URL.createObjectURL(v.file);
        out["B. blob address origin"] = new URL(url).origin + "  (page origin: " + location.origin + ")";
        const vid = document.createElement("video"); vid.muted = true; vid.preload = "auto"; vid.src = url;
        await withTimeout(new Promise((res, rej) => { vid.onloadeddata = res; vid.onerror = () => rej(new Error("video element error code " + (vid.error && vid.error.code) + " " + ((vid.error && vid.error.message) || ""))); }), 8000, "video load");
        out["B. video element"] = vid.videoWidth + "x" + vid.videoHeight + ", readyState " + vid.readyState + ", currentSrc scheme " + (vid.currentSrc || "").split(":")[0];
        const c = document.createElement("canvas"); c.width = 32; c.height = 18;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(vid, 0, 0, 32, 18);
        try { g.getImageData(0, 0, 32, 18); out["B. read pixels from the video"] = "OK"; }
        catch (e) { out["B. read pixels from the video"] = "FAILED - " + e.name + ": " + e.message; }
        // Test C: same, but with a copy of the file held in memory.
        if (v.file.size < 400e6 && /FAILED/.test(out["B. read pixels from the video"])) {
          try {
            const u2 = URL.createObjectURL(new Blob([await v.file.arrayBuffer()], { type: v.file.type || "video/mp4" }));
            const vid2 = document.createElement("video"); vid2.muted = true; vid2.src = u2;
            await withTimeout(new Promise((res) => { vid2.onloadeddata = res; }), 8000, "copy load");
            g.drawImage(vid2, 0, 0, 32, 18); g.getImageData(0, 0, 32, 18);
            out["C. same test with an in-memory copy"] = "OK (so the memory-copy fix works on this device)";
            URL.revokeObjectURL(u2);
          } catch (e) { out["C. same test with an in-memory copy"] = "FAILED - " + e.name + ": " + e.message; }
        }
        vid.removeAttribute("src"); vid.load(); URL.revokeObjectURL(url);
      } catch (e) { out["B. video test"] = "could not run: " + e.message; }
    } else out["B. video test"] = "skipped (no video selected)";

    // Test D: the player on the page
    try {
      const p = document.getElementById("player");
      if (p && p.src) {
        const err = p.error;
        out["D. page player"] = "readyState " + p.readyState + ", networkState " + p.networkState + ", error " + (err ? "code " + err.code + " " + (err.message || "") : "none") + ", size " + p.videoWidth + "x" + p.videoHeight;
      }
    } catch (e) { /* ignore */ }

    // Test E: storage space
    try { if (navigator.storage && navigator.storage.estimate) { const s = await navigator.storage.estimate(); out["E. storage (MB) used / quota"] = Math.round((s.usage || 0) / 1048576) + " / " + Math.round((s.quota || 0) / 1048576); } } catch (e) { /* ignore */ }

    // Test F: graphics card name (helps with video decode problems)
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) out["F. graphics"] = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) + " / " + gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (e) { /* ignore */ }

    // Test G: high-detail browser info
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const h = await withTimeout(navigator.userAgentData.getHighEntropyValues(["platformVersion", "architecture", "model", "uaFullVersion"]), 2000, "ua");
        out["G. detailed OS / browser"] = "platformVersion " + h.platformVersion + ", arch " + h.architecture + ", model " + (h.model || "n/a") + ", browser " + h.uaFullVersion;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ---------- 4. simple rules that guess the cause ---------- */
  function diagnose(entry, probes, ctx) {
    const msg = ((entry.error && (entry.error.name + ": " + entry.error.message)) || "") + " " + (entry.attempts || []).map((a) => a.error || "").join(" ");
    const tips = [];
    const probeText = JSON.stringify(probes);
    if (/tainted|SecurityError|insecure/i.test(msg)) {
      tips.push("The browser marked the picture as 'cross-origin', so it refuses to let the page read pixels from it (a 'tainted canvas'). Normally a video chosen from your own device is allowed, so this points to the device / browser setup.");
      if (/A\. plain canvas read.*(FAILED|ALTERED)/.test(probeText)) tips.push("TEST A FAILED: even a plain canvas cannot be read. A privacy feature (Brave shields, Firefox 'resist fingerprinting', a canvas-blocker extension) is blocking or scrambling canvas reads. Turn it off for this site, or use the compatibility engine (the app does this automatically).");
      if (/B\. read pixels from the video.*FAILED/.test(probeText) && /A\. plain canvas read.*OK/.test(probeText)) tips.push("Plain canvas works but the VIDEO taints it. Likely causes: in-app browser / WebView (Instagram, Facebook, some phone apps), a video picked from cloud storage (Google Photos / Drive / iCloud) or a network drive, or a protected / hardware-overlay video path.");
      if (/C\. same test.*OK/.test(probeText)) tips.push("An in-memory copy of the file works, so the app's 'memory copy' recovery step should fix this on this device.");
      if (/C\. same test.*FAILED/.test(probeText)) tips.push("Even an in-memory copy is blocked, so only the compatibility engine (ffmpeg decoding) or sound-only analysis can work here.");
      if (window.top !== window) tips.push("The page is inside a frame. Open https://dharmadr.github.io/Google/ directly in a normal browser tab.");
      if (/Instagram|FBAN|FBAV|Line\/|; wv\)|WebView/i.test(navigator.userAgent)) tips.push("The user agent looks like an in-app browser / WebView. Open the site in Chrome or Edge instead.");
    }
    if (/Array buffer allocation|out of memory|RangeError|memory access out of bounds|Invalid array length/i.test(msg)) {
      const mb = ctx && ctx.video ? ctx.video.sizeMB : "?";
      tips.push("Out of memory. File size is " + mb + " MB and this device reports " + (navigator.deviceMemory || "unknown") + " GB RAM. Try a shorter video, lower resolution, close other tabs, or use 'Fast - 2 frames per second'.");
    }
    if (/decodeAudioData|EncodingError|Unable to decode audio|audio/i.test(msg) && /decode/i.test(msg)) tips.push("The browser could not decode the audio track (unsupported audio codec such as AC-3/E-AC-3/DTS, or a damaged file). The app falls back to the ffmpeg decoder automatically.");
    if (/MEDIA_ERR|cannot play|could not play|DEMUXER|PIPELINE|hvc1|HEVC/i.test(msg)) tips.push("The browser cannot play this video format. HEVC/H.265 (common on phones and Nvidia/Windows recordings) is not supported by many browsers. Re-save as H.264 MP4, or rely on the ffmpeg compatibility engine.");
    if (/ffmpeg|export engine|WebAssembly|ffmpeg-core|Failed to fetch|NetworkError|load failed/i.test(msg)) tips.push("The export / compatibility engine (ffmpeg) could not load or crashed. Check the internet connection, ad-blockers or a strict network that blocks cdn.jsdelivr.net / unpkg.com. The site also hosts its own copy under /vendor/ffmpeg.");
    if (/QuotaExceeded|storage/i.test(msg)) tips.push("The browser ran out of storage space for this site. Clear site data or free disk space.");
    if (/MediaRecorder|recording came out empty|empty/i.test(msg)) tips.push("The real-time recorder produced nothing (common on phones and Safari). Use 'Best quality' export instead.");
    if (/timed out|too long/i.test(msg)) tips.push("A step timed out. The video may be very large, on a slow disk, or the tab was in the background. Keep the tab visible while the work runs.");
    if (!tips.length) tips.push("No specific rule matched. Use the stack trace, the recovery attempts and the recent log below.");
    return tips;
  }

  /* ---------- 5. building the report text ---------- */
  function kv(obj) { return Object.keys(obj).map((k) => "- " + k + ": " + obj[k]).join("\n"); }

  function buildText(entry, env, caps, probes, ctx) {
    const err = entry.error || {};
    const L = [];
    L.push("# ClipCutter error report");
    L.push("Report ID: " + entry.id + "   |   App version " + APP_VERSION + "   |   " + new Date(entry.time).toString());
    L.push("");
    L.push("## 1. Summary");
    L.push("- Status: " + (entry.recovered === true ? "FIXED AUTOMATICALLY (the app recovered; this report is for information)" : entry.recovered === "partial" ? "PARTLY FIXED (the app continued with reduced features, see attempts)" : "NOT RECOVERED (needs a code fix)"));
    L.push("- Where: " + (entry.stage || stageNow.name));
    L.push("- Problem: " + (err.name ? err.name + ": " : "") + (err.message || "(no message)"));
    if (entry.note) L.push("- Note: " + entry.note);
    L.push("");
    L.push("## 2. Error details");
    L.push("- Name: " + (err.name || "n/a"));
    L.push("- Message: " + (err.message || "n/a"));
    if (err.code !== undefined) L.push("- Code: " + err.code);
    L.push("- Stack trace:");
    L.push("```\n" + (err.stack || "(no stack available)") + "\n```");
    if (err.cause) L.push("- Cause: " + String(err.cause));
    L.push("");
    L.push("## 3. What the app was doing");
    L.push("- Current stage: " + stageNow.name + (stageNow.info ? " (" + stageNow.info + ")" : ""));
    L.push("- Stage trail (newest last):\n```\n" + (stageTrail.slice(-25).join("\n") || "none") + "\n```");
    L.push("- Your recent actions:\n```\n" + (crumbs.slice(-30).join("\n") || "none") + "\n```");
    L.push("");
    L.push("## 4. Automatic recovery attempts");
    if (entry.attempts && entry.attempts.length) {
      entry.attempts.forEach((a, i) => L.push((i + 1) + ". " + a.step + " / " + a.strategy + " -> " + (a.ok ? "WORKED" : "FAILED") + (a.error ? " (" + a.error + ")" : "") + (a.ms !== undefined ? " [" + a.ms + " ms]" : "")));
    } else L.push("- none recorded");
    L.push("");
    L.push("## 5. Likely cause (automatic guesses)");
    diagnose(entry, probes, ctx).forEach((t) => L.push("- " + t));
    L.push("");
    L.push("## 6. Video and settings");
    if (ctx && ctx.video) L.push(kv(ctx.video)); else L.push("- no video selected");
    if (ctx && ctx.settings) { L.push("- Settings:\n```\n" + JSON.stringify(ctx.settings, null, 1) + "\n```"); }
    if (ctx && ctx.extra) L.push(kv(ctx.extra));
    if (entry.extra) L.push(kv(entry.extra));
    L.push("");
    L.push("## 7. Device and browser");
    L.push(kv(env));
    L.push("");
    L.push("## 8. Capabilities");
    L.push(kv(caps));
    L.push("");
    L.push("## 9. Live tests (run when this report was made)");
    L.push(kv(probes));
    L.push("");
    L.push("## 10. Recent log (newest last)");
    L.push("```\n" + (logs.slice(-80).join("\n") || "empty") + "\n```");
    if (typeof Exporter !== "undefined" && Exporter.getLog) {
      const fl = Exporter.getLog();
      if (fl.length) L.push("\n## 11. ffmpeg log (last lines)\n```\n" + fl.slice(-40).join("\n") + "\n```");
    }
    L.push("");
    L.push("## How to use this report");
    L.push("Paste the whole text to Claude together with the message: \"Fix this ClipCutter error.\" Nothing here contains your video, only its name, size and format.");
    return L.join("\n");
  }

  /* ---------- 6. the pop-up ---------- */
  function ensureDom() {
    if (dom) return dom;
    dom = { dlg: document.getElementById("errDlg"), text: document.getElementById("errText"), title: document.getElementById("errTitle"),
            sum: document.getElementById("errSummary"), sel: document.getElementById("errSel"), badge: document.getElementById("reportBadge") };
    return dom;
  }

  function showEntry(entry) {
    const d = ensureDom();
    if (!d.dlg) return;
    d.title.textContent = entry.recovered === true ? "Fixed automatically - full report" : entry.recovered === "partial" ? "Continued with reduced features - full report" : "Something went wrong - full error report";
    d.sum.textContent = (entry.error && (entry.error.name + ": " + entry.error.message)) || "";
    d.sum.className = "err-sum " + (entry.recovered === true ? "good" : entry.recovered === "partial" ? "warn" : "bad");
    d.text.value = entry.text;
    if (d.sel) {
      d.sel.innerHTML = reports.map((r, i) => `<option value="${i}">${r.recovered === true ? "[fixed] " : r.recovered === "partial" ? "[partial] " : "[error] "}${new Date(r.time).toLocaleTimeString()} - ${String((r.error && r.error.message) || "report").replace(/[<>&"]/g, "").slice(0, 60)}</option>`).join("");
      d.sel.value = String(reports.indexOf(entry));
    }
    if (!d.dlg.open) { try { d.dlg.showModal(); } catch (e) { d.dlg.setAttribute("open", ""); } }
    d.text.scrollTop = 0;
  }

  function updateBadge() {
    const d = ensureDom();
    if (d.badge) { d.badge.textContent = reports.length; d.badge.hidden = reports.length === 0; }
  }

  function toastLink(text, entry, isError) {
    const box = document.getElementById("toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " err" : "") + " clickable";
    el.textContent = text + " Tap to see the report.";
    el.onclick = () => { showEntry(entry); el.remove(); };
    box.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 9000);
  }

  /* ---------- 7. the main function: capture an error ---------- */
  // options: { stage, recovered (true | "partial" | false), attempts, note, extra, show: "dialog" | "toast" | "none" }
  async function capture(error, options) {
    const o = options || {};
    let err = error;
    if (!(err instanceof Error)) err = { name: (err && err.name) || "Error", message: (err && err.message) || String(err), stack: (err && err.stack) || "" };
    const key = (err.name || "") + err.message;
    if (!o.force && seen.has(key) && Date.now() - seen.get(key) < 8000) return null;       // same error just reported
    seen.set(key, Date.now());

    const entry = {
      id: "CC-" + Date.now().toString(36).toUpperCase(), time: Date.now(),
      error: { name: err.name, message: err.message, stack: err.stack, code: err.code, cause: err.cause && (err.cause.message || err.cause) },
      stage: o.stage || stageNow.name, recovered: o.recovered === undefined ? false : o.recovered, attempts: o.attempts || err.attempts || [], note: o.note, extra: o.extra
    };
    pushLog("error", "CAPTURED " + key + " (recovered=" + entry.recovered + ")");
    reports.push(entry);
    updateBadge();

    let ctx = {}, probes = {};
    try { ctx = getContext() || {}; } catch (e) { ctx = { extra: { "context error": e.message } }; }
    try { probes = await runProbes(ctx); } catch (e) { probes = { "probe error": e.message }; }
    entry.text = buildText(entry, envSnapshot(), capabilities(), probes, ctx);

    const mode = o.show || (entry.recovered === true ? "toast" : "dialog");
    if (mode === "dialog") showEntry(entry);
    else if (mode === "toast") toastLink(entry.recovered === true ? "Fixed an issue automatically." : "Something needs your attention.", entry, entry.recovered !== true);
    return entry;
  }

  // A report with no error at all (the "Report" button in the top bar): system info + live tests.
  async function openDiagnostics() {
    const e = new Error("Manual diagnostics (no error)"); e.name = "Diagnostics";
    return capture(e, { recovered: true, show: "dialog", force: true, note: "Created with the Report button. Nothing failed." });
  }
  function openLast() { if (reports.length) showEntry(reports[reports.length - 1]); else openDiagnostics(); }

  /* ---------- 8. hooking up the buttons and the global error nets ---------- */
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      try { const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok; }
      catch (x) { return false; }
    }
  }

  function init(provider) {
    if (provider) getContext = provider;
    const d = ensureDom();
    const cur = () => reports[d.sel && d.sel.value !== "" ? +d.sel.value : reports.length - 1];
    const flash = (btn, text) => { if (!btn) return; const o = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = o), 1600); };
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
    on("errCopy", async (e) => { const btn = e.currentTarget; const ok = await copy(d.text.value); flash(btn, ok ? "Copied!" : "Select + copy manually"); if (!ok) { d.text.focus(); d.text.select(); } });
    on("errDownload", () => {
      const blob = new Blob([d.text.value], { type: "text/plain" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "clipcutter-error-report-" + ((cur() && cur().id) || "manual") + ".txt";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    });
    on("errRefresh", async (e) => {
      const btn = e.currentTarget, entry = cur(); if (!entry) return;
      flash(btn, "Running tests...");
      let ctx = {}; try { ctx = getContext() || {}; } catch (x) { /* ignore */ }
      entry.text = buildText(entry, envSnapshot(), capabilities(), await runProbes(ctx), ctx);
      d.text.value = entry.text;
    });
    on("errClose", () => d.dlg.close());
    if (d.sel) d.sel.addEventListener("change", () => showEntry(reports[+d.sel.value]));
    on("reportBtn", openLast);

    // Safety nets for errors nobody caught.
    const benign = /ResizeObserver|The play\(\) request was interrupted|AbortError|cancelled|Script error\.?$/i;
    window.addEventListener("error", (e) => {
      const msg = (e.error && e.error.message) || e.message || "";
      if (benign.test(msg)) return;
      capture(e.error || new Error(msg), { stage: stageNow.name, recovered: false, extra: { "source file": e.filename + ":" + e.lineno + ":" + e.colno } });
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason, msg = (r && r.message) || String(r);
      if (benign.test(msg)) return;
      capture(r instanceof Error ? r : new Error(msg), { stage: stageNow.name, recovered: false });
    });
    crumb("page ready, version " + APP_VERSION);
  }

  return { init, capture, stage, crumb, openDiagnostics, openLast, runProbes, version: APP_VERSION, get reports() { return reports; } };
})();

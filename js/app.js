/* =====================================================================
   js/app.js  -  the "glue": connects every button to the real work
   =====================================================================
   WHY THIS FILE EXISTS:
     index.html only draws the boxes. util.js / engine.js / exporter.js do
     the heavy work. This file listens to your clicks and calls them.

   MAIN PARTS (in order):
     A. State and settings     - what the page remembers
     B. Library                - add / select / delete videos
     C. Studio                 - player, timeline, manual trimmer
     D. Auto highlights        - run the engine, turn results into clips
     E. Analysis Lab           - the clue graph + event table
     F. Clips                  - clip cards, upload text
     G. Export                 - one clip, all clips, ZIP, cancel
     H. Calibrate              - draw the kill-feed box
     I. App extras             - theme, install button, offline mode

   HOW TO IMPROVE:
     - Each part is separate. To add a feature, add a function in the
       right part and connect it to a button id from index.html.
   ===================================================================== */

/* =====================================================================
   A. STATE AND SETTINGS
   ===================================================================== */
const lib = [];            // every video added; each one is an object (see addFiles)
let cur = null;            // the video being worked on
let videoSeq = 1, clipSeq = 1;
let analysing = false, exporting = false;
let aCtl = { cancel: false };   // lets the Cancel button stop the analysis
let eCtl = { cancel: false };   // lets the Cancel button stop the export
let sortMode = store.get("sortMode", "rank");

const player = $("player");

// Fill the two drop-down lists that come from profiles.js.
(function fillLists() {
  $("profileSel").innerHTML = Object.keys(PROFILES).map((k) => `<option value="${k}">${esc(PROFILES[k].name)}</option>`).join("");
  $("platformSel").innerHTML = Object.keys(PLATFORMS).map((k) => `<option value="${k}">${esc(PLATFORMS[k].name)}</option>`).join("");
  $("profileSel").value = "shooter_tr";
})();

// Remember every setting that has data-persist, and put saved values back when the page opens.
const persistEls = [...document.querySelectorAll("[data-persist]")];
(function restoreSettings() {
  const saved = store.get("settings", {});
  persistEls.forEach((el) => {
    if (!(el.id in saved)) return;
    if (el.type === "checkbox") el.checked = !!saved[el.id]; else el.value = saved[el.id];
  });
  persistEls.forEach((el) => {
    const save = () => {
      const all = store.get("settings", {});
      all[el.id] = el.type === "checkbox" ? el.checked : el.value;
      store.set("settings", all);
    };
    el.addEventListener("change", save); el.addEventListener("input", save);
  });
})();

// Read the "Auto highlights" settings in one go.
function readParams() {
  const lenVal = $("lenSel").value;
  let length = lenVal === "custom" ? clamp(parseFloat($("customLen").value) || 30, 3, 3600) : parseInt(lenVal, 10);
  const method = $("methodSel").value;
  if (method === "classic" && !length) length = 30;
  // The Hunter needs a game profile with screen boxes (kill feed, banner, hit marker). "Any video" has none, so use the common top-right layout.
  let profile = $("profileSel").value;
  // Unknown layout (no feed box, or the built-in top-right/top-left guesses that were never calibrated): watch the whole top strip.
  if ((method === "hunter" || method === "ai") && (!(PROFILES[profile] && PROFILES[profile].feed) || (["shooter_tr", "shooter_tl"].includes(profile) && !store.get("regions." + profile, null)))) profile = "shooter_top";
  return {
    method, profile, fps: parseFloat($("depthSel").value),
    platform: $("platformSel").value, length,
    count: clamp(parseInt($("countSel").value, 10) || 6, 1, 20),
    pre: clamp(parseFloat($("preSel").value) || 0, 0, 30), post: clamp(parseFloat($("postSel").value) || 0, 0, 30),
    gap: clamp(parseFloat($("gapSel").value) || 7, 2, 30), sens: parseFloat($("sensSel").value) || 1,
    focus: parseFloat($("focusSel").value), snap: parseFloat($("snapSel").value)
  };
}

// Read the export settings in one go.
function readExport() {
  return {
    engine: $("engineSel").value, preset: $("presetSel").value, res: $("resSel").value, fps: $("fpsSel").value,
    shape: $("shapeSel").value, fit: $("fitSel").value, speed: parseFloat($("speedSel").value), fade: parseFloat($("fadeSel").value),
    posX: parseInt($("posX").value, 10) / 100, posY: parseInt($("posY").value, 10) / 100,
    title: $("titleChk").checked, titleSecs: parseFloat($("titleSecs").value), mute: $("muteChk").checked, loud: $("loudChk").checked
  };
}

// Show / hide the controls that only matter for the chosen method or engine.
function syncUI() {
  const P = readParams(), classic = P.method === "classic";
  document.querySelectorAll(".smart-only").forEach((e) => (e.hidden = classic));
  document.querySelectorAll(".classic-only").forEach((e) => (e.hidden = !classic));
  const autoOpt = $("lenSel").querySelector('option[value="0"]');
  if (autoOpt) autoOpt.hidden = classic;
  if (classic && $("lenSel").value === "0") $("lenSel").value = "30";
  $("customWrap").hidden = $("lenSel").value !== "custom";
  $("sensVal").textContent = (parseFloat($("sensSel").value) || 1).toFixed(1);

  const eng = $("engineSel").value;
  document.querySelectorAll(".hq-only").forEach((e) => (e.hidden = eng !== "hq" && eng !== "turbo" && eng !== "cloud"));
  document.querySelectorAll(".shape-only").forEach((e) => {
    e.style.opacity = eng === "copy" ? 0.4 : 1;
    e.querySelectorAll("select,input").forEach((i) => (i.disabled = eng === "copy"));
  });
  $("engineHint").textContent = {
    cloud: "Sends the video once to YOUR server, which renders the clips with real ffmpeg (fast, high quality) and keeps going even if you close this page. Open the site later and the finished clips download by themselves. Deleting the video here also deletes it from the server. If the server cannot be reached, the clips are rendered on this device instead.",
    turbo: "Uses the video chip of your phone / PC (hardware H.264 encoder). The clip is played once while it is encoded, so it takes about as long as the clip itself instead of minutes or hours. Sharp picture, your chosen shape, title, fades and sound. If the device has no hardware encoder it falls back to the ffmpeg engine by itself.",
    hq: "Real H.264 encoding with ffmpeg: sharp picture, original frame rate, no dropped frames. It is slower than the clip itself (a 30 s Full HD clip can take a few minutes), and the tab should stay open. 'Quick' is the fastest, 'Maximum' the sharpest.",
    copy: "Instant and lossless: the file is cut without touching the picture. It keeps the original shape (no 9:16 crop), and the start can be up to ~2 s early because cuts happen at keyframes.",
    fast: "Plays the clip and records it in real time. Quick to start, but the picture is re-captured so it looks softer than the original. Use for previews."
  }[eng];
}

/* =====================================================================
   B. LIBRARY (add / select / delete videos)
   ===================================================================== */
const drop = $("drop"), fileInput = $("fileInput");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); });

// Some phones give an empty type for .mov, so we also check the file name.
const looksLikeVideo = (f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name);

async function addFiles(files, opts) {
  for (const file of files) {
    if (!looksLikeVideo(file)) { setStatus("Skipped " + file.name + " (not a video file).", undefined, true); continue; }
    const v = {
      id: videoSeq++, file, name: file.name, url: "", duration: 0, w: 0, h: 0, thumb: "",
      remote: opts && opts.remote ? { id: opts.remote, complete: true, pending: [], options: null } : null,
      an: null, anKey: "", det: null, clips: [], inT: 0, outT: 0, deleted: false, noPlay: false, previewUrl: "", codec: "", copyHow: "", cleanup: null, fb: { bad: [], good: [] }
    };
    // STEP 1: make a stable private copy right now, while the phone still allows reading the picked file.
    // (On Android the permission can disappear later, which made every reader fail in a real report.)
    try {
      setStatus("Saving a safe copy of " + file.name + " inside the browser...", 0);
      const c = await Compat.stableCopy(file, (f) => setStatus("Saving a safe copy of " + file.name + "... " + Math.round(f * 100) + "%", f));
      v.file = c.file; v.copyHow = c.how; v.cleanup = c.cleanup; v.copyName = c.name || ""; v.origType = file.type; v.origModified = file.lastModified;
    } catch (err) {
      const msg = "Could not read " + file.name + ": " + errText(err) + " Pick the file again (or copy it to your Downloads folder first).";
      setStatus(msg, 0, true); reportProblem(err, { recovered: false, stage: "add video", attempts: err.attempts, note: msg, extra: { "File": file.name, "Size (MB)": (file.size / 1048576).toFixed(1) } });
      continue;
    }
    // STEP 2: read length and size. The browser first; if it cannot play the format, ffmpeg does it.
    v.url = URL.createObjectURL(v.file);
    try { setStatus("Reading " + file.name + "...", 0); await probe(v); }
    catch (err) {
      const first = errText(err);
      try {
        setStatus(file.name + ": the browser cannot play this format, using the compatibility engine (first time loads about 30 MB)...", 0);
        const info = await Exporter.probeInfo(v, (t) => setStatus(t, 0));
        URL.revokeObjectURL(v.url); v.url = "";
        v.noPlay = true; v.duration = info.duration; v.w = info.w; v.h = info.h; v.codec = info.codec;
        toast(v.name + ": format '" + info.codec + "' is not playable in this browser. Analysis and export still work; use 'Make preview copy' to watch it.");
        reportProblem(new Error(first), { recovered: true, show: "none", stage: "add video", note: "Browser could not play it; ffmpeg read it instead (" + info.info + ")" });
      } catch (err2) {
        URL.revokeObjectURL(v.url); v.cleanup && v.cleanup();
        const msg = file.name + ": cannot be read. " + first + " | compatibility engine: " + errText(err2);
        setStatus(msg, 0, true); reportProblem(err2, { recovered: false, stage: "add video", note: msg, attempts: [{ step: "probe", strategy: "browser", ok: false, error: first }, { step: "probe", strategy: "ffmpeg", ok: false, error: errText(err2) }] });
        continue;
      }
    }
    v.outT = Math.min(30, v.duration);
    lib.push(v);
    if (Cloud.enabled() && Cloud.getConfig().auto) {            // optional: send it to the server in the background
      Compat.keepAwake(true);
      Cloud.upload(v, (f) => setStatus("Sending " + v.name + " to your server... " + Math.round(f * 100) + "%", f), { cancel: false })
        .then(() => { setStatus(v.name + " is on your server." + (Cloud.getConfig().offload ? " This device's copy is removed automatically when you are not using it." : ""), 1); renderLib(); })
        .catch((e) => { setStatus("Upload to the server failed: " + errText(e), 0, true); reportProblem(e, { recovered: "partial", stage: "cloud upload", show: "toast" }); })
        .finally(() => Compat.keepAwake(false));
    }
    renderLib(); renderStats();
    if (!cur) selectVideo(v);
    setStatus("Added " + file.name + (v.copyHow ? " (safe copy: " + v.copyHow + ")" : "") + ".", 0);
    // The small picture is decoration only, so any failure is ignored.
    (v.noPlay ? Exporter.thumbFF(v, Math.min(v.duration * 0.1, 3)) : Engine.thumbnail(v)).then((u) => { v.thumb = u; renderLib(); }).catch((e) => console.warn("Thumbnail skipped:", errText(e)));
  }
}

// Load only the video's info (length and size) with a temporary video element.
function probe(v) {
  return new Promise((resolve, reject) => {
    const t = document.createElement("video");
    t.preload = "metadata";
    const timer = setTimeout(() => reject(new Error("took too long to read.")), 20000);
    t.onloadedmetadata = () => {
      clearTimeout(timer);
      v.duration = t.duration; v.w = t.videoWidth; v.h = t.videoHeight;
      if (!isFinite(v.duration) || v.duration <= 0) reject(new Error("unknown length (is the file damaged?)."));
      else if (!t.videoWidth || !t.videoHeight) reject(new Error("the browser can read the sound but cannot decode the picture (unsupported video codec, often HEVC / H.265)."));
      else resolve();
    };
    t.onerror = () => { clearTimeout(timer); const me = t.error; reject(new Error("this browser cannot play it" + (me ? " (media error " + me.code + (me.message ? ": " + me.message : "") + ")" : "") + ".")); };
    t.src = v.url;
  });
}

const sizeOf = (v) => v.sizeBytes || v.file.size;      // an offloaded video has no local file, its size is remembered
function renderLib() {
  const box = $("libList");
  box.innerHTML = "";
  lib.forEach((v) => {
    const kills = v.det ? v.det.events.filter((e) => e.kind === "kill").length : 0;
    const el = document.createElement("div");
    el.className = "lib-item" + (v === cur ? " active" : "");
    el.innerHTML = `
      <div class="lib-left">
        ${v.thumb ? `<img src="${v.thumb}" alt="">` : `<div class="thumb-ph"></div>`}
        <div style="min-width:0">
          <div class="name">${esc(v.name)}</div>
          <div class="sub">${fmt(v.duration)} | ${v.w}x${v.h} | ${(sizeOf(v) / 1048576).toFixed(1)} MB${v.offloaded ? " | only on your server" : ""} | ${v.clips.length} clip(s)${v.an ? " | analysed" : ""}${v.remote ? (v.remote.complete ? " | on your server" : " | uploading...") : ""}${kills ? " | " + kills + " kill(s)" : ""}</div>
        </div>
      </div>
      <div class="row">
        <button class="ghost small" data-vact="select" data-id="${v.id}">${v === cur ? "Selected" : "Select"}</button>
        ${v.remote && v.remote.complete && !v.offloaded ? `<button class="ghost small" data-vact="offload" data-id="${v.id}">Free space</button>` : ""}
        <button class="danger small" data-vact="delete" data-id="${v.id}">Delete</button>
      </div>`;
    box.appendChild(el);
  });
  $("deleteAllBtn").hidden = lib.length < 2;
}

$("libList").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const v = lib.find((x) => x.id === +b.dataset.id);
  if (!v) return;
  if (b.dataset.vact === "select") selectVideo(v);
  if (b.dataset.vact === "delete") deleteVideo(v);
  if (b.dataset.vact === "offload") { if (analysing || exporting) alert("Please wait for the current work to finish."); else if (confirm("Remove the copy on this device? The video stays safe on your server and comes back automatically when you open it.")) offloadVideo(v); }
});

$("deleteAllBtn").addEventListener("click", () => {
  if (exporting || analysing) { alert("Please wait for the current work to finish."); return; }
  if (!confirm("Delete ALL videos and their clips from this page?")) return;
  [...lib].forEach(removeVideo);
  afterLibraryChange();
});

function deleteVideo(v) {
  if (exporting || analysing) { alert("Please wait for the current work to finish."); return; }
  if (!confirm('Delete "' + v.name + '" and its clips from this page? (Your original file on disk is not touched.)')) return;
  removeVideo(v);
  afterLibraryChange();
}

function removeVideo(v) {
  v.deleted = true;
  v.clips.forEach((c) => c.out && URL.revokeObjectURL(c.out.url));    // free exported files from memory
  Exporter.unmountVideo(v);
  if (v.url) URL.revokeObjectURL(v.url);
  if (v.previewUrl) URL.revokeObjectURL(v.previewUrl);
  try { v.cleanup && v.cleanup(); } catch (e) { /* ignore */ }
  Cloud.remove(v).then((ok) => { if (!ok && Cloud.pendingDeletes().length) toast("The server could not be reached; the video will be deleted from it automatically later."); });
  if (v.copyName) { Persist.del(v.copyName).catch(() => {}); v.clips.forEach((c) => c.out && c.out.saved && Persist.delExport(c.out.saved)); }
  lib.splice(lib.indexOf(v), 1);
  if (cur === v) cur = null;
}

function afterLibraryChange() {
  if (!cur && lib.length) selectVideo(lib[0], true);
  else if (!cur) {
    player.removeAttribute("src"); player.load();
    ["sec-studio", "sec-analyse", "sec-clips", "sec-export"].forEach((id) => ($(id).hidden = true));
    setStatus("Add a video to begin.", 0);
  }
  renderLib(); renderStats();
}

function selectVideo(v, passive) {
  cur = v;
  // 'passive' = the site selected it by itself on start-up: do not download yet, wait until the user opens it.
  if (v.offloaded && !passive) bringBack(v).then((ok) => { if (ok && cur === v) selectVideo(v, true); });
  if (v.url || v.previewUrl) player.src = v.previewUrl || v.url; else { player.removeAttribute("src"); player.load(); }
  $("meta").textContent = v.name + "  |  " + fmt(v.duration) + "  |  " + v.w + "x" + v.h + (v.noPlay ? "  |  format " + v.codec + " (not playable here" + (v.previewUrl ? ", showing a small preview copy" : "") + ")" : "");
  $("proxyBtn").hidden = !(v.noPlay && !v.previewUrl);
  ["sec-studio", "sec-analyse", "sec-clips", "sec-export"].forEach((id) => ($(id).hidden = false));
  $("inT").value = v.inT.toFixed(1); $("outT").value = v.outT.toFixed(1);
  renderLib(); renderClips(); drawTimeline(); drawLab(); renderEventTable(); updateAnState(); renderStats();
  setStatus(v.offloaded ? (passive ? "This video is on your server. Press Select on it to bring it back." : "Bringing it back from your server...") : v.an ? "Analysed. Change settings to re-pick clips." : "Ready. Press Find my highlights, or trim by hand.", 0);
}

// The live numbers at the top of the page.
function renderStats() {
  const clips = lib.reduce((s, v) => s + v.clips.length, 0);
  const kills = lib.reduce((s, v) => s + (v.det ? v.det.events.filter((e) => e.kind === "kill").length : 0), 0);
  const exp = lib.reduce((s, v) => s + v.clips.filter((c) => c.out).length, 0);
  $("statVideos").textContent = lib.length;
  $("statDuration").textContent = fmt(lib.reduce((s, v) => s + v.duration, 0));
  $("statClips").textContent = clips; $("statKills").textContent = kills; $("statExports").textContent = exp;
  $("zipBtn").disabled = exp === 0; $("packBtn").disabled = clips === 0;
}

/* =====================================================================
   C. STUDIO (timeline + manual trimmer) - kept from the earlier versions
   ===================================================================== */
let dragging = null;                                   // "in", "out" or "seek" while the mouse is down on the timeline
const timeToX = (t, W) => (t / cur.duration) * W;
const xToTime = (x, W) => clamp((x / W) * cur.duration, 0, cur.duration);

// The line shown behind the timeline: the excitement curve of the engine (or a simple sound+motion mix).
function timelineLine(v) {
  if (v.det && v.det.E) return { arr: v.det.E, step: Engine.DT };
  if (v.an) {
    const a = v.an, out = new Float32Array(a.N);
    for (let j = 0; j < a.N; j++) out[j] = 0.6 * (a.ch.loud[j] || 0) + 0.4 * (a.ch.motion[j] || 0);
    return { arr: out, step: Engine.DT };
  }
  return null;
}

function drawTimeline() {
  const c = $("timeline");
  if (!cur || c.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;            // keeps the drawing sharp on high-resolution screens
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const W = c.clientWidth, H = c.clientHeight;
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), accent2 = css.getPropertyValue("--accent2").trim(), ok = css.getPropertyValue("--ok").trim();
  const muted = css.getPropertyValue("--muted").trim(), text = css.getPropertyValue("--text").trim();

  const line = timelineLine(cur);
  if (line) {
    g.beginPath(); g.moveTo(0, H);
    const n = line.arr.length;
    for (let i = 0; i < n; i++) g.lineTo((i / n) * W, H - Math.min(1, line.arr[i]) * (H - 28) - 2);
    g.lineTo(W, H); g.closePath();
    g.fillStyle = accent2 + "55"; g.fill();
  } else {
    g.fillStyle = muted; g.font = "12px system-ui";
    g.fillText("Press 'Find my highlights' to see where the action is", 10, H / 2);
  }

  cur.clips.forEach((clip, i) => {
    const x1 = timeToX(clip.start, W), x2 = timeToX(clip.end, W);
    g.fillStyle = accent + "40"; g.fillRect(x1, 0, Math.max(2, x2 - x1), H);
    g.fillStyle = text; g.font = "11px system-ui"; g.fillText("#" + (i + 1), x1 + 3, 12);
  });

  if (cur.det) cur.det.events.forEach((e) => {          // event dots: red = kill, orange = peak, grey = feed only
    g.beginPath(); g.arc(timeToX(e.t, W), 22, 3 + 3 * e.conf, 0, 7);
    g.fillStyle = e.kind === "kill" ? "#ff4d6d" : e.kind === "peak" ? "#ffb84d" : "#8a93a8"; g.fill();
  });

  const xi = timeToX(cur.inT, W), xo = timeToX(cur.outT, W);
  g.fillStyle = ok + "30"; g.fillRect(xi, 0, Math.max(1, xo - xi), H);
  g.fillStyle = ok; g.fillRect(xi - 2, 0, 4, H); g.fillRect(xo - 2, 0, 4, H);
  g.fillRect(xi - 6, H - 16, 12, 16); g.fillRect(xo - 6, H - 16, 12, 16);          // grab boxes

  g.fillStyle = text; g.fillRect(timeToX(player.currentTime || 0, W) - 1, 0, 2, H);  // playhead
}
["timeupdate", "seeked", "play", "pause", "loadedmetadata"].forEach((ev) => player.addEventListener(ev, drawTimeline));
window.addEventListener("resize", () => { drawTimeline(); drawLab(); });
setInterval(() => { if (!player.paused) drawTimeline(); }, 120);

function setInOut(inT, outT) {
  if (!cur) return;
  inT = clamp(inT, 0, cur.duration); outT = clamp(outT, 0, cur.duration);
  if (outT < inT) outT = inT;
  cur.inT = inT; cur.outT = outT;
  $("inT").value = inT.toFixed(1); $("outT").value = outT.toFixed(1);
  drawTimeline();
}

$("timeline").addEventListener("pointerdown", (e) => {
  if (!cur) return;
  const c = e.currentTarget;
  c.setPointerCapture(e.pointerId);
  const rect = c.getBoundingClientRect(), x = e.clientX - rect.left, W = rect.width;
  if (Math.abs(x - timeToX(cur.inT, W)) < 10) dragging = "in";
  else if (Math.abs(x - timeToX(cur.outT, W)) < 10) dragging = "out";
  else { dragging = "seek"; player.currentTime = xToTime(x, W); }
});
$("timeline").addEventListener("pointermove", (e) => {
  if (!dragging || !cur) return;
  const rect = e.currentTarget.getBoundingClientRect(), t = xToTime(e.clientX - rect.left, rect.width);
  if (dragging === "in") setInOut(Math.min(t, cur.outT), cur.outT);
  else if (dragging === "out") setInOut(cur.inT, Math.max(t, cur.inT));
  else player.currentTime = t;
});
["pointerup", "pointercancel"].forEach((n) => $("timeline").addEventListener(n, () => (dragging = null)));

$("setIn").addEventListener("click", () => setInOut(player.currentTime, Math.max(cur.outT, player.currentTime)));
$("setOut").addEventListener("click", () => setInOut(Math.min(cur.inT, player.currentTime), player.currentTime));
$("inT").addEventListener("change", () => setInOut(parseFloat($("inT").value) || 0, cur.outT));
$("outT").addEventListener("change", () => setInOut(cur.inT, parseFloat($("outT").value) || 0));
$("playSel").addEventListener("click", () => previewRange(cur.inT, cur.outT));

$("addClipBtn").addEventListener("click", () => {
  if (!cur) return;
  if (cur.outT - cur.inT < 0.5) { setStatus("Make the selection at least 0.5 seconds long.", undefined, true); return; }
  cur.clips.push(makeClip(cur.inT, cur.outT));
  sortClips(); renderClips(); drawTimeline(); renderLib(); renderStats();
  toast("Clip added.");
});

document.querySelectorAll("[data-nudge]").forEach((b) =>
  b.addEventListener("click", () => { if (cur) player.currentTime = clamp(player.currentTime + parseFloat(b.dataset.nudge), 0, cur.duration); }));

$("splitBtn").addEventListener("click", () => {
  if (!cur) return;
  const t = player.currentTime, clip = cur.clips.find((c) => t > c.start + 0.3 && t < c.end - 0.3);
  if (!clip || !splitClip(clip, t)) setStatus("Move the playhead inside a clip first (at least 0.3 s from its edges).", undefined, true);
});

document.addEventListener("keydown", (e) => {
  if (!cur || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || $("calDlg").open) return;
  const step = e.shiftKey ? 0.1 : 1;
  if (e.key === "i" || e.key === "I") $("setIn").click();
  else if (e.key === "o" || e.key === "O") $("setOut").click();
  else if (e.key === "ArrowLeft") { player.currentTime = clamp(player.currentTime - step, 0, cur.duration); e.preventDefault(); }
  else if (e.key === "ArrowRight") { player.currentTime = clamp(player.currentTime + step, 0, cur.duration); e.preventDefault(); }
});

let previewTimer = null;
function previewRange(start, end) {
  player.currentTime = start; player.play();
  clearInterval(previewTimer);
  previewTimer = setInterval(() => { if (player.currentTime >= end || player.paused) { player.pause(); clearInterval(previewTimer); } }, 100);
  player.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* =====================================================================
   D. AUTO HIGHLIGHTS (run the engine, turn results into clips)
   ===================================================================== */
function updateAnState() {
  const pill = $("anState");
  if (!cur || !cur.an) { pill.textContent = "Not analysed"; pill.className = "pill"; return; }
  const P = readParams(), need = analysisKey(P) !== cur.anKey && !(P.method === "classic");
  const kills = cur.det ? cur.det.events.filter((e) => e.kind === "kill").length : 0;
  pill.textContent = need ? "Settings changed - analyse again" : "Analysed in " + fmt(cur.an.seconds) + (cur.an.audioOk ? "" : " (no audio)") + (kills ? " | " + kills + " kills" : "");
  pill.className = "pill" + (need ? "" : " ok");
}

// The analysis only needs repeating if the frame rate or kill-feed boxes changed.
const isHunt = (P) => P.method === "hunter" || P.method === "ai";      // both scan for MY kills (the AI method adds the AI check)
function getRegions(profileId) {
  const prof = PROFILES[profileId];
  if (!prof.feed) return {};
  return store.get("regions." + profileId, null) || prof.regions;
}
function analysisKey(P) {
  if (P.method === "classic") return "classic";
  return (isHunt(P) ? (P.method === "ai" ? "ai|" + AI.cfg().model + "|" + AI.cfg().name + "|" : "hunter|") + (typeof Teach !== "undefined" && Teach.get() ? "name" + Teach.get().id + "|" : "auto|") : "smart|") + P.fps + "|" + JSON.stringify(getRegions(P.profile));
}

function setAState(text, p, err) {
  $("aStatus").textContent = text; $("aStatus").className = err ? "status err" : "status";
  if (p !== undefined) $("aBar").style.width = Math.round(p * 100) + "%";
}

function setBusy(on) {
  analysing = on;
  $("analyseBtn").disabled = on; $("autoBtn").disabled = on;
  $("cancelAnalyseBtn").hidden = !on;
}

// Returns true if the video now has an analysis.
async function doAnalyse(v) {
  const P = readParams(), classic = P.method === "classic";
  if (P.method === "ai" && !AI.cfg().key && !AI.useWorker()) { setAState("AI Referee needs a connection: paste an Anthropic API key in the AI box, or log in to a server that has the ANTHROPIC_API_KEY secret.", 0, true); toast("AI Referee: no AI connection yet - see the AI box.", true); return false; }
  const key = analysisKey(P);
  if (v.an && (v.anKey === key || classic)) return true;           // already done: reuse it
  if (!(await ensureFile(v))) { setAState(FILE_GONE, 0, true); reportProblem(new Error(FILE_GONE), { recovered: false, stage: "analyse" }); return false; }

  const prof = PROFILES[P.profile];
  let fps = classic ? 1 : P.fps;
  const tpl = !classic && P.method === "hunter" && typeof Teach !== "undefined" ? Teach.get() : null;        // the taught picture of the user's name (or null)
  const useAI = !classic && P.method === "ai", autoName = !classic && P.method === "hunter" && !tpl && typeof AutoName !== "undefined";      // no taught name: find it automatically
  if (!classic && isHunt(P) && fps > 4) fps = 4;       // name matching only needs ~4 pictures per second (a kill-feed line stays visible for seconds): much faster
  const regions = classic ? {} : Object.assign({}, getRegions(P.profile), tpl ? { killfeed: Teach.region(tpl) } : {});
  aCtl = { cancel: false };
  setBusy(true); setAState("Starting...", 0.01); Compat.keepAwake(true);
  try {
    v.an = await Engine.analyse(v, { fps, regions, hunt: isHunt(P), tpl, profile: classic ? "auto" : P.profile, height: fps >= 10 ? 144 : 108, regionWidth: tpl || autoName || useAI ? 480 : fps >= 30 ? 320 : 240, collect: autoName || useAI ? { vw: v.w, vh: v.h } : null },
      aCtl, (f, text) => setAState(typeof text === "string" ? text : "Working...", f));
    v.anKey = key;
    if (autoName && !v.an.partial && v.an.rows) {
      setAState("Learning which kill-feed name is yours...", 0.97);
      try { v.an.auto = await AutoName.run(v.an, (f, t) => setAState(t, 0.97 + 0.03 * f)); }
      catch (e) { v.an.auto = { ok: false, reason: errText(e) }; console.warn("AutoName failed:", e); }
    }
    if (useAI && !v.an.partial) {
      setAState("AI Referee: preparing the moments...", 0.97);
      const pos = { tr: { x: 0.5, y: 0.0, w: 0.5, h: 0.36 }, tl: { x: 0.0, y: 0.0, w: 0.5, h: 0.36 }, top: { x: 0.0, y: 0.0, w: 1.0, h: 0.3 } }[store.get("ai.pos", "tr")] || { x: 0.5, y: 0, w: 0.5, h: 0.36 };
      try { v.an.ai = await AI.verify(v, v.an, { region: pos, onProgress: (f, t) => setAState(t, 0.97 + 0.03 * f), cancel: () => aCtl.cancel }); }
      catch (e) { if (e.message === Engine.CANCEL) throw e; v.an.ai = { ok: false, reason: errText(e) }; console.warn("AI Referee failed:", e); toast("AI Referee failed: " + errText(e), true); }
    }
    const rec = v.an.recovery, failed = rec ? rec.attempts.filter((a) => !a.ok) : [];
    if (v.an.partial) {
      setAState("Finished using SOUND ONLY (pictures could not be read). See the report.", 1, true);
      reportProblem(new Error(failed.length ? failed.map((a) => a.strategy + ": " + a.error).join(" | ") : "Pictures could not be read"), { recovered: "partial", stage: "analyse", attempts: rec.attempts, note: rec.notes.join(" ") });
    } else {
      const tm = rec && rec.timing, tmNote = tm ? " [audio " + Math.round((tm.audioMs || 0) / 1000) + " s, pictures " + (tm.scan ? tm.scan.n + " samples, " + Math.round(((tm.scan.grabMs || 0) + (tm.scan.procMs || 0) + (tm.scan.readMs || 0)) / 1000) + " s busy" + (tm.scan.freezes ? ", " + tm.scan.freezes + " freeze(s)" : "") : "") + "]" : "";
      setAState("Analysis finished in " + fmt(v.an.seconds) + "." + tmNote + (failed.length ? " (fixed automatically - " + (rec.frameSource || "backup") + " reader used)" : ""), 1);
      // Something failed on the way but the self-healing code got through: tell the user, quietly.
      if (failed.length) reportProblem(new Error(failed[0].error || "Recovered"), { recovered: true, stage: "analyse", attempts: rec.attempts });
    }
    return true;
  } catch (err) {
    if (err.message === Engine.CANCEL) { setAState("Analysis cancelled.", 0); toast("Analysis cancelled."); }
    else {
      console.error(err); setAState("Analysis failed: " + err.message + " - a full report was opened.", 0, true);
      reportProblem(err, { recovered: false, stage: "analyse", attempts: err.attempts });
    }
    return false;
  } finally { setBusy(false); Compat.keepAwake(false); }
}

function makeClip(start, end, extra) {
  return Object.assign({ id: clipSeq++, start, end, label: "", auto: false, score: null, conf: null, reason: "Made by hand", kills: 0, rank: 0, events: [], out: null, status: "" }, extra || {});
}

// Turn the analysis into clips (instant - can be repeated when settings change).
/* LEARN FROM THE USER (v5.8): deleting an automatic clip = "this was NOT my kill" (its moment is skipped next time and the
   next-best moments show up instead); the "Correct" button = "this WAS my kill" (the clip is kept and never duplicated).
   If the user's choices say the name sits on the other side of the row, sideRule flips ("killer" is the normal case). */
function sideRuleFrom(fb) {
  // Only the "Correct" clicks can flip the rule (a deleted clip may be deleted for any reason, so it proves nothing about the side).
  let kill = 0, vic = 0;
  (fb.good || []).forEach((g) => { if (g.side === "killer") kill++; else if (g.side === "victim") vic++; });
  return vic >= 2 && vic > kill ? "victim" : "killer";
}
function applySuggestions(v) {
  if (!v || !v.an) return;
  const P = readParams();
  let found;
  if (P.method === "smart" || isHunt(P)) {
    v.fb = v.fb || { bad: [], good: [] };
    v.det = (isHunt(P) ? Hunter : Engine).detect(v.an, { profile: P.profile, sens: isHunt(P) ? Math.max(1, P.sens) : P.sens, gap: P.gap, exclude: v.fb.bad.map((b) => b.t), sideRule: sideRuleFrom(v.fb) });
    v.relaxed = 0;      // (an automatic "easier settings" retry was removed: wrong clips are worse than none)
    const maxLen = PLATFORMS[P.platform].max;
    found = Engine.buildClips(v.an, v.det, { maxLen, minLen: Math.min(10, maxLen), fixedLen: P.length || 0, pre: P.pre, post: P.post, count: P.count, snap: P.snap > 0 });
    // After the user removed clips: if fewer than the wanted number are left, look again with a more open mind (more sensitive) so DIFFERENT moments show up - they are marked REVIEW.
    if (v.fb.bad.length && found.length < P.count) {
      try {
        const det2 = (isHunt(P) ? Hunter : Engine).detect(v.an, { profile: P.profile, sens: Math.max(1, P.sens) * 1.6, gap: P.gap, exclude: v.fb.bad.map((b) => b.t), sideRule: sideRuleFrom(v.fb) });
        const more = Engine.buildClips(v.an, det2, { maxLen, minLen: Math.min(10, maxLen), fixedLen: P.length || 0, pre: P.pre, post: P.post, count: P.count, snap: P.snap > 0 });
        more.forEach((m) => { if (found.length < P.count && !found.some((f) => Math.min(f.end, m.end) - Math.max(f.start, m.start) > 0)) { m.events = (m.events || []).map((e) => Object.assign({}, e, { tier: "review" })); found.push(m); } });
      } catch (e) { console.warn("Second look failed:", e); }
    }
    // NEVER EMPTY: nothing confirmed -> still show the loudest gunfire moments, labelled "Maybe".
    v.fallback = false;
    if (!found.length && v.an.audioOk) { try { found = Engine.fallbackPicks(v.an, { length: P.length || 20, count: P.count, snap: P.snap }); v.fallback = found.length > 0; } catch (e) { console.warn("Fallback picks failed:", e); } }
  } else {
    v.fallback = false;
    v.det = null;
    found = Engine.classic(v.an, { focus: P.focus, length: P.length || 30, count: P.count, snap: P.snap });
  }
  // Remove the old automatic clips but keep the ones made or edited by hand (and the ones the user confirmed).
  v.clips = v.clips.filter((c) => { if (c.auto) { c.out && URL.revokeObjectURL(c.out.url); return false; } return true; });
  found = found.filter((f) => !v.clips.some((c) => Math.min(c.end, f.end) - Math.max(c.start, f.start) > 0.4 * (f.end - f.start)));   // never duplicate a clip that is already kept
  found.forEach((f) => v.clips.push(makeClip(f.start, f.end, {
    auto: true, score: f.score01, conf: f.conf, reason: f.why, kills: f.kills, rank: f.rank, events: f.events,
    // APPROVED = your name was found on the kill row; REVIEW = clue-only or sound-only guess (check it yourself first).
    tier: !f.fallback && f.events && f.events.some((e) => e.tier === "approved") ? "approved" : "review",
    label: f.label === "Moment" ? "Moment " + f.rank : f.label
  })));
  sortClips();
  if (cur === v) { renderClips(); drawTimeline(); drawLab(); renderEventTable(); updateAnState(); }
  renderLib(); renderStats();
}

function sortClips() {
  if (!cur) return;
  if (sortMode === "rank") cur.clips.sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.start - b.start);
  else cur.clips.sort((a, b) => a.start - b.start);
}

// The main button.
$("analyseBtn").addEventListener("click", async () => {
  if (!cur || analysing) return;
  const v = cur, P = readParams();
  if (!(await doAnalyse(v))) return;
  applySuggestions(v);
  const n = v.clips.filter((c) => c.auto).length;
  let st = v.det && v.det.stats, autoNote = v.an && v.an.auto ? (v.an.auto.ok ? " Your name was found automatically (" + v.an.auto.stats.learned.withGun + " matching kills)." : " Automatic name search did not work (" + v.an.auto.reason + "), so the clue method was used.") : "", why = st ? " Moments checked: " + st.candidates + (Object.keys(st.reasons).length ? " - rejected: " + Object.entries(st.reasons).map(([k, c]) => c + "x " + k).join("; ") : "") + "." : "";
  why += autoNote;
  const inc = v.an && v.an.incomplete ? " Time limit reached: " + Math.round(v.an.incomplete.fraction * 100) + "% of the planned pictures were read (strongest gunfire first) - press the button again to continue from where it stopped." : "";
  if (v.fallback) { setAState("No kill of yours could be CONFIRMED, so " + n + " 'Maybe' moment(s) were picked by sound (loudest gunfire). Please check them." + why + inc + " Tap Troubleshoot to see why.", 1); toast(n + " 'Maybe' moments added (sound only)."); $("sec-clips").scrollIntoView({ behavior: "smooth" }); return; }
  setAState(n ? "Found " + n + " clip(s) around kills (" + (P.method === "ai" ? "AI Referee: your kills only" : isHunt(P) ? "Main-player kills only" : P.method) + "). Scroll down to check them." + inc + (v.relaxed ? " (Nothing passed the strict test, so easier settings were used - please check each clip.)" : "") : "No kill of the main player was recognised (method: " + (P.method === "hunter" ? "Main-player kills only" : P.method) + ")." + why + " Try Sensitivity 1.5-2, Deep detail (10 fps), or check the kill-feed box with Calibrate.", 1);
  if (n) { toast("Found " + n + " highlight clip(s)."); $("sec-clips").scrollIntoView({ behavior: "smooth" }); }
});
$("cancelAnalyseBtn").addEventListener("click", () => { aCtl.cancel = true; });

// Changing these settings re-picks clips instantly (no new scan needed).
["lenSel", "customLen", "countSel", "preSel", "postSel", "gapSel", "sensSel", "platformSel", "snapSel", "focusSel"].forEach((id) => {
  let timer = null;
  $(id).addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { syncUI(); if (cur && cur.an) applySuggestions(cur); }, 250); });
});
["methodSel", "profileSel", "depthSel"].forEach((id) =>
  $(id).addEventListener("change", () => { syncUI(); updateAnState(); if (cur && cur.an && id !== "depthSel") { if (analysisKey(readParams()) === cur.anKey || readParams().method === "classic") applySuggestions(cur); } }));
["engineSel"].forEach((id) => $(id).addEventListener("change", syncUI));
$("lenSel").addEventListener("change", syncUI);

/* =====================================================================
   E. ANALYSIS LAB (the clue graph + the event table)
   ===================================================================== */
const LANES = [["killfeed", "Kill feed"], ["banner", "Banner"], ["hit", "Hit marker"], ["burst", "Gunfire"], ["boom", "Boom"], ["loud", "Loudness"], ["motion", "Motion"], ["flash", "Flash"], ["red", "Red damage"]];

function drawLab() {
  const c = $("labCanvas");
  if (!cur || !$("labBox").open || c.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const W = c.clientWidth, H = c.clientHeight;
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue("--muted").trim(), line = css.getPropertyValue("--line").trim(), accent2 = css.getPropertyValue("--accent2").trim();
  if (!cur.an) { g.fillStyle = muted; g.font = "13px system-ui"; g.fillText("Run 'Find my highlights' to fill this graph.", 12, 28); return; }

  const left = 82, laneH = (H - 6) / LANES.length, an = cur.an, n = an.N;
  LANES.forEach(([key, label], li) => {
    const y0 = li * laneH + 3, arr = an.ch[key];
    g.fillStyle = muted; g.font = "11px system-ui"; g.textBaseline = "middle"; g.fillText(label, 6, y0 + laneH / 2);
    g.strokeStyle = line; g.beginPath(); g.moveTo(left, y0 + laneH - 1); g.lineTo(W, y0 + laneH - 1); g.stroke();
    const active = an.hasVisual || ["burst", "boom", "loud"].includes(key);
    if (!arr || !active) return;
    g.beginPath(); g.moveTo(left, y0 + laneH - 2);
    const step = Math.max(1, Math.floor(n / (W - left)));
    for (let i = 0; i < n; i += step) {
      let m = 0; for (let k = i; k < Math.min(n, i + step); k++) if (arr[k] > m) m = arr[k];
      g.lineTo(left + (i / n) * (W - left), y0 + laneH - 2 - m * (laneH - 6));
    }
    g.lineTo(W, y0 + laneH - 2); g.closePath(); g.fillStyle = accent2 + "88"; g.fill();
  });
  if (cur.det) cur.det.events.forEach((e) => {
    const x = left + (e.t / cur.duration) * (W - left);
    g.strokeStyle = e.kind === "kill" ? "#ff4d6d" : e.kind === "peak" ? "#ffb84d" : "#8a93a8";
    g.lineWidth = e.kind === "feed" ? 1 : 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.lineWidth = 1;
  });
  cur.clips.forEach((cl) => { g.fillStyle = "rgba(61,220,151,.12)"; g.fillRect(left + (cl.start / cur.duration) * (W - left), 0, ((cl.end - cl.start) / cur.duration) * (W - left), H); });
  g.fillStyle = css.getPropertyValue("--text").trim();
  g.fillRect(left + ((player.currentTime || 0) / cur.duration) * (W - left) - 1, 0, 2, H);
}
$("labBox").addEventListener("toggle", () => setTimeout(drawLab, 20));
$("labCanvas").addEventListener("click", (e) => {
  if (!cur) return;
  const rect = e.currentTarget.getBoundingClientRect(), left = 82;
  player.currentTime = clamp(((e.clientX - rect.left - left) / (rect.width - left)) * cur.duration, 0, cur.duration);
  drawLab();
});
player.addEventListener("timeupdate", () => { if ($("labBox").open) drawLab(); });

function renderEventTable() {
  const box = $("eventTable");
  if (!cur || !cur.det || !cur.det.events.length) { box.innerHTML = cur && cur.an ? '<p class="muted small">No events found with the current settings.</p>' : ""; return; }
  box.innerHTML = '<table><thead><tr><th>Time</th><th>Type</th><th>Confidence</th><th>Why</th><th></th></tr></thead><tbody>' +
    cur.det.events.map((e, i) => `<tr><td>${fmt(e.t)}.${Math.round((e.t % 1) * 10)}</td><td>${e.kind === "kill" ? "Kill" : e.kind === "peak" ? "Intense moment" : "Feed only"}</td>
      <td>${Math.round(e.conf * 100)}%</td><td>${esc(e.why)}</td>
      <td><button class="ghost small" data-ev="jump" data-i="${i}">Jump</button> <button class="ghost small" data-ev="clip" data-i="${i}">Make clip</button></td></tr>`).join("") + "</tbody></table>";
}
$("eventTable").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ev]");
  if (!b || !cur) return;
  const ev = cur.det.events[+b.dataset.i];
  if (b.dataset.ev === "jump") { player.currentTime = Math.max(0, ev.t - 1); player.scrollIntoView({ behavior: "smooth", block: "center" }); }
  else {
    const P = readParams();
    cur.clips.push(makeClip(clamp(ev.t - P.pre, 0, cur.duration - 1), clamp(ev.t + P.post + 3, 1, cur.duration), { label: ev.kind === "kill" ? "Kill" : "Moment", reason: "From event table", conf: ev.conf }));
    sortClips(); renderClips(); drawTimeline(); renderLib(); renderStats(); toast("Clip added.");
  }
});

/* =====================================================================
   F. CLIPS (cards, editing, upload text)
   ===================================================================== */
const findClip = (id) => cur && cur.clips.find((c) => c.id === +id);

// Suggested title / description / hashtags for a clip. Plain templates (no AI), easy to edit.
function packFor(clip, v) {
  const game = $("gameName").value.trim() || "Gameplay", handle = $("handleName").value.trim();
  const secs = Math.round(clip.end - clip.start);
  const P = readParams(), prof = PROFILES[P.profile] || PROFILES.auto;
  const base = ["#" + slug(game).replace(/-/g, "")];
  const tagSets = { shooter: ["#gaming", "#gamer", "#fps", "#shooter", "#clutch", "#highlights", "#kills"], auto: ["#highlights", "#viral", "#trending"], action: ["#sports", "#highlights", "#viral"], talk: ["#podcast", "#clips", "#viral"] };
  const set = prof.feed ? tagSets.shooter : P.profile === "action" ? tagSets.action : P.profile === "talk" ? tagSets.talk : tagSets.auto;
  const lead = clip.kills >= 2 ? clip.label.toUpperCase() : clip.kills === 1 ? "Clean kill" : "Insane moment";
  const title = (lead + " in " + secs + "s | " + game + " #Shorts").slice(0, 100);
  const tags = [...base, ...set].join(" ");
  const yt = title + "\n\n" + lead + " in " + game + (handle ? " - by " + handle : "") + ".\nLike and subscribe for more!\n\n#Shorts " + tags;
  const ig = lead + " in " + game + "\n" + (handle ? "Follow " + handle + " for more\n" : "") + "\n#reels " + tags;
  return { title, yt, ig, tags };
}

function renderClips() {
  const list = $("clipList");
  list.innerHTML = "";
  if (!cur) return;
  $("noClips").hidden = cur.clips.length > 0;
  $("exportAllBtn").disabled = !cur.clips.length || exporting;
  if ($("joinBtn")) $("joinBtn").disabled = !cur.clips.length || exporting;
  $("clearClipsBtn").disabled = !cur.clips.length;
  const P = readParams();

  cur.clips.forEach((clip, i) => {
    if (!clip.label) clip.label = "Clip " + (i + 1);
    const el = document.createElement("div");
    el.className = "clip"; el.dataset.id = clip.id;
    el.innerHTML = `
      <div class="clip-head">
        <div class="row" style="align-items:center">
          <span class="rank ${clip.rank === 1 ? "top" : ""}">${clip.rank ? "#" + clip.rank : i + 1}</span>
          <strong data-role="title">${esc(clip.label)}</strong>
        </div>
        <div class="badges">
          ${clip.auto ? (clip.tier === "approved" ? `<span class="badge ok">APPROVED - your name</span>` : `<span class="badge hot">REVIEW REQUIRED</span>`) : ""}
          ${clip.kills ? `<span class="badge hot">${clip.kills} kill${clip.kills > 1 ? "s" : ""}</span>` : ""}
          <span class="badge">${esc(clip.reason)}</span>
          <span class="badge ok" data-role="fit"></span>
        </div>
      </div>
      ${clip.conf !== null ? `<div class="conf" title="Confidence ${Math.round(clip.conf * 100)}%"><div style="width:${Math.round(clip.conf * 100)}%"></div></div>` : ""}
      <div class="row">
        <div class="grow" style="flex:2 1 180px"><label>Clip name (used as the title if enabled)</label><input type="text" data-field="label" value="${esc(clip.label)}"></div>
        <div class="grow"><label>Start (s)</label><input type="number" step="0.1" min="0" data-field="start" value="${clip.start.toFixed(1)}"></div>
        <div class="grow"><label>End (s)</label><input type="number" step="0.1" min="0" data-field="end" value="${clip.end.toFixed(1)}"></div>
      </div>
      <div class="row">
        <button class="ghost small" data-act="startM">Start -0.5s</button>
        <button class="ghost small" data-act="startP">Start +0.5s</button>
        <button class="ghost small" data-act="endM">End -0.5s</button>
        <button class="ghost small" data-act="endP">End +0.5s</button>
        <button class="ghost small" data-act="setStart">Start = playhead</button>
        <button class="ghost small" data-act="setEnd">End = playhead</button>
      </div>
      <div class="row">
        <button class="ghost" data-act="preview">Preview</button>
        <button class="ghost" data-act="split">Split at playhead</button>
        <button class="ghost" data-act="dup">Duplicate</button>
        ${clip.auto ? `<button data-act="good" title="This IS my kill: keep it and learn from it">&#10003; Correct</button>` : ""}
        <button class="danger" data-act="del" title="Deleting an automatic clip tells the site it was NOT your kill - the next analysis shows different moments">Delete clip</button>
        <button data-act="export">Export clip</button>
      </div>
      <div data-role="result" class="muted small"></div>
      <div class="bar"><div data-role="bar"></div></div>
      <details class="pack"><summary>Upload pack (title, description, hashtags)</summary>
        <label>YouTube Shorts title + description</label><textarea data-pack="yt" rows="4"></textarea>
        <button class="ghost small" data-act="copyYt">Copy YouTube text</button>
        <label style="margin-top:8px">Instagram Reels caption</label><textarea data-pack="ig" rows="3"></textarea>
        <button class="ghost small" data-act="copyIg">Copy Instagram text</button>
      </details>`;
    list.appendChild(el);
    updateClipCard(clip);
  });
}

function updateClipCard(clip) {
  const el = $("clipList").querySelector(`.clip[data-id="${clip.id}"]`);
  if (!el) return;
  const set = (f, val) => { const i = el.querySelector(`[data-field="${f}"]`); if (i && document.activeElement !== i) i.value = val; };
  set("start", clip.start.toFixed(1)); set("end", clip.end.toFixed(1));
  const d = clip.end - clip.start, tags = [];
  if (d <= 60) tags.push("Shorts"); if (d <= 90) tags.push("Reels");
  el.querySelector('[data-role="fit"]').textContent = (tags.length ? "Fits " + tags.join(" + ") + " - " : "") + Math.round(d) + "s (" + fmt(clip.start) + " to " + fmt(clip.end) + ")";
  el.querySelector('[data-role="title"]').textContent = clip.label;
  const pk = packFor(clip, cur);
  const yt = el.querySelector('[data-pack="yt"]'), ig = el.querySelector('[data-pack="ig"]');
  if (yt && document.activeElement !== yt) yt.value = pk.yt;
  if (ig && document.activeElement !== ig) ig.value = pk.ig;
  const res = el.querySelector('[data-role="result"]');
  if (clip.out) {
    res.innerHTML = `<a class="dl" href="${clip.out.url}" download="${esc(clip.out.name)}">Download ${esc(clip.out.name)} (${(clip.out.size / 1048576).toFixed(1)} MB)</a>
      <button class="danger small" data-act="deldl">Delete exported file</button>` +
      (clip.out.ext === "webm" ? `<div class="hint">WebM file. If Instagram rejects it, use "Best quality" export (MP4) or convert it.</div>` : "");
  } else res.textContent = clip.status || "";
}

$("clipList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const clip = findClip(b.closest(".clip").dataset.id);
  if (!clip) return;
  const act = b.dataset.act;
  const edited = () => { clip.auto = false; fixClip(clip); updateClipCard(clip); drawTimeline(); drawLab(); };
  if (act === "startM") { clip.start -= 0.5; edited(); }
  else if (act === "startP") { clip.start += 0.5; edited(); }
  else if (act === "endM") { clip.end -= 0.5; edited(); }
  else if (act === "endP") { clip.end += 0.5; edited(); }
  else if (act === "setStart") { clip.start = player.currentTime; edited(); }
  else if (act === "setEnd") { clip.end = player.currentTime; edited(); }
  else if (act === "preview") previewRange(clip.start, clip.end);
  else if (act === "split") { if (!splitClip(clip, player.currentTime)) toast("Move the playhead inside this clip first.", true); }
  else if (act === "dup") {
    cur.clips.splice(cur.clips.indexOf(clip) + 1, 0, makeClip(clip.start, clip.end, { label: clip.label + " copy", reason: "Copy" }));
    renderClips(); drawTimeline(); renderLib(); renderStats();
  }
  else if (act === "del") deleteClip(clip);
  else if (act === "good") {       // "Correct": this is my kill - keep it, learn from it
    cur.fb = cur.fb || { bad: [], good: [] };
    (clip.events || []).filter((e) => e.kind === "kill").forEach((e) => cur.fb.good.push({ t: e.t, side: e.side || "" }));
    clip.auto = false; clip.tier = "approved"; clip.reason = "Confirmed by you"; updateClipCard(clip); toast("Thanks - kept, and the site learns from it.");
  }
  else if (act === "deldl") { URL.revokeObjectURL(clip.out.url); clip.out = null; clip.status = ""; updateClipCard(clip); renderStats(); }
  else if (act === "export") exportOne(clip);
  else if (act === "copyYt") copyText(packFor(clip, cur).yt);
  else if (act === "copyIg") copyText(packFor(clip, cur).ig);
});

$("clipList").addEventListener("change", (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  const clip = findClip(e.target.closest(".clip").dataset.id);
  if (!clip) return;
  if (f === "label") { clip.label = e.target.value.trim() || "Clip"; updateClipCard(clip); return; }
  clip[f] = parseFloat(e.target.value); clip.auto = false; fixClip(clip); updateClipCard(clip); drawTimeline(); drawLab();
});
$("clipList").addEventListener("input", (e) => {                       // edited upload text stays as typed
  if (e.target.dataset.pack) e.target.dataset.touched = "1";
});

function fixClip(c) {
  c.start = clamp(+c.start || 0, 0, cur.duration - 0.2);
  c.end = clamp(+c.end || 0, c.start + 0.2, cur.duration);
}

function splitClip(clip, t) {
  if (t < clip.start + 0.3 || t > clip.end - 0.3) return false;
  const second = makeClip(t, clip.end, { label: clip.label + " (2)", reason: "Split" });
  clip.end = t; clip.auto = false; clip.label = clip.label.replace(/ \(1\)$/, "") + " (1)";
  cur.clips.splice(cur.clips.indexOf(clip) + 1, 0, second);
  renderClips(); drawTimeline(); renderLib(); renderStats();
  return true;
}

function deleteClip(clip) {
  if (clip.auto && cur) {       // remember: "this was not my kill"
    cur.fb = cur.fb || { bad: [], good: [] };
    const evs = (clip.events || []).filter((e) => e.kind === "kill");
    (evs.length ? evs : [{ t: (clip.start + clip.end) / 2 }]).forEach((e) => cur.fb.bad.push({ t: e.t, side: e.side || "" }));
  }
  if (clip.out) URL.revokeObjectURL(clip.out.url);
  cur.clips.splice(cur.clips.indexOf(clip), 1);
  renderClips(); drawTimeline(); drawLab(); renderLib(); renderStats();
}

$("clearClipsBtn").addEventListener("click", () => {
  if (!cur || !cur.clips.length) return;
  if (exporting) { alert("Please wait for the export to finish."); return; }
  if (!confirm("Delete all " + cur.clips.length + " clips of this video?")) return;
  cur.clips.forEach((c) => c.out && URL.revokeObjectURL(c.out.url));
  cur.clips = [];
  renderClips(); drawTimeline(); drawLab(); renderLib(); renderStats();
});

$("sortRank").addEventListener("click", () => { sortMode = "rank"; store.set("sortMode", sortMode); sortClips(); renderClips(); });
$("sortTime").addEventListener("click", () => { sortMode = "time"; store.set("sortMode", sortMode); sortClips(); renderClips(); });

/* =====================================================================
   G. EXPORT
   ===================================================================== */
function setEStatus(text, p, err) {
  $("eStatus").textContent = text; $("eStatus").className = err ? "status err" : "status";
  if (p !== undefined) $("eBar").style.width = Math.round(p * 100) + "%";
}

function setExporting(on) {
  exporting = on; Compat.keepAwake(on);
  $("cancelBtn").hidden = !on;
  $("exportAllBtn").disabled = on || !(cur && cur.clips.length);
  if ($("joinBtn")) $("joinBtn").disabled = on || !(cur && cur.clips.length);
  document.querySelectorAll('[data-act="export"]').forEach((b) => (b.disabled = on));
  $("autoBtn").disabled = on || analysing;
}

// A safe file name: video name + rank + clip name.
function clipFileName(v, clip, ext) {
  const idx = v.clips.indexOf(clip) + 1;
  return slug(v.name.replace(/\.[^.]+$/, "")) + "_" + String(clip.rank || idx).padStart(2, "0") + "_" + slug(clip.label) + "." + ext;
}

// Make sure the video's stored file can still be read. If another window removed it, try to open it again from private
// storage; if it is truly gone, say so clearly (instead of 4 confusing retries).
async function ensureFile(v) {
  if (v.offloaded && !(await bringBack(v))) return false;
  if (await Compat.readable(v.file)) return true;
  if (v.copyName) {
    try {
      const f = await Compat.openCopy(v.copyName, { name: v.name, type: v.origType || v.file.type, lastModified: v.origModified || v.file.lastModified });
      if (await Compat.readable(f)) {
        v.file = f; try { Exporter.unmountVideo(v); } catch (e) { /* ignore */ }
        if (v.url) { URL.revokeObjectURL(v.url); v.url = URL.createObjectURL(f); }
        return true;
      }
    } catch (e) { /* gone */ }
  }
  return false;
}
const FILE_GONE = "The stored copy of this video is no longer available (another window of the site may have cleaned it, or the browser freed the space). Please add the video again.";

// Export ONE clip. Returns true when finished, false if cancelled or failed.
async function exportClip(v, clip, worker, quiet) {
  worker = worker || Exporter;
  const base = readExport();
  if (base.fit === "track" && !base.trackPrior) {       // PLAYER TRACKING start point: the AI looks at one frame (if connected), otherwise the screen centre
    base.trackPrior = { x: 0.5, y: 0.5 };
    if (typeof AI !== "undefined" && AI.connected()) {
      try { const pr = await Promise.race([AI.locatePlayer(v, (clip.start + clip.end) / 2), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000))]); if (pr) { base.trackPrior = pr; clip.trackNote = "AI found the player at " + Math.round(pr.x * 100) + "%, " + Math.round(pr.y * 100) + "% (" + (pr.view || "?") + " view)"; } }
      catch (e) { console.warn("AI player locator skipped:", e); }
    }
  }
  if (v.noPlay && (base.engine === "fast" || base.engine === "turbo")) base.engine = "hq";      // these two need a video the browser can play
  if (base.engine === "turbo" && !Exporter.turboAvailable()) base.engine = "hq";
  const card = $("clipList").querySelector(`.clip[data-id="${clip.id}"]`);
  const barEl = card && card.querySelector('[data-role="bar"]');
  const say = (t) => { clip.status = t; if (!clip.out) updateClipCard(clip); if (!quiet) setEStatus(t); };
  if (base.engine === "cloud") base.engine = Exporter.turboAvailable() && !v.noPlay ? "turbo" : "hq";     // server unavailable or not used: render here
  if (clip.out) { URL.revokeObjectURL(clip.out.url); clip.out = null; }
  if (barEl) barEl.style.width = "0%";
  say("Preparing...");
  if (!(await ensureFile(v))) {
    clip.status = "Failed: " + FILE_GONE; setEStatus(FILE_GONE, 0, true); updateClipCard(clip);
    reportProblem(new Error(FILE_GONE), { recovered: false, stage: "export", note: "The stored video file could not be read before export started." });
    return false;
  }

  // SELF-HEALING EXPORT: if the chosen settings fail, we try simpler recipes one after another.
  // Recipe 0 is exactly what the user chose. Later ones drop risky extras (title picture, loudness,
  // speed change), then lower the resolution, then switch engine.
  const recipes = [{ name: "your settings", o: base }];
  if (base.engine === "turbo") {
    recipes.push({ name: "turbo, simple options (HD 720, no title / fades / speed change)", o: Object.assign({}, base, { preset: "quick", res: "720", title: false, fade: 0, speed: 1, loud: false }) });
    recipes.push({ name: "ffmpeg engine, quick preset, 540p", o: Object.assign({}, base, { engine: "hq", preset: "quick", res: "540", fps: "30", title: false, loud: false, fade: 0, speed: 1 }) });
    recipes.push({ name: "lossless cut (original shape)", o: Object.assign({}, base, { engine: "copy" }) });
  } else if (base.engine === "hq") {
    recipes.push({ name: "simple options (no title / loudness / fades, quick preset)", o: Object.assign({}, base, { preset: "quick", title: false, loud: false, fade: 0, speed: 1 }) });
    recipes.push({ name: "low resolution (540p, 30 fps, quick preset)", o: Object.assign({}, base, { preset: "quick", title: false, loud: false, fade: 0, speed: 1, res: "540", fps: "30" }) });
    recipes.push({ name: "lossless cut (original shape)", o: Object.assign({}, base, { engine: "copy" }) });
  } else if (base.engine === "fast") {
    recipes.push({ name: "best-quality engine, quick preset", o: Object.assign({}, base, { engine: "hq", preset: "quick", title: false, loud: false }) });
    recipes.push({ name: "lossless cut (original shape)", o: Object.assign({}, base, { engine: "copy" }) });
  }
  const attempts = [];
  for (let k = 0; k < recipes.length; k++) {
    const rcp = recipes[k], s0 = performance.now();
    try {
      if (k > 0) { say("Retrying with " + rcp.name + "..."); try { worker.cancel(); } catch (e) { /* reset the engine */ } eCtl.cancel = false; }
      const r = await worker.exportClip(v, clip, rcp.o, {
        ctl: eCtl, hiddenVideo: $("exportVideo"),
        status: say,
        progress: (f, eta) => { if (barEl) barEl.style.width = Math.round(f * 100) + "%"; if (!quiet) $("eBar").style.width = Math.round(f * 100) + "%"; if (eta > 2 && !quiet) setEStatus((clip.status || "").split("  (")[0] + "  (about " + fmt(eta) + " left)"); }
      });
      clip.out = { url: URL.createObjectURL(r.blob), name: clipFileName(v, clip, r.ext), size: r.blob.size, ext: r.ext, saved: "" };
      if (Cloud.profile().loggedIn) Cloud.putClip(v, clip, r.blob);          // keep a copy of the finished Short on the profile's server (best effort)
      if (r.info) console.log("Turbo export finished:", JSON.stringify(r.info));
      if (v.copyName) { const sn = v.copyName + "_c" + clip.id + "." + r.ext; Persist.saveExport(sn, r.blob).then(() => { if (clip.out) clip.out.saved = sn; }).catch((e) => console.warn("Could not keep the export for later:", errText(e))); }
      if (barEl) barEl.style.width = "100%";
      updateClipCard(clip); renderStats();
      if (k > 0) {
        attempts.push({ step: "export", strategy: rcp.name, ok: true, ms: Math.round(performance.now() - s0) });
        clip.status = "Done with " + rcp.name + " (your settings failed).";
        reportProblem(new Error(attempts[0].error), { recovered: k === recipes.length - 1 && rcp.o.engine === "copy" ? "partial" : true, stage: "export", attempts, note: "Exported with: " + rcp.name });
        updateClipCard(clip);
      }
      return true;
    } catch (err) {
      if (err.message === "cancelled" || (eCtl && eCtl.cancel)) { clip.status = "Cancelled."; setEStatus("Export cancelled.", 0); updateClipCard(clip); if (barEl) barEl.style.width = "0%"; return false; }
      console.error(err);
      attempts.push({ step: "export", strategy: rcp.name, ok: false, error: errText(err), ms: Math.round(performance.now() - s0) });
      // A reclaimed / closed / stalled encoder is a hiccup, not a bad setting: try the SAME settings once more (fresh encoder) before simplifying.
      if (!rcp.again && /Codec reclaimed|closed codec|stalled/i.test(errText(err))) {
        rcp.again = true; say("The video encoder was interrupted - trying again with the same settings...");
        try { worker.cancel(); } catch (e) { /* reset the engine */ } eCtl.cancel = false;
        await new Promise((r) => setTimeout(r, 1500)); k--; continue;
      }
      if (/NotFoundError|NotReadableError|could not be found/i.test(errText(err))) { k = recipes.length - 1; err = new Error(FILE_GONE + " (" + errText(err) + ")"); }      // retrying with other settings cannot help
      if (k === recipes.length - 1) {
        clip.status = "Failed: " + errText(err); setEStatus("Export failed: " + errText(err) + " - a full report was opened.", 0, true);
        updateClipCard(clip); if (barEl) barEl.style.width = "0%";
        reportProblem(err, { recovered: false, stage: "export", attempts });
        return false;
      }
    }
  }
  return false;
}

async function exportOne(clip) {
  if (exporting) return;
  const v = cur;
  if (readExport().engine === "cloud" && Cloud.enabled()) { const n = await exportCloud(v, [clip]); if (n) toast("Clip rendered on your server."); return; }
  eCtl = { cancel: false };
  setExporting(true);
  const ok = await exportClip(v, clip);
  setExporting(false);
  if (ok) { setEStatus("Export finished. Download it from the clip card.", 1); toast("Clip exported."); }
}

/* ---------- CLOUD SERVER EXPORT (js/cloud.js + /server) ---------- */
function refreshCloudUI() {
  const on = Cloud.enabled() && Cloud.canRender(), sel = $("engineSel");      // a storage-only server (Cloudflare R2) cannot render, so the "Cloud server" export choice is hidden
  let opt = sel.querySelector('option[value="cloud"]');
  if (on && !opt) { opt = document.createElement("option"); opt.value = "cloud"; opt.textContent = "Cloud server - renders on your server, keeps going if you close the page"; sel.appendChild(opt); }
  if (!on && opt) { if (sel.value === "cloud") sel.value = Exporter.turboAvailable() ? "turbo" : "hq"; opt.remove(); }
  $("cloudDot").hidden = !Cloud.enabled();
  syncUI();
}

// Keep asking the server about this video's clips; download each one as soon as it is finished.
async function pollCloud(v, ui) {
  if (v.polling) return;
  v.polling = true;
  try {
    while (!v.deleted && v.remote && v.remote.pending && v.remote.pending.length && !(ui && eCtl.cancel)) {
      let st;
      try { st = await Cloud.jobs(v); }
      catch (e) { if (e.status === 404) { v.remote = null; throw new Error("The server no longer has this video (it may have been cleared)."); } throw e; }
      for (const id of [...v.remote.pending]) {
        const clip = v.clips.find((c) => c.id === id), j = st.jobs[id];
        if (!clip) { v.remote.pending = v.remote.pending.filter((x) => x !== id); continue; }
        const card = $("clipList").querySelector(`.clip[data-id="${clip.id}"]`), bar = card && card.querySelector('[data-role="bar"]');
        if (!j || j.status === "cancelled") { clip.status = "Cancelled on the server."; v.remote.pending = v.remote.pending.filter((x) => x !== id); updateClipCard(clip); continue; }
        if (j.status === "error") { clip.status = "Server error: " + j.error; v.remote.pending = v.remote.pending.filter((x) => x !== id); updateClipCard(clip); reportProblem(new Error(j.error), { recovered: false, stage: "cloud render", extra: { "Clip": clip.label || clip.id } }); continue; }
        if (j.status === "done") {
          clip.status = "Downloading from the server...";
          const blob = await Cloud.download(v, String(id), j.size, (f) => { if (bar) bar.style.width = Math.round(f * 100) + "%"; });
          if (clip.out) URL.revokeObjectURL(clip.out.url);
          clip.out = { url: URL.createObjectURL(blob), name: clipFileName(v, clip, "mp4"), size: blob.size, ext: "mp4", saved: "" };
          if (v.copyName) { const sn = v.copyName + "_c" + clip.id + ".mp4"; Persist.saveExport(sn, blob).then(() => { if (clip.out) clip.out.saved = sn; }).catch(() => {}); }
          clip.status = "Done (rendered on your server)."; v.remote.pending = v.remote.pending.filter((x) => x !== id);
          if (bar) bar.style.width = "100%"; updateClipCard(clip); renderStats();
          continue;
        }
        clip.status = j.status === "running" ? "Rendering on your server... " + Math.round((j.progress || 0) * 100) + "%" : "Waiting in the server queue...";
        if (bar && j.status === "running") bar.style.width = Math.round((j.progress || 0) * 100) + "%";
        updateClipCard(clip);
      }
      if (ui) { const left = v.remote.pending.length; setEStatus("Server is rendering. " + left + " clip(s) left. You can close this page; reopen it later and the finished clips download by themselves.", 0.5); }
      if (v.remote.pending.length) await new Promise((r) => setTimeout(r, 2500));
    }
  } finally { v.polling = false; }
}

async function exportCloud(v, list) {
  eCtl = { cancel: false };
  setExporting(true);
  const o = readExport(); o.engine = "cloud";
  let done = 0;
  try {
    if (!(await ensureFile(v))) throw new Error(FILE_GONE);
    // 1. send the video (only the first time; later exports reuse it)
    if (!(v.remote && v.remote.complete)) setEStatus("Sending " + v.name + " to your server...", 0);
    await Cloud.upload(v, (f, eta) => setEStatus("Sending " + v.name + " to your server... " + Math.round(f * 100) + "%" + (eta > 3 ? " (about " + fmt(eta) + " left)" : ""), f * 0.5), eCtl);
    // 2. ask for the clips
    list.forEach((c) => { if (c.out) { URL.revokeObjectURL(c.out.url); c.out = null; } c.status = "Waiting in the server queue..."; updateClipCard(c); });
    await Cloud.submit(v, list, o);
    v.remote.pending = list.map((c) => c.id);
    // 3. wait + download
    await pollCloud(v, true);
    done = list.filter((c) => c.out).length;
    if (eCtl.cancel) { try { await Cloud.cancelJobs(v); } catch (e) { /* ignore */ } if (v.remote) v.remote.pending = []; setEStatus("Cancelled.", 0); }
    else setEStatus(done + " of " + list.length + " clips rendered on your server and downloaded.", 1);
  } catch (err) {
    if (err.message === "cancelled" || eCtl.cancel) { setEStatus("Cancelled.", 0); setExporting(false); return done; }
    // FALLBACK: never leave the user stuck. Render the unfinished clips on this device.
    console.error(err);
    const rest = list.filter((c) => !c.out);
    reportProblem(err, { recovered: "partial", stage: "cloud export", note: "The server could not finish. The remaining " + rest.length + " clip(s) were rendered on this device instead." });
    toast("Server problem: " + errText(err) + " Rendering on this device instead.", true);
    if (v.remote) v.remote.pending = [];
    for (const c of rest) { if (v.deleted || eCtl.cancel) break; if (await exportClip(v, c, null, false)) done++; }
    setEStatus(done + " of " + list.length + " clips exported (some on this device).", 1);
  }
  setExporting(false);
  return done;
}

// How many clips can be exported at the same time on THIS device (each needs its own ffmpeg engine).
function exportWorkers(n) {
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
  let k = Math.floor(cores / 3);                    // keep cores free for the page itself
  if (mem <= 4) k = Math.min(k, 2);
  if (mem <= 2) k = 1;
  return Math.max(1, Math.min(3, k, n));
}
const allWorkers = [];                              // every extra export engine we started

// autoOnly === true (Auto-make / join): skip REVIEW clips unless the "include review" box is ticked. The plain button exports everything.
let forceReview = false;   // set by Auto-make when NOTHING could be approved, so the user still gets output (clearly marked REVIEW)
const wantClip = (c, autoOnly) => !autoOnly || c.tier !== "review" || forceReview || ($("autoReview") && $("autoReview").checked);
async function exportAll(autoOnly) {
  if (exporting || !cur || !cur.clips.length) return 0;
  const v = cur, list = v.clips.filter((c) => wantClip(c, autoOnly === true));
  if (!list.length) return 0;
  if (readExport().engine === "cloud" && Cloud.enabled()) return exportCloud(v, list);
  eCtl = { cancel: false };
  setExporting(true);
  const base = readExport();
  let par = 1;       // ffmpeg engine: several engines at once; turbo: two hardware encoders at once on strong devices; others: one
  if (base.engine === "hq") par = exportWorkers(list.length);
  // NOTE (v5.5.1): turbo exports run ONE AT A TIME. Two hardware encoders + two playing videos made Chrome reclaim an encoder ("Codec reclaimed due to inactivity") and stall for minutes.
  const pool = [Exporter];
  while (pool.length < par) { const w = Exporter.spawn(); allWorkers.push(w); pool.push(w); }
  let done = 0, finished = 0, next = 0;
  const upd = () => setEStatus((par > 1 ? "Exporting " + par + " clips at once. " : "Exporting. ") + finished + " of " + list.length + " finished...", finished / list.length);
  upd();
  await Promise.all(pool.map(async (w) => {
    while (next < list.length && !v.deleted && !eCtl.cancel) {
      const clip = list[next++];
      const ok = await exportClip(v, clip, w, par > 1);
      finished++; if (ok) done++; upd();
    }
  }));
  // Free the extra engines (they hold memory).
  allWorkers.splice(0).forEach((w) => { try { w.cancel(); } catch (e) { /* ignore */ } });
  setExporting(false);
  setEStatus(eCtl.cancel ? "Export cancelled." : done + " of " + list.length + " clips exported. Download them from the cards or as a ZIP.", eCtl.cancel ? 0 : 1);
  return done;
}

$("exportAllBtn").addEventListener("click", exportAll);

/* ONE SHORT WITH ALL KILLS (v5.6): export the clips that are not finished yet, then glue every clip together in the
   order the kills happened (Exporter.joinClips, no re-encoding). The result gets a download link under the export buttons. */
async function joinAll() {
  if (exporting || !cur || !cur.clips.length) return false;
  const v = cur, list = v.clips.filter((c) => wantClip(c, true)).sort((a, b) => a.start - b.start);
  if (!list.length) { setEStatus("Nothing is APPROVED yet (only REVIEW clips). Check them, or tick 'include REVIEW moments'.", 0, true); return false; }
  if (list.some((c) => !c.out)) { const n = await exportAll(true); if (!n && list.some((c) => !c.out)) return false; }
  const ready = list.filter((c) => c.out);
  if (!ready.length) return false;
  const total = ready.reduce((s, c) => s + (c.end - c.start), 0);
  try {
    setEStatus("Joining " + ready.length + " clip(s) into one Short...", 0.5);
    const blobs = []; for (const c of ready) blobs.push(await (await fetch(c.out.url)).blob());
    const blob = await Exporter.joinClips(blobs, (t) => setEStatus(t, 0.7));
    if (v.joined && v.joined.url) URL.revokeObjectURL(v.joined.url);
    const name = slug(v.name.replace(/\.[^.]+$/, "")) + "_ALL-KILLS.mp4";
    v.joined = { url: URL.createObjectURL(blob), name, size: blob.size, clips: ready.length };
    const box = $("joinOut"); box.textContent = "";
    const a = document.createElement("a"); a.href = v.joined.url; a.download = name; a.textContent = "Download: " + name + " (" + (blob.size / 1048576).toFixed(1) + " MB, about " + fmt(total) + ", " + ready.length + " clip(s))";
    box.appendChild(a);
    if (total > 180) box.appendChild(document.createTextNode("  - longer than 3 minutes: too long for a Short. Lower the clip count / length and run it again."));
    setEStatus("One Short with all your kills is ready.", 1);
    return true;
  } catch (err) { setEStatus("Could not join the clips: " + errText(err), 0, true); reportProblem(err, { recovered: false, stage: "join" }); return false; }
}
$("joinBtn").addEventListener("click", joinAll);

/* CLIP REPORT (from the editing spec): a Markdown file with every clip - decision, times, event type, evidence, file name,
   caption + hashtags - and a separate list of REJECTED moments with the reason. Download it from the button. */
function clipReportText(v) {
  const hms = (t) => { t = Math.max(0, Math.round(t)); return String(Math.floor(t / 3600)).padStart(2, "0") + ":" + String(Math.floor(t / 60) % 60).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
  const tags = /pubg/i.test(readParams().profile || "") ? "#PUBG #PUBGMobile #PUBGClips #GamingReels" : "#Valorant #ValorantClips #GamingReels #FPSGaming";
  const sorted = [...v.clips].sort((a, b) => a.start - b.start), L = [];
  L.push("# ClipCutter clip report", "", "Video: " + v.name + "  |  App " + (window.Diag && Diag.APP_VERSION || ""), "");
  L.push("## Approved (your name matched on the kill row)", "", "| Clip | Start | End | Length | Event | Evidence | File | Caption |", "|---|---|---|---|---|---|---|---|");
  const row = (c, i) => "| " + String(i + 1).padStart(3, "0") + " | " + hms(c.start) + " | " + hms(c.end) + " | " + Math.round(c.end - c.start) + " s | " + (c.label || "") + " | " + String(c.reason || "").replace(/\|/g, "/") + " | " + clipFileName(v, c, "mp4") + " | " + (c.kills > 1 ? c.label : "Clean kill") + " by the main player. " + tags + " |";
  sorted.filter((c) => c.tier === "approved" || !c.auto).forEach((c, i) => L.push(row(c, i)));
  L.push("", "## REVIEW_REQUIRED (could not prove it is your kill - check by eye)", "", "| Clip | Start | End | Length | Event | Why uncertain | File | Caption |", "|---|---|---|---|---|---|---|---|");
  sorted.filter((c) => c.auto && c.tier === "review").forEach((c, i) => L.push(row(c, i)));
  const rej = (v.an && v.an.decisions || []).filter((d) => !d.ok);
  L.push("", "## Rejected / excluded moments (" + rej.length + ")", "");
  rej.slice(0, 200).forEach((d) => L.push("- " + hms(d.t) + " (" + d.t.toFixed(1) + " s): " + d.why));
  L.push("", "## Summary", "", "- Approved: " + sorted.filter((c) => c.tier === "approved" || !c.auto).length, "- Review required: " + sorted.filter((c) => c.auto && c.tier === "review").length, "- Rejected: " + rej.length);
  return L.join("\n");
}
$("clipReportBtn").addEventListener("click", () => {
  if (!cur || !cur.clips.length) { toast("Find highlights first.", true); return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([clipReportText(cur)], { type: "text/markdown" })); a.download = slug(cur.name.replace(/\.[^.]+$/, "")) + "_clip-report.md";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});
$("cancelBtn").addEventListener("click", () => { eCtl.cancel = true; Exporter.cancel(); allWorkers.forEach((w) => { try { w.cancel(); } catch (e) { /* ignore */ } }); });

$("zipBtn").addEventListener("click", async () => {
  const files = [];
  lib.forEach((v) => v.clips.forEach((c) => { if (c.out) files.push({ name: c.out.name, blob: null, clip: c }); }));
  if (!files.length) { toast("Export some clips first.", true); return; }
  setEStatus("Packing " + files.length + " file(s) into a ZIP...");
  try {
    for (const f of files) f.blob = await (await fetch(f.clip.out.url)).blob();
    const blob = await Exporter.makeZip(files.map((f) => ({ name: f.name, blob: f.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "clipcutter-shorts.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    setEStatus("ZIP ready (" + (blob.size / 1048576).toFixed(1) + " MB).", 1);
  } catch (err) { setEStatus("Could not make the ZIP: " + err.message, 0, true); }
});

$("packBtn").addEventListener("click", () => {
  const parts = [];
  lib.forEach((v) => v.clips.forEach((c) => { const p = packFor(c, v); parts.push("=== " + clipFileName(v, c, "mp4") + " ===\n" + p.yt + "\n\n--- Instagram ---\n" + p.ig); }));
  copyText(parts.join("\n\n\n"));
});

// ONE-CLICK: analyse -> pick clips -> export every clip.
$("autoBtn").addEventListener("click", async () => {
  if (!cur || analysing || exporting) return;
  const v = cur;
  if (!(await doAnalyse(v))) return;
  applySuggestions(v);
  if (!v.clips.length) { setAState("No highlights found, so nothing to export. Try another video type or a higher sensitivity.", 1, true); return; }
  setAState("Found " + v.clips.filter((c) => c.auto).length + " highlight(s). Exporting them now...", 1);
  $("sec-clips").scrollIntoView({ behavior: "smooth" });
  forceReview = !v.clips.some((c) => c.tier === "approved");
  if (forceReview) setAState("Your name could not be proven on any kill row, so every moment is marked REVIEW REQUIRED. Exporting them anyway - please check each one before posting.", 1);
  let n = 0; try { n = await exportAll(true); } finally { /* keep forceReview until the join below */ }
  if (!n) { forceReview = false; setAState("Nothing was exported. Check the clips below.", 1, true); return; }
  if (n && $("autoJoin") && $("autoJoin").checked && n > 1) await joinAll();
  forceReview = false;
  if (n) toast("Done! " + n + " Short(s) ready to download.");
});

/* =====================================================================
   H. CALIBRATE (draw the kill-feed box on a real frame of your game)
   ===================================================================== */
const ROLE_COLORS = { killfeed: "#ff4d6d", banner: "#ffb84d", hit: "#4dabff" };
let calRegions = null, calDrag = null;

function calCanvasSize() {
  const c = $("calCanvas"), vw = player.videoWidth || 16, vh = player.videoHeight || 9;
  const W = Math.min(780, Math.max(300, c.parentElement.clientWidth - 32));
  c.width = Math.round(W); c.height = Math.round((W * vh) / vw);
}
function drawCal() {
  const c = $("calCanvas"), g = c.getContext("2d");
  calCanvasSize();
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  try { if (player.readyState >= 2) g.drawImage(player, 0, 0, c.width, c.height); } catch (e) { /* no frame yet */ }
  Object.keys(calRegions).forEach((k) => {
    const r = calRegions[k];
    g.strokeStyle = ROLE_COLORS[k]; g.lineWidth = 2; g.fillStyle = ROLE_COLORS[k] + "33";
    g.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
    g.strokeRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
    g.fillStyle = ROLE_COLORS[k]; g.font = "bold 12px system-ui"; g.fillText({ killfeed: "Kill feed", banner: "Banner", hit: "Hit marker" }[k], r.x * c.width + 4, r.y * c.height + 14);
  });
}
$("proxyBtn").addEventListener("click", async () => {
  const v = cur; if (!v || analysing || exporting) return;
  $("proxyBtn").disabled = true; Compat.keepAwake(true);
  try {
    const f = await Exporter.makeProxy(v, (p, eta) => setStatus("Making a preview copy... " + Math.round(p * 100) + "%" + (eta > 2 ? " (about " + fmt(eta) + " left)" : ""), p), (t) => setStatus(t, 0));
    v.previewUrl = URL.createObjectURL(f); if (cur === v) selectVideo(v);
    setStatus("Preview copy ready (small size, only for watching; analysis and export still use your original).", 1);
  } catch (e) { setStatus("Preview copy failed: " + errText(e), 0, true); reportProblem(e, { recovered: false, stage: "preview copy" }); $("proxyBtn").disabled = false; }
  finally { Compat.keepAwake(false); $("proxyBtn").disabled = false; }
});

$("calBtn").addEventListener("click", () => {
  if (cur && cur.noPlay && !cur.previewUrl) { toast("Make the preview copy first (button under the player) so the picture can be shown here.", true); return; }
  if (!cur) return;
  const P = readParams();
  if (!PROFILES[P.profile].feed) { toast("Pick a shooter profile first (kill feed top-right / left / bottom-left).", true); return; }
  calRegions = JSON.parse(JSON.stringify(getRegions(P.profile)));
  $("calDlg").showModal();
  setTimeout(drawCal, 30);
});
$("calCanvas").addEventListener("pointerdown", (e) => {
  const c = e.currentTarget, rect = c.getBoundingClientRect();
  c.setPointerCapture(e.pointerId);
  const role = document.querySelector('input[name="calRole"]:checked').value;
  calDrag = { role, x0: (e.clientX - rect.left) / rect.width, y0: (e.clientY - rect.top) / rect.height };
});
$("calCanvas").addEventListener("pointermove", (e) => {
  if (!calDrag) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x1 = clamp((e.clientX - rect.left) / rect.width, 0, 1), y1 = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  const x = clamp(Math.min(calDrag.x0, x1), 0, 1), y = clamp(Math.min(calDrag.y0, y1), 0, 1);
  calRegions[calDrag.role] = { x, y, w: Math.max(0.02, Math.abs(x1 - calDrag.x0)), h: Math.max(0.02, Math.abs(y1 - calDrag.y0)) };
  drawCal();
});
["pointerup", "pointercancel"].forEach((n) => $("calCanvas").addEventListener(n, () => (calDrag = null)));
$("calRefresh").addEventListener("click", drawCal);
// The slider moves the video, then the picture in the dialog is redrawn from that frame.
$("calSeek").addEventListener("input", () => {
  if (!cur) return;
  const t = ($("calSeek").value / 1000) * cur.duration;
  player.addEventListener("seeked", drawCal, { once: true });
  player.currentTime = t;
});
$("calClose").addEventListener("click", () => $("calDlg").close());
$("calSave").addEventListener("click", () => {
  const P = readParams();
  store.set("regions." + P.profile, calRegions);
  $("calDlg").close(); updateAnState();
  toast("Boxes saved. Run the analysis again to use them.");
});
$("calReset").addEventListener("click", () => {
  const P = readParams();
  store.set("regions." + P.profile, null);
  calRegions = JSON.parse(JSON.stringify(PROFILES[P.profile].regions));
  drawCal(); updateAnState();
});

/* =====================================================================
   I. APP EXTRAS (theme, install button, offline mode, safety)
   ===================================================================== */
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "light" ? "#f4f6fb" : "#0b0d12"; }
applyTheme(store.get("theme", "dark"));
$("themeBtn").addEventListener("click", () => {
  const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  store.set("theme", t); applyTheme(t); drawTimeline(); drawLab();
});

let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $("installBtn").hidden = false; });
$("installBtn").addEventListener("click", async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $("installBtn").hidden = true; });

// Works offline after the first visit (the service worker keeps a copy of the site files).
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker not registered:", e));
}

// Warn before closing the tab while an export or analysis is running.
window.addEventListener("beforeunload", (e) => { if (exporting || analysing) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- LIBRARY MEMORY (js/persist.js) ----------
   Every few seconds, changed videos are saved (name, clips, trim points...). When the page opens again
   the library comes back by itself, with the clips and the finished files. */
const savedJson = new Map();                         // copyName -> last saved JSON (to skip unchanged ones)
function snapshotVideo(v) {
  return {
    key: v.copyName, offloaded: !!v.offloaded, name: v.name, type: v.origType || v.file.type || "video/mp4", size: sizeOf(v), lastModified: v.origModified || v.file.lastModified,
    duration: v.duration, w: v.w, h: v.h, noPlay: v.noPlay, codec: v.codec, thumb: v.thumb, inT: v.inT, outT: v.outT,
    remote: v.remote ? { id: v.remote.id, complete: !!v.remote.complete, pending: v.remote.pending || [] } : null,
    fb: v.fb || { bad: [], good: [] },
    clips: v.clips.map((c) => { const o = Object.assign({}, c); delete o.out; delete o.status; return o; }),
    outs: v.clips.filter((c) => c.out && c.out.saved).map((c) => ({ id: c.id, file: c.out.saved, name: c.out.name, size: c.out.size, ext: c.out.ext }))
  };
}
setInterval(() => {
  lib.forEach((v) => {
    if (!v.copyName || v.deleted) return;
    try {
      const rec = snapshotVideo(v), j = JSON.stringify(rec);
      if (savedJson.get(v.copyName) !== j) { savedJson.set(v.copyName, j); Persist.put(rec).catch((e) => console.warn("Could not save the library:", errText(e))); }
    } catch (e) { /* ignore */ }
  });
}, 3000);


/* =====================================================================
   SERVER SYNC (v5.3): move a video to the server and free this device, bring it back when needed,
   keep the editing state (clips, trim points) on the server, and rebuild the library from the server
   when this browser's data was cleared.
   WHY: phones have little space; the server (your own Cloudflare R2) has plenty. The local IndexedDB/OPFS
   copy still works as before, the server is a second, safer place.
   HOW TO IMPROVE: sync the finished Shorts back too, download in the background while you watch.
   ===================================================================== */
let lastActivity = Date.now();
["pointerdown", "keydown", "touchstart"].forEach((e) => window.addEventListener(e, () => { lastActivity = Date.now(); }, { passive: true }));

// Remove this device's copy of a video that is complete on the server.
async function offloadVideo(v) {
  if (!v || v.offloaded || !(v.remote && v.remote.complete)) return false;
  try {
    const st = await Cloud.status(v);                                        // make sure the server really has all of it
    if (!st.complete) return false;
  } catch (e) { return false; }
  const old = v.copyName, size = v.file.size;
  try { Exporter.unmountVideo(v); } catch (e) { /* ignore */ }
  if (v.url) { URL.revokeObjectURL(v.url); v.url = ""; }
  if (v.previewUrl) { URL.revokeObjectURL(v.previewUrl); v.previewUrl = ""; }
  v.sizeBytes = size; v.offloaded = true; v.copyHow = "on your server";
  v.file = new File([""], v.name, { type: v.origType || "video/mp4" });
  v.an = v.an;                                                               // the analysis stays in memory: it is small
  v.copyName = "off-" + v.remote.id;                                         // set FIRST, so the autosave cannot re-create the old record
  if (old) { await Persist.del(old).catch(() => {}); await Compat.removeCopy(old); }
  if (cur === v) { player.removeAttribute("src"); player.load(); }
  renderLib(); toast(v.name + ": the copy on this device was removed (it is safe on your server).");
  return true;
}

// Download an offloaded video from the server and store it on this device again. Returns true on success.
function bringBack(v) {
  if (!v.offloaded) return Promise.resolve(true);
  if (v.bringing) return v.bringing;
  v.bringing = (async () => {
    try {
      if (!Cloud.enabled()) throw new Error("This video is only on your server. Open Profile and log in again to bring it back.");
      const blob = await Cloud.fetchBlob("/api/videos/" + v.remote.id + "/file", (f) => setStatus("Bringing " + v.name + " back from your server... " + Math.round(f * 100) + "%", f));
      const file = new File([blob], v.name, { type: v.origType || "video/mp4" });
      const c = await Compat.stableCopy(file, (f) => setStatus("Saving " + v.name + " on this device... " + Math.round(f * 100) + "%", f));
      const old = v.copyName;
      v.file = c.file; v.copyHow = c.how; v.cleanup = c.cleanup; v.copyName = c.name || ""; v.sizeBytes = 0; v.offloaded = false;
      if (old && old !== v.copyName) Persist.del(old).catch(() => {});
      if (!v.noPlay) v.url = URL.createObjectURL(v.file);
      lastActivity = Date.now();
      setStatus(v.name + " is back on this device.", 0); renderLib();
      return true;
    } catch (e) { setStatus("Could not bring the video back: " + errText(e), 0, true); return false; }
    finally { v.bringing = null; }
  })();
  return v.bringing;
}

// Every 20 s: videos that are safely on the server and not in use are removed from this device (if the user wants that).
setInterval(() => {
  if (!Cloud.enabled() || Cloud.getConfig().offload === false || analysing || exporting) return;
  for (const v of lib) {
    if (v.offloaded || v.deleted || !(v.remote && v.remote.complete)) continue;
    if (v === cur && Date.now() - lastActivity < 120000) continue;           // the video being worked on stays until you were idle for 2 minutes
    offloadVideo(v); break;
  }
}, 20000);

// Keep the editing state on the server (same moment as the local autosave, only when it changed).
const syncedJson = new Map();
setInterval(() => {
  if (!Cloud.enabled() || !Cloud.profile().loggedIn) return;
  for (const v of lib) {
    if (v.deleted || !(v.remote && v.remote.complete)) continue;
    const obj = { name: v.name, duration: v.duration, w: v.w, h: v.h, thumb: v.thumb, inT: v.inT, outT: v.outT, type: v.origType || "", noPlay: !!v.noPlay, codec: v.codec || "",
      clips: v.clips.map((c) => { const o = Object.assign({}, c); delete o.out; delete o.status; return o; }) };
    const j = JSON.stringify(obj);
    if (syncedJson.get(v.remote.id) !== j && j.length < 380000) { syncedJson.set(v.remote.id, j); Cloud.putProject(v.remote.id, obj).catch(() => syncedJson.delete(v.remote.id)); }
  }
}, 5000);

// Add placeholders for every video that is on the server but not in this library (new device or cleared browser data).
async function pullFromServer() {
  if (!Cloud.enabled() || !Cloud.profile().loggedIn) return 0;
  let r; try { r = await Cloud.listMine(); } catch (e) { console.warn("Could not read the server library:", errText(e)); return 0; }
  const me = Cloud.profile().user, skip = new Set(Cloud.pendingDeletes());
  let added = 0;
  for (const sv of r.videos || []) {
    if (!sv.complete || skip.has(sv.id) || lib.some((x) => x.remote && x.remote.id === sv.id)) continue;
    if (sv.owner && sv.owner !== me) continue;
    const pj = sv.project || {};
    const v = { id: videoSeq++, file: new File([""], sv.name, { type: pj.type || "video/mp4" }), name: sv.name, url: "", duration: pj.duration || 0, w: pj.w || 0, h: pj.h || 0, thumb: pj.thumb || "", an: null, anKey: "", det: null,
      clips: (pj.clips || []).map((c) => Object.assign({}, c, { out: null, status: "" })), inT: pj.inT || 0, outT: pj.outT || Math.min(30, pj.duration || 30), deleted: false, noPlay: !!pj.noPlay, previewUrl: "", codec: pj.codec || "",
      copyHow: "on your server", copyName: "off-" + sv.id, offloaded: true, sizeBytes: sv.size, origType: pj.type || "video/mp4", origModified: Date.now(), cleanup: null,
      remote: { id: sv.id, complete: true, pending: [], options: null } };
    clipSeq = Math.max(clipSeq, ...v.clips.map((c) => (+c.id || 0) + 1), 1);
    lib.push(v); added++;
  }
  if (added) { renderLib(); renderStats(); if (!cur) selectVideo(lib[0], true); toast("Got " + added + " video(s) back from your server. They download when you open them."); }
  return added;
}
window.pullFromServer = pullFromServer;

async function restoreLibrary() {
  let recs = [];
  try { recs = await Persist.all(); } catch (e) { console.warn("No saved library:", errText(e)); }
  const keepCopies = [], keepOuts = [];
  for (const r of recs) {
    try {
      const file = r.offloaded ? new File([""], r.name, { type: r.type || "video/mp4" }) : await Compat.openCopy(r.key, { name: r.name, type: r.type, lastModified: r.lastModified });
      if (!r.offloaded && file.size !== r.size) throw new Error("stored copy is incomplete");
      const v = { id: videoSeq++, file, name: r.name, url: "", duration: r.duration, w: r.w, h: r.h, thumb: r.thumb || "", an: null, anKey: "", det: null,
        clips: r.clips || [], fb: r.fb || { bad: [], good: [] }, inT: r.inT || 0, outT: r.outT || 0, deleted: false, noPlay: !!r.noPlay, previewUrl: "", codec: r.codec || "", copyHow: "private storage (OPFS)", copyName: r.key,
        origType: r.type, origModified: r.lastModified, cleanup: () => Compat.cleanOld(lib.map((x) => x.copyName).filter(Boolean)) };
      if (r.offloaded) { v.offloaded = true; v.sizeBytes = r.size; v.copyHow = "on your server"; v.url = ""; }
      else if (!v.noPlay) v.url = URL.createObjectURL(file);
      v.remote = r.remote || null;
      const oldIds = v.clips.map((c) => c.id);
      v.clips.forEach((c) => { c.out = null; c.status = ""; });      // ids are kept: the server knows the clips by id
      clipSeq = Math.max(clipSeq, ...oldIds.map((n) => +n + 1 || 0), 1);
      for (const o of r.outs || []) {
        try {
          const f = await Persist.loadExport(o.file);
          const idx = oldIds.indexOf(o.id);
          if (idx >= 0) { v.clips[idx].out = { url: URL.createObjectURL(f), name: o.name, size: o.size, ext: o.ext, saved: o.file }; keepOuts.push(o.file); }
        } catch (e) { /* that file is gone */ }
      }
      lib.push(v); if (!r.offloaded) keepCopies.push(r.key);
    } catch (e) { console.warn("Could not restore " + r.name + ":", errText(e)); Persist.del(r.key).catch(() => {}); }
  }
  Compat.cleanOld(keepCopies); Persist.cleanExports(keepOuts);
  // Videos that were being rendered on the server when the page closed: pick the results up now.
  if (Cloud.enabled()) for (const v of lib) if (v.remote && v.remote.pending && v.remote.pending.length) { setEStatus("Collecting clips your server rendered while the page was closed...", 0.3); pollCloud(v, false).then(() => setEStatus("Server clips collected.", 1)).catch((e) => { setEStatus("Could not collect server clips: " + errText(e), 0, true); }); }
  if (lib.length) { renderLib(); renderStats(); if (!cur) selectVideo(lib[0], true); toast("Restored " + lib.length + " video(s) from your last visit. Analyse again to refresh the Analysis Lab; clips and finished files are kept."); }
}

/* ---------- cloud dialog ---------- */
(function cloudDialog() {
  const dlg = $("cloudDlg"), msg = (t, bad) => { $("cloudMsg").textContent = t; $("cloudMsg").style.color = bad ? "var(--danger)" : "var(--text)"; };
  $("cloudBtn").addEventListener("click", () => {
    const c = Cloud.getConfig(); $("cloudUrl").value = c.url; $("cloudBackup").value = c.backup; $("cloudToken").value = c.token; $("cloudAuto").checked = !!c.auto;
    const n = Cloud.pendingDeletes().length; msg(n ? n + " server delete(s) are waiting to be retried automatically." : "");
    dlg.showModal();
  });
  const read = () => ({ url: $("cloudUrl").value.trim(), backup: $("cloudBackup").value.trim(), token: $("cloudToken").value.trim(), auto: $("cloudAuto").checked, ...($("cloudToken").value.trim() !== Cloud.getConfig().token ? { user: "", role: "" } : {}) });   // typing a different token = leaving the profile login
  $("cloudSave").addEventListener("click", () => { Cloud.setConfig(read()); refreshCloudUI(); msg(Cloud.enabled() ? "Saved. Press 'Test connection' to check it." : "Saved. The cloud server is OFF (address or token missing)."); Cloud.flushDeletes(); });
  $("cloudTest").addEventListener("click", async () => {
    Cloud.setConfig(read()); refreshCloudUI();
    if (!Cloud.enabled()) return msg("Enter the server address and the token first.", true);
    msg("Testing...");
    const r = await Cloud.test();
    const lines = r.results.map((x) => (x.ok ? "OK   " : "FAIL ") + x.base + (x.ms ? "  (" + x.ms + " ms)" : "") + (x.error ? "  - " + x.error : ""));
    if (r.ok) { const i = r.info; lines.push("", "ffmpeg: " + (i.canRender ? i.ffmpeg : "NOT INSTALLED - rendering will not work"), "CPU cores: " + i.cores + " | memory: " + i.memGB + " GB", "Titles on clips: " + (i.titles ? "yes" : "no font found"), "Stored: " + (i.usedBytes / 1e9).toFixed(2) + " GB of " + (i.maxBytes / 1e9).toFixed(1) + " GB allowed | videos kept at most " + i.ttlHours + " h", "Queue: " + i.queue + " clip(s)"); }
    msg(lines.join("\n"), !r.ok);
  });
  $("cloudPurge").addEventListener("click", async () => {
    if (!confirm("Delete EVERY video and clip stored on your server? (Your videos on this page stay.)")) return;
    try { const r = await Cloud.purge(); lib.forEach((v) => { if (v.remote) { v.remote = null; } }); renderLib(); msg("Deleted " + r.deleted + " video(s) on the server."); } catch (e) { msg("Could not delete: " + errText(e), true); }
  });
  $("cloudClose").addEventListener("click", () => dlg.close());
  setInterval(() => Cloud.flushDeletes(), 60000);            // keep retrying postponed deletes
})();

// Show unexpected errors in the status line; js/diagnostics.js also opens the full report pop-up for them.
window.addEventListener("error", (e) => setStatus("Error: " + e.message, undefined, true));
window.addEventListener("unhandledrejection", (e) => setStatus("Error: " + ((e.reason && e.reason.message) || e.reason), undefined, true));

// One helper used everywhere: send a problem (fixed or not) to the report system.
function reportProblem(err, options) {
  try { if (typeof Diag !== "undefined") return Diag.capture(err instanceof Error ? err : new Error(String(err && err.message || err)), Object.assign({ force: true }, options)); }
  catch (e) { console.error("Could not make the error report:", e); }
}

// Tells the report system what video and settings are active (names and numbers only, never the video data).
function diagContext() {
  const v = cur, ctx = { extra: { "Videos in library": lib.length, "Analysing": analysing, "Exporting": exporting } };
  if (v) {
    ctx.videoObj = v;
    ctx.video = {
      Name: v.name, "Size (MB)": (v.file.size / 1048576).toFixed(1), sizeMB: Math.round(v.file.size / 1048576), "File type": v.file.type || "(empty)", "Last modified": new Date(v.file.lastModified).toISOString(),
      Duration: fmt(v.duration) + " (" + v.duration.toFixed(2) + " s)", Resolution: v.w + "x" + v.h, "Blob address": (v.url || "").slice(0, 60), "Blob origin": (function () { try { return new URL(v.url).origin; } catch (e) { return "?"; } })(),
      "Analysed": !!v.an, "Frame reader used": v.an && v.an.recovery ? (v.an.recovery.frameSource || "n/a") : "n/a", "Safe copy": v.copyHow || "none", "Browser can play it": !v.noPlay, "Video codec (if ffmpeg read it)": v.codec || "n/a", "Readers marked dead": Object.keys(v.deadSources || {}).join(", ") || "none", "Clips": v.clips.length
    };
  }
  try { ctx.settings = { analysis: readParams(), export: readExport() }; } catch (e) { ctx.settings = { error: e.message }; }
  return ctx;
}

/* ---------- START-UP ---------- */
(function init() {
  // Older visits remembered "Best quality (ffmpeg)", which is very slow on phones. Switch once to Turbo.
  if (store.get("engineV", 0) < 2) { store.set("engineV", 2); try { const sel = $("engineSel"); if (Exporter.turboAvailable() && sel.querySelector('option[value="turbo"]')) sel.value = "turbo"; sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* ignore */ } }
  if (!Exporter.turboAvailable()) { const o = $("engineSel").querySelector('option[value="turbo"]'); if (o) o.remove(); if ($("engineSel").value === "turbo") $("engineSel").value = "hq"; }
  refreshCloudUI();
  Cloud.flushDeletes();
  restoreLibrary().then(() => pullFromServer());
  if (typeof Diag !== "undefined") Diag.init(diagContext);   // error reports + pop-up
  try { if (typeof Persist !== "undefined" && Persist.cacheTidy) Persist.cacheTidy(7); } catch (e) { /* cache clean-up is optional */ }
  syncUI();
  const missing = [];
  if (!window.MediaRecorder) missing.push("video recording (Fast recorder will not work)");
  if (!(window.AudioContext || window.webkitAudioContext)) missing.push("audio analysis");
  setStatus(missing.length ? "Your browser lacks: " + missing.join(", ") + ". Use Chrome or Edge on a computer." : "Add a video to begin.", 0, missing.length > 0);
  renderStats();
})();


/* ---------- AI Referee settings box (v5.9) ---------- */
(function aiBox() {
  const box = $("aiBox"); if (!box) return;
  const c = AI.cfg(); $("aiName").value = c.name; $("aiModel").value = c.model; $("aiKey").value = c.key; $("aiPos").value = store.get("ai.pos", "tr");
  const sync = () => { box.hidden = $("methodSel").value !== "ai"; };
  $("methodSel").addEventListener("change", sync); sync();
  const bind = (id, key) => $(id).addEventListener("change", () => store.set(key, $(id).value.trim()));
  bind("aiName", "ai.name"); bind("aiModel", "ai.model"); bind("aiKey", "ai.key"); bind("aiPos", "ai.pos");
  $("aiTest").addEventListener("click", async () => {
    ["ai.name", "ai.model", "ai.key", "ai.pos"].forEach((k, i) => store.set(k, $(["aiName", "aiModel", "aiKey", "aiPos"][i]).value.trim()));
    $("aiMsg").textContent = "Testing...";
    try { const r = await AI.test(); $("aiMsg").textContent = "OK - the AI answered: " + r + (AI.cfg().key ? " (direct key)" : " (through your server)"); }
    catch (e) { $("aiMsg").textContent = "FAILED: " + errText(e); }
  });
})();

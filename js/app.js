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
  return {
    method, profile: $("profileSel").value, fps: parseFloat($("depthSel").value),
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
  document.querySelectorAll(".hq-only").forEach((e) => (e.hidden = eng !== "hq"));
  document.querySelectorAll(".shape-only").forEach((e) => {
    e.style.opacity = eng === "copy" ? 0.4 : 1;
    e.querySelectorAll("select,input").forEach((i) => (i.disabled = eng === "copy"));
  });
  $("engineHint").textContent = {
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

async function addFiles(files) {
  for (const file of files) {
    if (!looksLikeVideo(file)) { setStatus("Skipped " + file.name + " (not a video file).", undefined, true); continue; }
    const v = {
      id: videoSeq++, file, name: file.name, url: URL.createObjectURL(file), duration: 0, w: 0, h: 0, thumb: "",
      an: null, anKey: "", det: null, clips: [], inT: 0, outT: 0, deleted: false
    };
    try { setStatus("Reading " + file.name + "...", 0); await probe(v); }
    catch (err) { URL.revokeObjectURL(v.url); setStatus(file.name + ": " + err.message, 0, true); toast(file.name + ": " + err.message, true); continue; }
    v.outT = Math.min(30, v.duration);
    lib.push(v);
    renderLib(); renderStats();
    if (!cur) selectVideo(v);
    setStatus("Added " + file.name + ".", 0);
    Engine.thumbnail(v).then((u) => { v.thumb = u; renderLib(); }).catch(() => {});   // small picture, not important if it fails
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
      else resolve();
    };
    t.onerror = () => { clearTimeout(timer); reject(new Error("this browser cannot play it. Try an MP4 (H.264) file.")); };
    t.src = v.url;
  });
}

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
          <div class="sub">${fmt(v.duration)} | ${v.w}x${v.h} | ${(v.file.size / 1048576).toFixed(1)} MB | ${v.clips.length} clip(s)${v.an ? " | analysed" : ""}${kills ? " | " + kills + " kill(s)" : ""}</div>
        </div>
      </div>
      <div class="row">
        <button class="ghost small" data-vact="select" data-id="${v.id}">${v === cur ? "Selected" : "Select"}</button>
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
  URL.revokeObjectURL(v.url);
  lib.splice(lib.indexOf(v), 1);
  if (cur === v) cur = null;
}

function afterLibraryChange() {
  if (!cur && lib.length) selectVideo(lib[0]);
  else if (!cur) {
    player.removeAttribute("src"); player.load();
    ["sec-studio", "sec-analyse", "sec-clips", "sec-export"].forEach((id) => ($(id).hidden = true));
    setStatus("Add a video to begin.", 0);
  }
  renderLib(); renderStats();
}

function selectVideo(v) {
  cur = v;
  player.src = v.url;
  $("meta").textContent = v.name + "  |  " + fmt(v.duration) + "  |  " + v.w + "x" + v.h;
  ["sec-studio", "sec-analyse", "sec-clips", "sec-export"].forEach((id) => ($(id).hidden = false));
  $("inT").value = v.inT.toFixed(1); $("outT").value = v.outT.toFixed(1);
  renderLib(); renderClips(); drawTimeline(); drawLab(); renderEventTable(); updateAnState(); renderStats();
  setStatus(v.an ? "Analysed. Change settings to re-pick clips." : "Ready. Press Find my highlights, or trim by hand.", 0);
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
function getRegions(profileId) {
  const prof = PROFILES[profileId];
  if (!prof.feed) return {};
  return store.get("regions." + profileId, null) || prof.regions;
}
function analysisKey(P) {
  if (P.method === "classic") return "classic";
  return "smart|" + P.fps + "|" + JSON.stringify(getRegions(P.profile));
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
  const key = analysisKey(P);
  if (v.an && (v.anKey === key || classic)) return true;           // already done: reuse it

  const prof = PROFILES[P.profile];
  const fps = classic ? 1 : P.fps;
  const regions = classic ? {} : getRegions(P.profile);
  aCtl = { cancel: false };
  setBusy(true); setAState("Starting...", 0.01);
  try {
    v.an = await Engine.analyse(v, { fps, regions, profile: classic ? "auto" : P.profile, height: fps >= 10 ? 144 : 108, regionWidth: fps >= 30 ? 320 : 240 },
      aCtl, (f, text) => setAState(typeof text === "string" ? text : "Working...", f));
    v.anKey = key;
    const rec = v.an.recovery, failed = rec ? rec.attempts.filter((a) => !a.ok) : [];
    if (v.an.partial) {
      setAState("Finished using SOUND ONLY (pictures could not be read). See the report.", 1, true);
      reportProblem(failed[0] || new Error("Pictures could not be read"), { recovered: "partial", stage: "analyse", attempts: rec.attempts, note: rec.notes.join(" ") });
    } else {
      setAState("Analysis finished in " + fmt(v.an.seconds) + "." + (failed.length ? " (fixed automatically - " + (rec.frameSource || "backup") + " reader used)" : ""), 1);
      // Something failed on the way but the self-healing code got through: tell the user, quietly.
      if (failed.length) reportProblem(failed[0].error ? new Error(failed[0].error) : new Error("Recovered"), { recovered: true, stage: "analyse", attempts: rec.attempts });
    }
    return true;
  } catch (err) {
    if (err.message === Engine.CANCEL) { setAState("Analysis cancelled.", 0); toast("Analysis cancelled."); }
    else {
      console.error(err); setAState("Analysis failed: " + err.message + " - a full report was opened.", 0, true);
      reportProblem(err, { recovered: false, stage: "analyse", attempts: err.attempts });
    }
    return false;
  } finally { setBusy(false); }
}

function makeClip(start, end, extra) {
  return Object.assign({ id: clipSeq++, start, end, label: "", auto: false, score: null, conf: null, reason: "Made by hand", kills: 0, rank: 0, events: [], out: null, status: "" }, extra || {});
}

// Turn the analysis into clips (instant - can be repeated when settings change).
function applySuggestions(v) {
  if (!v || !v.an) return;
  const P = readParams();
  let found;
  if (P.method === "smart") {
    v.det = Engine.detect(v.an, { profile: P.profile, sens: P.sens, gap: P.gap });
    const maxLen = PLATFORMS[P.platform].max;
    found = Engine.buildClips(v.an, v.det, { maxLen, minLen: Math.min(10, maxLen), fixedLen: P.length || 0, pre: P.pre, post: P.post, count: P.count, snap: P.snap > 0 });
  } else {
    v.det = null;
    found = Engine.classic(v.an, { focus: P.focus, length: P.length || 30, count: P.count, snap: P.snap });
  }
  // Remove the old automatic clips but keep the ones made or edited by hand.
  v.clips = v.clips.filter((c) => { if (c.auto) { c.out && URL.revokeObjectURL(c.out.url); return false; } return true; });
  found.forEach((f) => v.clips.push(makeClip(f.start, f.end, {
    auto: true, score: f.score01, conf: f.conf, reason: f.why, kills: f.kills, rank: f.rank, events: f.events,
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
  const v = cur;
  if (!(await doAnalyse(v))) return;
  applySuggestions(v);
  const n = v.clips.filter((c) => c.auto).length;
  setAState(n ? "Found " + n + " clip(s). Scroll down to check them." : "No clear highlights found. Try a different video type, higher sensitivity or Deep detail.", 1);
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
        <button class="danger" data-act="del">Delete clip</button>
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
  exporting = on;
  $("cancelBtn").hidden = !on;
  $("exportAllBtn").disabled = on || !(cur && cur.clips.length);
  document.querySelectorAll('[data-act="export"]').forEach((b) => (b.disabled = on));
  $("autoBtn").disabled = on || analysing;
}

// A safe file name: video name + rank + clip name.
function clipFileName(v, clip, ext) {
  const idx = v.clips.indexOf(clip) + 1;
  return slug(v.name.replace(/\.[^.]+$/, "")) + "_" + String(clip.rank || idx).padStart(2, "0") + "_" + slug(clip.label) + "." + ext;
}

// Export ONE clip. Returns true when finished, false if cancelled or failed.
async function exportClip(v, clip) {
  const base = readExport();
  const card = $("clipList").querySelector(`.clip[data-id="${clip.id}"]`);
  const barEl = card && card.querySelector('[data-role="bar"]');
  const say = (t) => { clip.status = t; if (!clip.out) updateClipCard(clip); setEStatus(t); };
  if (clip.out) { URL.revokeObjectURL(clip.out.url); clip.out = null; }
  if (barEl) barEl.style.width = "0%";
  say("Preparing...");

  // SELF-HEALING EXPORT: if the chosen settings fail, we try simpler recipes one after another.
  // Recipe 0 is exactly what the user chose. Later ones drop risky extras (title picture, loudness,
  // speed change), then lower the resolution, then switch engine.
  const recipes = [{ name: "your settings", o: base }];
  if (base.engine === "hq") {
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
      if (k > 0) { say("Retrying with " + rcp.name + "..."); try { Exporter.cancel(); } catch (e) { /* reset the engine */ } eCtl.cancel = false; }
      const r = await Exporter.exportClip(v, clip, rcp.o, {
        ctl: eCtl, hiddenVideo: $("exportVideo"),
        status: say,
        progress: (f, eta) => { if (barEl) barEl.style.width = Math.round(f * 100) + "%"; $("eBar").style.width = Math.round(f * 100) + "%"; if (eta > 2) setEStatus((clip.status || "").split("  (")[0] + "  (about " + fmt(eta) + " left)"); }
      });
      clip.out = { url: URL.createObjectURL(r.blob), name: clipFileName(v, clip, r.ext), size: r.blob.size, ext: r.ext };
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
      attempts.push({ step: "export", strategy: rcp.name, ok: false, error: (err.name || "Error") + ": " + err.message, ms: Math.round(performance.now() - s0) });
      if (k === recipes.length - 1) {
        clip.status = "Failed: " + err.message; setEStatus("Export failed: " + err.message + " - a full report was opened.", 0, true);
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
  eCtl = { cancel: false };
  setExporting(true);
  const ok = await exportClip(v, clip);
  setExporting(false);
  if (ok) { setEStatus("Export finished. Download it from the clip card.", 1); toast("Clip exported."); }
}

async function exportAll() {
  if (exporting || !cur || !cur.clips.length) return 0;
  const v = cur, list = [...v.clips];
  eCtl = { cancel: false };
  setExporting(true);
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    if (v.deleted || eCtl.cancel) break;
    setEStatus("Exporting clip " + (i + 1) + " of " + list.length + "...", i / list.length);
    if (await exportClip(v, list[i])) done++; else if (eCtl.cancel) break;
  }
  setExporting(false);
  setEStatus(eCtl.cancel ? "Export cancelled." : done + " of " + list.length + " clips exported. Download them from the cards or as a ZIP.", eCtl.cancel ? 0 : 1);
  return done;
}

$("exportAllBtn").addEventListener("click", exportAll);
$("cancelBtn").addEventListener("click", () => { eCtl.cancel = true; Exporter.cancel(); });

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
  const n = await exportAll();
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
$("calBtn").addEventListener("click", () => {
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
      "Analysed": !!v.an, "Frame reader used": v.an && v.an.recovery ? (v.an.recovery.frameSource || "n/a") : "n/a", "Readers marked dead": Object.keys(v.deadSources || {}).join(", ") || "none", "Clips": v.clips.length
    };
  }
  try { ctx.settings = { analysis: readParams(), export: readExport() }; } catch (e) { ctx.settings = { error: e.message }; }
  return ctx;
}

/* ---------- START-UP ---------- */
(function init() {
  if (typeof Diag !== "undefined") Diag.init(diagContext);   // error reports + pop-up
  syncUI();
  const missing = [];
  if (!window.MediaRecorder) missing.push("video recording (Fast recorder will not work)");
  if (!(window.AudioContext || window.webkitAudioContext)) missing.push("audio analysis");
  setStatus(missing.length ? "Your browser lacks: " + missing.join(", ") + ". Use Chrome or Edge on a computer." : "Add a video to begin.", 0, missing.length > 0);
  renderStats();
})();

/* =====================================================================
   js/util.js  -  small helper tools used by every other file
   =====================================================================
   WHY THIS FILE EXISTS:
     Many files need the same little helpers (format time, clamp a number,
     show a message...). Keeping them in one place avoids copy-paste.

   HOW IT WORKS:
     Plain JavaScript functions placed in the global scope, so the other
     files (engine.js, exporter.js, app.js...) can call them directly.

   HOW TO IMPROVE:
     - Move to ES modules (import/export) if the project keeps growing.
   ===================================================================== */

// $("x") is a short way to write document.getElementById("x").
const $ = (id) => document.getElementById(id);

// Wait one "tick" so the browser can redraw the page during long loops.
const tick = () => new Promise((r) => setTimeout(r, 0));

// Keep a number between lo and hi.
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Seconds -> m:ss (or h:mm:ss for long videos).
function fmt(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

// Make text safe to place inside HTML (stops "<b>" tricks in file names).
function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A short name that is safe to use as a file name.
const slug = (t) => (t || "clip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";

// Big numbers with commas, e.g. 1,234,567.
const bigNum = (n) => Math.round(n).toLocaleString("en-US");

/* ---------- Saved settings (stays after you close the page) ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("clipcutter." + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("clipcutter." + key, JSON.stringify(value)); } catch (e) { /* private mode: ignore */ }
  }
};

/* ---------- Messages ---------- */

// Text under the video list + the main progress bar (0 to 1). isError turns the text red.
function setStatus(text, progress, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "status err" : "status";
  if (progress !== undefined) $("bar").style.width = Math.round(progress * 100) + "%";
}

// A small pop-up message that disappears by itself.
function toast(text, isError) {
  const box = $("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3800);
}

// Copy text to the clipboard (with a fallback for older browsers).
function copyText(text) {
  const done = () => toast("Copied!");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const t = document.createElement("textarea");
  t.value = text; document.body.appendChild(t); t.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("Could not copy", true); }
  t.remove();
}

/* ---------- Video helpers ---------- */

// Wait until a video jumps to a time (with a safety timeout so we never hang).
function seekTo(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener("seeked", done); resolve(); };
    video.addEventListener("seeked", done);
    video.currentTime = t;
    setTimeout(done, 3000);
  });
}

// Wait until a video has data to show (rejects with a friendly message on failure).
function whenLoaded(video, ms) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2) { resolve(); return; }
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("This browser cannot play that video. Try an MP4 (H.264) file.")); };
    const cleanup = () => { video.removeEventListener("loadeddata", ok); video.removeEventListener("error", bad); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("The video took too long to load.")); }, ms || 20000);
    video.addEventListener("loadeddata", ok);
    video.addEventListener("error", bad);
  });
}

/* ---------- Number helpers for the Quick analysis ---------- */

// Scale an array to 0..1 using the 95th percentile (one spike cannot squash the rest).
function normalise(arr) {
  if (!arr.length) return arr;
  const sorted = [...arr].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 1;
  return arr.map((v) => Math.min(1, v / (top || 1)));
}

// Smooth an array by averaging neighbours.
function smooth(arr, radius) {
  return arr.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = i - radius; k <= i + radius; k++) if (k >= 0 && k < arr.length) { sum += arr[k]; n++; }
    return sum / n;
  });
}

// Average of arr between two seconds.
function avg(arr, from, to) {
  let sum = 0, n = 0;
  for (let i = Math.floor(from); i < Math.min(to, arr.length); i++) { sum += arr[i]; n++; }
  return n ? sum / n : 0;
}

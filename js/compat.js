/* =====================================================================
   js/compat.js  -  COMPATIBILITY helpers (make the site work on any phone / video)
   =====================================================================
   WHY THIS FILE EXISTS (a real problem found in an error report):
     On an Android phone, a file you pick in the file chooser is only a
     "reference" to the real file. After some time (or when the browser tab
     goes into the background) Android can take the permission back, and every
     later read fails with:
         NotReadableError: The requested file could not be read, typically due
         to permission problems that have occurred after a reference to a file
         was acquired.
     That broke the video player, the memory copy AND ffmpeg at the same time.

   THE FIX - "stable copy":
     Right after you pick a file, while the permission is still fresh, we copy
     it ONCE into the browser's own private storage (OPFS, "Origin Private File
     System"). A file stored there belongs to this site, so it can never lose
     permission, and it does not use RAM. All later work reads the stable copy.
     If OPFS is not available we fall back to a copy held in memory.

   ALSO HERE:
     - Screen wake lock: keeps the phone screen on while analysing / exporting,
       because a sleeping tab is paused by Android (that also broke reads).
     - Cleanup of old copies from earlier visits.

   HOW TO IMPROVE:
     - Keep the copies between visits (a persistent library) instead of
       deleting them at start-up.
   ===================================================================== */

const Compat = (function () {
  "use strict";

  const DIR = "clipcutter-videos";
  let lock = null, lockUsers = 0;

  const guessType = (name) => {
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || [0, ""])[1].toLowerCase();
    return { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", "3gp": "video/3gpp", ts: "video/mp2t", mts: "video/mp2t", m2ts: "video/mp2t", mpg: "video/mpeg", mpeg: "video/mpeg", flv: "video/x-flv", wmv: "video/x-ms-wmv" }[ext] || "video/mp4";
  };

  // Copy a file into private browser storage. Returns { file, how, cleanup }.
  // onProgress(fraction) is called while copying. Throws if even reading the file fails.
  async function stableCopy(file, onProgress) {
    const type = file.type || guessType(file.name);
    const tried = [];

    // Plan A: OPFS (stored on disk by the browser, not in RAM).
    try {
      if (!(navigator.storage && navigator.storage.getDirectory)) throw new Error("OPFS not supported");
      try { const est = await navigator.storage.estimate(); if (est.quota && est.quota - (est.usage || 0) < file.size * 1.1) throw new Error("not enough browser storage space"); } catch (e) { if (/storage space/.test(e.message)) throw e; }
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + ".bin";
      const fh = await dir.getFileHandle(name, { create: true });
      if (!fh.createWritable) throw new Error("OPFS writing not supported");
      const w = await fh.createWritable();
      const reader = file.stream().getReader();
      let done = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          await w.write(r.value); done += r.value.length;
          onProgress && onProgress(done / file.size);
        }
        await w.close();
      } catch (e) { try { await w.abort(); } catch (x) { /* ignore */ } try { await dir.removeEntry(name); } catch (x) { /* ignore */ } throw e; }
      const stored = await fh.getFile();
      if (stored.size !== file.size) throw new Error("copy size mismatch (" + stored.size + " vs " + file.size + ")");
      // A File made by OPFS has no name/type, so we wrap it as a Blob-backed File with the right ones.
      const f = new File([stored], file.name, { type, lastModified: file.lastModified });
      return { file: f, how: "private storage (OPFS)", name, cleanup: () => dir.removeEntry(name).catch(() => {}) };
    } catch (e) {
      tried.push("OPFS: " + (e.name || "Error") + ": " + e.message);
      console.warn("Stable copy via OPFS failed:", e);
      if (e.name === "NotReadableError" || e.name === "NotFoundError") throw withTried(e, tried);   // the source itself is unreadable: nothing else will work
    }

    // Plan B: hold the copy in memory (works everywhere, but needs RAM).
    try {
      if (file.size > 900e6) throw new Error("file too big (" + Math.round(file.size / 1048576) + " MB) for a memory copy");
      const chunks = [], reader = file.stream().getReader();
      let done = 0;
      for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); done += r.value.length; onProgress && onProgress(done / file.size); }
      return { file: new File(chunks, file.name, { type, lastModified: file.lastModified }), how: "memory copy", cleanup: () => {} };
    } catch (e) {
      tried.push("memory: " + (e.name || "Error") + ": " + e.message);
      throw withTried(e, tried);
    }
  }
  function withTried(e, tried) { const x = new Error(errText(e)); x.name = e.name || "Error"; x.attempts = tried.map((t) => ({ step: "stable copy", strategy: t, ok: false })); return x; }

  // Remove stored copies that the saved library no longer refers to (keepNames = copies we still need).
  async function cleanOld(keepNames) {
    try {
      if (!(navigator.storage && navigator.storage.getDirectory)) return;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      for await (const [name] of dir.entries()) if (!(keepNames || []).includes(name)) await dir.removeEntry(name).catch(() => {});
    } catch (e) { /* nothing to clean */ }
  }

  // Get a stored copy back (after the page was closed and opened again).
  async function openCopy(name, file) {
    const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle(DIR);
    const stored = await (await dir.getFileHandle(name)).getFile();
    return new File([stored], file.name, { type: file.type || guessType(file.name), lastModified: file.lastModified });
  }

  /* KEEP-ALIVE: a web page cannot run after the browser app is closed (no website can), but it CAN keep
     working while you switch tabs / apps or the screen turns off, if the browser is told the page is busy:
       1. Screen wake lock    - the screen does not sleep.
       2. Web Lock            - Chrome does not freeze / discard a tab that holds a lock.
       3. Quiet looping sound - Chrome keeps a tab that is playing audio running in the background.
       4. Media session       - Android shows a "ClipCutter is working" player card, which also protects the tab. */
  let silentEl = null, lockRelease = null;
  function silentWav() {
    const n = 8000, b = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, t) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
    w(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, "data"); b.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, (i % 2 ? 1 : -1) * 3, true);       // +-3 out of 32768 = far below hearing
    return new Blob([b.buffer], { type: "audio/wav" });
  }
  function startKeepAlive() {
    try {
      if (!silentEl) { silentEl = new Audio(URL.createObjectURL(silentWav())); silentEl.loop = true; silentEl.volume = 1; }
      silentEl.play().catch(() => {});
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "ClipCutter is working", artist: "Analysing / exporting your clips", album: "Keep this running" });
        navigator.mediaSession.playbackState = "playing";
      }
    } catch (e) { /* optional */ }
    try { if (navigator.locks && !lockRelease) navigator.locks.request("clipcutter-work", () => new Promise((r) => { lockRelease = r; })).catch(() => {}); } catch (e) { /* optional */ }
  }
  function stopKeepAlive() {
    try { silentEl && silentEl.pause(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none"; } catch (e) { /* ignore */ }
    try { lockRelease && lockRelease(); lockRelease = null; } catch (e) { /* ignore */ }
  }

  // Call keepAwake(true) when heavy work starts and keepAwake(false) when it ends.
  async function keepAwake(on) {
    lockUsers = Math.max(0, lockUsers + (on ? 1 : -1));
    if (lockUsers === 1 && on) startKeepAlive();
    if (!lockUsers) stopKeepAlive();
    try {
      if (!("wakeLock" in navigator)) return;
      if (on && !lock) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => (lock = null)); }
      if (!lockUsers && lock) { await lock.release(); lock = null; }
    } catch (e) { /* not allowed (for example the tab is hidden): ignore */ }
  }
  // A wake lock is dropped when the tab is hidden. Ask again when it comes back.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && lockUsers && !lock) { try { navigator.wakeLock.request("screen").then((l) => { lock = l; l.addEventListener("release", () => (lock = null)); }).catch(() => {}); } catch (e) { /* ignore */ } } });

  return { stableCopy, cleanOld, openCopy, keepAwake, guessType };
})();

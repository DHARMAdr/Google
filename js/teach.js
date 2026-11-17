/* =====================================================================
   js/teach.js  -  "Teach it my name"
   =====================================================================
   WHY: a website cannot know WHICH kill-feed line is yours. Reading the text (OCR) is heavy and
   unreliable on small phone recordings. So you show it once: pick a frame where your kill is in
   the kill feed and draw a box around your name. The picture inside the box (gray values) is
   saved in this browser. The engine (engine.js: matchTemplate) then looks for that picture in
   every frame and Hunter (hunter.js: detectByName) turns every NEW matching line into a kill.
   HOW IT WORKS HERE: the frame is drawn on a canvas, you drag a rectangle, Save cuts that
   rectangle out of the FULL-resolution frame, converts it to gray and keeps it in localStorage.
   HOW TO IMPROVE: let it learn from several examples, also keep colour, show a live "match" preview.
   ===================================================================== */
const Teach = (function () {
  "use strict";
  const KEY = "teach";

  function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
  function unb64(t) { const s = atob(t), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

  // The saved template (or null).
  function get() {
    const t = store.get(KEY, null);
    if (!t || !t.b64) return null;
    try { return { id: t.id, w: t.w, h: t.h, vw: t.vw, vh: t.vh, bx: t.bx, by: t.by, bw: t.bw, bh: t.bh, gray: unb64(t.b64) }; } catch (e) { return null; }
  }
  // The kill-feed search area for a taught name: the whole right/top part of the screen, down to a bit below the taught line.
  function region(t) { return { x: 0.2, y: 0, w: 0.79, h: Math.min(0.7, t.by + t.bh + 0.15) }; }

  /* ---------- the dialog ---------- */
  const dlg = $("teachDlg"), cv = $("teachCanvas"), g = cv.getContext("2d");
  let box = null, drag = null;
  const msg = (t, bad) => { $("teachMsg").textContent = t || ""; $("teachMsg").style.color = bad ? "var(--bad, #e5484d)" : ""; };

  function draw() {
    const vw = player.videoWidth || 16, vh = player.videoHeight || 9;
    cv.width = vw; cv.height = vh;                      // full resolution, so the saved picture is sharp
    g.fillStyle = "#000"; g.fillRect(0, 0, vw, vh);
    try { if (player.readyState >= 2) g.drawImage(player, 0, 0, vw, vh); } catch (e) { /* no frame yet */ }
    if (box) {
      g.lineWidth = Math.max(2, vw / 300); g.strokeStyle = "#ffcc00"; g.fillStyle = "rgba(255,204,0,.18)";
      g.fillRect(box.x * vw, box.y * vh, box.w * vw, box.h * vh); g.strokeRect(box.x * vw, box.y * vh, box.w * vw, box.h * vh);
    }
    $("teachTime").textContent = (player.currentTime || 0).toFixed(1) + " s";
  }
  function pos(e) { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; }
  cv.addEventListener("pointerdown", (e) => { drag = pos(e); box = { x: drag.x, y: drag.y, w: 0, h: 0 }; cv.setPointerCapture(e.pointerId); draw(); });
  cv.addEventListener("pointermove", (e) => { if (!drag) return; const p = pos(e); box = { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) }; draw(); });
  cv.addEventListener("pointerup", () => { drag = null; });

  function seekTo2(t) { player.currentTime = Math.min(Math.max(0, t), player.duration || 0); player.pause(); }
  player.addEventListener("seeked", () => { if (dlg.open) draw(); });
  $("teachSeek").addEventListener("input", () => seekTo2(parseFloat($("teachSeek").value)));
  $("teachBack").addEventListener("click", () => seekTo2(player.currentTime - 0.5));
  $("teachFwd").addEventListener("click", () => seekTo2(player.currentTime + 0.5));

  $("teachBtn").addEventListener("click", () => {
    if (!cur) { toast("Add a video first."); return; }
    if (!player.src) { toast("This video cannot be shown here (make a preview copy first)."); return; }
    $("teachSeek").max = player.duration || 1; $("teachSeek").value = player.currentTime || 0;
    box = null; msg(get() ? "A name is already saved. Draw a new box and press Save to replace it." : "");
    dlg.showModal(); player.pause(); setTimeout(draw, 150);
  });

  $("teachSave").addEventListener("click", () => {
    if (!box || box.w < 0.02 || box.h < 0.008) { msg("Draw a box around your name first (drag with your finger or mouse).", true); return; }
    const vw = player.videoWidth, vh = player.videoHeight;
    const x = Math.round(box.x * vw), y = Math.round(box.y * vh), w = Math.max(8, Math.round(box.w * vw)), h = Math.max(6, Math.round(box.h * vh));
    const t = document.createElement("canvas"); t.width = vw; t.height = vh;
    const tg = t.getContext("2d", { willReadFrequently: true });
    try { tg.drawImage(player, 0, 0, vw, vh); } catch (e) { msg("Could not read the picture: " + errText(e), true); return; }
    const px = tg.getImageData(x, y, Math.min(w, vw - x), Math.min(h, vh - y));
    const gray = new Uint8Array(px.width * px.height);
    for (let k = 0; k < gray.length; k++) gray[k] = (77 * px.data[4 * k] + 150 * px.data[4 * k + 1] + 29 * px.data[4 * k + 2]) >> 8;
    // a flat box (no text) cannot be matched
    let mn = 255, mx = 0; for (const q of gray) { if (q < mn) mn = q; if (q > mx) mx = q; }
    if (mx - mn < 40) { msg("That box looks empty (no text). Move the slider to a kill-feed line and box your name.", true); return; }
    store.set(KEY, { id: Date.now().toString(36), w: px.width, h: px.height, vw, vh, bx: box.x, by: box.y, bw: box.w, bh: box.h, b64: b64(gray) });
    if (cur) { cur.anKey = ""; }                                   // the next analysis must use the new name
    msg("Saved. Close this window and press 'Find my highlights'. Only kill-feed lines with this name will make clips.");
    toast("Name saved.");
  });
  $("teachClear").addEventListener("click", () => { store.set(KEY, null); if (cur) cur.anKey = ""; msg("Forgotten. The site is back to the general method."); });
  $("teachClose").addEventListener("click", () => dlg.close());

  return { get, region };
})();

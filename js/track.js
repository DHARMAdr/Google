/* =====================================================================
   js/track.js  -  PLAYER / ACTION TRACKER for 9:16 framing (v5.10)
   =====================================================================
   WHY IT EXISTS
     Turning a wide gameplay picture (16:9) into a tall one (9:16) by "crop to fill" keeps only a narrow vertical
     slice. If that slice is always the centre, the action (the enemy, the muzzle flash, your character in
     third-person games) can slide out of the picture. This tracker moves the slice to follow the action.

   HOW IT WORKS (frame by frame, plain words)
     For EVERY frame that is exported:
       1. The frame is shrunk to a tiny 64x36 grey picture (fast).
       2. It is compared with the previous tiny frame: pixels that changed a lot = something moves / flashes.
          Brighter pixels (muzzle flash, ability flashes) count extra.
       3. The screen parts that are only HUD (kill feed, minimap, health / ammo) are ignored.
       4. Changed pixels near the expected player position (the crosshair / the character) count more
          (a soft "bubble" around the prior point, default = screen centre).
       5. The centre of weight of all changed pixels = where the action is. That is the target point.
       6. The crop window glides to the target with a speed limit and a dead zone, so the video does not shake.
     The prior point can come from the AI (js/ai.js locatePlayer): Claude looks at ONE frame and says where the
     player's character / weapon is - useful in third-person games (PUBG Mobile, Free Fire, CoD Mobile).

   HONEST LIMITS: it follows MOTION and FLASHES, it does not recognise a character by shape (no neural network
     runs in the browser). In first-person games (Valorant) the character is not on screen; the tracker follows the
     fight around the crosshair.
   HOW TO IMPROVE: look ahead a few frames (needs a pre-pass), track the enemy marker colour, add zoom-in on kills.
   ===================================================================== */
const Track = (function () {
  "use strict";
  const W = 96, H = 54, LAG = 3;       // small grid; each frame is compared with the one LAG frames earlier (slow motion still shows up)
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // Parts of the screen that are HUD only (fractions): kill feed (top right), minimap (top left), bottom bars.
  const isHud = (x, y) => (x > 0.55 && y < 0.32) || (x < 0.22 && y < 0.32) || y > 0.86;

  function create(prior) {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    const p0 = { x: prior && prior.x != null ? clamp(prior.x, 0.1, 0.9) : 0.5, y: prior && prior.y != null ? clamp(prior.y, 0.1, 0.9) : 0.5 };
    const ring = []; let prev = null, fx = p0.x, fy = p0.y, frames = 0, moved = 0, lastSw = 0;
    const grey = new Float32Array(W * H);

    function update(el) {
      try { g.drawImage(el, 0, 0, W, H); } catch (e) { return { x: fx, y: fy }; }
      const d = g.getImageData(0, 0, W, H).data;
      for (let i = 0, k = 0; i < grey.length; i++, k += 4) grey[i] = 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2];
      let sw = 0, sx = 0, sy = 0;
      if (prev) {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const nx = x / W, ny = y / H; if (isHud(nx, ny)) continue;
          const df = grey[y * W + x] - prev[y * W + x], a = Math.abs(df); if (a < 9) continue;
          const dx = (nx - p0.x) / 0.30, dy = (ny - p0.y) / 0.35;
          const w = a * (df > 0 ? 1.6 : 1) * (0.35 + Math.exp(-(dx * dx + dy * dy) / 2));
          sw += w; sx += w * nx; sy += w * ny;
        }
      }
      ring.push(new Float32Array(grey)); if (ring.length > LAG) ring.shift();
      prev = ring.length >= LAG ? ring[0] : null;
      // target = centre of the changes (or drift back to the prior point when nothing moves)
      let tx = p0.x, ty = p0.y, gain = 0.03;
      if (sw > W * H * 0.25) { tx = sx / sw; ty = sy / sw; gain = 0.12; }
      let stepX = (tx - fx) * gain, stepY = (ty - fy) * gain;
      if (Math.abs(tx - fx) < 0.03) stepX = 0;                   // dead zone: no tiny shaking
      if (Math.abs(ty - fy) < 0.03) stepY = 0;
      fx = clamp(fx + clamp(stepX, -0.012, 0.012), 0.05, 0.95);   // speed limit per frame
      fy = clamp(fy + clamp(stepY, -0.012, 0.012), 0.05, 0.95);
      frames++; lastSw = sw; if (sw > W * H * 0.25) moved++;
      return { x: fx, y: fy };
    }
    return { update, stats: () => ({ frames, active: moved, lastSw: Math.round(lastSw), x: +fx.toFixed(2), y: +fy.toFixed(2) }) };
  }

  // Convert a focus point (fractions of the SOURCE picture) into the crop position (0 = left/top edge, 1 = right/bottom edge)
  // for "scale to cover the output, then crop". dw/dh = scaled size of the video, W/H = output size.
  function cropPos(f, dw, dh, outW, outH) {
    return { x: dw > outW ? clamp((f.x * dw - outW / 2) / (dw - outW), 0, 1) : 0.5, y: dh > outH ? clamp((f.y * dh - outH / 2) / (dh - outH), 0, 1) : 0.5 };
  }
  return { create, cropPos };
})();

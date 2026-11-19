/* =====================================================================
   js/hunter.js  -  the "MAIN PLAYER HUNTER" (new detection method, v5)
   =====================================================================
   WHAT IT DOES (plain words):
     The older Smart engine said "something happened in the kill feed, so it
     is probably a kill". That also catches teammates' kills, enemy deaths far
     away, and loud-but-boring moments, and it padded the list with "intense
     moment" clips that contain no kill at all.

     The Hunter only keeps a moment when it looks like the PERSON WHO IS
     RECORDING (the "main player", whose view we are watching) got a kill.
     Nothing else is ever turned into a clip. No kill = no clip.

   HOW IT DECIDES (every kill must pass ALL of these tests):
     1. OWN SHOTS   - loud gunfire right before the moment (a few shots in the
                      last ~2 s). Far-away gunfights are quieter and rarely fit.
     2. TWO CLUES   - at least two of these three screen clues agree:
                        HIT MARKER (flash at the crosshair; only YOUR bullets make it)
                        CENTRE BANNER / skull / medal (only YOUR kills make it)
                        KILL-FEED LINE (new text line in the feed)
                      A feed line alone = probably a teammate => rejected.
                      A hit marker alone = you hurt someone but did not kill => rejected.
     3. NOT A DEATH - a big red damage flash with no hit marker means YOU
                      were shot, so it is rejected.
     4. NOT A CUT   - clues during a scene cut / camera whip are ignored
                      (the engine already zeroes those).
   Every rejected candidate stays in the event table with its reason, so you
   can see WHY something was not used.

   Each accepted kill gets a score 0..1 (stronger clues + gunfire = higher).
   Kills close together become one streak (double, triple...). The result has
   the same shape as Engine.detect(), so Engine.buildClips() is reused as is.

   HONEST LIMITS:
     - Without reading text (OCR) it cannot read your NAME. It recognises
       "your" kills from clues only YOUR actions create (hit marker, banner,
       your own gunfire). If a game shows no banner and no hit marker, accuracy
       drops: draw the boxes with "Calibrate" for that game.

   HOW TO IMPROVE:
     - Read the kill-feed text with OCR and match your player name.
     - Learn from the clips you keep / delete (adjust the thresholds).
   ===================================================================== */

const Hunter = (function () {
  "use strict";

  const DT = Engine.DT;

  // The biggest value of a time line between two times (seconds).
  function peak(arr, t0, t1) {
    const N = arr.length;
    const a = Math.max(0, Math.floor(t0 / DT)), b = Math.min(N - 1, Math.ceil(t1 / DT));
    let m = 0;
    for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  // Own gunfire just before time t: how many sharp shots, and how strong the loudest one is.
  function shotsBefore(onsets, t) {
    let n = 0, strongest = 0;
    for (const o of onsets) {
      if (o.t > t + 0.25) break;                 // onsets are in time order
      if (o.t >= t - 2.4) { n++; if (o.s > strongest) strongest = o.s; }
    }
    return { n, strongest };
  }

  /* ---------------------------------------------------------------
     NAME MODE (used when the user taught the site their own name, see js/teach.js)
     The engine looked for the taught picture of the user's name in the kill-feed area of every
     frame (Engine: matchTemplate). Every time ONE MORE line with the user's name appears, that is
     a kill/death of the user. Lines that show up at a view switch (scene cut right after) are
     treated as the user's own DEATH and dropped (the camera jumps to a spectator view).
     No gunfire or hit marker is needed (abilities, knives and wall-bangs also count); gunfire
     only raises the confidence.
     --------------------------------------------------------------- */
  function detectByName(an, params) {
    const { N, ch } = an, M = ch.mine, C = ch.mineN, onsets = (an.onsets || []).slice().sort((a, b) => a.t - b.t);
    const stats = { candidates: 0, kills: 0, reasons: {}, mode: "name" };
    const events = [];
    const back = Math.round(1.6 / DT), ahead = Math.round(0.4 / DT);
    for (let j = 1; j < N; j++) {
      if (!(M[j] >= 0.55 && C[j] >= 1)) continue;
      let prevMax = 0;
      for (let k = Math.max(0, j - back); k < j; k++) if (C[k] > prevMax) prevMax = C[k];
      if (C[j] <= prevMax) continue;                                         // not a NEW line
      let stays = false;
      for (let k = j; k <= Math.min(N - 1, j + ahead); k++) if (C[k] >= C[j]) stays = true;
      if (!stays) continue;                                                  // flicker, not a real line
      const t = j * DT;
      stats.candidates++;
      let death = false;
      for (let k = Math.max(0, Math.round((t - 0.3) / DT)); k <= Math.min(N - 1, Math.round((t + 2.5) / DT)); k++) if (ch.cut[k] > 0) death = true;
      const gun = an.audioOk ? shotsBefore(onsets, t + 0.2) : { n: 0, strongest: 0 };
      if (death) { events.push({ t, conf: 0.2, kind: "feed", why: "rejected: the view switched right after (probably your own death)" }); stats.reasons["your own death (view switch)"] = (stats.reasons["your own death (view switch)"] || 0) + 1; continue; }
      const conf = Math.min(1, 0.7 + Math.min(0.2, (M[j] - 0.55) * 0.5) + (gun.n >= 2 ? 0.1 : 0));
      events.push({ t, conf, kind: "kill", why: "your name appeared in the kill feed (match " + M[j].toFixed(2) + (gun.n ? ", " + gun.n + " shot(s) before" : "") + ")" });
    }
    return finish(an, params, events, stats, true);
  }

  // Shared ending: drop doubles, group into streaks, build the picture line.
  /* EVIDENCE TIERS (v5.7, from the editing spec): a kill is APPROVED only when your NAME was found on the kill-feed row (taught or
     automatic) - that is the proof it is the main player's kill. Kills found by clues only (sound + hit marker + banner) cannot be
     attributed to you, so they are REVIEW REQUIRED, never silently approved. Lobby / death / teammate rows are REJECTED. */
  function finish(an, params, events, stats, named) {
    const prof = PROFILES[params.profile] || PROFILES.shooter_tr, N = an.N;
    events.sort((a, b) => a.t - b.t);
    // REFEREE: a kill must happen inside a real firefight (not in the lobby / buy phase).
    if (typeof Referee !== "undefined") { const r = Referee.judge(an, events); for (const k in r) stats.reasons[k] = (stats.reasons[k] || 0) + r[k]; }
    events.forEach((e) => { e.tier = e.kind !== "kill" ? "rejected" : named ? "approved" : "review"; });
    const kept = [];
    for (const e of events) {
      const last = kept[kept.length - 1];
      if (last && e.t - last.t < 0.9) { if (e.kind === "kill" && (last.kind !== "kill" || e.conf > last.conf)) kept[kept.length - 1] = e; }
      else kept.push(e);
    }
    const gap = params.gap || prof.gap || 7;
    const scenes = []; let curS = null;
    for (const e of kept) {
      if (e.kind !== "kill") continue;
      if (curS && e.t - curS.events[curS.events.length - 1].t <= gap) curS.events.push(e);
      else { curS = { events: [e] }; scenes.push(curS); }
    }
    scenes.forEach((s) => {
      s.kills = s.events.length; s.first = s.events[0].t; s.last = s.events[s.events.length - 1].t;
      s.score = s.events.reduce((sum, e, idx) => sum + e.conf * (1 + 0.4 * idx), 0);
      s.conf = Math.max(...s.events.map((e) => e.conf));
      s.tier = s.events.some((e) => e.tier === "approved") ? "approved" : "review";
      const n = s.kills;
      s.label = n >= 5 ? "Multi-kill x" + n : n === 4 ? "Quad kill" : n === 3 ? "Triple kill" : n === 2 ? "Double kill" : "Kill";
    });
    const E = new Float32Array(N);
    kept.forEach((e) => { if (e.kind === "kill") { const j = Math.min(N - 1, Math.round(e.t / DT)); for (let k = Math.max(0, j - 5); k <= Math.min(N - 1, j + 5); k++) E[k] = Math.max(E[k], e.conf); } });
    stats.kills = scenes.reduce((n, s) => n + s.kills, 0);
    return { events: kept, scenes, E, stats };
  }

  /* detect(an, params) -> { events, scenes, E }
       params.sens : above 1 accepts weaker evidence (more kills), below 1 is stricter */
  function detect(an, params) {
    if (an.hasTemplate && an.ch.mine) return detectByName(an, params);
    // AUTOMATIC NAME (js/autoname.js): the name was found by itself, so use the rows it matched.
    if (an.auto && an.auto.ok) { const r = finish(an, params, an.auto.events, Object.assign({ candidates: an.auto.events.length, reasons: {} }, an.auto.stats), true); return r; }
    const sens = params.sens || 1;
    const prof = PROFILES[params.profile] || PROFILES.shooter_tr;
    const { N, ch } = an;
    const onsets = (an.onsets || []).slice().sort((a, b) => a.t - b.t);
    const events = [];

    // Thresholds for "this clue is really present" (lower = easier).
    const T = { hit: 0.34 / sens, banner: 0.34 / sens, feed: 0.30 / sens };

    // ---- 1) CANDIDATES: local peaks of a combined screen-clue line ----
    const V = new Float32Array(N);
    const dil = (arr, j, r) => { let m = 0; for (let k = Math.max(0, j - r); k <= Math.min(N - 1, j + r); k++) if (arr[k] > m) m = arr[k]; return m; };
    for (let j = 0; j < N; j++) V[j] = dil(ch.hit, j, 3) * 0.6 + dil(ch.banner, j, 4) * 0.8 + dil(ch.killfeed, j, 3) * 0.5;
    const cand = [];
    for (let j = 0; j < N; j++) {
      if (V[j] < 0.25 / sens) continue;
      let isMax = true;
      for (let k = Math.max(0, j - 6); k <= Math.min(N - 1, j + 6); k++) if (V[k] > V[j] || (V[k] === V[j] && k < j)) { isMax = false; break; }
      if (isMax) cand.push(j);
    }

    const stats = { candidates: cand.length, kills: 0, reasons: {} };
    // ---- 2) JUDGE every candidate ----
    for (const j of cand) {
      const t = j * DT;
      const hit = peak(ch.hit, t - 0.7, t + 0.5);
      const ban = peak(ch.banner, t - 0.4, t + 1.3);          // banners appear a little AFTER the shot
      const feed = peak(ch.killfeed, t - 0.6, t + 0.9);
      const red = peak(ch.red, t - 1.2, t + 0.3);
      const gun = an.audioOk ? shotsBefore(onsets, t) : { n: 99, strongest: 99 };   // no sound: this test cannot be used

      const clues = (hit >= T.hit ? 1 : 0) + (ban >= T.banner ? 1 : 0) + (feed >= T.feed ? 1 : 0);
      const shooting = gun.n >= 2 || gun.strongest >= 3.0 / Math.sqrt(sens);
      const strongClue = ban >= 0.6;                // only the centre banner may stand alone (a hit marker alone just means you hurt someone)

      let reason = "", ok = true;
      if (an.audioOk && !shooting) { ok = false; reason = "no gunfire of your own just before it"; }
      else if (clues < 2 && !(clues === 1 && strongClue && an.audioOk && gun.n >= 3)) {
        ok = false;
        reason = clues === 0 ? "too weak" : (feed >= T.feed && hit < T.hit && ban < T.banner) ? "kill-feed only (probably a teammate)" : "only one clue (no kill confirmed)";
      } else if (red >= 0.8 && hit < 0.5) { ok = false; reason = "you were hit (red flash), probably your own death"; }

      // Score: stronger clues + clear gunfire = higher.
      const clue = Math.min(1, hit / 0.8) * 0.35 + Math.min(1, ban / 0.8) * 0.35 + Math.min(1, feed / 0.7) * 0.2;
      const gunS = an.audioOk ? Math.min(1, gun.n / 4) * 0.1 + Math.min(1, gun.strongest / 5) * 0.1 : 0.1;
      const conf = Math.min(1, clue + gunS + (clues >= 3 ? 0.1 : 0));
      if (ok) {
        const names = [hit >= T.hit ? "hit marker" : "", ban >= T.banner ? "centre banner" : "", feed >= T.feed ? "kill feed" : ""].filter(Boolean);
        events.push({ t, conf, kind: "kill", why: "your kill: " + names.join(" + ") + (an.audioOk ? " + " + gun.n + " shot(s) before" : "") });
      } else if (conf > 0.15) {
        events.push({ t, conf: conf * 0.5, kind: "feed", why: "rejected: " + reason });
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      }
    }

    return finish(an, params, events, stats);
  }

  return { detect };
})();

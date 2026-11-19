/* =====================================================================
   js/referee.js  -  the REFEREE (v5.5): "is this really a live fight, and is this really MY kill?"
   =====================================================================
   WHY IT EXISTS (plain words)
     A real report showed clips cut from the LOBBY / BUY PHASE (the first ~30-45 s of every Valorant
     round) and no real kills at all. Reason: the lobby has loud MUSIC and blinking names. Music has
     sharp beats that look exactly like gunshots to a simple sound detector, and a blinking name list
     looks like "my name appeared in the kill feed". So the site "found" dozens of fake kills there.

   WHAT THE REFEREE DOES (3 steps)
     1. cleanOnsets(): finds sound beats that repeat like MUSIC (a steady train of beats lasting many
        seconds) and throws them away. Gunfire comes in short bursts with pauses, so it stays.
     2. fight(an, t): counts the REAL gunshots in the 8 seconds before time t. A live round has many,
        a lobby / buy phase / menu has none. This tells us "a fight is going on here".
     3. judge(an, events): every kill must happen inside a fight. Kills outside one are rejected with
        the reason "no firefight around (lobby / buy phase / menu)". Every decision (accepted or
        rejected, and why) is written to an.decisions so the status line and the report can show it.

   HOW TO IMPROVE: also read the round timer / BUY PHASE text with OCR to know the phase exactly;
     use the game's own sound (spike plant beep, round-start gong) as extra phase markers.
   ===================================================================== */
const Referee = (function () {
  "use strict";

  const FIGHT_WINDOW = 8;      // seconds looked back to decide "a fight is going on"
  const FIGHT_MIN = 3;         // real shots needed inside that window
  const SHOT_MIN_S = 1.2;      // a beat must be at least this strong to count as a shot

  /* ---- 1) remove music-like beat trains ----
     A "run" = beats whose neighbours are never more than 1.2 s apart. If a run lasts 8 s or more with
     at least 12 beats AND the gaps are very regular (or repeat as double / half), it is music. */
  function cleanOnsets(onsets) {
    const s = onsets.slice().sort((a, b) => a.t - b.t);
    const drop = new Set();
    let i = 0, musicSec = 0;
    while (i < s.length) {
      let j = i;
      while (j + 1 < s.length && s[j + 1].t - s[j].t <= 1.2) j++;
      const n = j - i + 1, dur = s[j].t - s[i].t;
      if (n >= 12 && dur >= 8) {
        const gaps = []; for (let k = i + 1; k <= j; k++) gaps.push(s[k].t - s[k - 1].t);
        const sorted = gaps.slice().sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)] || 1;
        let regular = 0;
        for (const g of gaps) { const r = g / med; if (Math.abs(r - 1) < 0.22 || Math.abs(r - 2) < 0.3 || Math.abs(r - 0.5) < 0.12 || Math.abs(r - 3) < 0.4) regular++; }
        if (regular / gaps.length >= 0.6) { for (let k = i; k <= j; k++) drop.add(k); musicSec += dur; }
      }
      i = j + 1;
    }
    const clean = s.filter((_, k) => !drop.has(k));
    clean.musicBeats = drop.size; clean.musicSec = musicSec;
    return clean;
  }

  /* ---- 2) "is a fight going on at time t?" ---- */
  function shotTimes(an) {
    if (!an._shots) an._shots = (an.onsets || []).filter((o) => o.s >= SHOT_MIN_S).map((o) => o.t).sort((a, b) => a - b);
    return an._shots;
  }
  // Number of real shots in [t - 8 s, t + 0.5 s].
  function fight(an, t) {
    const a = shotTimes(an); let n = 0;
    for (let k = 0; k < a.length; k++) { if (a[k] > t + 0.5) break; if (a[k] >= t - FIGHT_WINDOW) n++; }
    return n;
  }
  const live = (an, t) => !an.audioOk || fight(an, t) >= FIGHT_MIN;

  /* ---- 3) judge the kill events ----
     events: [{t, conf, kind, why}]. Kills with no fight around become kind "feed" (rejected). */
  function judge(an, events) {
    const log = an.decisions = [], reasons = {};
    for (const e of events) {
      if (e.kind !== "kill") { log.push({ t: e.t, ok: false, why: e.why }); continue; }
      const f = an.audioOk ? fight(an, e.t) : 99;
      if (f < FIGHT_MIN) {
        e.kind = "feed"; e.conf = Math.min(e.conf, 0.15);
        e.why = "rejected: no firefight around (lobby / buy phase / menu) - only " + f + " real shot(s) in the 8 s before";
        reasons["no firefight around (lobby / buy phase / menu)"] = (reasons["no firefight around (lobby / buy phase / menu)"] || 0) + 1;
      } else e.why += " | " + f + " real shots in the 8 s before";
      log.push({ t: e.t, ok: e.kind === "kill", why: e.why });
    }
    return reasons;
  }

  return { cleanOnsets, fight, live, judge, FIGHT_MIN };
})();

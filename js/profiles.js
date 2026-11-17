/* =====================================================================
   js/profiles.js  -  game "profiles" (what to look for in each kind of video)
   =====================================================================
   WHY THIS FILE EXISTS:
     Every game shows kills in a different place and sounds different.
     A profile tells the Highlight Engine WHERE to look on the screen
     (kill feed, centre banner, hit marker) and HOW MUCH to trust each clue.

   HOW IT WORKS:
     - regions: boxes in fractions of the screen (x, y = top-left corner,
       w, h = size, all from 0 to 1). 0.5 means "half way across".
     - w (weights): how important each clue is when scoring a moment.
         killfeed = new line appears in the kill feed
         banner   = big text/medal appears (e.g. "ELIMINATED", "Headshot")
         hit      = hit-marker flash around the crosshair
         burst    = fast gunfire-like sound bursts
         boom     = explosion / heavy low sound
         loud     = overall loudness (cheering, commentary, music peaks)
         motion   = lots of movement on screen
         flash    = sudden bright flash on the whole screen
         red      = red damage flash / blood on the screen
     - gap: shots closer together than this many seconds count as one streak
     - pre / post: seconds of lead-in and after-action added around a streak

   HOW TO IMPROVE:
     - Add more profiles (copy one and change the boxes).
     - Use the "Calibrate" button in the site to draw the boxes yourself;
       your boxes are saved and override these defaults.
   ===================================================================== */

const PROFILES = {
  auto: {
    name: "Any video (auto - sound + action)",
    feed: false, regions: {},
    w: { killfeed: 0, banner: 0, hit: 0, burst: 0.8, boom: 0.5, loud: 0.9, motion: 0.7, flash: 0.4, red: 0.2 },
    gap: 6, pre: 4, post: 3
  },
  shooter_tr: {
    name: "Shooter - kill feed top-right (BGMI, PUBG, Free Fire, Valorant, CS2, Fortnite...)",
    feed: true,
    regions: {
      killfeed: { x: 0.62, y: 0.03, w: 0.37, h: 0.27 },
      banner:   { x: 0.28, y: 0.60, w: 0.44, h: 0.22 },
      hit:      { x: 0.44, y: 0.40, w: 0.12, h: 0.20 }
    },
    w: { killfeed: 1, banner: 0.7, hit: 0.5, burst: 0.9, boom: 0.5, loud: 0.4, motion: 0.3, flash: 0.3, red: 0.2 },
    gap: 7, pre: 5, post: 3.5
  },
  shooter_tl: {
    name: "Shooter - kill feed top-left",
    feed: true,
    regions: {
      killfeed: { x: 0.01, y: 0.03, w: 0.37, h: 0.27 },
      banner:   { x: 0.28, y: 0.60, w: 0.44, h: 0.22 },
      hit:      { x: 0.44, y: 0.40, w: 0.12, h: 0.20 }
    },
    w: { killfeed: 1, banner: 0.7, hit: 0.5, burst: 0.9, boom: 0.5, loud: 0.4, motion: 0.3, flash: 0.3, red: 0.2 },
    gap: 7, pre: 5, post: 3.5
  },
  // Used by the Main-player Hunter when the game's layout is unknown: the kill feed is searched along the WHOLE top
  // of the screen (works for top-left, top-centre and top-right layouts). Static HUD pieces (map, counters) do not matter,
  // because the engine only reacts to NEW text appearing.
  shooter_top: {
    name: "Shooter - kill feed anywhere along the top (Free Fire, BGMI, PUBG, CoD Mobile...)",
    feed: true,
    regions: {
      killfeed: { x: 0.03, y: 0.02, w: 0.94, h: 0.30 },
      banner:   { x: 0.20, y: 0.50, w: 0.60, h: 0.35 },
      hit:      { x: 0.40, y: 0.35, w: 0.20, h: 0.30 }
    },
    w: { killfeed: 1, banner: 0.7, hit: 0.5, burst: 0.9, boom: 0.5, loud: 0.4, motion: 0.3, flash: 0.3, red: 0.2 },
    gap: 7, pre: 5, post: 3.5
  },
  shooter_bl: {
    name: "Shooter - kill feed bottom-left",
    feed: true,
    regions: {
      killfeed: { x: 0.01, y: 0.55, w: 0.34, h: 0.30 },
      banner:   { x: 0.28, y: 0.60, w: 0.44, h: 0.22 },
      hit:      { x: 0.44, y: 0.40, w: 0.12, h: 0.20 }
    },
    w: { killfeed: 1, banner: 0.7, hit: 0.5, burst: 0.9, boom: 0.5, loud: 0.4, motion: 0.3, flash: 0.3, red: 0.2 },
    gap: 7, pre: 5, post: 3.5
  },
  action: {
    name: "Sports / racing / action (crowd, engines, big moments)",
    feed: false, regions: {},
    w: { killfeed: 0, banner: 0, hit: 0, burst: 0.3, boom: 0.6, loud: 1, motion: 0.9, flash: 0.5, red: 0.1 },
    gap: 8, pre: 5, post: 4
  },
  talk: {
    name: "Talk / podcast / vlog (energetic speech)",
    feed: false, regions: {},
    w: { killfeed: 0, banner: 0, hit: 0, burst: 0.1, boom: 0.1, loud: 1, motion: 0.4, flash: 0.1, red: 0 },
    gap: 10, pre: 3, post: 3
  }
};

// Platform length limits (seconds). Rules change, so check the platforms before uploading.
const PLATFORMS = {
  both59:  { name: "YouTube Shorts + Instagram Reels (up to 59 s)", max: 59 },
  reels90: { name: "Instagram Reels (up to 90 s)", max: 90 },
  shorts3: { name: "YouTube Shorts (up to 3 min)", max: 180 },
  long:    { name: "Longer highlight (up to 5 min)", max: 300 }
};

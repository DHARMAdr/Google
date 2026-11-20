/* =====================================================================================
   doctor.js  -  "Troubleshoot": finds common problems and fixes them with one tap (v5.11)
   -------------------------------------------------------------------------------------
   WHY IT EXISTS
   - People hit the same few problems again and again: an old cached copy of the site,
     a full browser storage, a dead video decoder, a job that froze while the app was
     minimised. Before, they had to read a report. Now the site checks itself and offers a button.
   HOW IT WORKS
   1. Doctor.scan() runs small RULES. Each rule returns nothing (all fine) or a finding:
      { id, level: "bad"|"warn"|"info", title, text, fixLabel, fix() }.
   2. A tiny tracker counts how long the page was HIDDEN (minimised / other app) while a job ran.
      Phones freeze hidden pages, so this explains "it stopped when I left the app".
   3. A watchdog looks every 5 s: if a job is running but the progress bar has not moved for
      90 s, it shows a toast that opens this dialog.
   HOW TO IMPROVE
   - Add a rule: push another block into scan(). Keep rules cheap (no heavy work).
   - Send findings to the server for a fleet view (Cloud.report) if you ever run one.
   ===================================================================================== */
const Doctor = (() => {
  const hidden = { ms: 0, times: 0, since: 0, jobMs: 0 };   // time spent hidden, how many times, and hidden while a job ran
  let lastBar = "", lastMove = Date.now(), stuckShown = false, lastFindings = [];

  const busy = () => (typeof analysing !== "undefined" && analysing) || (typeof exporting !== "undefined" && exporting);

  // ---- hidden-time tracker ----
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hidden.since = Date.now(); hidden.wasBusy = busy(); }
    else if (hidden.since) {
      const d = Date.now() - hidden.since; hidden.ms += d; hidden.times++;
      if (hidden.wasBusy || busy()) hidden.jobMs += d;
      hidden.since = 0;
      // Came back after a long hidden time during a job: the phone may have frozen the page.
      if (d > 20000 && busy()) { lastMove = Date.now(); try { toast("You were away " + Math.round(d / 1000) + " s. If progress stopped, open Troubleshoot."); } catch (e) { /* ignore */ } }
    }
  });

  // ---- watchdog: a job whose progress bar does not move ----
  setInterval(() => {
    if (!busy()) { stuckShown = false; lastMove = Date.now(); return; }
    const bar = (document.getElementById("aBar") || {}).style, bar2 = (document.getElementById("eBar") || {}).style;
    const sig = (bar && bar.width) + "|" + (bar2 && bar2.width) + "|" + ((document.getElementById("aStatus") || {}).textContent || "");
    if (sig !== lastBar) { lastBar = sig; lastMove = Date.now(); stuckShown = false; return; }
    if (Date.now() - lastMove > 90000 && !stuckShown && document.visibilityState === "visible") {
      stuckShown = true;
      try { toast("No progress for 90 s. Tap Troubleshoot for a fix.", true); } catch (e) { /* ignore */ }
      try { Diag.crumb("watchdog: no progress for 90 s"); } catch (e) { /* ignore */ }
    }
  }, 5000);

  /* ---------- the rules ---------- */
  async function scan() {
    const F = [];
    const add = (f) => F.push(f);

    // 1. Old cached copy of the site
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        const keys = await caches.keys();
        const mine = keys.filter((k) => /^clipcutter-v\d+/.test(k)), cur = mine.sort().pop();
        if (mine.length > 0 && regs.length) add({ id: "sw", level: "info", title: "Site files cache", text: "Using cache " + cur + ", app " + Diag.version + ". If something looks old or buggy, refresh the site files (your videos are not touched).", fixLabel: "Refresh site files", fix: async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); location.reload(); } });
      }
    } catch (e) { /* ignore */ }

    // 2. Storage space
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const s = await navigator.storage.estimate(), used = s.usage || 0, quota = s.quota || 1, pct = used / quota;
        const mb = Math.round(used / 1048576);
        if (pct > 0.8) add({ id: "space", level: "bad", title: "Browser storage almost full (" + mb + " MB, " + Math.round(pct * 100) + "%)", text: "Big videos and cached analysis fill it. Clearing the analysis cache frees space (analysis can be run again).", fixLabel: "Clear analysis cache", fix: async () => { await Persist.cacheClear(); } });
        else if (pct > 0.5) add({ id: "space", level: "warn", title: "Storage is half full (" + mb + " MB)", text: "Fine for now. Clear the cache if you see 'not enough space'.", fixLabel: "Clear analysis cache", fix: async () => { await Persist.cacheClear(); } });
      }
    } catch (e) { /* ignore */ }

    // 3. Safe mode (decoder skipped)
    if (store.get("safe", false)) add({ id: "safe", level: "info", title: "Safe mode is ON", text: "The hardware video decoder is skipped. Analysis is slower but avoids decoder crashes.", fixLabel: "Turn safe mode off", fix: () => store.set("safe", false) });
    else add({ id: "safe", level: "info", title: "Analysis crashes or freezes?", text: "Safe mode skips the hardware decoder. Slower, but works on phones whose decoder breaks.", fixLabel: "Turn safe mode on", fix: () => store.set("safe", true) });

    // 4. Low memory device
    const mem = navigator.deviceMemory || 0, depth = $("depthSel") && +$("depthSel").value;
    if (mem && mem <= 4 && depth > 5) add({ id: "mem", level: "warn", title: "Low-memory device with heavy detail", text: "This device reports ~" + mem + " GB RAM. Detail " + depth + " fps may crash the tab.", fixLabel: "Use Balanced (5 fps)", fix: () => { $("depthSel").value = "5"; $("depthSel").dispatchEvent(new Event("change")); } });

    // 5. Export stalls: use the steady engine
    const eng = $("engineSel") && $("engineSel").value;
    if (eng === "turbo" || eng === "fast") add({ id: "export", level: "info", title: "Export freezes or says 'codec reclaimed'?", text: "Switch to the lossless 'Original quality, instant' cut or the ffmpeg engine; they never use the hardware encoder.", fixLabel: "Use ffmpeg engine", fix: () => { $("engineSel").value = "hq"; $("engineSel").dispatchEvent(new Event("change")); } });

    // 6. Hidden-time
    if (hidden.jobMs > 15000) add({ id: "hidden", level: "warn", title: "The app was minimised for " + Math.round(hidden.jobMs / 1000) + " s during a job", text: "Phones freeze hidden pages. Keep ClipCutter on screen (the site plays a silent sound and holds the screen awake to help). Long videos survive because progress is saved: just run Analyse again and it resumes." });

    // 7. Stuck job
    if (busy() && Date.now() - lastMove > 60000) add({ id: "stuck", level: "bad", title: "Job not moving for " + Math.round((Date.now() - lastMove) / 1000) + " s", text: "Reload the page. Saved progress is kept, so Analyse resumes where it stopped.", fixLabel: "Reload now", fix: () => location.reload() });

    // 8. Missing browser features
    const miss = [];
    if (typeof VideoDecoder === "undefined") miss.push("WebCodecs VideoDecoder");
    if (typeof VideoEncoder === "undefined") miss.push("VideoEncoder");
    if (!window.indexedDB) miss.push("IndexedDB");
    if (miss.length) add({ id: "feat", level: "warn", title: "Browser lacks: " + miss.join(", "), text: "Use a current Chrome or Edge for full speed. Slower backup methods are used automatically." });

    // 9. Recent errors
    try { const n = (Diag.reports || []).filter((r) => r.recovered !== true).length; if (n) add({ id: "errs", level: "warn", title: n + " unresolved error report(s) saved", text: "Open Report in the header and send the newest one." }); } catch (e) { /* ignore */ }

    if (!F.some((f) => f.level !== "info")) F.unshift({ id: "ok", level: "ok", title: "No problems found", text: "Everything checked looks healthy. Options below are for when something still misbehaves." });
    lastFindings = F;
    return F;
  }

  /* ---------- the dialog ---------- */
  async function open() {
    let dlg = document.getElementById("docDlg");
    if (!dlg) {
      dlg = document.createElement("dialog"); dlg.id = "docDlg";
      dlg.innerHTML = '<h3 style="margin:0 0 6px">Troubleshoot</h3><p class="muted small" style="margin:0 0 10px">The site checked itself. Tap a button to fix a problem. Your videos and clips are never deleted by these fixes.</p><div id="docList"></div><div class="row" style="margin-top:10px"><button class="ghost small" id="docRescan">Check again</button><button class="ghost small" id="docClose">Close</button></div>';
      document.body.appendChild(dlg);
      dlg.querySelector("#docClose").onclick = () => dlg.close();
      dlg.querySelector("#docRescan").onclick = () => render(dlg);
    }
    dlg.showModal(); await render(dlg);
  }
  async function render(dlg) {
    const list = dlg.querySelector("#docList"); list.textContent = "Checking...";
    const F = await scan(); list.textContent = "";
    F.forEach((f) => {
      const box = document.createElement("div"); box.className = "card"; box.style.cssText = "margin:0 0 8px;padding:10px;border-left:4px solid " + ({ bad: "#ff4d6d", warn: "#ffb84d", ok: "#3ecf8e", info: "#4dabff" }[f.level] || "#888");
      const t = document.createElement("strong"); t.textContent = f.title;
      const p = document.createElement("div"); p.className = "muted small"; p.textContent = f.text;
      box.append(t, p);
      if (f.fix) {
        const b = document.createElement("button"); b.className = "small"; b.style.marginTop = "6px"; b.textContent = f.fixLabel || "Fix";
        b.onclick = async () => { b.disabled = true; try { await f.fix(); toast("Done: " + (f.fixLabel || "fixed")); } catch (e) { toast("Could not fix: " + (e.message || e), true); } render(dlg); };
        box.append(b);
      }
      list.append(box);
    });
  }

  // Text for the error report (section 4c).
  function summary() {
    const L = ["- hidden: " + Math.round(hidden.ms / 1000) + " s in " + hidden.times + " time(s); during jobs " + Math.round(hidden.jobMs / 1000) + " s",
      "- safe mode: " + (store.get("safe", false) ? "ON" : "off"),
      "- last scan: " + (lastFindings.filter((f) => f.level === "bad" || f.level === "warn").map((f) => f.title).join(" | ") || "nothing flagged / not run")];
    return L.join("\n");
  }

  function init() { const b = document.getElementById("docBtn"); if (b) b.addEventListener("click", open); }
  return { init, scan, open, summary, hidden };
})();
document.addEventListener("DOMContentLoaded", Doctor.init);

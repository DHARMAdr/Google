/* =====================================================================
   js/profile.js  -  PROFILES screen (username + 6-digit code) and the admin ("parent") view
   =====================================================================
   WHAT IT DOES:
     - Log in / create a profile on YOUR Cloudflare storage server (see /cloudflare-storage).
       The server address is typed by hand each time (nothing is pre-filled on purpose).
     - Logged in: new videos are uploaded to the server automatically (Cloud.auto) and each
       finished Short is kept there too (see Cloud.putClip in js/cloud.js). Every profile only
       sees its own files.
     - "My videos on the server": load a video back onto this device, download or delete clips.
     - ADMIN profile ("parent"): also sees every other profile (videos, clips, size, last seen),
       can download/delete their files, reset their code, or delete a profile.
     - LOG OUT: the page forgets the server + session and clears its own local copy of the library
       (the files stay safe on the server) so the next person starts clean.
   HOW IT IS BUILT: all text from the server is put on screen with textContent (never innerHTML),
     so a strange username or file name cannot inject code.
   HOW TO IMPROVE: show thumbnails, let the admin watch a clip in the dialog, add "stay logged in".
   ===================================================================== */
(function () {
  "use strict";

  // on(id, event, fn): like addEventListener, but if the element is missing (an old cached index.html) it is skipped instead of crashing everything.
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); else console.warn("profile.js: element #" + id + " is missing - reload the page to get the newest version"); };
  const dlg = $("profDlg"), msg = (t, bad) => { $("pfMsg").textContent = t || ""; $("pfMsg").style.color = bad ? "var(--bad, #e5484d)" : ""; };
  const mb = (n) => (n / 1048576).toFixed(n > 1e9 ? 0 : 1) + " MB";
  const when = (t) => t ? new Date(t).toLocaleString() : "never";

  // A small helper that builds a DOM element (text is always set with textContent).
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function btn(text, fn, cls) { const b = el("button", text, "small " + (cls || "ghost")); b.onclick = fn; return b; }

  // Header button shows who is logged in.
  function refreshHeader() {
    const p = Cloud.profile();
    $("profBtn").textContent = p.loggedIn ? "Profile: " + p.user + (p.role === "admin" ? " (admin)" : "") : "Profile";
  }

  // Remove everything of THIS device's library without touching the server copies.
  function clearLocalLibrary() {
    [...lib].forEach((v) => { v.remote = null; removeVideo(v); });      // remote=null: Cloud.remove() then has nothing to delete on the server
    afterLibraryChange();
  }

  /* ---------- lists ---------- */
  function renderVideos(box, videos, who) {
    box.textContent = "";
    if (!videos.length) { box.appendChild(el("div", "Nothing here yet.", "muted")); return; }
    for (const v of videos) {
      const row = el("div"); row.style.cssText = "border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0";
      row.appendChild(el("div", v.name + "  -  " + mb(v.size) + "  -  " + when(v.created) + (v.complete ? "" : "  (upload unfinished)") + (who ? "  -  " + v.owner : "")));
      const acts = el("div"); acts.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px";
      if (v.complete) acts.appendChild(btn("Load on this device", () => loadVideo(v)));
      acts.appendChild(btn("Delete video", async () => {
        if (!confirm('Delete "' + v.name + '" and its clips from the server?')) return;
        try { await Cloud.delVideoId(v.id); (who ? openUser(who) : refreshMine()); } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
      }, "danger"));
      row.appendChild(acts);
      const clips = Object.entries(v.clips || {});
      for (const [cid, c] of clips) {
        const line = el("div"); line.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;padding-left:10px";
        line.appendChild(el("span", "Short: " + c.name + " (" + mb(c.size) + ")"));
        line.appendChild(btn("Download", async () => {
          try { msg("Downloading..."); const b = await Cloud.fetchBlob("/api/videos/" + v.id + "/clips/" + cid + "/file"); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = c.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); msg(""); } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
        }));
        line.appendChild(btn("Delete", async () => { try { await Cloud.delClipId(v.id, cid); (who ? openUser(who) : refreshMine()); } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); } }, "danger"));
        row.appendChild(line);
      }
      box.appendChild(row);
    }
  }

  // Bring a stored video back into the library of this device.
  async function loadVideo(v) {
    if (lib.some((x) => x.remote && x.remote.id === v.id)) { msg("That video is already in your library on this device."); return; }
    try {
      msg("Downloading " + v.name + "...");
      const blob = await Cloud.fetchBlob("/api/videos/" + v.id + "/file", (f) => msg("Downloading " + v.name + "... " + Math.round(f * 100) + "%"));
      await addFiles([new File([blob], v.name, { type: "video/mp4" })], { remote: v.id });
      msg("Loaded " + v.name + ". Close this window to work with it.");
    } catch (e) { msg("Could not load it: " + errText(e), true); }
  }

  async function refreshMine() {
    try { const r = await Cloud.listMine(); const mine = Cloud.profile().role === "admin" ? r.videos.filter((x) => x.owner === Cloud.profile().user || x.owner === "owner") : r.videos; renderVideos($("pfMine"), mine); }
    catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
  }

  async function refreshAdmin() {
    const box = $("pfUsers"); box.textContent = "";
    try {
      const r = await Cloud.adminUsers();
      for (const u of r.users) {
        const row = el("div"); row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid var(--line);padding:6px 0";
        row.appendChild(el("b", u.name + (u.role === "admin" ? " (admin)" : "")));
        row.appendChild(el("span", u.videos + " video(s), " + u.clips + " short(s), " + mb(u.bytes) + ", last seen " + when(u.lastSeen)));
        row.appendChild(btn("View files", () => openUser(u.name)));
        row.appendChild(btn("Reset code", async () => {
          const pin = prompt("New 6-digit code for " + u.name + ":"); if (pin === null) return;
          try { await Cloud.adminPin(u.name, pin.trim()); msg("Code changed for " + u.name + "."); } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
        }));
        if (u.role !== "admin") row.appendChild(btn("Delete profile", async () => {
          if (!confirm("Delete the profile " + u.name + " and ALL its videos and Shorts from the server? This cannot be undone.")) return;
          try { await Cloud.adminDelete(u.name); $("pfUserVids").textContent = ""; refreshAdmin(); } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
        }, "danger"));
        box.appendChild(row);
      }
    } catch (e) { msg(errText(e).replace(/^CloudError: /, ""), true); }
  }
  async function openUser(name) {
    const box = $("pfUserVids"); box.textContent = "Loading " + name + "...";
    try { const r = await Cloud.adminVideos(name); box.textContent = ""; box.appendChild(el("b", "Files of " + name)); const holder = el("div"); box.appendChild(holder); renderVideos(holder, r.videos, name); refreshAdmin(); }
    catch (e) { box.textContent = ""; msg(errText(e).replace(/^CloudError: /, ""), true); }
  }

  /* ---------- show the right half of the dialog ---------- */
  function showState() {
    const p = Cloud.profile(), inn = p.loggedIn;
    $("pfOut").hidden = inn; $("pfIn").hidden = !inn;
    $("pfLogin").hidden = inn; $("pfReg").hidden = inn; $("pfLogout").hidden = !inn; $("pfRefresh").hidden = !inn;
    $("pfTitle").textContent = inn ? "Profile" : "Log in";
    $("pfAdmin").hidden = !(inn && p.role === "admin");
    if (inn) {
      $("pfWho").textContent = "Logged in as " + p.user + (p.role === "admin" ? " (ADMIN - you can see all profiles)" : "") + " on " + Cloud.getConfig().url;
      refreshMine(); if (p.role === "admin") refreshAdmin();
    }
    if (inn && $("pfOffload")) $("pfOffload").checked = Cloud.getConfig().offload !== false;
    refreshHeader();
  }

  async function doSign(kind) {
    const url = $("pfUrl").value.trim(), u = $("pfUser").value.trim(), pin = $("pfPin").value.trim();
    if (!/^\d{6}$/.test(pin)) { msg("The code must be exactly 6 digits.", true); return; }
    msg(kind === "login" ? "Logging in..." : "Creating the profile...");
    try {
      const wasOwner = store.get("libOwner", "");
      const r = kind === "login" ? await Cloud.login(url, u, pin) : await Cloud.register(url, u, pin, $("pfKey").value.trim());
      if (wasOwner && wasOwner !== r.user && lib.length) clearLocalLibrary();      // another person's files must not show up under this profile
      store.set("libOwner", r.user);
      $("pfPin").value = ""; $("pfKey").value = "";
      msg(""); showState(); Cloud.flushDeletes(); if (typeof pullFromServer === "function") pullFromServer();
      toast("Welcome, " + r.user + (r.role === "admin" ? " (admin)" : "") + ". New videos are saved to your server automatically.");
    } catch (e) { msg(errText(e).replace(/^CloudError: /, "") + "\n\nPress \"Server: check / set up\" to find out exactly what is wrong.", true); }
  }

  async function doLogout() {
    if (analysing || exporting) { alert("Please wait for the current work to finish."); return; }
    const unsaved = lib.filter((v) => !(v.remote && v.remote.complete));
    const warn = unsaved.length ? "\n\nWARNING: " + unsaved.length + " video(s) are NOT on the server yet and will be removed from this device: " + unsaved.map((v) => v.name).join(", ") : "";
    if (!confirm("Log out? This page will forget the server and clear its local copy. Your files stay on the server." + warn)) return;
    clearLocalLibrary();
    await Cloud.logout();
    store.set("libOwner", "");
    $("pfUserVids").textContent = ""; $("pfMine").textContent = "";
    msg(""); showState();
    if (typeof refreshCloudUI === "function") refreshCloudUI();
    toast("Logged out. The server was forgotten on this device.");
  }


  /* ---------- SERVER POP-UP ---------- */
  const sd = $("srvDlg");
  async function srvCheck() {
    const url = $("srvUrl").value.trim();
    $("srvSteps").textContent = "Checking..."; $("srvReport").hidden = true; $("srvCopyReport").hidden = true;
    let r;
    try { r = await Cloud.diagnose(url, { user: $("pfUser").value.trim(), pin: /^\d{6}$/.test($("pfPin").value.trim()) ? $("pfPin").value.trim() : "" }); }
    catch (e) { r = { ok: false, steps: [], report: "The check itself crashed: " + errText(e) }; }
    const box = $("srvSteps"); box.textContent = "";
    for (const x of r.steps) {
      const row = el("div"); row.style.cssText = "margin:4px 0;padding:6px 8px;border-radius:8px;border:1px solid var(--line)";
      row.appendChild(el("b", (x.ok ? "OK  " : "PROBLEM  ") + x.name)); row.appendChild(el("div", x.text));
      if (!x.ok && x.fix) { const f = el("div", "How to fix: " + x.fix); f.style.cssText = "margin-top:3px;color:var(--accent,#7cc)"; row.appendChild(f); }
      box.appendChild(row);
    }
    box.appendChild(el("div", r.ok ? "The server is working." : "The server is NOT working yet. Fix the first PROBLEM above, then check again. Press 'Copy server report' to send me the details.", r.ok ? "" : "")).style.fontWeight = "600";
    $("srvReport").value = r.report; $("srvReport").hidden = r.ok; $("srvCopyReport").hidden = false;
    if (r.ok && /^https?:/.test(url)) $("pfUrl").value = url;
    return r;
  }
  on("pfServer", "click", () => { $("srvUrl").value = $("pfUrl").value.trim() || Cloud.getConfig().url || ""; $("srvOrigin").textContent = location.origin; $("srvSteps").textContent = ""; $("srvReport").hidden = true; $("srvCopyReport").hidden = true; sd.showModal(); });
  on("srvCheck", "click", srvCheck);
  on("srvUse", "click", () => { $("pfUrl").value = $("srvUrl").value.trim(); sd.close(); msg("Server address filled in. Now type your username and code."); });
  on("srvHow", "click", () => { $("srvOrigin").textContent = location.origin; $("srvGuide").hidden = !$("srvGuide").hidden; });
  on("srvClose", "click", () => sd.close());
  on("srvCopyReport", "click", async () => { const t = $("srvReport").value; try { await navigator.clipboard.writeText(t); toast("Server report copied."); } catch (e) { $("srvReport").hidden = false; $("srvReport").select(); toast("Select the text and copy it."); } });
  on("srvCopyCode", "click", async () => {
    try { const t = await (await fetch("cloudflare-storage/worker.js", { cache: "no-store" })).text(); await navigator.clipboard.writeText(t); toast("Server code copied (" + Math.round(t.length / 1024) + " KB). Paste it into your Cloudflare Worker."); }
    catch (e) { toast("Could not copy: " + errText(e)); }
  });

  on("profBtn", "click", () => { msg(""); showState(); dlg.showModal(); });
  on("pfClose", "click", () => dlg.close());
  on("pfLogin", "click", () => doSign("login"));
  on("pfReg", "click", () => doSign("register"));
  on("pfLogout", "click", doLogout);
  on("pfOffload", "change", () => { Cloud.setConfig({ offload: $("pfOffload").checked }); toast($("pfOffload").checked ? "Videos on the server will be removed from this device when not in use." : "Videos stay on this device too."); });
  on("pfRefresh", "click", () => { msg(""); showState(); });
  on("pfPin", "keydown", (e) => { if (e.key === "Enter") doSign("login"); });
  window.addEventListener("cc-session-expired", () => { refreshHeader(); toast("Your login ran out. Open Profile and enter your code again."); });
  refreshHeader();
})();

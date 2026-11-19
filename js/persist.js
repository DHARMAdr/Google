/* =====================================================================
   js/persist.js  -  remembers your library between visits
   =====================================================================
   WHY: before, closing the tab (or the phone killing it in the background) lost your uploaded video,
   your clips and your exported files, and you had to start again.

   WHAT IS SAVED (all inside this browser, nothing is uploaded anywhere):
     - IndexedDB "clipcutter" / "videos": one small record per video (name, size, length, the clip list,
       trim points, thumbnail). The video itself is already kept in private storage by compat.js.
     - Private file storage (OPFS) folder "clipcutter-exports": the finished clip files.

   HOW IT WORKS: app.js calls Persist.put() every few seconds when something changed, and Persist.all()
   once when the page opens to bring everything back.

   HOW TO IMPROVE: also save the analysis results (typed arrays) so the Analysis Lab works after a restart.
   ===================================================================== */

const Persist = (function () {
  "use strict";
  const DB = "clipcutter", STORE = "videos", CACHE = "cache", EXP = "clipcutter-exports";

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 2);      // version 2 added the "cache" store (analysis results kept between visits)
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "key" });
        if (!r.result.objectStoreNames.contains(CACHE)) r.result.createObjectStore(CACHE, { keyPath: "key" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); res(req && req.result); };
      t.onerror = () => { db.close(); rej(t.error); };
    });
  }
  // The CACHE store holds results that are expensive to make (sound features, picture scans) so a retry, a reload
  // or a crash does not start from zero. Each entry: { key, at, val }. Everything here is best effort and never throws.
  async function cacheRun(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(CACHE, mode), req = fn(t.objectStore(CACHE));
      t.oncomplete = () => { db.close(); res(req && req.result); };
      t.onerror = () => { db.close(); rej(t.error); };
      t.onabort = () => { db.close(); rej(t.error || new Error("cache write aborted")); };
    });
  }
  const cacheGet = (key) => cacheRun("readonly", (s) => s.get(key)).then((r) => (r ? r.val : null)).catch(() => null);
  const cachePut = (key, val) => cacheRun("readwrite", (s) => s.put({ key, at: Date.now(), val })).then(() => true).catch(() => false);
  const cacheDel = (key) => cacheRun("readwrite", (s) => s.delete(key)).catch(() => {});
  const cacheKeys = () => cacheRun("readonly", (s) => s.getAllKeys()).catch(() => []);
  async function cacheClear() { try { await cacheRun("readwrite", (s) => s.clear()); } catch (e) { /* ignore */ } }
  // Remove entries older than 'days' days (called once at start-up).
  async function cacheTidy(days) {
    try {
      const old = await cacheRun("readonly", (s) => s.getAll());
      for (const r of old || []) if (Date.now() - r.at > days * 864e5) await cacheDel(r.key);
    } catch (e) { /* ignore */ }
  }
  const put = (rec) => run("readwrite", (s) => s.put(rec));
  const del = (key) => run("readwrite", (s) => s.delete(key));
  const all = () => run("readonly", (s) => s.getAll()).then((r) => r || []);

  async function expDir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(EXP, { create: true }); }
  async function saveExport(name, blob) {
    const d = await expDir(), fh = await d.getFileHandle(name, { create: true }), w = await fh.createWritable();
    await w.write(blob); await w.close();
  }
  async function loadExport(name) { const d = await expDir(); return (await d.getFileHandle(name)).getFile(); }
  async function delExport(name) { try { const d = await expDir(); await d.removeEntry(name); } catch (e) { /* ignore */ } }
  async function cleanExports(keep) {
    try { const d = await expDir(); for await (const [n] of d.entries()) { const made = parseInt(n.slice(0, 8), 36) || 0; if (!keep.includes(n) && Date.now() - made > 600e3) await d.removeEntry(n).catch(() => {}); } } catch (e) { /* ignore */ }
  }

  return { cacheGet, cachePut, cacheDel, cacheKeys, cacheClear, cacheTidy, put, del, all, saveExport, loadExport, delExport, cleanExports };
})();

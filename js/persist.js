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
  const DB = "clipcutter", STORE = "videos", EXP = "clipcutter-exports";

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "key" });
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

  return { put, del, all, saveExport, loadExport, delExport, cleanExports };
})();

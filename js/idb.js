// idb.js — tiny promise wrapper over IndexedDB (one object store, key→value).
// No dependencies. Used by persist.js as the primary world store so builds can
// grow far past the ~5 MB localStorage cap without silent save failures.

const DB_NAME = 'minicraft';
const STORE = 'worlds';
const DB_VERSION = 1;

let dbPromise = null;

function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject)=>{
    let req;
    try{ req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror   = ()=>reject(req.error);
    req.onblocked = ()=>reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

function tx(mode, fn){
  return openDB().then(db=>new Promise((resolve, reject)=>{
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const r = fn(store);
    if(r) r.onsuccess = ()=>{ result = r.result; };
    t.oncomplete = ()=>resolve(result);
    t.onerror    = ()=>reject(t.error);
    t.onabort    = ()=>reject(t.error || new Error('IndexedDB transaction aborted'));
  }));
}

// Feature probe — resolves true only if IndexedDB is usable in this context
// (some private-mode browsers expose the API but throw on open).
export async function available(){
  if(typeof indexedDB === 'undefined') return false;
  try{ await openDB(); return true; }
  catch(e){ return false; }
}

export const get = key => tx('readonly',  s => s.get(key));
export const put = (key, val) => tx('readwrite', s => s.put(val, key));
export const del = key => tx('readwrite', s => s.delete(key));

// Ask the browser to keep our data durable (won't be evicted under disk pressure).
export async function requestPersistence(){
  try{ return navigator.storage?.persist ? await navigator.storage.persist() : false; }
  catch(e){ return false; }
}

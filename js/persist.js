// persist.js — world save slots, edit tracking, export/import.
// Primary store is IndexedDB (js/idb.js) so builds can grow far past the ~5 MB
// localStorage cap. An in-memory cache mirrors the slots so the menu/read API
// stays synchronous; writes go to IndexedDB asynchronously. localStorage is kept
// as a one-time migration source and an emergency write fallback.
import * as idb from './idb.js';

const SLOTS = 3;
const KEY = i=>'mc_world_'+i;
export let activeSlot = null;
const editMap = new Map(); // "x,y,z" -> t (compacted: last write per block wins)

// In-memory mirror of every slot (null = empty). Populated by init().
const cache = new Array(SLOTS).fill(null);
let idbOk = false; // false → running in localStorage-only fallback mode

// ---- Save-health reporting -------------------------------------------------
// Report every write so the UI can show a live indicator and shout before any
// progress is lost. On IndexedDB the ceiling is huge, so "near" is just a
// friendly "big world, back it up" nudge; in fallback mode it tracks the 5 MB cap.
let saveStatusHook = null;
export function setSaveStatusHook(fn){ saveStatusHook = fn; }
function report(status){ try{ saveStatusHook?.(status); }catch(e){} }
const warnBytes = ()=> idbOk ? 15e6 : 3.5e6;

// ---- helpers ---------------------------------------------------------------
function readLS(i){
  try{ const s = localStorage.getItem(KEY(i)); return s ? JSON.parse(s) : null; }
  catch(e){ return null; }
}
// v1.5.5 raised the surface by 16 — shift old edits & position up to match.
function upgrade(d){
  if(!d) return { d:null, changed:false };
  if((d.v||1) < 2){
    d.edits = (d.edits||[]).map(([x,y,z,t])=>[x, y+16, z, t]);
    if(d.pos) d.pos[1] += 16;
    d.v = 2;
    return { d, changed:true };
  }
  return { d, changed:false };
}

// Fire-and-forget durable write of one slot; falls back LS→report on failure.
function persistWrite(i, d, bytes){
  const near = bytes >= warnBytes();
  if(idbOk){
    idb.put(KEY(i), d)
      .then(()=> report({ ok:true, bytes, near }))
      .catch(()=>{ // IndexedDB write failed — try localStorage as a last resort
        try{ localStorage.setItem(KEY(i), JSON.stringify(d)); report({ ok:true, bytes, near, fallback:true }); }
        catch(e){ report({ ok:false, reason:'idb', bytes }); }
      });
  } else {
    try{ localStorage.setItem(KEY(i), JSON.stringify(d)); report({ ok:true, bytes, near }); }
    catch(e){ report({ ok:false, reason:'quota', bytes }); }
  }
}

// ---- boot ------------------------------------------------------------------
// Must complete before the world menu is built so slots aren't shown empty.
export async function init(){
  idbOk = await idb.available();
  if(idbOk){
    for(let i=0;i<SLOTS;i++){
      let raw = null;
      try{ raw = await idb.get(KEY(i)); }catch(e){ raw = null; }
      const { d, changed } = upgrade(raw || null);
      cache[i] = d;
      if(changed && d){ try{ await idb.put(KEY(i), d); }catch(e){} }
    }
    // One-time, non-destructive migration of any existing localStorage worlds.
    if(!localStorage.getItem('mc_idb_migrated')){
      for(let i=0;i<SLOTS;i++){
        if(!cache[i]){
          const { d } = upgrade(readLS(i));
          if(d){ cache[i] = d; try{ await idb.put(KEY(i), d); }catch(e){} }
        }
      }
      try{ localStorage.setItem('mc_idb_migrated', '1'); }catch(e){}
    }
    idb.requestPersistence(); // ask the browser not to evict our worlds
  } else {
    // No IndexedDB (rare / private mode) — read straight from localStorage.
    for(let i=0;i<SLOTS;i++) cache[i] = upgrade(readLS(i)).d;
  }
}

// ---- edit tracking ---------------------------------------------------------
export function recordEdit(x,y,z,t){
  if(activeSlot===null) return;
  editMap.set(x+','+y+','+z, t);
}
function editsArray(){
  return [...editMap].map(([k,t])=>{
    const [x,y,z] = k.split(',').map(Number);
    return [x,y,z,t];
  });
}

// ---- read API (synchronous, served from cache) -----------------------------
export function peek(i){ return cache[i] || null; }
export function listWorlds(){ return cache.slice(0, SLOTS); }

// ---- slot lifecycle --------------------------------------------------------
export function create(i, name, mode){
  const d = {v:2, name, mode, seed:(Math.random()*2**31)|0,
             edits:[], inv:{}, slots:null, pos:null, yaw:0,
             tod:.28, intel:0, hp:20, hunger:20, savedAt:Date.now()};
  cache[i] = d;
  persistWrite(i, d, JSON.stringify(d).length);
  return d;
}
export function open(i){
  const d = cache[i];
  if(!d) return null;
  activeSlot = i;
  editMap.clear();
  for(const [x,y,z,t] of (d.edits||[])) editMap.set(x+','+y+','+z, t);
  return d;
}
export function closeActive(){ activeSlot = null; editMap.clear(); }

export function save(partial){
  if(activeSlot===null) return false;
  const d = cache[activeSlot] || {v:2};
  Object.assign(d, partial, {edits: editsArray(), savedAt: Date.now()});
  cache[activeSlot] = d;
  persistWrite(activeSlot, d, JSON.stringify(d).length);
  return true;
}
export function remove(i){
  cache[i] = null;
  if(idbOk) idb.del(KEY(i)).catch(()=>{});
  try{ localStorage.removeItem(KEY(i)); }catch(e){} // clear any legacy copy too
  if(activeSlot===i) closeActive();
}

// ---- export / import -------------------------------------------------------
export function exportWorld(i){
  const d = cache[i];
  if(!d) return;
  const blob = new Blob([JSON.stringify(d)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'minicraft-' + (d.name||'world').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}
export function importWorld(file, cb){
  const r = new FileReader();
  r.onload = async ()=>{
    try{
      const parsed = JSON.parse(r.result);
      if(typeof parsed.seed!=='number' || !Array.isArray(parsed.edits)) throw 0;
      const { d } = upgrade(parsed);
      let slot = -1;
      for(let i=0;i<SLOTS;i++) if(!cache[i]){ slot = i; break; }
      if(slot===-1){ cb(false, 'All world slots are full — delete one first.'); return; }
      d.name = (d.name||'Imported world') + '';
      d.savedAt = Date.now();
      cache[slot] = d;
      try{
        if(idbOk) await idb.put(KEY(slot), d);
        else localStorage.setItem(KEY(slot), JSON.stringify(d));
        cb(true, `Imported "${d.name}" into slot ${slot+1}.`);
      }catch(e){
        cache[slot] = null; // roll back so the menu doesn't show a phantom world
        cb(false, 'Could not save the imported world (storage error).');
      }
    }catch(e){ cb(false, 'That file is not a valid MiniCraft world.'); }
  };
  r.onerror = ()=>cb(false, 'Could not read the file.');
  r.readAsText(file);
}

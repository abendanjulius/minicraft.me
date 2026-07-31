// persist.js — world save slots (localStorage), edit tracking, export/import
const SLOTS = 3;
const KEY = i=>'mc_world_'+i;
export let activeSlot = null;
const editMap = new Map(); // "x,y,z" -> t (compacted: last write per block wins)

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

export function peek(i){
  try{ const s = localStorage.getItem(KEY(i)); return s ? JSON.parse(s) : null; }
  catch(e){ return null; }
}
export function listWorlds(){
  const out = [];
  for(let i=0;i<SLOTS;i++) out.push(peek(i));
  return out;
}
export function create(i, name, mode){
  const d = {v:2, name, mode, seed:(Math.random()*2**31)|0,
             edits:[], inv:{}, slots:null, pos:null, yaw:0,
             tod:.28, intel:0, hp:20, hunger:20, savedAt:Date.now()};
  try{ localStorage.setItem(KEY(i), JSON.stringify(d)); }catch(e){ return null; }
  return d;
}
export function open(i){
  const d = peek(i);
  if(!d) return null;
  if((d.v||1) < 2){
    // v1.5.5 raised the surface by 16 — shift old edits & position up to match
    d.edits = (d.edits||[]).map(([x,y,z,t])=>[x, y+16, z, t]);
    if(d.pos) d.pos[1] += 16;
    d.v = 2;
    try{ localStorage.setItem(KEY(i), JSON.stringify(d)); }catch(e){}
  }
  activeSlot = i;
  editMap.clear();
  for(const [x,y,z,t] of (d.edits||[])) editMap.set(x+','+y+','+z, t);
  return d;
}
export function closeActive(){ activeSlot = null; editMap.clear(); }
export function save(partial){
  if(activeSlot===null) return false;
  const d = peek(activeSlot) || {v:1};
  Object.assign(d, partial, {edits: editsArray(), savedAt: Date.now()});
  try{ localStorage.setItem(KEY(activeSlot), JSON.stringify(d)); return true; }
  catch(e){ return false; } // quota — very large worlds
}
export function remove(i){
  localStorage.removeItem(KEY(i));
  if(activeSlot===i) closeActive();
}

// ---- export / import ----
export function exportWorld(i){
  const d = peek(i);
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
  r.onload = ()=>{
    try{
      const d = JSON.parse(r.result);
      if(typeof d.seed!=='number' || !Array.isArray(d.edits)) throw 0;
      if((d.v||1) < 2){
        d.edits = d.edits.map(([x,y,z,t])=>[x, y+16, z, t]);
        if(d.pos) d.pos[1] += 16;
        d.v = 2;
      }
      let slot = -1;
      for(let i=0;i<SLOTS;i++) if(!peek(i)){ slot = i; break; }
      if(slot===-1){ cb(false, 'All world slots are full — delete one first.'); return; }
      d.name = (d.name||'Imported world') + '';
      d.savedAt = Date.now();
      localStorage.setItem(KEY(slot), JSON.stringify(d));
      cb(true, `Imported "${d.name}" into slot ${slot+1}.`);
    }catch(e){ cb(false, 'That file is not a valid MiniCraft world.'); }
  };
  r.onerror = ()=>cb(false, 'Could not read the file.');
  r.readAsText(file);
}

// chests.js — placeable Crates for item storage
import { wrapC } from './world.js';
import { inventory, renderHotbar, renderInv, invOpen, addToInventory } from './ui.js';
import { sfx } from './audio.js';
import { gm } from './mode.js';
import { TYPES, ITEMS } from './render.js';

const SLOTS = 15;
export const chests = new Map(); // "x,y,z" -> {slots: (null|{id,n})[]}
let openKey = null;
let onChange = null; // notify net when contents change
export function setChestChangeHook(fn){ onChange = fn; }

const keyOf = (x,y,z) => wrapC(x)+','+y+','+wrapC(z);

export function ensure(x,y,z){
  const k = keyOf(x,y,z);
  if(!chests.has(k)){
    chests.set(k, {slots: Array(SLOTS).fill(null)});
  }
  return chests.get(k);
}

export function removeAt(x,y,z){
  const k = keyOf(x,y,z);
  const c = chests.get(k);
  if(c){
    // spill contents into player inv if local? leave on ground ideally — for now grant to no one, drop lost
    chests.delete(k);
  }
  if(openKey===k) close();
}

export function serialize(){
  const out = [];
  for(const [k,c] of chests){
    out.push([k, c.slots.map(s => s ? [s.id, s.n] : null)]);
  }
  return out;
}

export function applyRemote(list){
  chests.clear();
  for(const [k, slots] of list||[]){
    chests.set(k, {slots: (slots||[]).map(s => s ? {id:s[0], n:s[1]} : null)});
  }
  if(openKey && chests.has(openKey)) renderChestUI();
  else if(openKey) close();
}

export function isOpen(){ return !!openKey; }
export function openKeyGet(){ return openKey; }

export function open(x,y,z){
  openKey = keyOf(x,y,z);
  ensure(x,y,z);
  const el = document.getElementById('chestUI');
  if(el) el.style.display = 'block';
  document.body.classList.add('inv-open');
  renderChestUI();
  sfx.place();
}

export function close(){
  openKey = null;
  const el = document.getElementById('chestUI');
  if(el) el.style.display = 'none';
  // don't force close inv
}

function nameOf(id){
  return id>=100 ? (ITEMS[id]?.name||id) : (TYPES[id]?.name||id);
}
function iconHTML(id){
  if(id>=100) return `<span class="ticon">${ITEMS[id]?.icon||'❓'}</span>`;
  return `<div class="sw" style="background-image:url(${TYPES[id]?.icon||''})"></div>`;
}

export function renderChestUI(){
  const grid = document.getElementById('chestGrid');
  if(!grid || !openKey) return;
  const c = chests.get(openKey);
  if(!c) return;
  grid.innerHTML = '';
  c.slots.forEach((s,i)=>{
    const d = document.createElement('div');
    d.className = 'invItem' + (s?'':' empty');
    if(s) d.innerHTML = `${iconHTML(s.id)}<span class="cnt">${s.n}</span>`;
    else d.innerHTML = '';
    d.title = s ? nameOf(s.id) : 'Empty';
    d.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      // take one stack out into player inventory
      if(!s) return;
      if(gm.forge) return;
      addToInventory(s.id);
      s.n--;
      if(s.n<=0) c.slots[i] = null;
      renderChestUI();
      renderHotbar();
      if(invOpen) renderInv();
      onChange?.();
      sfx.tick?.(1) || sfx.place();
    });
    grid.appendChild(d);
  });
}

/** Put currently selected hotbar item (1 count) into open chest */
export function depositSelected(hotbarSlots, sel){
  if(!openKey) return false;
  const c = chests.get(openKey);
  if(!c) return false;
  const h = hotbarSlots[sel.slot];
  if(!h || h.k==='t') return false;
  const id = h.id;
  if(!gm.forge && !(inventory[id]>0)) return false;
  // find stack or empty
  let slot = c.slots.find(s => s && s.id===id && s.n<64);
  if(!slot){
    const idx = c.slots.findIndex(s => !s);
    if(idx<0) return false;
    c.slots[idx] = {id, n:0};
    slot = c.slots[idx];
  }
  slot.n++;
  if(!gm.forge){
    inventory[id]--;
    if(inventory[id]<=0){
      delete inventory[id];
      hotbarSlots[sel.slot] = null;
    }
  }
  renderChestUI();
  renderHotbar();
  if(invOpen) renderInv();
  onChange?.();
  sfx.place();
  return true;
}

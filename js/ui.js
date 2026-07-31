// ui.js — 10-slot hotbar (tools live in slots), inventory, chat, compass, touch controls
import { TYPES, TOOLS, ITEMS, isTouch } from './render.js';
import { gm } from './mode.js';
import { itemBlurb } from './content.js';

export const inventory = {};
// Slots hold null | {k:'b', id:blockType} | {k:'t', id:toolId}. Tools start in slots 8/9/0.
export const hotbarSlots = new Array(10).fill(null);
hotbarSlots[7] = {k:'t', id:'pick'};
hotbarSlots[8] = {k:'t', id:'axe'};
hotbarSlots[9] = {k:'t', id:'shovel'};
export const sel = { slot:0 };
export const joy = { x:0, y:0 };

const $ = id=>document.getElementById(id);
let onHeldChange = null, playerHooks = null;
const toolInfo = id=>TOOLS.find(t=>t.id===id);

// What the selected slot means
export function slotTool(){ const s = hotbarSlots[sel.slot]; return (s && s.k==='t') ? s.id : 'hand'; }
export function slotBlock(){ const s = hotbarSlots[sel.slot]; return (s && s.k==='b') ? s.id : 0; }
export function nextToolSlot(){
  for(let i=1;i<=10;i++){
    const j = (sel.slot+i)%10;
    if(hotbarSlots[j]?.k==='t'){ sel.slot=j; renderHotbar(); return; }
  }
}

export function addToInventory(t){
  inventory[t] = (inventory[t]||0)+1;
  const kind = t>=100 ? 'f' : 'b';
  if(!hotbarSlots.some(s=>s?.k===kind && s.id===t)){
    const empty = hotbarSlots.findIndex(s=>s===null);
    if(empty !== -1) hotbarSlots[empty] = {k:kind, id:t};
  }
  renderHotbar();
  if(invOpen) renderInv();
}
export function setHeldChangeHook(fn){ onHeldChange = fn; }

export function renderHotbar(){
  const hb = $('hotbar'); hb.innerHTML = '';
  hotbarSlots.forEach((s,i)=>{
    const d = document.createElement('div');
    const isBlock = s?.k==='b', isTool = s?.k==='t', isFood = s?.k==='f';
    const count = gm.forge ? '∞' : ((isBlock||isFood) ? (inventory[s.id]||0) : 0);
    d.className = 'slot' + (i===sel.slot?' active':'') + (s?'':' empty') + (!gm.forge&&(isBlock||isFood)&&!count?' zero':'');
    const label = (i+1)%10;
    if(isTool){
      d.innerHTML = `<span class="num">${label}</span><span class="ticon">${toolInfo(s.id).icon}</span>`;
    } else if(isFood){
      d.innerHTML = `<span class="num">${label}</span><span class="ticon">${ITEMS[s.id].icon}</span><span class="cnt">${count}</span>`;
    } else {
      d.innerHTML = `<span class="num">${label}</span><div class="sw" ${isBlock?`style="background-image:url(${TYPES[s.id].icon})"`:''}></div>${isBlock?`<span class="cnt">${count}</span>`:''}`;
    }
    if(s && !isTouch){
      d.draggable = true;
      d.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain','slot:'+i));
    }
    d.addEventListener('dragover', e=>e.preventDefault());
    d.addEventListener('drop', e=>{
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      if(data.startsWith('invb:')){ const id=+data.slice(5); hotbarSlots[i] = {k: id>=100?'f':'b', id}; }
      else if(data.startsWith('invt:')) hotbarSlots[i] = {k:'t', id:data.slice(5)};
      else if(data.startsWith('slot:')){
        const j = +data.slice(5);
        [hotbarSlots[i], hotbarSlots[j]] = [hotbarSlots[j], hotbarSlots[i]];
      }
      renderHotbar();
    });
    d.addEventListener('pointerdown', e=>{ e.stopPropagation(); sel.slot=i; renderHotbar(); });
    hb.appendChild(d);
  });
  // HUD label for what's held
  const t = slotTool(), b = slotBlock();
  const fd = hotbarSlots[sel.slot]?.k==='f' ? hotbarSlots[sel.slot].id : 0;
  $('toolName').textContent = t!=='hand' ? toolInfo(t).name : fd ? ITEMS[fd].name : (b ? TYPES[b].name : 'Hand');
  onHeldChange?.();
}


function showItemInfo(name, blurb, anchorEl){
  let tip = $('itemInfo');
  if(!tip){
    tip = document.createElement('div');
    tip.id = 'itemInfo';
    document.body.appendChild(tip);
  }
  tip.innerHTML = `<b>${name}</b>${blurb ? `<span>${blurb}</span>` : ''}`;
  tip.classList.add('show');
  if(anchorEl){
    const r = anchorEl.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 200, Math.max(8, r.left + r.width/2 - 90));
    const y = Math.max(8, r.top - 8);
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
    tip.style.transform = 'translateY(-100%)';
  }
  clearTimeout(showItemInfo._t);
  showItemInfo._t = setTimeout(()=>tip.classList.remove('show'), 2200);
}
function bindItemInfo(el, name, blurb, onPick){
  el.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    showItemInfo(name, blurb, el);
    onPick?.();
  });
}

export let invOpen = false;
export function renderInv(){
  if(gm.forge){ renderInvForge(); return; }
  // Tools row — always available so a swapped-out tool is never lost
  const tr = $('invTools'); tr.innerHTML = '';
  for(const t of TOOLS){
    if(t.id==='hand') continue;
    const d = document.createElement('div');
    d.className = 'invItem';
    d.innerHTML = `<span class="ticon">${t.icon}</span>`;
    d.title = t.name;
    if(!isTouch){
      d.draggable = true;
      d.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain','invt:'+t.id));
    }
    bindItemInfo(d, t.name, 'Mining tool — equip to the selected hotbar slot',
      ()=>{ hotbarSlots[sel.slot] = {k:'t', id:t.id}; renderHotbar(); });
    tr.appendChild(d);
  }
  // Blocks
  const grid = $('invGrid'); grid.innerHTML = '';
  let any = false;
  for(const tid in inventory){
    if(inventory[tid]<=0) continue;
    any = true;
    const d = document.createElement('div');
    d.className = 'invItem';
    const isFood = +tid>=100;
    d.innerHTML = isFood
      ? `<span class="ticon">${ITEMS[tid].icon}</span><span class="cnt">${inventory[tid]}</span>`
      : `<div class="sw" style="background-image:url(${TYPES[tid].icon})"></div><span class="cnt">${inventory[tid]}</span>`;
    if(!isTouch){
      d.draggable = true;
      d.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain','invb:'+tid));
    }
    const name = isFood ? (ITEMS[tid]?.name || tid) : (TYPES[tid]?.name || tid);
    const blurb = itemBlurb(+tid, TYPES, ITEMS);
    bindItemInfo(d, name, blurb,
      ()=>{ hotbarSlots[sel.slot] = {k:isFood?'f':'b', id:+tid}; renderHotbar(); });
    grid.appendChild(d);
  }
  if(!any) grid.innerHTML = '<span class="empty-note">Nothing yet — go mine some blocks.</span>';
}
let tabHook = null;
export function setTabHook(fn){ tabHook = fn; }
export function switchTab(tab){
  document.querySelectorAll('.itab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  for(const t of ['items','craft','guide']) $('tab-'+t).style.display = (t===tab)?'block':'none';
  tabHook?.(tab);
}
function renderInvForge(){
  // Full catalog, everything infinite
  const tr = $('invTools'); tr.innerHTML = '';
  for(const t of TOOLS){
    if(t.id==='hand') continue;
    const d = document.createElement('div');
    d.className = 'invItem';
    d.innerHTML = `<span class="ticon">${t.icon}</span>`;
    d.addEventListener('pointerdown', ()=>{ hotbarSlots[sel.slot] = {k:'t', id:t.id}; renderHotbar(); });
    tr.appendChild(d);
  }
  const grid = $('invGrid'); grid.innerHTML = '';
  const all = [...Object.keys(TYPES).map(Number), ...Object.keys(ITEMS).map(Number)];
  for(const tid of all){
    const isItem = tid>=100;
    const d = document.createElement('div');
    d.className = 'invItem';
    d.title = isItem ? ITEMS[tid].name : TYPES[tid].name;
    d.innerHTML = isItem
      ? `<span class="ticon">${ITEMS[tid].icon}</span><span class="cnt">∞</span>`
      : `<div class="sw" style="background-image:url(${TYPES[tid].icon})"></div><span class="cnt">∞</span>`;
    d.addEventListener('pointerdown', ()=>{
      hotbarSlots[sel.slot] = {k: isItem?'f':'b', id:tid};
      inventory[tid] = 999; // Forge: hand model + place/eat
      renderHotbar();
    });
    grid.appendChild(d);
  }
}
export function toggleInv(open, tab){
  invOpen = open ?? !invOpen;
  $('inv').style.display = invOpen ? 'block' : 'none';
  document.body.classList.toggle('inv-open', invOpen);
  if(invOpen){ renderInv(); switchTab(tab||'items'); document.exitPointerLock?.(); }
  else playerHooks?.relock?.();
}

export function initUI(hooks){
  playerHooks = hooks;
  $('invHelp').textContent = isTouch
    ? 'Tap a tool or block to put it in the selected hotbar slot. (🎒 to close)'
    : 'Drag items onto hotbar slots, or tap to fill the selected slot. Drop a slot here to clear it. (E to close)';
  $('inv').addEventListener('dragover', e=>e.preventDefault());
  $('inv').addEventListener('drop', e=>{
    const data = e.dataTransfer.getData('text/plain');
    if(data.startsWith('slot:')){ hotbarSlots[+data.slice(5)] = null; renderHotbar(); }
  });
  $('invClear').addEventListener('pointerdown', ()=>{ hotbarSlots[sel.slot]=null; renderHotbar(); });
  document.querySelectorAll('.itab').forEach(b=>b.addEventListener('pointerdown', e=>{ e.stopPropagation(); switchTab(b.dataset.tab); }));
  renderHotbar();
  if(isTouch) initTouch(hooks);
}

function initTouch(hooks){
  document.body.classList.add('touch');
  $('touchUI').style.display = 'block';
  const joyBase = $('joyBase'), joyStick = $('joyStick');
  let joyId = null, joyCX = 0, joyCY = 0, lookId = null, lookX = 0, lookY = 0;

  $('joyZone').addEventListener('touchstart', e=>{
    e.preventDefault();
    const t = e.changedTouches[0];
    joyId = t.identifier; joyCX = t.clientX; joyCY = t.clientY;
    joyBase.style.display = joyStick.style.display = 'block';
    joyBase.style.left = (joyCX-55)+'px'; joyBase.style.top = (joyCY-55)+'px';
    joyStick.style.left = (joyCX-24)+'px'; joyStick.style.top = (joyCY-24)+'px';
  }, {passive:false});
  document.addEventListener('touchmove', e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){
        let dx = t.clientX-joyCX, dy = t.clientY-joyCY;
        const len = Math.hypot(dx,dy), max = 45;
        if(len>max){ dx*=max/len; dy*=max/len; }
        joy.x = dx/max; joy.y = dy/max;
        joyStick.style.left = (joyCX+dx-24)+'px'; joyStick.style.top = (joyCY+dy-24)+'px';
      } else if(t.identifier===lookId){
        hooks.look((t.clientX-lookX)*.004, (t.clientY-lookY)*.004);
        lookX = t.clientX; lookY = t.clientY;
      }
    }
  }, {passive:false});
  document.addEventListener('touchend', e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){ joyId=null; joy.x=joy.y=0; joyBase.style.display=joyStick.style.display='none'; }
      if(t.identifier===lookId) lookId=null;
    }
  });
  $('game').addEventListener('touchstart', e=>{
    e.preventDefault();
    if(invOpen) return;
    const t = e.changedTouches[0];
    if(lookId===null){ lookId = t.identifier; lookX = t.clientX; lookY = t.clientY; }
  }, {passive:false});

  $('btnJump').addEventListener('touchstart', e=>{ e.preventDefault(); hooks.jump(true); });
  $('btnJump').addEventListener('touchend', ()=>hooks.jump(false));
  $('btnMine').addEventListener('touchstart', e=>{ e.preventDefault(); hooks.mine(true); });
  $('btnMine').addEventListener('touchend', ()=>hooks.mine(false));
  $('btnPlace').addEventListener('touchstart', e=>{ e.preventDefault(); hooks.place(); });
  $('btnInv').addEventListener('touchstart', e=>{ e.preventDefault(); toggleInv(); });
}

// ---- Chat ----
export const chat = { open:false };
export function addChat(name, text){
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'chatMsg';
  d.textContent = name + ': ' + text;
  log.appendChild(d);
  while(log.children.length>8) log.removeChild(log.firstChild);
  setTimeout(()=>{ d.classList.add('fade'); setTimeout(()=>d.remove(), 1200); }, 9000);
}
export function openChat(){
  if(chat.open) return;
  chat.open = true;
  $('chatRow').style.display = 'flex';
  $('chatInput').focus();
}
export function closeChat(){
  chat.open = false;
  $('chatInput').value = '';
  $('chatRow').style.display = 'none';
  $('chatInput').blur();
}
export function initChat(onSend){
  const inp = $('chatInput');
  inp.addEventListener('keydown', e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ const t = inp.value.trim(); if(t) onSend(t); closeChat(); }
    if(e.key==='Escape') closeChat();
  });
  $('chatSend').addEventListener('pointerdown', ()=>{
    const t = inp.value.trim(); if(t) onSend(t); closeChat();
  });
  $('btnChat').addEventListener('touchstart', e=>{ e.preventDefault(); openChat(); });
}

export function setCompass(deg){
  $('compassArrow').style.transform = `rotate(${deg}deg)`;
}
export function restoreInv(inv, slots){
  for(const k of Object.keys(inventory)) delete inventory[k];
  Object.assign(inventory, inv||{});
  if(Array.isArray(slots) && slots.length===10){
    for(let i=0;i<10;i++) hotbarSlots[i] = slots[i] && slots[i].k && slots[i].id!=null ? {k:slots[i].k, id:slots[i].id} : null;
  }
  sel.slot = 0;
  renderHotbar();
}
export function setBanner(text){
  const b = $('banner');
  b.textContent = text || '';
  b.style.display = text ? 'block' : 'none';
}
export function setHud(fps, pos){
  $('fps').textContent = fps;
  $('pos').textContent = pos;
}
export function setHorde(n){
  const el = $('horde');
  el.style.display = n>0 ? 'inline' : 'none';
  el.textContent = '🧠 Horde: ' + '★'.repeat(n) + '☆'.repeat(3-n);
  el.className = 'iq'+n;
}
export function setPlayers(list){
  $('players').textContent = list.length ? '👥 ' + list.join(', ') : '';
}

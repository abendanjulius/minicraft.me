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
export function getSearchQuery(){
  const el = $('invSearch');
  return (el?.value || '').trim().toLowerCase();
}
export function matchesSearch(name, ...extra){
  const q = getSearchQuery();
  if(!q) return true;
  const hay = [name, ...extra].join(' ').toLowerCase();
  return hay.includes(q);
}

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

// craft.js is injected from main.js so the two modules don't import each other
let craftApi = null;
export function setCraftApi(api){ craftApi = api; }

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
const CATS = [
  {id:'inv',    icon:'🎒', label:'Inventory'},
  {id:'can',    icon:'✨', label:'Craftable'},
  {id:'guide',  icon:'📖', label:'Guide'},
  {id:'build',  icon:'🧱', label:'Construction'},
  {id:'gear',   icon:'⚔️', label:'Equipment'},
  {id:'light',  icon:'💡', label:'Lights'},
  {id:'food',   icon:'🍖', label:'Food & Meds'},
  {id:'nature', icon:'🌿', label:'Materials'},
];
let invCat = 'inv', invPick = null;

function catOf(id){
  if(id < 100){
    if(TYPES[id]?.light || id===10) return 'light';
    return 'build';
  }
  const it = ITEMS[id];
  if(!it) return 'nature';
  if(it.dmg) return 'gear';
  if(it.food || it.heal) return 'food';
  return 'nature';
}
const recipesFor = id => (craftApi?.RECIPES || []).filter(r => r.out.id === id);
const canCraftNow = id => recipesFor(id).some(r => craftApi.canCraft(r));
const iconOf = id => id>=100
  ? `<span class="ticon">${ITEMS[id]?.icon || '?'}</span>`
  : `<div class="sw" style="background-image:url(${TYPES[id]?.icon})"></div>`;
const nameOf = id => (id>=100 ? ITEMS[id]?.name : TYPES[id]?.name) || 'Unknown';

function idsForCat(cat){
  const all = [...Object.keys(TYPES).map(Number), ...Object.keys(ITEMS).map(Number)];
  const hideVariant = id => (id>=49 && id<=55) || id===63;
  if(cat==='inv'){
    if(gm.forge) return all.filter(id => !hideVariant(id));
    return all.filter(id => !hideVariant(id) && (inventory[id]||0) > 0);
  }
  if(cat==='can') return all.filter(id => !hideVariant(id) && recipesFor(id).length && (gm.forge || canCraftNow(id)));
  if(cat==='guide'){
    const guide = craftApi?.GUIDE || [];
    // unique ids from guide entries that still exist as items/blocks
    const seen = new Set();
    const ids = [];
    for(const g of guide){
      if(seen.has(g.id)) continue;
      if(!(TYPES[g.id] || ITEMS[g.id])) continue;
      seen.add(g.id);
      ids.push(g.id);
    }
    return ids;
  }
  return all.filter(id => {
    if((id>=49 && id<=55) || id===63) return false; // door/trapdoor state variants
    return catOf(id) === cat;
  });
}

function renderRail(){
  const rail = $('invRail');
  rail.innerHTML = CATS.map(c =>
    `<button class="railBtn${c.id===invCat?' active':''}" data-cat="${c.id}" title="${c.label}" type="button">${c.icon}</button>`
  ).join('');
}

function renderDetail(){
  const box = $('invDetail');
  if(invPick == null || !(TYPES[invPick] || ITEMS[invPick])){
    const hint = invCat==='guide'
      ? 'Pick an entry to learn where to find it and what it is for.'
      : 'Pick an item on the left to see its recipe.';
    box.innerHTML = `<div class="dSlots"><div class="dSlot"></div><div class="dSlot"></div>
        <div class="dSlot"></div><div class="dSlot"></div></div>
      <div class="dArrow">▼</div>
      <div class="dSlot out"></div>
      <p class="dHint">${hint}</p>`;
    return;
  }
  const id = invPick;
  const have = inventory[id] || 0;
  const it = id>=100 ? ITEMS[id] : null;
  const facts = [];
  if(it?.dmg)  facts.push(`⚔ ${it.dmg} damage`);
  if(it?.food) facts.push(`🍗 +${it.food} hunger`);
  if(it?.heal) facts.push(`❤ +${it.heal} health`);
  if(id<100){
    if(TYPES[id].light || id===10) facts.push('💡 Light source — blocks zombie spawns nearby');
    else if(id===44) facts.push('🪜 Climbable');
    else if(id>=45 && id<=47) facts.push('⛏ Ore');
    const t = TOOLS.find(t => t.good.includes(id));
    if(t) facts.push(`${t.icon} Fastest with ${t.name}`);
  }
  const g = (craftApi?.GUIDE || []).find(x => x.id === id);
  const recipes = recipesFor(id);
  let html = `<div class="dHead">${iconOf(id)}<b>${nameOf(id)}</b></div>
    <div class="dHave">You have: ${gm.forge ? '∞' : have}</div>`;
  if(facts.length) html += facts.map(f=>`<div class="dFact">${f}</div>`).join('');
  if(g){
    html += `<div class="dGuideBlock">
      <div class="dGuideLabel">📍 Where</div>
      <div class="dFact">${g.where}</div>
      <div class="dGuideLabel">🛠 Uses</div>
      <div class="dFact">${g.uses}</div>
    </div>`;
  } else if(invCat==='guide'){
    html += `<div class="dFact dHint">No guide notes for this item yet.</div>`;
  }
  recipes.forEach((r,i)=>{
    const ok = craftApi.canCraft(r);
    const ings = r.in.map(([iid,n])=>{
      const h = inventory[iid]||0;
      const okI = gm.forge || h>=n;
      return `<div class="dSlot ${okI?'':'miss'}" title="${nameOf(iid)}">${iconOf(iid)}
                <span class="sCnt">${gm.forge?'∞':h+'/'+n}</span></div>`;
    }).join('');
    html += `<div class="dRecipe">
       <div class="dSlots">${ings}</div>
       <div class="dArrow">▼</div>
       <div class="dSlot out">${iconOf(r.out.id)}<span class="sCnt">×${r.out.n}</span></div>
       <button class="dCraft" data-r="${i}" ${ok?'':'disabled'} type="button">Craft</button>
       ${r.tip?`<div class="dTip">${r.tip}</div>`:''}</div>`;
  });
  html += `<button class="dAssign" type="button">Put in slot ${(sel.slot+1)%10}</button>`;
  box.innerHTML = html;
  box.querySelectorAll('.dCraft').forEach(b=>b.addEventListener('click', e=>{
    e.stopPropagation();
    craftApi.craft(recipes[+b.dataset.r]);
    renderInv();
  }));
  box.querySelector('.dAssign').addEventListener('click', e=>{
    e.stopPropagation();
    hotbarSlots[sel.slot] = {k: id>=100 ? 'f' : 'b', id};
    if(gm.forge && id>=100) inventory[id] = 999;
    renderHotbar();
  });
}

export function renderInv(){
  const grid = $('invGrid');
  if(!grid) return;
  renderRail();
  document.body.classList.toggle('inv-guide', invCat==='guide');
  const title = $('invTitle');
  if(title) title.textContent = CATS.find(c=>c.id===invCat)?.label || 'Inventory';
  const q = getSearchQuery();
  grid.innerHTML = '';

  // tools always live in the Equipment tab and in Inventory
  if(invCat==='gear' || invCat==='inv'){
    for(const t of TOOLS){
      if(t.id==='hand') continue;
      if(q && !matchesSearch(t.name)) continue;
      const d = document.createElement('div');
      d.className = 'invItem tool' + (hotbarSlots[sel.slot]?.k==='t' && hotbarSlots[sel.slot].id===t.id ? ' sel':'');
      d.innerHTML = `<span class="ticon">${t.icon}</span>`;
      d.title = t.name;
      d.addEventListener('pointerdown', e=>{
        e.stopPropagation();
        hotbarSlots[sel.slot] = {k:'t', id:t.id};
        renderHotbar();
      });
      grid.appendChild(d);
    }
  }

  let shown = 0;
  for(const id of idsForCat(invCat)){
    if(q){
      const g = (craftApi?.GUIDE || []).find(x => x.id === id);
      if(!matchesSearch(nameOf(id), g?.where || '', g?.uses || '')) continue;
    }
    const have = inventory[id]||0;
    const craftable = recipesFor(id).length > 0;
    const d = document.createElement('div');
    d.className = 'invItem' + (invPick===id?' sel':'') + (!gm.forge && !have && invCat!=='inv' ? ' ghost':'');
    d.title = nameOf(id);
    d.innerHTML = iconOf(id)
      + (gm.forge ? '<span class="cnt">∞</span>' : (have ? `<span class="cnt">${have}</span>` : ''))
      + (craftable && (gm.forge || canCraftNow(id)) ? '<span class="plus">+</span>' : '');
    d.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      invPick = id;
      if(have>0 || gm.forge){
        hotbarSlots[sel.slot] = {k: id>=100 ? 'f' : 'b', id};
        if(gm.forge && id>=100) inventory[id] = 999;
        renderHotbar();
      }
      renderInv();
    });
    grid.appendChild(d);
    shown++;
  }
  if(!shown && !grid.childElementCount){
    grid.innerHTML = invCat==='inv'
      ? '<span class="empty-note">Your pack is empty — go mine some blocks.</span>'
      : invCat==='guide'
        ? '<span class="empty-note">No guide entries match your search.</span>'
        : '<span class="empty-note">Nothing here yet.</span>';
  }
  renderDetail();
}

export function setInvCat(cat){ invCat = cat; renderInv(); }

export function setTabHook(fn){ tabHook = fn; }
export function switchTab(tab){
  if(tab==='craft' || tab==='can') setInvCat('can');
  else if(tab==='guide') setInvCat('guide');
  else if(tab==='build' || tab==='construction') setInvCat('build');
  else if(tab==='gear' || tab==='food' || tab==='light' || tab==='nature') setInvCat(tab);
  else setInvCat('inv');
}
export function toggleInv(open, tab){
  invOpen = open ?? !invOpen;
  // CSS drives visibility via body.inv-open (display:flex !important) — do not fight it with inline styles
  document.body.classList.toggle('inv-open', invOpen);
  if(invOpen){
    invPick = null;
    // Prefer a tab that always has content (empty pack looked "broken")
    const start = tab || (gm.forge ? 'build' : 'inv');
    switchTab(start);
    renderInv();
    document.exitPointerLock?.();
  } else {
    document.body.classList.remove('inv-guide');
    playerHooks?.relock?.();
  }
}

export function initUI(hooks){
  playerHooks = hooks;
  const rail = $('invRail');
  rail.addEventListener('pointerdown', e=>{
    const b = e.target.closest('[data-cat]');
    if(!b) return;
    e.stopPropagation();
    setInvCat(b.dataset.cat);
  });
  $('invClose').addEventListener('pointerdown', e=>{ e.stopPropagation(); toggleInv(false); });
  const search = $('invSearch');
  if(search){
    search.addEventListener('input', ()=>renderInv());
    search.addEventListener('keydown', e=>e.stopPropagation());
    search.addEventListener('pointerdown', e=>e.stopPropagation());
  }
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
  $('btnDrop')?.addEventListener('touchstart', e=>{ e.preventDefault(); hooks.drop?.(); });
  const sp = $('btnSprint');
  if(sp){
    sp.addEventListener('touchstart', e=>{ e.preventDefault(); hooks.sprint?.(true); });
    sp.addEventListener('touchend', ()=>hooks.sprint?.(false));
  }
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

export function setCompass(deg){ /* compass is now a canvas map; angle handled in main */ }
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

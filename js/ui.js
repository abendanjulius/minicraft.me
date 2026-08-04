// ui.js — 10-slot hotbar (tools live in slots), inventory, chat, compass, touch controls
import { TYPES, TOOLS, ITEMS, isTouch } from './render.js';
import { gm } from './mode.js';
import { itemBlurb } from './content.js';
import { sfx } from './audio.js';

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

function showSlotName(name){
  if(!name) return;
  let el = $('slotNameToast');
  if(!el){
    el = document.createElement('div');
    el.id = 'slotNameToast';
    document.body.appendChild(el);
  }
  el.textContent = name;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=> el.classList.remove('show'), 1600);
}

function nameForHotbarSlot(s){
  if(!s) return '';
  if(s.k==='t') return toolInfo(s.id).name;
  if(s.k==='f') return ITEMS[s.id]?.name || '';
  if(s.k==='b') return TYPES[s.id]?.name || '';
  return '';
}


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
    d.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      // Inventory open: place selected item into this slot (no auto-fill on item click)
      if(invOpen && (invPick != null || invPickTool)){
        if(invPickTool){
          hotbarSlots[i] = {k:'t', id:invPickTool};
          invPickTool = null;
        } else {
          const id = +invPick;
          hotbarSlots[i] = {k: id>=100 ? 'f' : 'b', id};
        }
        sel.slot = i;
        showSlotName(nameForHotbarSlot(hotbarSlots[i]));
        renderHotbar();
        if(invOpen) renderInv();
        return;
      }
      // Normal: select slot + show name toast
      sel.slot = i;
      showSlotName(nameForHotbarSlot(hotbarSlots[i]));
      renderHotbar();
    });
    hb.appendChild(d);
  });
  // Inventory button — last icon after the 10 slots
  const invBtn = document.createElement('div');
  invBtn.className = 'slot invSlotBtn';
  invBtn.title = 'Inventory';
  invBtn.innerHTML = '<span class="ticon">🎒</span>';
  invBtn.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    toggleInv();
  });
  hb.appendChild(invBtn);

  // HUD label for what's held
  const t = slotTool(), b = slotBlock();
  const fd = hotbarSlots[sel.slot]?.k==='f' ? hotbarSlots[sel.slot].id : 0;
  const tn = $('toolName');
  if(tn) tn.textContent = t!=='hand' ? toolInfo(t).name : fd ? ITEMS[fd].name : (b ? TYPES[b].name : 'Hand');
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
  {id:'inv',    icon:'👤', label:'Character'},
  {id:'can',    icon:'🛠️', label:'Crafting'},
  {id:'build',  icon:'🧱', label:'Blocks'},
  {id:'gear',   icon:'⚔️', label:'Equipment'},
  {id:'light',  icon:'💡', label:'Lights'},
  {id:'food',   icon:'🍖', label:'Food'},
  {id:'nature', icon:'🌿', label:'Items'},
  {id:'guide',  icon:'📖', label:'Guide'},
];
let invCat = 'inv', invPick = null;
let invPickTool = null;
let boxHint = '';
// head, chest, legs, feet, offhand (shield)
export const armorSlots = { head:null, chest:null, legs:null, feet:null, off:null };
let armorHook = null;
export function setArmorHook(fn){ armorHook = fn; }
export function getArmorSlots(){ return { ...armorSlots }; }
function notifyArmor(){ try{ armorHook?.(getArmorSlots()); }catch(e){} }

// Wipe the entire carried loadout (inventory, hotbar, armor). Used when a world
// crosses from Forge into Nightfall, so unlimited Forge gear can't enter survival.
export function clearLoadout(){
  for(const k of Object.keys(inventory)) delete inventory[k];
  for(let i=0;i<hotbarSlots.length;i++) hotbarSlots[i]=null;
  armorSlots.head = armorSlots.chest = armorSlots.legs = armorSlots.feet = armorSlots.off = null;
  sel.slot = 0;
  renderHotbar();
  if(invOpen) renderInv();
  notifyArmor();
}

/** Only real armor/shield items — never weapons, food, blocks, tools */
function canEquipInSlot(itemId, slotKey){
  const id = +itemId;
  if(!Number.isFinite(id)) return false;
  const it = ITEMS[id];
  if(!it) return false;
  if(it.dmg) return false;          // swords / weapons
  if(it.food || it.heal) return false;
  if(!it.slot) return false;        // must declare a slot
  if(it.slot !== slotKey) return false;
  return true;
}



function catOf(id){
  if(id < 100){
    if(TYPES[id]?.light || id===10) return 'light';
    return 'build';
  }
  const it = ITEMS[id];
  if(!it) return 'nature';
  if(it.dmg || it.slot || it.armor) return 'gear';
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
  const hideVariant = id => {
    if(id===63 || id===65) return true;
    // hide non-item door state ids (keep base item ids 48,70,78,86)
    if(id>=49 && id<=55) return true;
    if(id>=71 && id<=77) return true;
    if(id>=79 && id<=85) return true;
    if(id>=87 && id<=93) return true;
    return false;
  };
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

function renderCharPane(){
  // Exact Minecraft Pocket-style Armor pane
  const slotMeta = [
    { key:'head',  label:'Helmet',     svg:'M4 6h8v2H4zm1-3h6v3H5z' },
    { key:'chest', label:'Chestplate', svg:'M3 3h3v2H3zm7 0h3v2h-3zM4 5h8v9H4z' },
    { key:'legs',  label:'Leggings',   svg:'M4 2h8v3H4zm0 3h3v9H4zm5 0h3v9H9z' },
    { key:'feet',  label:'Boots',      svg:'M3 5h4v8H3zm6 0h4v8H9zM2 11h5v3H2zm7 0h5v3H9z' },
    { key:'off',   label:'Shield',     svg:'M8 1L2 4v4c0 4 3 6 6 7 3-1 6-3 6-7V4L8 1z' },
  ];
  const slots = slotMeta.map(s => {
    const eq = armorSlots[s.key];
    let inner;
    if(eq){
      inner = iconOf(eq);
    } else {
      inner = `<svg class="armorSil" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="#3a3a3a" d="${s.svg}"/></svg>`;
    }
    return `<button type="button" class="armorSlot${eq?' filled':''}" data-armor="${s.key}" title="${s.label}">${inner}</button>`;
  }).join('');

  const hx = (id, fb) => {
    const c = id && ITEMS[id]?.color;
    if(c == null) return fb;
    return '#' + (c>>>0).toString(16).padStart(6,'0');
  };
  const headC = hx(armorSlots.head, '#c48a5a');
  const shirtC = hx(armorSlots.chest, '#3d7a4a');
  const pantC = hx(armorSlots.legs, '#4a3420');
  const bootC = hx(armorSlots.feet, '#2b2b2b');
  const helm = armorSlots.head
    ? `<div class="mcHelm" style="background:${hx(armorSlots.head,'#8B5A2B')}"></div>` : '';
  const shield = armorSlots.off
    ? `<div class="mcShield" style="background:${hx(armorSlots.off,'#8B6914')}"></div>` : '';
  const hint = boxHint ? `<p class="dHint charHint" style="color:#a33">${boxHint}</p>` : '';
  boxHint = '';
  return `<div class="mcArmorBox">
    <div class="mcArmorInner">
      <div class="mcArmorSlots">${slots}</div>
      <div class="mcArmorView">
        <div class="mcSkin">
          ${helm}
          <div class="mcHair"></div>
          <div class="mcHead" style="background:${armorSlots.head ? hx(armorSlots.head,'#8B5A2B') : '#c48a5a'}">
            <div class="mcEye mcEyeL"></div>
            <div class="mcEye mcEyeR"></div>
            <div class="mcMouth"></div>
          </div>
          <div class="mcTorso" style="background:${shirtC}"></div>
          <div class="mcArmL"></div>
          <div class="mcArmR"></div>
          <div class="mcLegL" style="background:${pantC}"></div>
          <div class="mcLegR" style="background:${pantC}"></div>
          <div class="mcBootL" style="background:${bootC}"></div>
          <div class="mcBootR" style="background:${bootC}"></div>
          ${shield}
        </div>
      </div>
    </div>
    ${hint}
  </div>`;
}

function renderDetail(){
  const box = $('invDetail');
  // Character tab ALWAYS shows the armor + figure panel (Minecraft-style)
  if(invCat==='inv' || invCat==='gear'){
    box.innerHTML = renderCharPane();
    return;
  }
  if(invPick == null || !(TYPES[invPick] || ITEMS[invPick])){
    if(invCat==='can'){
      box.innerHTML = `<div class="dSlots"><div class="dSlot"></div><div class="dSlot"></div>
          <div class="dSlot"></div><div class="dSlot"></div></div>
        <div class="dArrow">▼</div>
        <div class="dSlot out"></div>
        <p class="dHint">Pick a craftable item to see its recipe.</p>`;
      return;
    }
    const hint = invCat==='guide'
      ? 'Pick an entry to learn where to find it and what it is for.'
      : 'Pick an item on the left for details.';
    box.innerHTML = `<p class="dHint">${hint}</p>`;
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
  document.body.classList.toggle('inv-craft', invCat==='can');
  document.body.classList.toggle('inv-char', invCat==='inv' || invCat==='gear');
  document.body.classList.toggle('inv-full', invCat==='build' || invCat==='nature' || invCat==='light' || invCat==='food');
  const title = $('invTitle');
  if(title) title.textContent = CATS.find(c=>c.id===invCat)?.label || 'Items';
  const q = getSearchQuery();
  grid.innerHTML = '';

  // tools always live in the Equipment tab and in Inventory
  if(invCat==='gear' || invCat==='inv'){
    for(const t of TOOLS){
      if(t.id==='hand') continue;
      if(q && !matchesSearch(t.name)) continue;
      const d = document.createElement('div');
      d.className = 'invItem tool' + (invPickTool===t.id ? ' sel':'');
      d.innerHTML = `<span class="ticon">${t.icon}</span>`;
      d.title = t.name;
      d.addEventListener('pointerdown', e=>{
        e.stopPropagation();
        invPick = null;
        invPickTool = t.id;
        // Highlight selection only; place by tapping a hotbar slot
        renderInv();
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
      invPickTool = null;
      // Do NOT auto-add to hotbar — select then tap a hotbar slot to place
      if(gm.forge && id>=100) inventory[id] = 999;
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
    // Prefer a tab that always has content (empty pack looked "broken" on mobile)
    let start = tab;
    if(!start){
      const hasItems = Object.values(inventory).some(n => n > 0);
      start = hasItems ? 'inv' : (gm.forge ? 'build' : 'can');
    }
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
  // Single delegated armor-slot handler (strict slot rules)
  const detail = $('invDetail');
  if(detail && !detail.dataset.armorBound){
    detail.dataset.armorBound = '1';
    detail.addEventListener('pointerdown', e=>{
      const btn = e.target.closest('[data-armor]');
      if(!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.armor;
      if(!key) return;

      // Unequip if slot already filled
      if(armorSlots[key] != null){
        armorSlots[key] = null;
        boxHint = '';
        notifyArmor();
        renderInv();
        return;
      }

      // Must have a selected inventory item
      if(invPick == null){
        boxHint = 'Select an armor piece first.';
        renderInv();
        return;
      }

      // Strict: only matching armor type (blocks swords etc.)
      if(!canEquipInSlot(invPick, key)){
        const need = {head:'helmet',chest:'chestplate',legs:'leggings',feet:'boots',off:'shield'}[key]||key;
        const it = ITEMS[invPick];
        boxHint = it?.dmg
          ? 'Weapons cannot go in armor slots.'
          : `Only a ${need} fits this slot.`;
        renderInv();
        return;
      }

      if((inventory[invPick]||0) < 1 && !gm.forge){
        boxHint = 'You do not have that item.';
        renderInv();
        return;
      }

      armorSlots[key] = +invPick;
      boxHint = '';
      notifyArmor();
      renderInv();
    });
  }
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
  // ========== Crosshair dig/place (Minecraft PE style) ==========
  // Aim with crosshair. Short tap = place. Hold = mine.
  // Looking is allowed on the same finger; only large early drag cancels a pending hold.
  let digId = null, digX = 0, digY = 0, digStart = 0, digMaxMove = 0;
  let digMining = false, digTimer = null;
  let lastTapX = null, lastTapY = null;   // where the 🧱 button re-places
  // Touch-to-place: you tap the block you want, so there is no crosshair.
  // A drag is looking and NEVER places, however it ends. TAP_SLOP is finger
  // jitter only — past it the gesture is a look, permanently.
  const HOLD_MS = 450;
  const TAP_SLOP = 12;     // px — beyond this the gesture is a drag, not a tap
  const MINE_CANCEL = 36;  // px — drag this much before HOLD cancels pending mine start
  $('crosshair')?.style.setProperty('display', 'none', 'important');

  function digClear(stopMine){
    if(digTimer){ clearTimeout(digTimer); digTimer = null; }
    if(stopMine && digMining){ hooks.mine(false); digMining = false; }
    digId = null;
  }

  function isUiTouch(x, y){
    const el = document.elementFromPoint(x, y);
    if(!el || !el.closest) return false;
    return !!el.closest('#hotbar,#joyZone,.tbtn,#btnChat,#btnQuit,#btnMode,#compass,#inv,#pauseMenu,#chatBox');
  }

  // Prefer the canvas; fall back to #game
  const digSurface = document.querySelector('#game canvas') || $('game');

  digSurface.addEventListener('touchstart', e=>{
    if(invOpen || !hooks) return;
    // only primary finger for dig
    const t = e.changedTouches[0];
    if(isUiTouch(t.clientX, t.clientY)) return;
    // Keep clear of the joystick, but no further: isUiTouch already rejects
    // #joyZone and the rest of the HUD, and a 38% dead strip made most of a
    // landscape phone unable to place at all.
    if(t.clientX < innerWidth * 0.22) return;

    e.preventDefault();
    if(lookId === null){ lookId = t.identifier; lookX = t.clientX; lookY = t.clientY; }

    digId = t.identifier;
    digX = t.clientX; digY = t.clientY;
    digStart = performance.now();
    digMaxMove = 0;
    digMining = false;
    if(digTimer) clearTimeout(digTimer);
    digTimer = setTimeout(()=>{
      digTimer = null;
      if(digId == null || invOpen) return;
      if(digMaxMove > MINE_CANCEL) return; // was looking around
      digMining = true;
      hooks.mine(true, digX, digY);        // dig the block under the finger
    }, HOLD_MS);
  }, {passive:false});

  document.addEventListener('touchmove', e=>{
    if(digId == null) return;
    for(const t of e.changedTouches){
      if(t.identifier !== digId) continue;
      const d = Math.hypot(t.clientX - digX, t.clientY - digY);
      if(d > digMaxMove) digMaxMove = d;
      if(!digMining && digMaxMove > MINE_CANCEL && digTimer){
        clearTimeout(digTimer); digTimer = null;
      }
    }
  }, {passive:true});

  const endDig = e=>{
    if(digId == null) return;
    for(const t of e.changedTouches){
      if(t.identifier !== digId) continue;
      const held = performance.now() - digStart;
      const wasMining = digMining;
      const move = digMaxMove;
      if(digTimer){ clearTimeout(digTimer); digTimer = null; }
      if(digMining){ hooks.mine(false); digMining = false; }
      digId = null;

      // PLACE only on a clean tap — at the pixel that was tapped. Any drag past
      // TAP_SLOP was a look, so it never places no matter how it ended.
      if(!wasMining && !invOpen && held < HOLD_MS && move < TAP_SLOP){
        const tx = t.clientX, ty = t.clientY;
        lastTapX = tx; lastTapY = ty;
        requestAnimationFrame(()=> hooks.place?.(tx, ty));
      }
    }
  };
  document.addEventListener('touchend', endDig);
  document.addEventListener('touchcancel', endDig);

  function bindPress(el, onStart, onEnd){
    if(!el) return;
    const down = e=>{ e.preventDefault(); e.stopPropagation(); el.classList.add('pressed'); onStart?.(e); };
    const up = e=>{ el.classList.remove('pressed'); onEnd?.(e); };
    el.addEventListener('touchstart', down, {passive:false});
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  }
  bindPress($('btnJump'), ()=>hooks.jump(true), ()=>hooks.jump(false));
  // Mining stays a hold-on-world gesture, but placing gets a dedicated button:
  // tap detection on the world surface can miss, and a button never does.
  const bm = $('btnMine'); if(bm) bm.style.display = 'none';
  // 🧱 repeats a placement at the last spot you tapped — handy for stacking
  // without re-aiming. Falls back to screen centre before your first tap.
  bindPress($('btnPlace'), ()=>{
    if(lastTapX === null) hooks.place?.(innerWidth/2, innerHeight/2);
    else hooks.place?.(lastTapX, lastTapY);
  }, null);
  $('btnDrop')?.addEventListener('touchstart', e=>{ e.preventDefault(); hooks.drop?.(); });
  bindPress($('btnSprint'), ()=>hooks.sprint?.(true), ()=>hooks.sprint?.(false));
  bindPress($('btnDrop'), ()=>hooks.drop?.(), null);
  const bf = $('btnFly');
  if(bf){
    bf.addEventListener('touchstart', e=>{
      e.preventDefault(); e.stopPropagation();
      bf.classList.add('pressed');
      const on = hooks.fly?.();
      // Ensure toggle class even if player path missed it
      if(on === true) bf.classList.add('active');
      else if(on === false) bf.classList.remove('active');
      setTimeout(()=> bf.classList.remove('pressed'), 150);
    });
    bf.addEventListener('touchend', ()=> bf.classList.remove('pressed'));
    bf.addEventListener('touchcancel', ()=> bf.classList.remove('pressed'));
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

// Transient slide-in notice (reuses the #toasts rail + .toast styling).
export function toast(text, ms=3500){
  const host = $('toasts');
  if(!host) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  host.appendChild(t);
  requestAnimationFrame(()=>t.classList.add('show'));
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(), 500); }, ms);
}

// Elegant auto-dismissing center card. body accepts inline HTML (trusted callers).
let _cnTimer = null;
export function showCenterNotice(icon, title, body, ms = 4200){
  const el = $('centerNotice');
  if(!el) return;
  el.querySelector('.cnIcon').textContent = icon || '';
  el.querySelector('.cnTitle').textContent = title || '';
  el.querySelector('.cnBody').innerHTML = body || '';
  const card = el.querySelector('.cnCard');
  card.classList.remove('cnOut');
  el.style.display = 'flex';
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = ''; // restart entrance
  clearTimeout(_cnTimer);
  _cnTimer = setTimeout(()=>{
    card.classList.add('cnOut');
    setTimeout(()=>{ el.style.display = 'none'; card.classList.remove('cnOut'); }, 420);
  }, ms);
}

// Scary center-screen countdown; calls onDone() when it hits zero.
export function startHordeCountdown(secs = 10, onDone){
  const el = $('hordeCountdown');
  if(!el){ onDone?.(); return; }
  const numEl = el.querySelector('.hcNum');
  const labelEl = el.querySelector('.hcLabel');
  const subEl = el.querySelector('.hcSub');
  el.classList.remove('hcPanic','hcBurst');
  labelEl.textContent = 'THE HORDE APPROACHES';
  subEl.textContent = 'brace yourself…';
  el.style.display = 'flex';
  let n = secs;
  numEl.textContent = n;
  try{ sfx.heartbeat?.(); }catch(e){}
  const iv = setInterval(()=>{
    n--;
    if(n <= 0){
      clearInterval(iv);
      numEl.textContent = '';
      labelEl.textContent = 'THEY’RE HERE';
      subEl.textContent = '';
      el.classList.add('hcBurst');
      try{ sfx.hordeRoar?.(); }catch(e){}
      setTimeout(()=>{ el.style.display = 'none'; el.classList.remove('hcPanic','hcBurst'); }, 800);
      try{ onDone?.(); }catch(e){}
      return;
    }
    numEl.textContent = n;
    // restart the pop animation each tick
    numEl.style.animation = 'none'; void numEl.offsetWidth; numEl.style.animation = '';
    try{ sfx.heartbeat?.(); }catch(e){}
    if(n <= 3){ el.classList.add('hcPanic'); subEl.textContent = 'RUN.'; }
  }, 1000);
}

// Live save-health pip in the HUD. state: 'ok' | 'warn' | 'fail'
export function setSaveState(state){
  const el = $('saveState');
  if(!el) return;
  el.className = state==='fail' ? 'sFail' : state==='warn' ? 'sWarn' : 'sOk';
  el.textContent = state==='fail' ? '⚠ NOT SAVING'
                 : state==='warn' ? '💾 world large'
                 : '💾';
  el.title = state==='fail' ? 'Save failed — storage is full. Export this world now to avoid losing progress.'
           : state==='warn' ? 'This world is getting large. Export a backup to be safe.'
           : 'World saved';
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

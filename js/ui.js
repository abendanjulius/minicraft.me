// ui.js — hotbar, inventory, tool row, touch controls, banners
import { TYPES, TOOLS, isTouch } from './render.js';

export const inventory = {};
export const hotbarSlots = [null,null,null,null,null];
export const sel = { slot:0, tool:0 };   // shared selection state
export const joy = { x:0, y:0 };         // virtual joystick output

const $ = id=>document.getElementById(id);
let onToolChange = null, playerHooks = null;

export function addToInventory(t){
  inventory[t] = (inventory[t]||0)+1;
  if(!hotbarSlots.includes(t)){
    const empty = hotbarSlots.indexOf(null);
    if(empty !== -1) hotbarSlots[empty] = t;
  }
  renderHotbar();
  if(invOpen) renderInv();
}

export function renderTools(){
  const div = $('tools'); div.innerHTML = '';
  TOOLS.forEach((t,i)=>{
    const d = document.createElement('div');
    d.className = 'slot tool' + (i===sel.tool?' active':'');
    d.textContent = t.icon;
    d.title = t.name;
    d.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      sel.tool = i; renderTools();
      $('toolName').textContent = t.name;
    });
    div.appendChild(d);
  });
  onToolChange?.();
}
export function setToolChangeHook(fn){ onToolChange = fn; }

export function renderHotbar(){
  const hb = $('hotbar'); hb.innerHTML = '';
  hotbarSlots.forEach((tid,i)=>{
    const d = document.createElement('div');
    const count = tid ? (inventory[tid]||0) : 0;
    d.className = 'slot' + (i===sel.slot?' active':'') + (tid?'':' empty') + (tid&&!count?' zero':'');
    d.innerHTML = `<span class="num">${i+1}</span><div class="sw" ${tid?`style="background-image:url(${TYPES[tid].icon})"`:''}></div>${tid?`<span class="cnt">${count}</span>`:''}`;
    if(tid && !isTouch){
      d.draggable = true;
      d.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain','slot:'+i));
    }
    d.addEventListener('dragover', e=>e.preventDefault());
    d.addEventListener('drop', e=>{
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      if(data.startsWith('inv:')) hotbarSlots[i] = +data.slice(4);
      else if(data.startsWith('slot:')){
        const j = +data.slice(5);
        [hotbarSlots[i], hotbarSlots[j]] = [hotbarSlots[j], hotbarSlots[i]];
      }
      renderHotbar();
    });
    d.addEventListener('pointerdown', e=>{ e.stopPropagation(); sel.slot=i; renderHotbar(); });
    hb.appendChild(d);
  });
  onToolChange?.(); // held item may have changed
}

export let invOpen = false;
export function renderInv(){
  const grid = $('invGrid'); grid.innerHTML = '';
  let any = false;
  for(const tid in inventory){
    if(inventory[tid]<=0) continue;
    any = true;
    const d = document.createElement('div');
    d.className = 'invItem';
    d.innerHTML = `<div class="sw" style="background-image:url(${TYPES[tid].icon})"></div><span class="cnt">${inventory[tid]}</span>`;
    if(!isTouch){
      d.draggable = true;
      d.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain','inv:'+tid));
    }
    d.addEventListener('pointerdown', ()=>{ hotbarSlots[sel.slot] = +tid; renderHotbar(); });
    grid.appendChild(d);
  }
  if(!any) grid.innerHTML = '<span class="empty-note">Nothing yet — go mine some blocks.</span>';
}
export function toggleInv(open){
  invOpen = open ?? !invOpen;
  $('inv').style.display = invOpen ? 'block' : 'none';
  document.body.classList.toggle('inv-open', invOpen);
  if(invOpen){ renderInv(); document.exitPointerLock?.(); }
  else playerHooks?.relock?.();
}

export function initUI(hooks){
  playerHooks = hooks;
  $('invHelp').textContent = isTouch
    ? 'Tap a block to put it in the selected hotbar slot. (🎒 to close)'
    : 'Drag a block onto a hotbar slot, or tap one to fill the selected slot. Drop a slot here to clear it. (E to close)';
  $('inv').addEventListener('dragover', e=>e.preventDefault());
  $('inv').addEventListener('drop', e=>{
    const data = e.dataTransfer.getData('text/plain');
    if(data.startsWith('slot:')){ hotbarSlots[+data.slice(5)] = null; renderHotbar(); }
  });
  $('invClear').addEventListener('pointerdown', ()=>{ hotbarSlots[sel.slot]=null; renderHotbar(); });
  renderHotbar(); renderTools();
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

export function setBanner(text){
  const b = $('banner');
  b.textContent = text || '';
  b.style.display = text ? 'block' : 'none';
}
export function setHud(fps, pos, tool){
  $('fps').textContent = fps;
  $('pos').textContent = pos;
  if(tool) $('toolName').textContent = tool;
}
export function setPlayers(list){
  $('players').textContent = list.length ? '👥 ' + list.join(', ') : '';
}

// survival.js — health, hunger, food, death, achievements
import { ITEMS, TYPES } from './render.js';
import { inventory, renderHotbar, renderInv, invOpen, addChat, getArmorSlots } from './ui.js';
import { sfx } from './audio.js';
import { gm } from './mode.js';
function armorPoints(){
  let a = 0;
  const slots = getArmorSlots?.() || {};
  for(const id of Object.values(slots)){
    if(id && ITEMS[id]?.armor) a += ITEMS[id].armor;
  }
  return a;
}


const $ = id=>document.getElementById(id);
export const sv = { hp:20, hunger:20, air:20, dead:false };

// Breath. Drains only while the HEAD is under — wading chest-deep is fine.
// ~15s of air, then a heart every 2s; refills fast the moment you surface.
const AIR_MAX = 20, AIR_DRAIN = AIR_MAX/15, AIR_REFILL = AIR_MAX/2.5, DROWN_EVERY = 2;
let submerged = false, drownT = 0;
export function setSubmerged(v){ submerged = !!v; }
export const isSubmerged = ()=> submerged;
let bedSpawn = null; // {x,y,z}
export function getBedSpawn(){ return bedSpawn; }
export function setBedSpawn(x,y,z){
  bedSpawn = {x, y, z};
  note('bed');
}
export function sleepTillDawn(){
  // time skip is driven by the sleep animation in player.js
  import('./render.js').then(r=>{ try{ r.setDayTime(0.28); }catch(e){} });
  sv.hp = Math.min(20, sv.hp + 6);
  sv.hunger = Math.min(20, sv.hunger + 2);
  renderVitals();
  note('sleep');
}

let onRespawn = null, onDeath = null, eatCd = 0, starveT = 0, regenT = 0, nightWasDark = false;

// ---- Achievements ----
const ACH = [
  {id:'mine1',  name:'First Block!',   goal:'Mine your first block'},
  {id:'log1',   name:'Timber!',        goal:'Chop a log from a tree'},
  {id:'ruin1',  name:'Ruin Raider',    goal:'Mine brick, planks or glass from a ruin'},
  {id:'build10',name:'Constructor',    goal:'Place 10 blocks'},
  {id:'meal1',  name:'Tasty',          goal:'Eat some food'},
  {id:'craft1', name:'Craftsman',      goal:'Craft something (press C)'},
  {id:'torch1', name:'Let There Be Light', goal:'Place a torch'},
  {id:'night1', name:'Sunrise',        goal:'Survive a night'},
  {id:'bed',   name:'Home Sweet Home', goal:'Set a bed as your respawn'},
  {id:'sleep', name:'Good Night',     goal:'Sleep through the night'},
  {id:'zkill1', name:'Back to Sleep',  goal:'Defeat a zombie'},
  {id:'recover1',name:'Leave No One Behind', goal:'Recover a fallen body before the horde feeds'},
  {id:'dayhunt1',name:'Daywalker Hunter',    goal:'Slay a hiding zombie in daylight'},
  {id:'cave1',  name:'Spelunker',      goal:'Descend into a cave'},
  {id:'ore1',   name:'Motherlode',     goal:'Mine Crystal Ore in the deep dark'},
  {id:'cube1',  name:'The Last Light', goal:'Find the Elder Cube'},
  {id:'keep1',  name:'Cradle',         goal:'Socket the Elder Cube into a Keepstone'},
  {id:'keepfull',name:'Reclaimed',     goal:'Fill a Keepstone’s claim to its edge'},
  {id:'claim1', name:'First Light',    goal:'Reclaim 1% of the world'},
  {id:'claim5', name:'Widening Dawn',  goal:'Reclaim 5% of the world'},
  {id:'claim10',name:'The Long Light', goal:'Reclaim 10% of the world'},
  {id:'claim25',name:'Dominion',       goal:'Reclaim a quarter of the world'},
];
const unlocked = new Set(JSON.parse(localStorage.getItem('mc_ach')||'[]'));
let placedCount = +(localStorage.getItem('mc_placed')||0);
function unlock(id){
  if(unlocked.has(id)) return;
  unlocked.add(id);
  localStorage.setItem('mc_ach', JSON.stringify([...unlocked]));
  const a = ACH.find(x=>x.id===id);
  toast('🏆 ' + a.name);
  sfx.ach();
  updateGoal();
}
function toast(text){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(()=>t.classList.add('show'), 20);
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(), 500); }, 3500);
}
function updateGoal(){
  const next = ACH.find(a=>!unlocked.has(a.id));
  $('goal').textContent = next ? '⭐ ' + next.goal : '⭐ All goals complete!';
}
export function note(what, arg){
  if(what==='mine'){
    unlock('mine1');
    if(arg===4) unlock('log1');
    if(arg===7||arg===8||arg===9) unlock('ruin1');
    if(arg===47) unlock('ore1');
  }
  if(what==='cave') unlock('cave1');
  if(what==='place'){
    placedCount++;
    localStorage.setItem('mc_placed', placedCount);
    if(placedCount>=10) unlock('build10');
  }
  if(what==='eat')   unlock('meal1');
  if(what==='craft') unlock('craft1');
  if(what==='place' && arg===10) unlock('torch1');
  if(what==='zkill'){ unlock('zkill1'); toast('Zombie defeated!'); }
  if(what==='dayhunt'){ unlock('zkill1'); unlock('dayhunt1'); toast('Hider slain! The horde weakens faster.'); }
  if(what==='recover'){ unlock('recover1'); toast('🕯 Body recovered — the horde learns nothing.'); }
  if(what==='bed'){ unlock('bed'); toast('🛏 Respawn point set'); }
  if(what==='sleep'){ unlock('sleep'); toast('😴 Slept till dawn'); }
  if(what==='cube'){ unlock('cube1'); toast('💠 The Elder Cube — it lights your way, it will not protect you'); }
  if(what==='socket'){ unlock('keep1'); toast('💠 Seated. Hold this ground.'); }
  if(what==='keepfull'){ unlock('keepfull'); toast('🕯 Claimed for good — the night cannot return here'); }
  if(what==='milestone'){
    const id = ['claim1','claim5','claim10','claim25'][arg-1];
    if(id) unlock(id);
  }
  if(what==='cubelost'){ toast('💠 You dropped the Elder Cube — get it back before they do'); }
}

// ---- Vitals UI ----
export function renderVitals(){
  const h = $('hearts'), f = $('hungerBar'), a = $('airBar');
  let hs = '', fs = '', as = '';
  for(let i=0;i<10;i++){
    hs += `<span class="vit ${sv.hp     > i*2+1 ? '' : sv.hp     > i*2 ? 'half' : 'off'}">❤</span>`;
    fs += `<span class="vit ${sv.hunger > i*2+1 ? '' : sv.hunger > i*2 ? 'half' : 'off'}">🍗</span>`;
    as += `<span class="vit ${sv.air    > i*2+1 ? '' : sv.air    > i*2 ? 'half' : 'off'}">🫧</span>`;
  }
  h.innerHTML = hs; f.innerHTML = fs;
  if(a){
    // Only surfaces when it matters — a full bar of bubbles is just clutter.
    a.innerHTML = as;
    a.style.display = sv.air >= 20 ? 'none' : 'block';
  }
}

export let godMode = false;
export function setGodMode(v){ godMode = !!v; }
export function damage(n, cause){
  if(godMode) return;

  if(gm.forge || sv.dead || n<=0) return;
  const ar = armorPoints();
  if(ar>0) n = Math.max(1, Math.round(n * (1 - Math.min(0.55, ar * 0.09))));
  sv.hp = Math.max(0, sv.hp - n);
  renderVitals();
  sfx.hurt();
  const v = $('vignette');
  v.style.opacity = .55;
  setTimeout(()=>v.style.opacity = 0, 220);
  if(sv.hp<=0) die(cause);
}
function die(cause){
  sv.dead = true;
  onDeath?.();
  const msg = {fall:'You fell from a high place', zombie:'A zombie got you', starve:'You starved',
               drown:'You drowned'}[cause] || 'You died';
  $('deathMsg').textContent = msg;
  $('deathScreen').style.display = 'flex';
  document.exitPointerLock?.();
}
export function respawn(){
  sv.dead = false; sv.hp = 20; sv.hunger = 20; sv.air = 20;
  drownT = 0;
  renderVitals();
  $('deathScreen').style.display = 'none';
  onRespawn?.();
}

export function eatSelected(foodId){
  if(eatCd>0 || sv.dead) return false;
  if(!inventory[foodId] || inventory[foodId]<=0) return false;
  const it = ITEMS[foodId];
  const useful = (it.food && sv.hunger < 20) || (it.heal && sv.hp < 20);
  if(!useful) return false;
  inventory[foodId]--;
  if(it.food) sv.hunger = Math.min(20, sv.hunger + it.food);
  if(it.heal) sv.hp = Math.min(20, sv.hp + it.heal);
  eatCd = 1;
  sfx.eat();
  note('eat');
  renderHotbar();
  if(invOpen) renderInv();
  renderVitals();
  return true;
}

// Called every frame from the main loop. moving = horizontal movement, dl = daylight 0..1
export function tick(dt, moving, dl){
  if(gm.forge || sv.dead){
    // Forge and death both reset breath, so surfacing isn't a punishment later.
    if(sv.air !== 20){ sv.air = 20; renderVitals(); }
    return;
  }
  eatCd = Math.max(0, eatCd - dt);

  // ---- breath ----
  const airWas = sv.air;
  if(submerged){
    sv.air = Math.max(0, sv.air - dt * AIR_DRAIN);
    if(sv.air <= 0){
      drownT += dt;
      if(drownT >= DROWN_EVERY){ drownT = 0; damage(2, 'drown'); }
    }
  } else {
    sv.air = Math.min(AIR_MAX, sv.air + dt * AIR_REFILL);
    drownT = 0;
  }
  if(Math.ceil(airWas) !== Math.ceil(sv.air)) renderVitals();

  // hunger drains slowly, faster while moving
  sv.hunger = Math.max(0, sv.hunger - dt*(.015 + (moving?.02:0)));
  // starving hurts; full-ish hunger regenerates
  if(sv.hunger<=0){
    starveT += dt;
    if(starveT>=3){ starveT=0; damage(1,'starve'); }
  } else if(sv.hunger>=18 && sv.hp<20){
    regenT += dt;
    if(regenT>=3){ regenT=0; sv.hp=Math.min(20,sv.hp+1); sv.hunger=Math.max(0,sv.hunger-.5); renderVitals(); }
  }
  // survived-a-night tracking
  if(dl<.1) nightWasDark = true;
  if(nightWasDark && dl>.35){ nightWasDark = false; unlock('night1'); }
  // hunger bar only re-renders occasionally via damage/eat; cheap periodic refresh:
  vitalsT += dt;
  if(vitalsT>1){ vitalsT=0; renderVitals(); }
}
let vitalsT = 0;

export function jumpCost(){ sv.hunger = Math.max(0, sv.hunger - .05); }

export function restore(hp, hunger){
  sv.hp = Math.min(20, Math.max(1, hp ?? 20));
  sv.hunger = Math.min(20, Math.max(0, hunger ?? 20));
  renderVitals();
}
export function initSurvival(hooks){
  onRespawn = hooks.onRespawn;
  onDeath = hooks.onDeath;
  $('respawnBtn').addEventListener('click', respawn);
  $('respawnBtn').addEventListener('touchstart', e=>{ e.preventDefault(); respawn(); });
  renderVitals();
  updateGoal();
}
export function showVitals(show){
  $('vitals').style.display = show?'flex':'none';
  $('goal').style.display = show?'block':'none';
}

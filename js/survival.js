// survival.js — health, hunger, food, death, achievements
import { ITEMS, TYPES } from './render.js';
import { inventory, renderHotbar, renderInv, invOpen, addChat } from './ui.js';
import { sfx } from './audio.js';
import { gm } from './mode.js';
function armorPoints(){
  let a = 0;
  if((inventory[181]||0)>0) a += 1;
  if((inventory[182]||0)>0) a += 3;
  if((inventory[183]||0)>0) a += 1;
  return a;
}


const $ = id=>document.getElementById(id);
export const sv = { hp:20, hunger:20, dead:false };
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
}

// ---- Vitals UI ----
export function renderVitals(){
  const h = $('hearts'), f = $('hungerBar');
  let hs = '', fs = '';
  for(let i=0;i<10;i++){
    hs += `<span class="vit ${sv.hp     > i*2+1 ? '' : sv.hp     > i*2 ? 'half' : 'off'}">❤</span>`;
    fs += `<span class="vit ${sv.hunger > i*2+1 ? '' : sv.hunger > i*2 ? 'half' : 'off'}">🍗</span>`;
  }
  h.innerHTML = hs; f.innerHTML = fs;
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
  const msg = {fall:'You fell from a high place', zombie:'A zombie got you', starve:'You starved'}[cause] || 'You died';
  $('deathMsg').textContent = msg;
  $('deathScreen').style.display = 'flex';
  document.exitPointerLock?.();
}
export function respawn(){
  sv.dead = false; sv.hp = 20; sv.hunger = 20;
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
  if(gm.forge || sv.dead) return;
  eatCd = Math.max(0, eatCd - dt);
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

// ai.js — Cube-arc spectator bot. Drives the local player until you turn it off.
// No time limit. Nightfall-oriented: vault → Cube → Keepstone → siege → done.
// Pathing: 8-way scored steering + jump/dig recovery (v2.5.2).

import { WORLD, WH, getBlock, surfaceY, isWalkThrough, wrapC, seed } from './world.js';
import { player, view, state, keys, setMine, placeAction, castBlock, carryingCube, setInputLocked, skinIdx, toggleFly, pulsePlace, hasBlockSupport, placeOverlapsPlayer } from './player.js';
import { inventory, hotbarSlots, sel, renderHotbar, joy, addChat } from './ui.js';
import { TYPES, ITEMS, faceURL, SKINS, applyEdit } from './render.js';
import { gm } from './mode.js';
import * as eldercube from './eldercube.js';
import * as keepstones from './keepstones.js';
import * as craft from './craft.js';
import { zombies } from './mobs.js';
import * as survival from './survival.js';
import * as net from './net.js';
import * as buildings from './buildings.js';
import * as persist from './persist.js';

const CUBE = 186;
const KEEPSTONE = 43;
const STONE = 3;
const IRON_CHUNK = 121;
const IRON_INGOT = 126;
const CRYSTAL = 122;

const PHASES = {
  IDLE: 'idle',
  TRAVEL: 'travel',
  DESCEND: 'descend',
  LOOT: 'loot',
  ASCEND: 'ascend',
  GATHER: 'gather',
  PLACE: 'place',
  SOCKET: 'socket',
  DEFEND: 'defend',
  DONE: 'done',
  // Builder
  BUILD_SETUP: 'build_setup',
  BUILD_PLACE: 'build_place',
  BUILD_DONE: 'build_done',
};

/** @type {'story'|'builder'} */
let botProfile = 'story';
/** @type {'creative'|'landmark'|null} */
let builderMode = null;
let landmarkId = null;
let buildQueue = [];     // [{x,y,z,id}, ...] absolute cells
let buildIndex = 0;
let buildOrigin = null;  // {x,y,z}
let buildName = '';
let placeCd = 0;
let buildClipped = 0;    // cells dropped for being above the world ceiling
let buildDeferred = [];  // cells that had no support this pass
let buildPass = 1;
let buildPassPlaced = 0;
let buildPlacedTotal = 0;   // blocks actually placed (the cursor also moves on skips)
let buildStranded = 0;
let approachT = 0; // time spent trying to reach current build cell
let unstuckHold = 0;
let unstuckYawHold = 0;
let unstuckRiseY = 0;
let buildStartedAt = 0;  // performance.now()/1000 when first block of this job placed
let buildPlaceTimes = []; // rolling samples of seconds per block
let buildJobId = null;     // registry id of the active job
let pendingLandmark = null; // landmark awaiting continue/new choice


let active = false;
let phase = PHASES.IDLE;
let status = '';
let target = null;
let mineTimer = 0;
let mineLock = null; // {x,y,z} hold still until this block breaks
let deathWait = 0;
let actionCd = 0;
let stuckT = 0;
let lastPos = {x:0, y:0, z:0};
let phaseT = 0;
let announceAt = 0;
let avoidYaw = 0;          // temporary detour heading
let avoidT = 0;            // seconds left on detour
let digCd = 0;
let craftCd = 0;
let streamCamGuard = 0;
let wanderAng = 0;
let recoverMode = 0;       // 0 none, 1 dig, 2 turn, 3 back up
let sameActionCount = 0;   // stuck-alarm: same plan with no progress
let sameActionTick = 0;
let lastActionKey = '';
let progressPos = {x:0,y:0,z:0};
let steerDir = null;   // held [dx,dz] for smooth pathing
let steerHold = 0;
let smoothPitchTarget = null;

export const isActive = () => active;
export const getPhase = () => phase;
export const getStatus = () => status;

function setStatus(s){
  if(s === status) return;
  status = s;
  const el = document.getElementById('aiStatus');
  if(el) el.textContent = active ? `🤖 ${s}` : '';
  if(active) updateStreamCam(s);
}


function streamCamEl(){ return document.getElementById('streamCam'); }

function showStreamCam(){
  const el = streamCamEl();
  if(!el){
    console.warn('[ai] streamCam element missing');
    return;
  }
  el.classList.add('scShow');
  el.setAttribute('aria-hidden', 'false');
  // Inline styles beat stubborn mobile CSS
  const touch = document.body.classList.contains('touch');
  el.style.setProperty('display', 'block', 'important');
  el.style.setProperty('visibility', 'visible', 'important');
  el.style.setProperty('opacity', '1', 'important');
  el.style.setProperty('z-index', '9999', 'important');
  el.style.setProperty('position', 'fixed', 'important');
  el.style.setProperty('left', '8px', 'important');
  if(touch){
    el.style.setProperty('top', '42px', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('width', '50px', 'important');
  } else {
    el.style.setProperty('bottom', '12px', 'important');
    el.style.setProperty('top', 'auto', 'important');
    el.style.setProperty('width', '60px', 'important');
  }
  const img = document.getElementById('scFace');
  const name = document.getElementById('scName');
  try{
    const idx = skinIdx();
    if(img){
      img.src = faceURL(idx);
      img.style.imageRendering = 'pixelated';
      img.onerror = ()=>{ img.style.background = '#4a6fa5'; img.removeAttribute('src'); };
    }
    if(name) name.textContent = (SKINS[idx]?.name || 'Player') + ' · AI';
  }catch(e){
    console.warn('[ai] streamCam face', e);
    if(img) img.style.background = '#4a6fa5';
  }
  updateStreamCam('starting the run');
}

function hideStreamCam(){
  const el = streamCamEl();
  if(!el) return;
  el.classList.remove('scShow','scMine','scFight','scSwim');
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
}

function updateStreamCam(action){
  // Name/action text removed from UI — keep mood only for face animation
  const el = streamCamEl();
  if(!el) return;
  el.dataset.mood = '';
  const a = (action || status || '').toLowerCase();
  if(a.includes('fight') || a.includes('siege')) el.dataset.mood = 'fight';
  else if(a.includes('swim')) el.dataset.mood = 'swim';
  else if(a.includes('mining') || a.includes('shaft') || a.includes('gather') || a.includes('descend') || a.includes('climb')) el.dataset.mood = 'mine';
  else el.dataset.mood = 'idle';
}

const FACE_EXPR = ['scLookL','scLookR','scNod','scBlink','scLean','scShock','scMine','scFight','scSwim'];
let faceT = 0;
let faceHold = 0;
let faceExpr = '';

/** Drive natural streamer-like head motion independent of status text. */
function tickStreamFace(dt){
  const el = streamCamEl();
  if(!el || !el.classList.contains('scShow')) return;
  faceT += dt;
  faceHold -= dt;

  const mood = el.dataset.mood || 'idle';

  // Blink every ~2.5–4s
  if(faceHold <= 0 && Math.random() < dt * 0.35){
    faceExpr = 'scBlink';
    faceHold = 0.12;
  } else if(faceHold <= 0){
    // Pick expression from mood
    let pick;
    if(mood === 'fight'){
      pick = Math.random() < 0.55 ? 'scFight' : (Math.random() < 0.5 ? 'scShock' : 'scLookL');
      faceHold = 0.25 + Math.random() * 0.35;
    } else if(mood === 'mine'){
      pick = Math.random() < 0.6 ? 'scLean' : (Math.random() < 0.5 ? 'scNod' : 'scMine');
      faceHold = 0.35 + Math.random() * 0.5;
    } else if(mood === 'swim'){
      pick = 'scSwim';
      faceHold = 0.4;
    } else {
      // idle: glance around like watching the game
      const r = Math.random();
      if(r < 0.28) pick = 'scLookL';
      else if(r < 0.56) pick = 'scLookR';
      else if(r < 0.72) pick = 'scNod';
      else if(r < 0.85) pick = 'scLean';
      else pick = '';
      faceHold = 0.45 + Math.random() * 1.1;
    }
    faceExpr = pick;
  }

  for(const c of FACE_EXPR) el.classList.toggle(c, c === faceExpr);
}

function clearKeys(){
  keys.KeyW = keys.KeyA = keys.KeyS = keys.KeyD = false;
  keys.Space = false;
  keys.ShiftLeft = keys.ShiftRight = keys.sprint = false;
}

function clearMining(){
  mineLock = null;
  mineTimer = 0;
  state.mineHeld = false;
  state.mineTarget = null;
  state.mineScreen = null;
  state.mining = null;
  try{ setMine(false); }catch(e){}
}

function reevaluatePhase(){
  stuckT = 0;
  avoidT = 0;
  recoverMode = 0;
  target = vaultTarget();
  if(carryingCube() || has(CUBE)){
    setPhase(PHASES.GATHER, 'Have the Cube — gathering Keepstone…');
  } else if(keepstones.sieging()){
    setPhase(PHASES.DEFEND, 'Siege underway — defending…');
  } else if(keepstones.all().some(s => s.socketed && keepstones.isDone(s))){
    setPhase(PHASES.DONE, 'Claim complete — watching…');
  } else {
    setPhase(PHASES.TRAVEL, 'Marching to the vault…');
  }
}


function wrapDelta(d){
  if(d >  WORLD/2) d -= WORLD;
  if(d < -WORLD/2) d += WORLD;
  return d;
}

function distXZ(ax, az, bx, bz){
  return Math.hypot(wrapDelta(bx - ax), wrapDelta(bz - az));
}

function solid(x, y, z){
  y = y|0;
  if(y < 0 || y >= WH) return true;
  const b = getBlock(Math.round(x), y, Math.round(z));
  return !!(b && !isWalkThrough(b) && b !== 64);
}

function isWaterAt(x, y, z){
  return getBlock(Math.round(x), y|0, Math.round(z)) === 64;
}

function headSubmerged(){
  return isWaterAt(player.pos.x, player.pos.y + 1.5, player.pos.z);
}

function feetInWater(){
  return isWaterAt(player.pos.x, player.pos.y, player.pos.z)
      || isWaterAt(player.pos.x, player.pos.y + 0.5, player.pos.z);
}

function inWaterNow(){
  return headSubmerged() || feetInWater();
}

/** Best horizontal direction toward dry / shallow ground. */
function shoreSteer(){
  const px = Math.round(player.pos.x);
  const py = Math.round(player.pos.y);
  const pz = Math.round(player.pos.z);
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let best = null, bestScore = -Infinity;
  for(const [dx, dz] of dirs){
    const len = Math.hypot(dx, dz);
    let score = 0;
    // probe 1..4 blocks out
    for(let step = 1; step <= 4; step++){
      const nx = px + (dx / len) * step;
      const nz = pz + (dz / len) * step;
      if(!isWaterAt(nx, py + 1, nz) && !solid(nx, py + 1, nz)) score += 6;
      if(!isWaterAt(nx, py, nz)) score += 5;
      if(!isWaterAt(nx, py, nz) && solid(nx, py - 1, nz)) score += 12; // shore
      if(solid(nx, py, nz) && solid(nx, py + 1, nz)) score -= 8; // wall
    }
    if(target){
      const nx = px + dx / len * 2, nz = pz + dz / len * 2;
      score += (distXZ(px, pz, target.x, target.z) - distXZ(nx, nz, target.x, target.z)) * 2;
    }
    if(score > bestScore){ bestScore = score; best = [dx / len, dz / len]; }
  }
  return best;
}

/**
 * Only seizes control when the HEAD is underwater (real submersion).
 * Wading (feet only) returns false so normal pathing keeps working.
 * Avoids the old "jump + look up forever" loop.
 */
function escapeWater(dt){
  // Wading: do not hijack — navigateTo will prefer dry land
  if(!headSubmerged()) return false;

  const px = Math.round(player.pos.x);
  const py = Math.round(player.pos.y);
  const pz = Math.round(player.pos.z);

  setStatus('Swimming out…');
  keys.sprint = false;
  keys.ShiftLeft = keys.ShiftRight = false;
  keys.Space = true; // always buoyancy when submerged

  // Ceiling solids directly above — dig them (explicit look + mine)
  let ceiling = null;
  for(let dy = 2; dy <= 5; dy++){
    if(solid(px, py + dy, pz)){ ceiling = py + dy; break; }
  }
  if(ceiling != null){
    selectTool('pick');
    // aim at the block center above the eyes
    view.pitch = -1.35;
    keys.KeyW = false;
    if(digCd <= 0) digLook(0.65);
    // also try mining the block in front-up if vertical ray misses
    if(mineTimer <= 0){
      const ax = Math.round(px - Math.sin(view.yaw));
      const az = Math.round(pz - Math.cos(view.yaw));
      if(solid(ax, ceiling, az) || solid(px, ceiling, pz)){
        view.yaw += 0.15 * dt; // micro-sweep so castBlock catches a face
        digLook(0.65);
      }
    }
    return true;
  }

  // No ceiling: swim toward shore with mostly HORIZONTAL look so we can dig
  // walls and actually path — not stare at the sky.
  const steer = shoreSteer();
  if(steer){
    faceYaw(Math.atan2(-steer[0], -steer[1]), dt, 1.8);
  } else {
    view.yaw += 1.5 * dt;
  }
  keys.KeyW = true;

  // Alternate dig ahead (walls) vs slight look-up (surface) every ~0.7s
  const pulse = Math.floor(phaseT * 1.4) % 3;
  if(pulse === 0){
    view.pitch = -0.25; // look slightly up while swimming
  } else if(pulse === 1){
    view.pitch = 0.05;
    const ax = px - Math.sin(view.yaw);
    const az = pz - Math.cos(view.yaw);
    if(solid(ax, py + 1, az) || solid(ax, py + 2, az)){
      if(digCd <= 0) digLook(0.55);
    }
  } else {
    view.pitch = -0.15;
    // carve forward if blocked
    if(digCd <= 0) digLook(0.4);
  }

  // If not gaining height for a while, spin and dig a new direction
  const movedY = player.pos.y - lastPos.y;
  if(movedY < 0.03) stuckT += dt;
  else stuckT = Math.max(0, stuckT - dt * 2);

  if(stuckT > 1.0){
    view.yaw += 1.1 + Math.random() * 0.8;
    view.pitch = -0.2;
    digLook(0.7);
    stuckT = 0.2;
  }

  return true;
}

function passableColumn(x, yFeet, z){
  // body needs feet cell walk-through-or-ground and head clear
  const fy = Math.round(yFeet);
  if(solid(x, fy + 1, z)) return false; // chest
  if(solid(x, fy + 2, z)) return false; // head
  return true;
}

function faceYaw(want, dt, rate = 0.95){
  let dy = want - view.yaw;
  while(dy > Math.PI) dy -= Math.PI * 2;
  while(dy < -Math.PI) dy += Math.PI * 2;
  // Wider dead-zone — stops left/right shimmer
  if(Math.abs(dy) < 0.06) return true;
  // Strong ease when nearly aligned
  const ease = Math.min(1, Math.abs(dy) * 0.9);
  const max = rate * dt * (0.25 + 0.55 * ease);
  view.yaw += Math.max(-max, Math.min(max, dy));
  return Math.abs(dy) < 0.1;
}

function faceToward(tx, tz, dt, pitch = null, rate = 1.15){
  const dx = wrapDelta(tx - player.pos.x);
  const dz = wrapDelta(tz - player.pos.z);
  const want = Math.atan2(-dx, -dz);
  const ok = faceYaw(want, dt, rate);
  if(pitch != null){
    const dp = pitch - view.pitch;
    if(Math.abs(dp) > 0.03){
      const max = rate * 0.85 * dt;
      view.pitch += Math.max(-max, Math.min(max, dp));
    }
    view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch));
  }
  return ok;
}

function smoothPitch(want, dt, rate = 0.9){
  const dp = want - view.pitch;
  if(Math.abs(dp) < 0.03) return;
  const max = rate * dt;
  view.pitch += Math.max(-max, Math.min(max, dp));
  view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch));
}

function selectTool(id){
  const i = hotbarSlots.findIndex(s => s?.k === 't' && s.id === id);
  if(i >= 0){ sel.slot = i; renderHotbar(); return true; }
  return false;
}

function selectItem(id){
  const i = hotbarSlots.findIndex(s => s && s.id === id);
  if(i >= 0){ sel.slot = i; renderHotbar(); return true; }
  if((inventory[id] || 0) > 0){
    const empty = hotbarSlots.findIndex(s => s === null);
    if(empty >= 0){
      hotbarSlots[empty] = {k: id >= 100 ? 'f' : 'b', id};
      sel.slot = empty;
      renderHotbar();
      return true;
    }
  }
  return false;
}

function has(id, n = 1){ return (inventory[id] || 0) >= n; }
function count(id){ return inventory[id] || 0; }

/** Put an owned item/tool onto an empty hotbar slot (or select if already there). */
function ensureHotbar(id, kind){
  const existing = hotbarSlots.findIndex(s => s && s.id === id);
  if(existing >= 0){ sel.slot = existing; renderHotbar(); return true; }
  if(kind !== 't' && count(id) <= 0) return false;
  const empty = hotbarSlots.findIndex(s => s === null);
  if(empty < 0) return false;
  hotbarSlots[empty] = {k: kind, id};
  sel.slot = empty;
  renderHotbar();
  return true;
}

function ensureTool(toolId){
  const i = hotbarSlots.findIndex(s => s?.k === 't' && s.id === toolId);
  if(i >= 0) return true;
  const empty = hotbarSlots.findIndex(s => s === null);
  if(empty < 0){
    // replace a non-tool slot
    const slot = hotbarSlots.findIndex(s => !s || s.k !== 't');
    if(slot < 0) return false;
    hotbarSlots[slot] = {k: 't', id: toolId};
    renderHotbar();
    return true;
  }
  hotbarSlots[empty] = {k: 't', id: toolId};
  renderHotbar();
  return true;
}

/** Craft any one recipe that outputs outId (first craftable match). */
function tryCraftId(outId){
  for(const r of craft.RECIPES){
    if(r.out.id !== outId) continue;
    if(!craft.canCraft(r)) continue;
    if(!craft.craft(r)) continue;
    const kind = outId >= 100 ? 'f' : 'b';
    ensureHotbar(outId, kind);
    return true;
  }
  return false;
}

function hasWeapon(){
  if(hotbarSlots.some(s => s?.k === 'f' && ITEMS[s.id]?.dmg)) return true;
  for(const id of [140, 141, 142, 143, 144, 145, 146]) if(count(id) > 0) return true;
  return false;
}

function selectWeapon(){
  for(let i = 0; i < hotbarSlots.length; i++){
    const s = hotbarSlots[i];
    if(s?.k === 'f' && ITEMS[s.id]?.dmg){ sel.slot = i; renderHotbar(); return true; }
  }
  for(const id of [143, 142, 141, 140, 146, 145, 144]){
    if(count(id) > 0 && ensureHotbar(id, 'f')) return true;
  }
  return false;
}

/**
 * Full crafting brain — runs on a short cooldown.
 * Builds planks/sticks/torches/ingots/weapons/Keepstone when ingredients exist.
 */
function runCrafting(){
  // Core conversions
  if(has(4, 1)) tryCraftId(7);            // log → planks
  if(has(7, 2)) tryCraftId(110);          // planks → sticks
  if(has(IRON_CHUNK, 3)) tryCraftId(IRON_INGOT);
  // Makeshift coal + torches (light for caves / night)
  if(count(120) < 4 && has(4, 1) && has(119, 1)) tryCraftId(120);
  if(count(10) < 8 && has(110, 1) && (has(4, 1) || has(120, 1) || has(128, 1))) tryCraftId(10);
  // Club / wooden weapon
  if(!hasWeapon() && has(7, 2) && has(110, 1)) tryCraftId(140);
  // Keepstone
  if(has(CRYSTAL, 2) && has(IRON_INGOT, 2) && has(STONE, 8)) tryCraftId(KEEPSTONE);
  // Simple cooked-ish foods when possible
  if(count(101) + count(102) + count(103) + count(150) < 2){
    tryCraftId(150); // whatever simple food recipes accept
  }
  // Ensure basic tools always on bar
  ensureTool('pick');
  ensureTool('axe');
  ensureTool('shovel');
  if(has(KEEPSTONE)) ensureHotbar(KEEPSTONE, 'b');
  if(has(CUBE)) ensureHotbar(CUBE, 'f');
  if(has(10)) ensureHotbar(10, 'b');
}

function ensureKeepstoneMats(){
  runCrafting();
  return has(KEEPSTONE);
}

/** Eat / heal from inventory when vitals are low. */
function useConsumables(){
  const sv = survival.sv;
  if(sv.hunger < 14){
    // Prefer cooked/better foods by food value
    const foods = Object.keys(inventory)
      .map(Number)
      .filter(id => inventory[id] > 0 && ITEMS[id]?.food)
      .sort((a, b) => (ITEMS[b].food || 0) - (ITEMS[a].food || 0));
    for(const id of foods){
      if(survival.eatSelected(id)) return true;
    }
  }
  if(sv.hp < 12){
    const meds = Object.keys(inventory)
      .map(Number)
      .filter(id => inventory[id] > 0 && ITEMS[id]?.heal)
      .sort((a, b) => (ITEMS[b].heal || 0) - (ITEMS[a].heal || 0));
    for(const id of meds){
      if(survival.eatSelected(id)) return true;
    }
    // food also heals some recipes — try food as backup
    const foods = Object.keys(inventory)
      .map(Number)
      .filter(id => inventory[id] > 0 && ITEMS[id]?.food);
    for(const id of foods){
      if(survival.eatSelected(id)) return true;
    }
  }
  return false;
}

/** Place a torch nearby if we have one and it's dark-ish / underground. */
function maybePlaceTorch(){
  if(!has(10)) return false;
  if(player.pos.y > 18) return false; // surface-ish, skip
  if(!ensureHotbar(10, 'b')) return false;
  placeAction();
  return true;
}

function manageInventory(dt){
  craftCd -= dt;
  useConsumables();
  if(craftCd > 0) return;
  craftCd = 1.4;
  runCrafting();
}

/** Start a world-locked dig on the crosshair block. Movement freezes until it breaks. */
function digLook(_hold = 0.45){
  if(mineLock) return true;
  selectTool('pick') || selectTool('shovel') || selectTool('axe');
  const r = castBlock(6);
  if(!r || !r.hit) return false;
  const [bx, by, bz] = r.hit;
  const t = getBlock(bx, by, bz);
  if(!t || t === 64 || (TYPES[t]?.hard ?? 99) >= 90) return false;
  mineLock = {x: bx, y: by, z: bz};
  // World-lock: do NOT call setMine(true) — that clears mineTarget on desktop path.
  state.mineScreen = null;
  state.mineTarget = [bx, by, bz];
  state.mineHeld = true;
  state.mining = null; // restart progress on this cell
  mineTimer = 15;
  digCd = 0.45;
  return true;
}

/** Stand still; keep world-locked dig alive until the cell is air. */
function holdMine(dt){
  if(!mineLock) return false;
  const {x, y, z} = mineLock;
  if(!getBlock(x, y, z)){
    mineLock = null;
    state.mineHeld = false;
    state.mineTarget = null;
    state.mining = null;
    mineTimer = 0;
    return false;
  }
  // Re-assert lock every frame (nothing else should clear it mid-dig)
  state.mineScreen = null;
  state.mineTarget = [x, y, z];
  state.mineHeld = true;
  keys.KeyW = keys.KeyA = keys.KeyS = keys.KeyD = false;
  keys.sprint = false;
  keys.Space = false;
  // Face the block for particles / feedback only — target is world-locked
  const eyeY = player.pos.y + 1.6;
  const dx = wrapDelta(x - player.pos.x);
  const dy = (y + 0.5) - eyeY;
  const dz = wrapDelta(z - player.pos.z);
  const horiz = Math.hypot(dx, dz) || 0.001;
  faceYaw(Math.atan2(-dx, -dz), dt, 1.3);
  smoothPitch(Math.atan2(-dy, horiz), dt, 1.1);
  mineTimer -= dt;
  if(mineTimer <= 0){
    mineLock = null;
    state.mineHeld = false;
    state.mineTarget = null;
    state.mining = null;
  }
  return true;
}

/** Explicitly mine a world cell by facing it. */
function digCell(x, y, z, dt){
  faceToward(x + 0.01, z + 0.01, dt, Math.atan2(-(y + 0.5 - (player.pos.y + 1.6)),
    Math.max(0.4, distXZ(player.pos.x, player.pos.z, x, z))), 5);
  return digLook(0.5);
}

function nearestHostile(){
  let best = null, bestD = 7;
  for(const zb of zombies.values()){
    if(!zb?.c?.g?.visible) continue;
    const p = zb.c.g.position;
    const d = Math.hypot(p.x - player.pos.x, p.y - player.pos.y, p.z - player.pos.z);
    if(d < bestD){ bestD = d; best = p; }
  }
  return best;
}

function fightNearby(dt){
  const p = nearestHostile();
  if(!p) return false;
  selectWeapon();
  faceToward(p.x, p.z, dt, -0.1);
  const d = distXZ(player.pos.x, player.pos.z, p.x, p.z);
  keys.KeyW = d > 1.6;
  keys.sprint = false;
  if(actionCd <= 0){
    setMine(true);
    actionCd = 0.55;
    mineTimer = 0.2;
  }
  return true;
}

function vaultTarget(){
  const v = eldercube.vaultRecord() || eldercube.vaultSite(seed);
  return {x: v.x, y: v.y + 1, z: v.z};
}

/**
 * Score a step in direction (dx,dz). Higher = better.
 * Prefers open 1-block steps toward the goal; penalizes walls and cliffs.
 */
function scoreStep(dx, dz, goalX, goalZ){
  const nx = player.pos.x + dx;
  const nz = player.pos.z + dz;
  const fy = Math.round(player.pos.y);
  // must not be solid at body
  if(solid(nx, fy + 1, nz) && solid(nx, fy, nz)) return -100;
  let score = 0;
  // progress toward goal
  const before = distXZ(player.pos.x, player.pos.z, goalX, goalZ);
  const after = distXZ(nx, nz, goalX, goalZ);
  score += (before - after) * 12;

  // Avoid walking into lakes when pathing on land
  if(isWaterAt(nx, fy, nz) || isWaterAt(nx, fy + 1, nz)){
    score -= 25;
  }
  // ground at same level
  if(solid(nx, fy - 1, nz) && !solid(nx, fy, nz) && !solid(nx, fy + 1, nz)){
    score += 8; // clean walk
  } else if(solid(nx, fy, nz) && !solid(nx, fy + 1, nz) && !solid(nx, fy + 2, nz)){
    score += 4; // 1-block step-up (jump)
  } else if(!solid(nx, fy - 1, nz) && !solid(nx, fy - 2, nz)){
    score -= 6; // drop / hole
  } else if(solid(nx, fy, nz) && solid(nx, fy + 1, nz)){
    score -= 20; // wall
  }

  // slight noise so we don't freeze on ties
  score += Math.sin(nx * 12.3 + nz * 7.1 + phaseT) * 0.15;
  return score;
}

/**
 * Pick best of 8 directions toward goal. Sets view + movement keys.
 * Returns true when within arriveR of goal XZ.
 */
function navigateTo(goalX, goalZ, dt, opts = {}){
  // Never walk while a dig is locked in
  if(mineLock){ keys.KeyW = false; return false; }
  const arriveR = opts.arriveR ?? 1.4;
  const sprint = opts.sprint !== false;
  const d = distXZ(player.pos.x, player.pos.z, goalX, goalZ);
  if(d <= arriveR){
    keys.KeyW = false;
    faceToward(goalX, goalZ, dt, opts.pitch ?? -0.1);
    return true;
  }

  // Active detour (stuck recovery)
  if(avoidT > 0){
    avoidT -= dt;
    faceYaw(avoidYaw, dt, 1.0);
    keys.KeyW = true;
    keys.sprint = false;
    keys.Space = true;
    // dig while detouring if still blocked
    const fx = player.pos.x - Math.sin(view.yaw);
    const fz = player.pos.z - Math.cos(view.yaw);
    const fy = Math.round(player.pos.y);
    if(solid(fx, fy, fz) || solid(fx, fy + 1, fz)){
      if(digCd <= 0) digLook(0.5);
    }
    return false;
  }

  // Hold a steer direction for a bit — re-picking every frame shakes the camera
  steerHold -= dt;
  const needRescore = steerHold <= 0 || !steerDir;
  if(needRescore){
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    let best = null, bestScore = -Infinity;
    for(const [dx, dz] of dirs){
      const len = Math.hypot(dx, dz);
      const s = scoreStep(dx / len * 1.1, dz / len * 1.1, goalX, goalZ);
      if(s > bestScore){ bestScore = s; best = [dx / len, dz / len]; }
    }
    if(bestScore < -15){
      faceToward(goalX, goalZ, dt, 0.12, 1.0);
      keys.KeyW = true;
      keys.Space = true;
      if(digCd <= 0) digLook(0.55);
      return false;
    }
    steerDir = best;
    // Hold heading longer so camera does not flip-flop
    steerHold = (botProfile === 'builder') ? (1.6 + Math.random() * 0.6) : (0.9 + Math.random() * 0.4);
  }

  const [bx, bz] = steerDir;
  const wantYaw = Math.atan2(-bx, -bz);
  faceYaw(wantYaw, dt, botProfile === 'builder' ? 0.85 : 1.1);
  if(opts.pitch != null) smoothPitch(opts.pitch, dt, 0.85);
  else smoothPitch(-0.08, dt, 0.7);

  // Continuous walk (pulses caused velocity jitter / screen shake)
  keys.KeyW = true;
  keys.sprint = false;

  // Step-up / dig — pitch eased, never snapped
  const ax = player.pos.x - Math.sin(view.yaw) * 1.0;
  const az = player.pos.z - Math.cos(view.yaw) * 1.0;
  const fy = Math.round(player.pos.y);
  if(solid(ax, fy, az) && !solid(ax, fy + 1, az) && !solid(ax, fy + 2, az)){
    keys.Space = true;
  } else if(solid(ax, fy, az) && solid(ax, fy + 1, az)){
    smoothPitch(0.08, dt, 1.0);
    if(botProfile !== 'builder' && digCd <= 0) digLook(0.5);
    if(botProfile !== 'builder') steerHold = 0;
  } else if(!solid(ax, fy, az) && solid(ax, fy + 1, az)){
    smoothPitch(-0.25, dt, 1.0);
    if(botProfile !== 'builder' && digCd <= 0) digLook(0.5);
    if(botProfile !== 'builder') steerHold = 0;
  }

  // Stuck recovery
  const moved = Math.hypot(player.pos.x - lastPos.x, player.pos.y - lastPos.y, player.pos.z - lastPos.z);
  if(moved < 0.04) stuckT += dt;
  else stuckT = Math.max(0, stuckT - dt * 2);

  if(stuckT > 0.55){
    recoverMode = (recoverMode + 1) % 5;
    stuckT = 0.1;
    if(recoverMode === 0){
      view.pitch = 0.15;
      digLook(0.7);
    } else if(recoverMode === 1){
      // Stable detour — do not flip side every tick
      avoidYaw = view.yaw + 1.15;
      avoidT = 1.4;
      keys.Space = true;
    } else if(recoverMode === 2){
      // dig head-height and feet-height ahead
      view.pitch = -0.2;
      digLook(0.7);
    } else if(recoverMode === 3){
      if(!headSubmerged() && !isWaterAt(player.pos.x, player.pos.y - 1, player.pos.z)){
        view.pitch = 1.15;
        digLook(0.6);
        keys.KeyW = false;
      } else {
        avoidYaw = view.yaw + 1.6;
        avoidT = 0.9;
        keys.Space = true;
      }
    } else {
      keys.KeyW = false;
      keys.KeyS = true;
      avoidYaw = view.yaw + 2.0;
      avoidT = 1.0;
    }
  }

  return false;
}

/**
 * Dig a vertical shaft under the player down to vault Y.
 * World-locks the block under the feet so progress actually finishes.
 */
function digDownToward(ty, dt){
  if(player.pos.y <= ty + 1.6){
    return true;
  }
  selectTool('pick');
  keys.KeyW = keys.KeyA = keys.KeyS = keys.KeyD = false;
  keys.sprint = false;
  smoothPitch(1.25, dt, 1.2);

  const px = Math.round(player.pos.x);
  const pz = Math.round(player.pos.z);
  // Prefer the solid block immediately under the feet, then one below
  const candidates = [
    Math.floor(player.pos.y - 0.15),
    Math.floor(player.pos.y - 1.15),
    Math.floor(player.pos.y - 2.15),
  ];
  for(const by of candidates){
    if(by < 1 || by >= WH) continue;
    if(!solid(px, by, pz)) continue;
    // Already locked on this cell — holdMine will finish it
    if(mineLock && mineLock.x === px && mineLock.y === by && mineLock.z === pz) return false;
    // Lock a new under-foot cell (do not use digLook/cast — look drift was the bug)
    mineLock = {x: px, y: by, z: pz};
    state.mineScreen = null;
    state.mineTarget = [px, by, pz];
    state.mineHeld = true;
    state.mining = null;
    mineTimer = 15;
    return false;
  }
  // Open air below — gravity drops us through the shaft
  return false;
}

/** Climb / dig staircase upward to surface. */
function digUpToward(dt){
  const surf = surfaceY(Math.round(player.pos.x), Math.round(player.pos.z));
  if(player.pos.y >= surf - 0.4) return true;

  selectTool('pick');
  // Prefer a forward-up step: dig block at head+1 in front, then jump-walk
  const fx = Math.round(player.pos.x - Math.sin(view.yaw));
  const fz = Math.round(player.pos.z - Math.cos(view.yaw));
  const hy = Math.round(player.pos.y + 2);
  const mid = Math.round(player.pos.y + 1);

  if(solid(fx, hy, fz) || solid(fx, mid, fz)){
    view.pitch = -0.55;
    digLook(0.5);
  } else if(solid(Math.round(player.pos.x), hy, Math.round(player.pos.z))){
    // ceiling above — dig straight up
    view.pitch = -1.2;
    digLook(0.5);
  }

  keys.KeyW = true;
  keys.Space = true;
  keys.sprint = false;

  // rotate slowly if not gaining height
  if(stuckT > 0.8){
    view.yaw += 0.8;
    stuckT = 0;
  }
  return false;
}

function setPhase(p, msg){
  phase = p;
  phaseT = 0;
  stuckT = 0;
  avoidT = 0;
  recoverMode = 0;
  steerDir = null;
  steerHold = 0;
  setStatus(msg || p);
  if(performance.now() > announceAt){
    addChat('🤖', msg || p);
    announceAt = performance.now() + 5000;
  }
}


/** Normalize status so "To vault · 355m" and "To vault · 350m" count as same action. */
function actionKey(){
  const s = (status || '').replace(/\d+/g, '#');
  return phase + '|' + s;
}

/**
 * If the bot repeats the same plan ~10 times with almost no movement,
 * force a different action so it cannot soft-lock forever.
 */
function forceUnstick(){
  clearMining();
  stuckT = 0;
  avoidT = 0;
  recoverMode = 0;
  steerDir = null;
  steerHold = 0;
  sameActionCount = 0;
  sameActionTick = 0;
  const side = Math.random() < 0.5 ? 1 : -1;
  avoidYaw = view.yaw + side * (1.2 + Math.random() * 1.2);
  avoidT = 1.4 + Math.random() * 0.8;
  keys.Space = true;
  addChat('🤖', 'Stuck alarm — changing plan.');
  setStatus('Stuck alarm — new plan');

  // Phase-specific escapes
  if(phase === PHASES.TRAVEL){
    // Dig through whatever is in front, then keep walking
    view.pitch = 0.1;
    digLook(0.7);
    wanderAng += Math.PI * 0.7;
  } else if(phase === PHASES.DESCEND){
    // Sidestep off the stuck shaft column and dig again
    player.pos.x += side * 1.2;
    player.pos.z += side * 0.6;
    clearMining();
  } else if(phase === PHASES.LOOT){
    wanderAng += Math.PI;
    view.yaw += side * 1.5;
  } else if(phase === PHASES.ASCEND){
    view.yaw += side * 1.8;
    view.pitch = -0.5;
    digLook(0.7);
  } else if(phase === PHASES.GATHER){
    wanderAng += Math.PI * (0.8 + Math.random());
    // Give up on this dig target
    clearMining();
  } else if(phase === PHASES.PLACE || phase === PHASES.SOCKET){
    view.yaw += side * 1.0;
    view.pitch = 0.5;
  } else if(phase === PHASES.DEFEND){
    wanderAng += Math.PI * 0.5;
  }
  progressPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
}

function checkStuckAlarm(dt){
  const key = actionKey();
  const moved = Math.hypot(
    player.pos.x - progressPos.x,
    player.pos.y - progressPos.y,
    player.pos.z - progressPos.z
  );
  if(moved > 2.0){
    progressPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
    sameActionCount = 0;
    sameActionTick = 0;
    lastActionKey = key;
    return;
  }
  if(key !== lastActionKey){
    lastActionKey = key;
    sameActionCount = 0;
    sameActionTick = 0;
    return;
  }
  // Same plan, little movement — tick every ~1.2s
  sameActionTick += dt;
  if(sameActionTick >= 1.2){
    sameActionTick = 0;
    sameActionCount++;
    if(sameActionCount >= 10){
      forceUnstick();
    } else if(sameActionCount >= 5 && sameActionCount % 2 === 0){
      // Mild nudge before full alarm
      avoidYaw = view.yaw + (Math.random() < 0.5 ? 1 : -1) * 0.9;
      avoidT = Math.max(avoidT, 0.7);
      clearMining();
    }
  }
}

function ensureBuildBlocks(id){
  // Forge has infinite materials; Nightfall needs stock
  if(gm.forge) return true;
  if((inventory[id] || 0) > 0) return true;
  // Fallbacks: any solid buildable
  for(const alt of [3, 7, 8, 13, 1, 4]){
    if((inventory[alt] || 0) > 0) return alt;
  }
  return false;
}

/** Put the exact block type in the active hotbar slot so the hand matches the place. */


function formatEta(sec){
  if(!isFinite(sec) || sec < 0) return '…';
  sec = Math.max(0, Math.ceil(sec));
  const m = (sec / 60) | 0;
  const s = sec % 60;
  if(m >= 60){
    const h = (m / 60) | 0;
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${String(s).padStart(2,'0')}s` : `${s}s`;
}

/** Estimate remaining build time from observed place rate. */
function buildEtaSec(){
  const left = Math.max(0, buildQueue.length - buildIndex);
  if(left <= 0) return 0;
  let per = 0.48; // default: place cadence + aim + one-block hop
  if(buildPlaceTimes.length >= 3){
    const sum = buildPlaceTimes.reduce((a, b) => a + b, 0);
    per = sum / buildPlaceTimes.length;
  } else if(buildIndex > 0 && buildStartedAt){
    const elapsed = performance.now() / 1000 - buildStartedAt;
    per = Math.max(0.2, elapsed / buildIndex);
  }
  // slight padding for travel between sparse cells
  return left * per * 1.05;
}

function noteBlockPlaced(){
  const now = performance.now() / 1000;
  if(!buildStartedAt) buildStartedAt = now;
  else {
    const last = buildPlaceTimes.length
      ? buildStartedAt + buildPlaceTimes.reduce((a,b)=>a+b,0)
      : buildStartedAt;
    // approximate interval from index timing
    const elapsed = now - buildStartedAt;
    const per = elapsed / Math.max(1, buildIndex);
    buildPlaceTimes.push(per);
    if(buildPlaceTimes.length > 12) buildPlaceTimes.shift();
  }
}


// ---- Build job registry (per world seed + save slot) ----
function buildJobsKey(){
  const slot = persist.activeSlot ?? 'tmp';
  return `mc_buildjobs_${slot}_${seed}`;
}
function loadBuildJobs(){
  try{
    const raw = localStorage.getItem(buildJobsKey());
    if(!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  }catch(e){ return []; }
}
function saveBuildJobs(list){
  try{ localStorage.setItem(buildJobsKey(), JSON.stringify(list)); }catch(e){}
}
function findUnfinishedJob(landmarkId){
  return loadBuildJobs().find(j => j.landmarkId === landmarkId && !j.completed) || null;
}
function upsertBuildJob(job){
  const list = loadBuildJobs().filter(j => j.id !== job.id);
  // Only one unfinished job per landmark id
  const cleaned = list.filter(j => !(j.landmarkId === job.landmarkId && !j.completed && j.id !== job.id));
  cleaned.push(job);
  saveBuildJobs(cleaned);
}
function markJobCompleted(id){
  const list = loadBuildJobs().map(j => j.id === id ? {...j, completed:true, buildIndex:j.total, updatedAt:Date.now()} : j);
  saveBuildJobs(list);
}
function removeJob(id){
  saveBuildJobs(loadBuildJobs().filter(j => j.id !== id));
}
function snapshotJobProgress(){
  if(botProfile !== 'builder' || builderMode !== 'landmark') return;
  if(!landmarkId || !buildOrigin || !buildQueue.length) return;
  if(buildIndex >= buildQueue.length){
    if(buildJobId) markJobCompleted(buildJobId);
    return;
  }
  const job = {
    id: buildJobId || (`job_${landmarkId}_${Date.now()}`),
    landmarkId,
    name: buildName || landmarkId,
    origin: {...buildOrigin},
    buildIndex,
    total: buildQueue.length,
    completed: false,
    updatedAt: Date.now(),
  };
  buildJobId = job.id;
  upsertBuildJob(job);
}

function resumeJob(job){
  landmarkId = job.landmarkId;
  builderMode = 'landmark';
  botProfile = 'builder';
  buildJobId = job.id;
  buildName = job.name;
  buildOrigin = {...job.origin};
  const bp = buildings.blueprint(job.landmarkId);
  const ox = job.origin.x, oy = job.origin.y, oz = job.origin.z;
  const CEIL = WH - 2;
  const all = orderOutsideIn(bp.blocks).map(([dx,dy,dz,bid])=>({
    x:ox+dx, y:oy+dy, z:oz+dz, id:bid, defers:0
  }));
  buildQueue = all.filter(c => c.y >= 1 && c.y < CEIL);
  buildClipped = all.length - buildQueue.length;
  buildDeferred = [];
  buildPass = 1;
  buildPassPlaced = 0;
  buildPlacedTotal = 0;
  buildStranded = 0;
  buildIndex = Math.min(job.buildIndex|0, buildQueue.length);
  buildStartedAt = 0;
  buildPlaceTimes = [];
}

function ensureFlying(){
  if(!gm.forge) return false;
  if(!state.flying){
    try{ toggleFly(); }catch(e){ state.flying = true; }
  }
  return !!state.flying;
}

function stopFlying(){
  if(state.flying){
    try{ toggleFly(); }catch(e){ state.flying = false; }
  }
}

/** Adjust altitude while flying toward a target block Y. Returns true when close enough. */
function flyTowardY(targetY, dt){
  if(!state.flying) return Math.abs(player.pos.y - targetY) < 3;
  // Aim so feet are ~1.5 below the block (natural place height)
  const wantY = targetY - 1.4;
  const dy = wantY - player.pos.y;
  if(Math.abs(dy) < 1.1){
    keys.Space = false;
    keys.ShiftLeft = keys.ShiftRight = keys.sprint = false;
    return true;
  }
  if(dy > 0){
    keys.Space = true;
    keys.ShiftLeft = keys.ShiftRight = keys.sprint = false;
  } else {
    keys.Space = false;
    keys.ShiftLeft = true; // fly down
    keys.sprint = false;
  }
  return false;
}

function holdBlock(id){
  const kind = id >= 100 ? 'f' : 'b';
  let i = hotbarSlots.findIndex(s => s && s.k === kind && s.id === id);
  if(i < 0){
    // Prefer empty slot; else slot 0 (don't stomp tools every frame if already a block)
    i = hotbarSlots.findIndex(s => s === null);
    if(i < 0) i = 0;
    hotbarSlots[i] = {k: kind, id};
  }
  if(sel.slot !== i) sel.slot = i;
  if(gm.forge && id < 100) inventory[id] = Math.max(inventory[id] || 0, 64);
  renderHotbar();
}

/** Bottom-up, outside-in so walls/legs exist before interior. */
/** Build order: bottom layer up, and within a layer walk a serpentine (boustrophedon)
 *  path so consecutive blocks are neighbours.
 *
 *  The previous order sorted each layer by distance-from-centre, which grouped
 *  symmetric cells like (10,3) and (3,10) together — sending the bot back and
 *  forth across the whole footprint between placements. Travel dominated the
 *  build: measured 20 h for all eight landmarks vs 8.5 h with this order, for
 *  an identical finished structure. */
function orderOutsideIn(relBlocks){
  return [...relBlocks].sort((a, b) => {
    if(a[1] !== b[1]) return a[1] - b[1];   // lowest course first
    if(a[0] !== b[0]) return a[0] - b[0];   // row by row
    // reverse every other row so the bot turns at the end instead of jumping back
    return (Math.abs(a[0]) % 2 === 0) ? a[2] - b[2] : b[2] - a[2];
  });
}

/** Stand outside the structure relative to origin — not inside the hull. */
/** Where the bot should be to place `cell`.
 *
 *  Standing *beside* the target only works for the outer shell: as soon as a
 *  structure has an inside, the spot 2.6 blocks sideways is inside solid blocks
 *  and the bot can never arrive — it orbits, times out, and places nothing.
 *
 *  Builds run bottom-up, so the column directly above the target is always
 *  clear. When flying, hover over the cell and look down at it; that reaches
 *  interior and exterior cells alike. On foot (Nightfall) hovering isn't an
 *  option, so fall back to the radial position. */
const HOVER = 2.6;
function standOutside(cell){
  if(state.flying){
    return { x: cell.x, z: cell.z, hoverY: cell.y + HOVER, above: true };
  }
  const ox = buildOrigin?.x ?? cell.x;
  const oz = buildOrigin?.z ?? cell.z;
  let dx = cell.x - ox, dz = cell.z - oz;
  let len = Math.hypot(dx, dz);
  if(len < 0.2){
    // center column: pick a fixed outside offset
    dx = 1; dz = 0; len = 1;
  }
  const dist = 2.6;
  return {
    x: cell.x + (dx / len) * dist,
    z: cell.z + (dz / len) * dist,
    hoverY: cell.y,
    above: false,
  };
}

function builderUnstuck(dt){
  // Smooth escape — pick ONE heading and keep it (no left/right strobing)
  ensureFlying();
  unstuckHold -= dt;
  if(unstuckHold <= 0){
    // Prefer outward from structure center
    if(buildOrigin){
      const dx = player.pos.x - buildOrigin.x;
      const dz = player.pos.z - buildOrigin.z;
      if(Math.hypot(dx, dz) > 0.4)
        unstuckYawHold = Math.atan2(-dx, -dz); // face outward
      else
        unstuckYawHold = view.yaw + 1.2;
    } else {
      unstuckYawHold = view.yaw + 1.2;
    }
    unstuckRiseY = (buildOrigin?.y || player.pos.y) + 8;
    unstuckHold = 2.8; // hold this plan for seconds
  }
  faceYaw(unstuckYawHold, dt, 0.8);
  keys.KeyW = true;
  keys.Space = true; // steady climb, not pulsed
  keys.ShiftLeft = keys.ShiftRight = keys.sprint = false;
  flyTowardY(unstuckRiseY + 1.4, dt);
}

/** Forge is creative mode: floating geometry (shell roofs, arches) is allowed
 *  there, exactly as it is for a human in creative. Nightfall keeps the
 *  survival rule that a block must touch something. */
function canBotPlaceAt(x, y, z){
  if(y < 1 || y >= WH) return false;
  return gm.forge ? true : hasBlockSupport(x, y, z);
}

function placeBuildBlock(x, y, z, id){
  x = wrapC(x); z = wrapC(z);
  y = y|0;
  if(y < 1 || y >= WH) return false;
  if(getBlock(x, y, z)) return true; // already filled counts as done
  if(!canBotPlaceAt(x, y, z)) return false;
  // Don't place inside the player's body
  if(placeOverlapsPlayer(x, y, z)) return false;
  let useId = id;
  if(!gm.forge){
    const ok = ensureBuildBlocks(id);
    if(ok === false) return false;
    if(ok !== true) useId = ok;
    if((inventory[useId] || 0) <= 0) return false;
    inventory[useId]--;
  }
  holdBlock(useId);
  applyEdit(x, y, z, useId, false);
  try{ net.sendEdit?.(x, y, z, useId); }catch(e){}
  try{ pulsePlace(); }catch(e){}
  return true;
}

function setupLandmark(id, originOverride = null){
  const bp = buildings.blueprint(id);
  buildName = bp.name;
  landmarkId = id;
  let ox, oy, oz;
  if(originOverride){
    ox = originOverride.x; oy = originOverride.y; oz = originOverride.z;
  } else {
    ox = Math.round(player.pos.x);
    oz = Math.round(player.pos.z);
    oy = surfaceY(ox, oz) + 1;
  }
  buildOrigin = {x: ox, y: oy, z: oz};
  const sorted = orderOutsideIn(bp.blocks);
  const CEIL = WH - 2; // leave headroom so the bot can fly above the top course
  const all = sorted.map(([dx, dy, dz, bid]) => ({
    x: ox + dx, y: oy + dy, z: oz + dz, id: bid, defers: 0
  }));
  // Cells above the world ceiling can never be placed. Drop them once, here —
  // leaving them in the queue made the bot churn for minutes doing nothing.
  buildQueue = all.filter(c => c.y >= 1 && c.y < CEIL);
  buildClipped = all.length - buildQueue.length;
  buildDeferred = [];
  buildPass = 1;
  buildPassPlaced = 0;
  buildPlacedTotal = 0;
  buildStranded = 0;
  if(!originOverride) buildIndex = 0;
  buildStartedAt = 0;
  buildPlaceTimes = [];
  if(!buildJobId) buildJobId = `job_${id}_${Date.now()}`;
  snapshotJobProgress();
}

function setupCreative(){
  const bp = buildings.randomCreative();
  buildName = bp.name;
  const ox = Math.round(player.pos.x + Math.sin(view.yaw) * -4);
  const oz = Math.round(player.pos.z + Math.cos(view.yaw) * -4);
  const oy = surfaceY(ox, oz) + 1;
  buildOrigin = {x: ox, y: oy, z: oz};
  const sorted = orderOutsideIn(bp.blocks);
  const CEIL = WH - 2; // leave headroom so the bot can fly above the top course
  const all = sorted.map(([dx, dy, dz, bid]) => ({
    x: ox + dx, y: oy + dy, z: oz + dz, id: bid, defers: 0
  }));
  // Cells above the world ceiling can never be placed. Drop them once, here —
  // leaving them in the queue made the bot churn for minutes doing nothing.
  buildQueue = all.filter(c => c.y >= 1 && c.y < CEIL);
  buildClipped = all.length - buildQueue.length;
  buildDeferred = [];
  buildPass = 1;
  buildPassPlaced = 0;
  buildPlacedTotal = 0;
  buildStranded = 0;
  buildIndex = 0;
  buildStartedAt = 0;
  buildPlaceTimes = [];
}

function tickBuilder(dt){
  placeCd -= dt;

  if(phase === PHASES.BUILD_SETUP){
    if(builderMode === 'creative') setupCreative();
    else if(landmarkId) setupLandmark(landmarkId);
    else setupCreative();
    if(gm.forge) ensureFlying();
    if(!buildQueue.length){
      setStatus('Build queue empty');
      addChat('🤖', 'Build failed — empty blueprint.');
      setPhase(PHASES.BUILD_DONE, 'Nothing to build');
      return;
    }
    addChat('🤖', `Building ${buildName} — ${buildQueue.length} blocks (hands-on).`);
    if(buildClipped > 0){
      addChat('🤖', `⚠ ${buildClipped} blocks are above the world ceiling (y${WH}) and were skipped — ${buildName} will be built up to its cut-off height.`);
    }
    approachT = 0;
    placeCd = 0.3;
    setPhase(PHASES.BUILD_PLACE, `Building ${buildName}…`);
    return;
  }

  if(phase === PHASES.BUILD_PLACE){
    if(!buildQueue.length){
      setPhase(PHASES.BUILD_SETUP, 'Rebuilding queue…');
      return;
    }
    if(buildIndex >= buildQueue.length){
      // End of a pass. Anything still unsupported gets another pass, as long as
      // the last pass actually achieved something (otherwise it never will).
      if(buildDeferred.length && buildPassPlaced > 0 && buildPass < 12){
        buildQueue = buildDeferred;
        buildDeferred = [];
        buildIndex = 0;
        buildPass++;
        buildPassPlaced = 0;
        clearKeys();
        setStatus(`${buildName} · pass ${buildPass} · ${buildQueue.length} left`);
        return;
      }
      buildStranded = buildDeferred.length;
      buildDeferred = [];
      if(buildJobId) markJobCompleted(buildJobId);
      snapshotJobProgress();
      if(buildStranded > 0 || buildClipped > 0){
        const bits = [];
        if(buildClipped) bits.push(`${buildClipped} above world ceiling`);
        if(buildStranded) bits.push(`${buildStranded} unreachable (floating geometry)`);
        addChat('🤖', `${buildName} finished — ${bits.join(', ')}.`);
      } else {
        addChat('🤖', `${buildName} finished — every block placed.`);
      }
      setPhase(PHASES.BUILD_DONE, `${buildName} complete`);
      return;
    }

    const cell = buildQueue[buildIndex];
    const cx = wrapC(cell.x), cy = cell.y|0, cz = wrapC(cell.z);

    // Already solid — done
    if(getBlock(cx, cy, cz)){
      buildIndex++;
      approachT = 0;
      clearKeys();
      return;
    }

    // No support yet — hold it over for the next pass (neighbours may appear).
    if(!canBotPlaceAt(cx, cy, cz)){
      buildDeferred.push(cell);
      buildIndex++;
      approachT = 0;
      clearKeys();   // FIX: without this the bot kept the ascend key held and flew away
      return;
    }

    const total = buildQueue.length + buildIndex; // approx remaining+done unstable; use index display
    const left = buildQueue.length - buildIndex;
    const eta = formatEta(buildEtaSec());
    const passTag = buildPass > 1 ? ` · pass ${buildPass}` : '';
    setStatus(`${buildName} · ${buildPlacedTotal} placed · ${left} left${passTag} · ETA ${eta}`);
    const etaEl = document.getElementById('aiEta');
    if(etaEl){
      etaEl.style.display = 'block';
      etaEl.textContent = `⏱ ${eta} remaining · ${buildPlacedTotal} placed`;
    }

    holdBlock(cell.id);
    if(gm.forge) ensureFlying();

    approachT += dt;
    const stand = standOutside(cell);
    const d = distXZ(player.pos.x, player.pos.z, stand.x, stand.z);
    const near = d <= (stand.above ? 1.2 : 2.8);

    // Stuck recovery: fly + jump + strafe outside
    if(approachT > 5.5){
      builderUnstuck(dt);
      if(approachT > 12){
        // give up on approach — try place if support+no overlap, else defer
        if(!placeOverlapsPlayer(cx, cy, cz) && placeBuildBlock(cx, cy, cz, cell.id)){
          buildIndex++;
          noteBlockPlaced();
          placeCd = 0.3;
        } else {
          buildDeferred.push(cell);
          buildIndex++;
        }
        approachT = 0;
        clearKeys();
      }
      return;
    }

    // flyTowardY aims the feet 1.4 below its argument, so add that back on
    const flyTarget = stand.above ? cell.y + HOVER + 1.4 : cell.y;

    if(!near){
      navigateTo(stand.x, stand.z, dt, {sprint: false, arriveR: 2.2});
      if(state.flying) flyTowardY(flyTarget, dt);
      return;
    }

    keys.KeyW = false;
    if(state.flying){
      const ok = flyTowardY(flyTarget, dt);
      if(!ok && approachT < 8) return;
    }

    // Look at the block (steeply down when hovering above it)
    const eyeY = player.pos.y + 1.6;
    const horiz = distXZ(player.pos.x, player.pos.z, cx, cz);
    const pitch = Math.atan2(-(cy + 0.5 - eyeY), Math.max(stand.above ? 0.15 : 0.6, horiz));
    faceToward(cx, cz, dt, pitch, 0.9);

    if(placeCd > 0) return;
    if(placeOverlapsPlayer(cx, cy, cz)){
      // Step farther out so we don't place inside ourselves
      builderUnstuck(dt);
      return;
    }

    if(placeBuildBlock(cx, cy, cz, cell.id)){
      buildIndex++;
      buildPassPlaced++;
      buildPlacedTotal++;
      noteBlockPlaced();
      placeCd = 0.36;
      approachT = 0;
      if(buildIndex % 8 === 0) snapshotJobProgress();
    } else {
      // couldn't place right now — retry on the next pass
      buildDeferred.push(cell);
      buildIndex++;
      approachT = 0;
      placeCd = 0.15;
    }
    return;
  }

  if(phase === PHASES.BUILD_DONE){
    setStatus(`${buildName} complete`);
    const etaEl = document.getElementById('aiEta');
    if(etaEl){
      etaEl.textContent = '⏱ Done';
      setTimeout(()=>{ if(etaEl.textContent === '⏱ Done') etaEl.style.display = 'none'; }, 2500);
    }
    clearKeys();
    if(state.flying){
      const ground = surfaceY(Math.round(player.pos.x), Math.round(player.pos.z)) + 1;
      if(player.pos.y > ground + 2) flyTowardY(ground + 1.4, dt);
      else stopFlying();
    }
    view.yaw += 0.1 * dt;
    if(builderMode === 'creative' && phaseT > 6){
      setPhase(PHASES.BUILD_SETUP, 'Next creative build…');
    }
  }
}


export function start(opts = {}){
  if(active) return;
  if(!state.playing){ addChat('🤖', 'Start a world first.'); return; }

  botProfile = opts.profile || 'story';
  builderMode = opts.builderMode || null;
  landmarkId = opts.landmarkId || null;
  buildJobId = null;

  if(opts.resumeJob){
    resumeJob(opts.resumeJob);
  }

  if(botProfile === 'story' && gm.forge){
    addChat('🤖', 'Story campaign needs Nightfall — switch mode and try again.');
    return;
  }
  if(botProfile === 'builder' && !gm.forge){
    addChat('🤖', 'Builder tip: Forge mode has unlimited blocks.');
  }

  active = true;
  setInputLocked?.(true);
  document.body.classList.add('ai-driving');
  clearKeys();
  clearMining();
  deathWait = 0;
  sameActionCount = 0;
  sameActionTick = 0;
  lastActionKey = '';
  progressPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
  // Do NOT clear queue after resumeJob — that wiped progress and left the bot walking forever
  if(!opts.resumeJob){
    buildQueue = [];
    buildIndex = 0;
    buildJobId = buildJobId; // keep if set later by setup
  }

  if(botProfile === 'builder'){
    if(opts.resumeJob && buildQueue.length){
      if(gm.forge) ensureFlying();
      setPhase(PHASES.BUILD_PLACE, `Resuming ${buildName}…`);
      addChat('🤖', `Resuming ${buildName} from ${buildIndex}/${buildQueue.length}.`);
    } else {
      buildQueue = [];
      buildIndex = 0;
      setPhase(PHASES.BUILD_SETUP, builderMode === 'creative' ? 'Creative building…' : 'Preparing landmark…');
      addChat('🤖', builderMode === 'creative'
        ? 'Builder ON — creative mode (no time limit).'
        : `Builder ON — constructing ${(buildings.listBuildings().find(b=>b.id===landmarkId)||{}).name || 'landmark'}.`);
    }
  } else {
    reevaluatePhase();
    addChat('🤖', 'Story campaign ON — Elder Cube arc. No time limit.');
  }

  const btn = document.getElementById('btnAI');
  if(btn) btn.classList.add('active');
  showStreamCam();
}

export function stop(){
  if(!active) return;
  // Register unfinished landmark builds before wiping state
  if(botProfile === 'builder' && builderMode === 'landmark' && buildQueue.length && buildIndex < buildQueue.length){
    snapshotJobProgress();
    addChat('🤖', `Build paused — ${buildName} saved at ${buildIndex}/${buildQueue.length}.`);
  }
  active = false;
  setInputLocked?.(false);
  document.body.classList.remove('ai-driving');
  clearKeys();
  clearMining();
  deathWait = 0;
  phase = PHASES.IDLE;
  botProfile = 'story';
  builderMode = null;
  // keep landmarkId/buildJobId cleared; progress is in registry
  landmarkId = null;
  buildJobId = null;
  buildQueue = [];
  buildIndex = 0;
  setStatus('');
  const btn = document.getElementById('btnAI');
  if(btn) btn.classList.remove('active');
  stopFlying();
  hideStreamCam();
  closeProfileModal();
  closeContinueModal();
  const etaEl = document.getElementById('aiEta');
  if(etaEl) etaEl.style.display = 'none';
  addChat('🤖', 'Bot OFF — all actions stopped.');
}

export function openProfileModal(){
  const m = document.getElementById('aiProfileModal');
  if(!m){ start({profile:'story'}); return; }
  m.classList.add('show');
  m.style.display = 'flex';
  m.setAttribute('aria-hidden', 'false');
  document.getElementById('aiBuilderOpts').style.display = 'none';
  document.getElementById('aiBuildingList').style.display = 'none';
  m.querySelector('.aiProfileGrid').style.display = 'flex';
}

export function closeProfileModal(){
  const m = document.getElementById('aiProfileModal');
  if(!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  m.setAttribute('aria-hidden', 'true');
}

function showBuilderOpts(){
  const m = document.getElementById('aiProfileModal');
  m.querySelector('.aiProfileGrid').style.display = 'none';
  document.getElementById('aiBuilderOpts').style.display = 'block';
  document.getElementById('aiBuildingList').style.display = 'none';
}

function closeContinueModal(){
  const m = document.getElementById('aiContinueModal');
  if(!m) return;
  m.classList.remove('show');
  m.style.display = 'none';
  m.setAttribute('aria-hidden', 'true');
  pendingLandmark = null;
}

function openContinueModal(job){
  pendingLandmark = job.landmarkId;
  const m = document.getElementById('aiContinueModal');
  if(!m){
    start({profile:'builder', builderMode:'landmark', landmarkId: job.landmarkId, resumeJob: job});
    return;
  }
  document.getElementById('aiContinueTitle').textContent = job.name || 'Unfinished build';
  document.getElementById('aiContinueHint').textContent =
    `Saved progress: ${job.buildIndex}/${job.total} blocks (${Math.floor(100*job.buildIndex/Math.max(1,job.total))}%).`;
  document.getElementById('aiContinueDesc').textContent =
    `Resume at block ${job.buildIndex + 1} of ${job.total}`;
  m.classList.add('show');
  m.style.display = 'flex';
  m.setAttribute('aria-hidden', 'false');
}

function showBuildingList(){
  document.getElementById('aiBuilderOpts').style.display = 'none';
  document.getElementById('aiBuildingList').style.display = 'block';
  const grid = document.getElementById('aiBuildingGrid');
  grid.innerHTML = '';
  for(const b of buildings.listBuildings()){
    const job = findUnfinishedJob(b.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aiBuildBtn' + (job ? ' hasJob' : '');
    btn.innerHTML = `<span class="ic">${b.icon}</span><span class="nm">${b.name}</span>` +
      (job ? `<span class="badge">Unfinished ${job.buildIndex}/${job.total}</span>` : '');
    btn.addEventListener('click', ()=>{
      closeProfileModal();
      if(job) openContinueModal(job);
      else start({profile:'builder', builderMode:'landmark', landmarkId: b.id});
    });
    grid.appendChild(btn);
  }
}

export function initProfileUI(){
  const m = document.getElementById('aiProfileModal');
  if(!m || m.dataset.ready) return;
  m.dataset.ready = '1';
  m.querySelectorAll('[data-profile]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const prof = btn.getAttribute('data-profile');
      if(prof === 'story'){
        closeProfileModal();
        start({profile:'story'});
      } else {
        showBuilderOpts();
      }
    });
  });
  m.querySelectorAll('[data-build]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const mode = btn.getAttribute('data-build');
      if(mode === 'creative'){
        closeProfileModal();
        start({profile:'builder', builderMode:'creative'});
      } else {
        showBuildingList();
      }
    });
  });
  document.getElementById('aiBuilderBack')?.addEventListener('click', ()=>{
    document.getElementById('aiBuilderOpts').style.display = 'none';
    m.querySelector('.aiProfileGrid').style.display = 'flex';
  });
  document.getElementById('aiBuildingBack')?.addEventListener('click', showBuilderOpts);
  document.getElementById('aiProfileClose')?.addEventListener('click', closeProfileModal);

  document.getElementById('aiContinueBtn')?.addEventListener('click', ()=>{
    const job = pendingLandmark ? findUnfinishedJob(pendingLandmark) : null;
    closeContinueModal();
    if(job) start({profile:'builder', builderMode:'landmark', landmarkId: job.landmarkId, resumeJob: job});
  });
  document.getElementById('aiStartNewBtn')?.addEventListener('click', ()=>{
    const id = pendingLandmark;
    const old = id ? findUnfinishedJob(id) : null;
    // Starting new abandons the old unfinished job (mark superseded)
    if(old) removeJob(old.id);
    closeContinueModal();
    if(id) start({profile:'builder', builderMode:'landmark', landmarkId: id});
  });
  document.getElementById('aiContinueClose')?.addEventListener('click', closeContinueModal);
}

export function toggle(){
  if(active) stop();
  else {
    initProfileUI();
    openProfileModal();
  }
}

export function tick(dt){
  if(!active || !state.playing || state.paused) return;

  // Death: clear dig lock and auto-respawn after a short beat
  if(survival.sv.dead){
    clearKeys();
    clearMining();
    deathWait += dt;
    setStatus('Respawning…');
    if(deathWait >= 1.5){
      deathWait = 0;
      try{ survival.respawn(); }catch(e){ console.warn('[ai] respawn', e); }
      if(botProfile === 'builder') setPhase(PHASES.BUILD_PLACE, `Resume ${buildName || 'build'}…`);
      else reevaluatePhase();
      addChat('🤖', 'Respawned — continuing.');
    }
    return;
  }
  deathWait = 0;

  phaseT += dt;
  actionCd -= dt;
  digCd -= dt;
  clearKeys();
  if(joy){ joy.x = 0; joy.y = 0; }

  // Builder must not run craft/tool brain — it steals the hotbar from holdBlock
  if(botProfile !== 'builder'){
    manageInventory(dt);
    checkStuckAlarm(dt);
  }
  tickStreamFace(dt);

  // Keep facecam visible (mobile Safari / layout can drop it)
  streamCamGuard -= dt;
  if(streamCamGuard <= 0){
    streamCamGuard = 2.5;
    const cam = streamCamEl();
    if(cam && !cam.classList.contains('scShow')) showStreamCam();
    else if(cam && cam.style.display === 'none') showStreamCam();
  }

  // Builder: pure place loop — never blocked by mining lock / water escape / stuck digs
  if(botProfile === 'builder'){
    clearMining();
    tickBuilder(dt);
    lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
    return;
  }

  // Finish the current dig before walking again — moving resets mine progress.
  if(holdMine(dt)){
    setStatus('Mining…');
    lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
    return;
  }

  // Water escape takes priority over combat and goals — drowning/stuck lakes
  // were the main failure mode in testing.
  if(escapeWater(dt)){
    const moved = Math.hypot(player.pos.x - lastPos.x, player.pos.y - lastPos.y, player.pos.z - lastPos.z);
    if(moved < 0.05) stuckT += dt;
    else stuckT = Math.max(0, stuckT - dt);
    lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
    return;
  }

  if(phase !== PHASES.DONE && fightNearby(dt)){
    setStatus('Fighting…');
    lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
    return;
  }

  switch(phase){
    case PHASES.TRAVEL: {
      target = vaultTarget();
      const d = distXZ(player.pos.x, player.pos.z, target.x, target.z)|0;
      setStatus(`To vault · ${d}m`);
      if(navigateTo(target.x, target.z, dt, {sprint: false, arriveR: 2.2})){
        clearMining();
        setPhase(PHASES.DESCEND, 'Descending into the vault…');
      }
      break;
    }
    case PHASES.DESCEND: {
      target = vaultTarget();
      // Stay over the vault mouth while digging the shaft
      if(distXZ(player.pos.x, player.pos.z, target.x, target.z) > 2.5){
        if(!mineLock) navigateTo(target.x, target.z, dt, {sprint: false, arriveR: 1.5});
        setStatus(`To vault mouth · ${distXZ(player.pos.x,player.pos.z,target.x,target.z)|0}m`);
        break;
      }
      setStatus(`Shaft dig · y ${player.pos.y|0} → vault ${target.y}`);
      if(digDownToward(target.y, dt)){
        setPhase(PHASES.LOOT, 'Searching for the Elder Cube…');
      }
      break;
    }
    case PHASES.LOOT: {
      if(carryingCube() || has(CUBE)){
        setPhase(PHASES.ASCEND, 'Cube secured — climbing out…');
        break;
      }
      target = vaultTarget();
      setStatus('Mining the vault…');
      // spiral around vault center
      wanderAng += dt * 1.1;
      const ox = target.x + Math.cos(wanderAng) * 2.2;
      const oz = target.z + Math.sin(wanderAng) * 2.2;
      navigateTo(ox, oz, dt, {sprint: false, arriveR: 0.8, pitch: 0.35});
      if(digCd <= 0) digLook(0.5);
      if(phaseT > 100) setPhase(PHASES.ASCEND, 'Vault timed out — resurfacing…');
      break;
    }
    case PHASES.ASCEND: {
      const surf = surfaceY(Math.round(player.pos.x), Math.round(player.pos.z));
      setStatus(`Climbing · y ${player.pos.y|0}→${surf}`);
      if(digUpToward(dt)){
        setPhase(PHASES.GATHER, 'On surface — Keepstone materials…');
      }
      if(phaseT > 150){
        // spin and keep trying
        view.yaw += dt * 1.5;
      }
      break;
    }
    case PHASES.GATHER: {
      if(!carryingCube() && !has(CUBE)){
        setPhase(PHASES.TRAVEL, 'Lost the Cube — returning to vault…');
        break;
      }
      if(ensureKeepstoneMats()){
        setPhase(PHASES.PLACE, 'Keepstone ready — placing…');
        break;
      }
      // Need list for status
      const need = [];
      if(!has(STONE, 8)) need.push('stone');
      if(!has(IRON_INGOT, 2) && !has(IRON_CHUNK, 6)) need.push('iron');
      if(!has(CRYSTAL, 2)) need.push('crystal');
      setStatus('Gathering ' + (need.join('/') || 'materials') + '…');

      // Prefer digging what we still need
      if(!has(STONE, 8)){
        selectTool('pick');
        view.pitch = 0.55;
      } else if(!has(IRON_INGOT, 2) || !has(CRYSTAL, 2)){
        selectTool('pick');
        // go deeper for ores
        if(player.pos.y > 14){
          view.pitch = 1.0;
          if(digCd <= 0 && !mineLock) digLook(0.5);
        }
      } else if(!has(7, 4) && !has(4, 2)){
        selectTool('axe'); // trees for sticks/torches
        view.pitch = -0.05;
      }

      wanderAng += dt * 0.55;
      const wx = player.pos.x + Math.cos(wanderAng) * 12;
      const wz = player.pos.z + Math.sin(wanderAng) * 12;
      if(!mineLock) navigateTo(wx, wz, dt, {sprint: false, arriveR: 2, pitch: null});
      if(digCd <= 0 && !mineLock) digLook(0.45);
      if(actionCd <= 0){ maybePlaceTorch(); actionCd = 4; }
      break;
    }
    case PHASES.PLACE: {
      if(!has(KEEPSTONE) && !ensureKeepstoneMats()){
        setPhase(PHASES.GATHER, 'Need Keepstone materials…');
        break;
      }
      selectItem(KEEPSTONE);
      // place on open surface a couple blocks ahead
      const sx = Math.round(player.pos.x - Math.sin(view.yaw) * 2);
      const sz = Math.round(player.pos.z - Math.cos(view.yaw) * 2);
      faceToward(sx, sz, dt, 0.45);
      keys.KeyW = distXZ(player.pos.x, player.pos.z, sx, sz) > 1.6;
      if(actionCd <= 0){
        placeAction();
        actionCd = 0.55;
      }
      if(keepstones.all().length){
        setPhase(PHASES.SOCKET, 'Socketing the Elder Cube…');
      }
      break;
    }
    case PHASES.SOCKET: {
      const stones = keepstones.all();
      if(!stones.length){
        setPhase(PHASES.PLACE, 'No Keepstone — placing again…');
        break;
      }
      const s = stones[stones.length - 1];
      navigateTo(s.x, s.z, dt, {sprint: false, arriveR: 2.0, pitch: 0.3});
      if(actionCd <= 0){
        placeAction();
        actionCd = 0.45;
      }
      if(keepstones.sieging() || s.socketed){
        setPhase(PHASES.DEFEND, 'Cube seated — holding the siege…');
      }
      break;
    }
    case PHASES.DEFEND: {
      const s = keepstones.activeStone() || keepstones.all().find(x => x.socketed);
      if(!s){
        setPhase(PHASES.PLACE, 'Stone lost — rebuilding…');
        break;
      }
      if(keepstones.isDone(s)){
        setPhase(PHASES.DONE, 'Ground claimed. Bot idle — watching…');
        break;
      }
      setStatus(`Siege · r ${s.radius|0}/${keepstones.targetRadius(s)|0}`);
      const ang = phaseT * 0.55;
      const ox = s.x + Math.cos(ang) * 7;
      const oz = s.z + Math.sin(ang) * 7;
      if(!fightNearby(dt)) navigateTo(ox, oz, dt, {sprint: false, arriveR: 1.5});
      break;
    }
    case PHASES.DONE: {
      setStatus('Claim complete — watching');
      clearKeys();
      view.yaw += 0.12 * dt;
      break;
    }
    default: break;
  }

  lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
}

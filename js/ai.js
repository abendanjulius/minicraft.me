// ai.js — Cube-arc spectator bot. Drives the local player until you turn it off.
// No time limit. Nightfall-oriented: vault → Cube → Keepstone → siege → done.
// Pathing: 8-way scored steering + jump/dig recovery (v2.5.2).

import { WORLD, WH, getBlock, surfaceY, isWalkThrough, wrapC, seed } from './world.js';
import { player, view, state, keys, setMine, placeAction, castBlock, carryingCube, setInputLocked, skinIdx } from './player.js';
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

function faceYaw(want, dt, rate = 1.15){
  let dy = want - view.yaw;
  while(dy > Math.PI) dy -= Math.PI * 2;
  while(dy < -Math.PI) dy += Math.PI * 2;
  // Dead-zone stops micro-jitter when almost aligned
  if(Math.abs(dy) < 0.035) return true;
  // Ease-in: slower when close, still capped
  const ease = Math.min(1, Math.abs(dy) * 1.4);
  const max = rate * dt * (0.4 + 0.6 * ease);
  view.yaw += Math.max(-max, Math.min(max, dy));
  return Math.abs(dy) < 0.07;
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
    faceYaw(avoidYaw, dt, 2.0);
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
    steerHold = 0.55 + Math.random() * 0.35;
  }

  const [bx, bz] = steerDir;
  const wantYaw = Math.atan2(-bx, -bz);
  faceYaw(wantYaw, dt, 1.2);
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
    if(digCd <= 0) digLook(0.5);
    steerHold = 0; // allow rescore after wall
  } else if(!solid(ax, fy, az) && solid(ax, fy + 1, az)){
    smoothPitch(-0.25, dt, 1.0);
    if(digCd <= 0) digLook(0.5);
    steerHold = 0;
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
      const side = (Math.floor(phaseT * 3) % 2) ? 1 : -1;
      avoidYaw = view.yaw + side * (1.0 + Math.random() * 0.7);
      avoidT = 1.1;
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
      avoidYaw = view.yaw + Math.PI * (0.5 + Math.random() * 0.5) * ((Math.floor(phaseT) % 2) ? 1 : -1);
      avoidT = 0.7;
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

function placeBuildBlock(x, y, z, id){
  if(y < 1 || y >= WH) return false;
  if(getBlock(x, y, z)) return true; // already filled counts as done
  let useId = id;
  if(!gm.forge){
    const ok = ensureBuildBlocks(id);
    if(ok === false) return false;
    if(ok !== true) useId = ok;
    if((inventory[useId] || 0) <= 0) return false;
    inventory[useId]--;
  }
  applyEdit(x, y, z, useId, false);
  try{ net.sendEdit?.(x, y, z, useId); }catch(e){}
  return true;
}

function setupLandmark(id){
  const bp = buildings.blueprint(id);
  buildName = bp.name;
  const ox = Math.round(player.pos.x);
  const oz = Math.round(player.pos.z);
  const oy = surfaceY(ox, oz) + 1;
  buildOrigin = {x: ox, y: oy, z: oz};
  // Sort bottom-up so foundations go first
  const sorted = [...bp.blocks].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  buildQueue = sorted.map(([dx, dy, dz, bid]) => ({
    x: ox + dx, y: oy + dy, z: oz + dz, id: bid
  }));
  buildIndex = 0;
}

function setupCreative(){
  const bp = buildings.randomCreative();
  buildName = bp.name;
  const ox = Math.round(player.pos.x + Math.sin(view.yaw) * -4);
  const oz = Math.round(player.pos.z + Math.cos(view.yaw) * -4);
  const oy = surfaceY(ox, oz) + 1;
  buildOrigin = {x: ox, y: oy, z: oz};
  const sorted = [...bp.blocks].sort((a, b) => a[1] - b[1]);
  buildQueue = sorted.map(([dx, dy, dz, bid]) => ({
    x: ox + dx, y: oy + dy, z: oz + dz, id: bid
  }));
  buildIndex = 0;
}

function tickBuilder(dt){
  placeCd -= dt;
  if(phase === PHASES.BUILD_SETUP){
    if(builderMode === 'creative') setupCreative();
    else if(landmarkId) setupLandmark(landmarkId);
    else setupCreative();
    setPhase(PHASES.BUILD_PLACE, `Building ${buildName}…`);
    return;
  }
  if(phase === PHASES.BUILD_PLACE){
    if(buildIndex >= buildQueue.length){
      setPhase(PHASES.BUILD_DONE, `${buildName} complete`);
      return;
    }
    const cell = buildQueue[buildIndex];
    setStatus(`${buildName} · ${buildIndex + 1}/${buildQueue.length}`);
    const d = distXZ(player.pos.x, player.pos.z, cell.x, cell.z);
    // Walk near the cell
    if(d > 3.2){
      navigateTo(cell.x, cell.z, dt, {sprint: false, arriveR: 2.4});
      return;
    }
    // Look at placement
    faceToward(cell.x, cell.z, dt, Math.atan2(-(cell.y + 0.5 - (player.pos.y + 1.6)), Math.max(0.5, d)), 1.2);
    keys.KeyW = false;
    if(placeCd > 0) return;
    if(placeBuildBlock(cell.x, cell.y, cell.z, cell.id)){
      buildIndex++;
      placeCd = 0.28; // human place cadence
    } else {
      // no materials — skip or try gather
      if(!gm.forge){
        setStatus('Need blocks — gathering…');
        selectTool('pick');
        if(!mineLock) digLook(0.5);
        placeCd = 0.5;
        // skip this cell after a few fails
        if(phaseT > 8){ buildIndex++; phaseT = 0; }
      } else {
        buildIndex++;
      }
    }
    return;
  }
  if(phase === PHASES.BUILD_DONE){
    setStatus(`${buildName} complete — watching`);
    clearKeys();
    view.yaw += 0.1 * dt;
    // Creative: start another doodle after a pause
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
  buildQueue = [];
  buildIndex = 0;

  if(botProfile === 'builder'){
    setPhase(PHASES.BUILD_SETUP, builderMode === 'creative' ? 'Creative building…' : 'Preparing landmark…');
    addChat('🤖', builderMode === 'creative'
      ? 'Builder ON — creative mode (no time limit).'
      : `Builder ON — constructing ${(buildings.listBuildings().find(b=>b.id===landmarkId)||{}).name || 'landmark'}.`);
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
  active = false;
  setInputLocked?.(false);
  document.body.classList.remove('ai-driving');
  clearKeys();
  clearMining();
  deathWait = 0;
  phase = PHASES.IDLE;
  botProfile = 'story';
  builderMode = null;
  landmarkId = null;
  setStatus('');
  const btn = document.getElementById('btnAI');
  if(btn) btn.classList.remove('active');
  hideStreamCam();
  closeProfileModal();
  addChat('🤖', 'Bot OFF.');
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

function showBuildingList(){
  document.getElementById('aiBuilderOpts').style.display = 'none';
  document.getElementById('aiBuildingList').style.display = 'block';
  const grid = document.getElementById('aiBuildingGrid');
  grid.innerHTML = '';
  for(const b of buildings.listBuildings()){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aiBuildBtn';
    btn.innerHTML = `<span class="ic">${b.icon}</span><span class="nm">${b.name}</span>`;
    btn.addEventListener('click', ()=>{
      closeProfileModal();
      start({profile:'builder', builderMode:'landmark', landmarkId: b.id});
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

  manageInventory(dt);
  checkStuckAlarm(dt);
  tickStreamFace(dt);

  // Keep facecam visible (mobile Safari / layout can drop it)
  streamCamGuard -= dt;
  if(streamCamGuard <= 0){
    streamCamGuard = 2.5;
    const cam = streamCamEl();
    if(cam && !cam.classList.contains('scShow')) showStreamCam();
    else if(cam && cam.style.display === 'none') showStreamCam();
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

  // Builder profile skips combat focus unless attacked up close
  if(botProfile === 'builder'){
    if(nearestHostile() && fightNearby(dt)){
      lastPos = {x: player.pos.x, y: player.pos.y, z: player.pos.z};
      return;
    }
    tickBuilder(dt);
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

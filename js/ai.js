// ai.js — Cube-arc spectator bot. Drives the local player until you turn it off.
// No time limit. Nightfall-oriented: vault → Cube → Keepstone → siege → done.
// Pathing: 8-way scored steering + jump/dig recovery (v2.5.2).

import { WORLD, WH, getBlock, surfaceY, isWalkThrough, wrapC, seed } from './world.js';
import { player, view, state, keys, setMine, placeAction, castBlock, carryingCube, setInputLocked } from './player.js';
import { inventory, hotbarSlots, sel, renderHotbar, joy, addChat } from './ui.js';
import { gm } from './mode.js';
import * as eldercube from './eldercube.js';
import * as keepstones from './keepstones.js';
import * as craft from './craft.js';
import { zombies } from './mobs.js';
import { TYPES } from './render.js';
import * as survival from './survival.js';

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
};

let active = false;
let phase = PHASES.IDLE;
let status = '';
let target = null;
let mineTimer = 0;
let mineLock = null; // {x,y,z} hold still until this block breaks
let actionCd = 0;
let stuckT = 0;
let lastPos = {x:0, y:0, z:0};
let phaseT = 0;
let announceAt = 0;
let avoidYaw = 0;          // temporary detour heading
let avoidT = 0;            // seconds left on detour
let digCd = 0;
let wanderAng = 0;
let recoverMode = 0;       // 0 none, 1 dig, 2 turn, 3 back up

export const isActive = () => active;
export const getPhase = () => phase;
export const getStatus = () => status;

function setStatus(s){
  if(s === status) return;
  status = s;
  const el = document.getElementById('aiStatus');
  if(el) el.textContent = active ? `🤖 ${s}` : '';
}

function clearKeys(){
  keys.KeyW = keys.KeyA = keys.KeyS = keys.KeyD = false;
  keys.Space = false;
  keys.ShiftLeft = keys.ShiftRight = keys.sprint = false;
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
    faceYaw(Math.atan2(-steer[0], -steer[1]), dt, 4);
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

function faceYaw(want, dt, rate = 3.2){
  let dy = want - view.yaw;
  while(dy > Math.PI) dy -= Math.PI * 2;
  while(dy < -Math.PI) dy += Math.PI * 2;
  const max = rate * dt;
  view.yaw += Math.max(-max, Math.min(max, dy));
  return Math.abs(dy) < 0.12;
}

function faceToward(tx, tz, dt, pitch = null, rate = 3.2){
  const dx = wrapDelta(tx - player.pos.x);
  const dz = wrapDelta(tz - player.pos.z);
  const want = Math.atan2(-dx, -dz);
  const ok = faceYaw(want, dt, rate);
  if(pitch != null){
    const dp = pitch - view.pitch;
    const max = rate * dt;
    view.pitch += Math.max(-max, Math.min(max, dp));
    view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch));
  }
  return ok;
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

function tryCraftId(outId){
  const r = craft.RECIPES.find(x => x.out.id === outId);
  if(!r || !craft.canCraft(r)) return false;
  return craft.craft(r);
}

function ensureKeepstoneMats(){
  while(has(IRON_CHUNK, 3) && !has(IRON_INGOT, 2)) tryCraftId(IRON_INGOT);
  if(has(CRYSTAL, 2) && has(IRON_INGOT, 2) && has(STONE, 8)){
    return tryCraftId(KEEPSTONE) || has(KEEPSTONE);
  }
  return has(KEEPSTONE);
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
  digCd = 0.15;
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
  faceYaw(Math.atan2(-dx, -dz), dt, 8);
  view.pitch += Math.max(-6 * dt, Math.min(6 * dt, Math.atan2(-dy, horiz) - view.pitch));
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
  faceToward(p.x, p.z, dt, -0.1);
  const d = distXZ(player.pos.x, player.pos.z, p.x, p.z);
  keys.KeyW = d > 1.6;
  keys.sprint = false;
  if(actionCd <= 0){
    setMine(true);
    actionCd = 0.32;
    mineTimer = 0.15;
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
    faceYaw(avoidYaw, dt, 4);
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

  // Score 8 compass directions (cardinal + diagonal)
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

  // If every direction is bad, force recovery dig toward goal
  if(bestScore < -15){
    faceToward(goalX, goalZ, dt, 0.15);
    keys.KeyW = true;
    keys.Space = true;
    if(digCd <= 0) digLook(0.55);
    return false;
  }

  const [bx, bz] = best;
  const wantYaw = Math.atan2(-bx, -bz);
  faceYaw(wantYaw, dt, 3.5);
  if(opts.pitch != null){
    const dp = opts.pitch - view.pitch;
    view.pitch += Math.max(-3 * dt, Math.min(3 * dt, dp));
  } else {
    view.pitch += Math.max(-2 * dt, Math.min(2 * dt, -0.08 - view.pitch));
  }

  keys.KeyW = true;
  keys.sprint = sprint && d > 8 && stuckT < 0.4;

  // Step-up: solid at feet level ahead, clear above → jump
  const ax = player.pos.x - Math.sin(view.yaw) * 1.0;
  const az = player.pos.z - Math.cos(view.yaw) * 1.0;
  const fy = Math.round(player.pos.y);
  if(solid(ax, fy, az) && !solid(ax, fy + 1, az) && !solid(ax, fy + 2, az)){
    keys.Space = true;
  }
  // Two-high wall → dig
  else if(solid(ax, fy, az) && solid(ax, fy + 1, az)){
    if(digCd <= 0){
      view.pitch = 0.05;
      digLook(0.5);
    }
  }
  // Head-height only → dig head
  else if(!solid(ax, fy, az) && solid(ax, fy + 1, az)){
    if(digCd <= 0){
      view.pitch = -0.35;
      digLook(0.5);
    }
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

/** Dig a 1×2 shaft downward toward target Y while staying near XZ. */
function digDownToward(ty, dt){
  const px = Math.round(player.pos.x), pz = Math.round(player.pos.z);
  const py = Math.round(player.pos.y);
  selectTool('pick');
  view.pitch = 1.15;
  // clear under feet
  if(solid(px, py - 1, pz) || solid(px, py, pz)){
    digLook(0.55);
    keys.KeyW = false;
    return player.pos.y <= ty + 1.2;
  }
  if(mineLock){ keys.KeyW = false; return player.pos.y <= ty + 1.2; }
  // if somehow floating, walk
  keys.KeyW = false;
  return player.pos.y <= ty + 1.2;
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
  setStatus(msg || p);
  if(performance.now() > announceAt){
    addChat('🤖', msg || p);
    announceAt = performance.now() + 5000;
  }
}

export function start(){
  if(active) return;
  if(!state.playing){ addChat('🤖', 'Start a world first.'); return; }
  if(gm.forge){
    addChat('🤖', 'Cube-arc bot runs in Nightfall — switch mode and try again.');
    return;
  }
  active = true;
  setInputLocked?.(true);
  document.body.classList.add('ai-driving');
  clearKeys();
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
  const btn = document.getElementById('btnAI');
  if(btn) btn.classList.add('active');
  addChat('🤖', 'Cube-arc bot ON — smarter pathing. No time limit.');
}

export function stop(){
  if(!active) return;
  active = false;
  setInputLocked?.(false);
  document.body.classList.remove('ai-driving');
  clearKeys();
  setMine(false);
  mineLock = null;
  mineTimer = 0;
  phase = PHASES.IDLE;
  setStatus('');
  const btn = document.getElementById('btnAI');
  if(btn) btn.classList.remove('active');
  addChat('🤖', 'Cube-arc bot OFF.');
}

export function toggle(){
  if(active) stop(); else start();
}

export function tick(dt){
  if(!active || !state.playing || state.paused) return;
  if(survival.sv.dead){ clearKeys(); return; }

  phaseT += dt;
  actionCd -= dt;
  digCd -= dt;
  clearKeys();
  if(joy){ joy.x = 0; joy.y = 0; }

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
      if(navigateTo(target.x, target.z, dt, {sprint: true, arriveR: 2.2})){
        setPhase(PHASES.DESCEND, 'Descending into the vault…');
      }
      break;
    }
    case PHASES.DESCEND: {
      target = vaultTarget();
      if(distXZ(player.pos.x, player.pos.z, target.x, target.z) > 3){
        navigateTo(target.x, target.z, dt, {sprint: false, arriveR: 2});
        break;
      }
      setStatus(`Descending · y ${player.pos.y|0}→${target.y}`);
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
      setStatus('Gathering stone / ores…');
      tryCraftId(IRON_INGOT);
      // wander & dig
      wanderAng += dt * 0.6;
      const wx = player.pos.x + Math.cos(wanderAng) * 10;
      const wz = player.pos.z + Math.sin(wanderAng) * 10;
      navigateTo(wx, wz, dt, {sprint: false, arriveR: 2, pitch: 0.4});
      if(digCd <= 0) digLook(0.45);
      if((!has(CRYSTAL, 2) || !has(IRON_INGOT, 2)) && player.pos.y > 10){
        view.pitch = 0.95;
        digLook(0.5);
      }
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

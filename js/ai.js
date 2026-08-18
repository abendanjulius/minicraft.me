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

function inWaterNow(){
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
  return isWaterAt(px, py, pz) || isWaterAt(px, py + 1, pz) || isWaterAt(px, py + 1.5, pz);
}

/**
 * Escape lakes / underwater pockets.
 * Priority: dig ceiling → swim straight up → swim toward nearest shore.
 * Returns true if it handled this frame (caller should skip normal pathing).
 */
function escapeWater(dt){
  if(!inWaterNow()) return false;

  const px = Math.round(player.pos.x);
  const py = Math.round(player.pos.y);
  const pz = Math.round(player.pos.z);

  setStatus('Swimming out…');
  keys.sprint = false;
  keys.ShiftLeft = keys.ShiftRight = false;

  // 1) Solid block above head? Dig it — common "trapped under water+ceiling"
  for(let dy = 2; dy <= 4; dy++){
    if(solid(px, py + dy, pz)){
      selectTool('pick');
      view.pitch = -1.2;
      faceYaw(view.yaw, dt, 1);
      digLook(0.55);
      keys.Space = true; // keep buoyancy while digging
      keys.KeyW = false;
      return true;
    }
  }

  // 2) Ceiling is clear of solids — swim up hard
  keys.Space = true;
  view.pitch = -0.9;

  // 3) Find best horizontal escape toward shallower / dry ground
  const dirs = [
    [1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],
  ];
  let best = null, bestScore = -Infinity;
  for(const [dx, dz] of dirs){
    const len = Math.hypot(dx, dz);
    const nx = px + (dx / len) * 2;
    const nz = pz + (dz / len) * 2;
    let score = 0;
    // prefer air at head height
    if(!isWaterAt(nx, py + 2, nz) && !solid(nx, py + 2, nz)) score += 20;
    if(!isWaterAt(nx, py + 1, nz)) score += 10;
    if(!isWaterAt(nx, py, nz)) score += 8;
    // shore: solid under a non-water cell
    if(!isWaterAt(nx, py, nz) && solid(nx, py - 1, nz)) score += 15;
    // open column to surface
    let openUp = 0;
    for(let y = py; y < Math.min(WH, py + 8); y++){
      if(solid(nx, y, nz)){ openUp = -5; break; }
      if(!isWaterAt(nx, y, nz)){ openUp += 3; break; }
      openUp += 1;
    }
    score += openUp;
    // lightly bias toward current goal if we have one
    if(target){
      const before = distXZ(px, pz, target.x, target.z);
      const after = distXZ(nx, nz, target.x, target.z);
      score += (before - after) * 2;
    }
    if(score > bestScore){ bestScore = score; best = [dx / len, dz / len]; }
  }

  if(best){
    const want = Math.atan2(-best[0], -best[1]);
    faceYaw(want, dt, 3.5);
    keys.KeyW = true;
  } else {
    keys.KeyW = true;
    view.yaw += dt * 1.2; // spin search
  }

  // 4) If still not rising and stuck, dig sideways underwater walls
  const movedY = player.pos.y - lastPos.y;
  if(stuckT > 0.5 || movedY < 0.02){
    const ax = px - Math.sin(view.yaw);
    const az = pz - Math.cos(view.yaw);
    if(solid(ax, py + 1, az) || solid(ax, py + 2, az)){
      view.pitch = -0.4;
      digLook(0.5);
    } else if(stuckT > 1.2){
      // random turn to find a gap
      avoidYaw = view.yaw + (Math.random() > 0.5 ? 1.2 : -1.2);
      avoidT = 0.8;
      stuckT = 0;
    }
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

/** Mine whatever the crosshair hits (short reach). */
function digLook(hold = 0.45){
  selectTool('pick') || selectTool('shovel') || selectTool('axe');
  const r = castBlock(5);
  if(!r || !r.hit) return false;
  const t = getBlock(...r.hit);
  if(!t || t === 64 || (TYPES[t]?.hard ?? 99) >= 90) return false;
  setMine(true);
  mineTimer = hold;
  digCd = 0.2;
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

  if(stuckT > 0.7){
    recoverMode = (recoverMode + 1) % 4;
    stuckT = 0.15;
    if(recoverMode === 0){
      // dig straight ahead
      view.pitch = 0.1;
      digLook(0.7);
    } else if(recoverMode === 1){
      // detour 70–110° left or right
      const side = (Math.floor(phaseT * 3) % 2) ? 1 : -1;
      avoidYaw = view.yaw + side * (0.9 + Math.random() * 0.5);
      avoidT = 0.9 + Math.random() * 0.6;
    } else if(recoverMode === 2){
      // dig down only on dry land — underwater this made traps worse
      if(!inWaterNow() && !isWaterAt(player.pos.x, player.pos.y - 1, player.pos.z)){
        view.pitch = 1.2;
        digLook(0.6);
        keys.KeyW = false;
      } else {
        avoidYaw = view.yaw + 1.4;
        avoidT = 0.7;
        keys.Space = true;
      }
    } else {
      // back up briefly then re-steer
      keys.KeyW = false;
      keys.KeyS = true;
      avoidYaw = view.yaw + Math.PI * 0.6 * ((Math.floor(phaseT) % 2) ? 1 : -1);
      avoidT = 0.55;
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
  if(mineTimer > 0){
    mineTimer -= dt;
    if(mineTimer <= 0) setMine(false);
  }

  clearKeys();
  if(joy){ joy.x = 0; joy.y = 0; }

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

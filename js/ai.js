// ai.js — Cube-arc spectator bot. Drives the local player until you turn it off.
// No time limit. Nightfall-oriented: vault → Cube → Keepstone → siege → done.

import { WORLD, WH, CENTER, getBlock, heightAt, surfaceY, isWalkThrough, wrapC, seed } from './world.js';
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
  TRAVEL: 'travel',       // walk to vault XZ
  DESCEND: 'descend',     // dig down to vault Y
  LOOT: 'loot',           // mine cube / area
  ASCEND: 'ascend',       // get back to surface
  GATHER: 'gather',       // materials for Keepstone
  PLACE: 'place',         // place Keepstone
  SOCKET: 'socket',       // seat the Cube
  DEFEND: 'defend',       // hold siege
  DONE: 'done',           // claim finished — keep idling / watch
};

let active = false;
let phase = PHASES.IDLE;
let status = '';
let target = null;        // {x,y,z}
let mineTimer = 0;
let actionCd = 0;
let stuckT = 0;
let lastPos = {x:0,z:0};
let phaseT = 0;
let announceAt = 0;

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

function faceToward(tx, tz, dt, pitch = null){
  const dx = wrapDelta(tx - player.pos.x);
  const dz = wrapDelta(tz - player.pos.z);
  // look dir: (-sin yaw, -cos yaw) → yaw = atan2(-dx, -dz)
  const want = Math.atan2(-dx, -dz);
  let dy = want - view.yaw;
  while(dy > Math.PI) dy -= Math.PI*2;
  while(dy < -Math.PI) dy += Math.PI*2;
  const max = 2.8 * dt;
  view.yaw += Math.max(-max, Math.min(max, dy));
  if(pitch != null){
    const dp = pitch - view.pitch;
    view.pitch += Math.max(-max, Math.min(max, dp));
    view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch));
  }
}

function selectTool(id){
  const i = hotbarSlots.findIndex(s => s?.k === 't' && s.id === id);
  if(i >= 0){ sel.slot = i; renderHotbar(); return true; }
  return false;
}

function selectItem(id){
  const i = hotbarSlots.findIndex(s => s && s.id === id);
  if(i >= 0){ sel.slot = i; renderHotbar(); return true; }
  // put into an empty hotbar slot if we have it in inventory
  if((inventory[id]||0) > 0){
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

function has(id, n=1){ return (inventory[id]||0) >= n; }

function tryCraftId(outId){
  const r = craft.RECIPES.find(x => x.out.id === outId);
  if(!r) return false;
  if(!craft.canCraft(r)) return false;
  return craft.craft(r);
}

function ensureKeepstoneMats(){
  // Keepstone: 2 crystal, 2 iron ingot, 8 stone
  while(has(IRON_CHUNK, 3) && !has(IRON_INGOT, 2)) tryCraftId(IRON_INGOT);
  if(has(CRYSTAL, 2) && has(IRON_INGOT, 2) && has(STONE, 8)){
    return tryCraftId(KEEPSTONE) || has(KEEPSTONE);
  }
  return has(KEEPSTONE);
}

function blockAhead(dist = 1){
  const fx = Math.round(player.pos.x - Math.sin(view.yaw) * dist);
  const fz = Math.round(player.pos.z - Math.cos(view.yaw) * dist);
  const fy = Math.round(player.pos.y + 0.5);
  return {x:fx, y:fy, z:fz, feet:getBlock(fx, fy, fz), head:getBlock(fx, fy+1, fz)};
}

function digAhead(dt){
  selectTool('pick') || selectTool('shovel') || selectTool('axe');
  const r = castBlock(5);
  if(r && r.hit){
    const t = getBlock(...r.hit);
    if(t && t !== 64 && TYPES[t]?.hard < 90){
      setMine(true);
      mineTimer = 0.4;
      return true;
    }
  }
  return false;
}

function nearestHostile(){
  let best = null, bestD = 6;
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
  faceToward(p.x, p.z, dt, -0.15);
  keys.KeyW = distXZ(player.pos.x, player.pos.z, p.x, p.z) > 1.8;
  if(actionCd <= 0){
    setMine(true);
    actionCd = 0.35;
    setTimeout(()=>setMine(false), 120);
  }
  return true;
}

function vaultTarget(){
  const v = eldercube.vaultRecord() || eldercube.vaultSite(seed);
  return {x: v.x, y: v.y + 1, z: v.z};
}

function goToXZ(tx, tz, dt, sprint = true){
  faceToward(tx, tz, dt, -0.12);
  const d = distXZ(player.pos.x, player.pos.z, tx, tz);
  if(d < 1.2){ keys.KeyW = false; return true; }
  keys.KeyW = true;
  keys.sprint = sprint;
  const ahead = blockAhead(1);
  if(ahead.feet && !isWalkThrough(ahead.feet)){
    if(isWalkThrough(ahead.head) && isWalkThrough(getBlock(ahead.x, ahead.y+2, ahead.z))){
      keys.Space = true; // jump up step
    } else {
      digAhead(dt);
    }
  }
  // stuck detection
  const moved = Math.hypot(player.pos.x - lastPos.x, player.pos.z - lastPos.z);
  if(moved < 0.05) stuckT += dt; else stuckT = 0;
  if(stuckT > 1.2){
    digAhead(dt);
    keys.Space = true;
    // slight strafe to unstick
    keys.KeyA = (Math.floor(phaseT) % 2) === 0;
    keys.KeyD = !keys.KeyA;
    stuckT = 0;
  }
  return false;
}

function setPhase(p, msg){
  phase = p;
  phaseT = 0;
  setStatus(msg || p);
  if(performance.now() > announceAt){
    addChat('🤖', msg || p);
    announceAt = performance.now() + 4000;
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
  addChat('🤖', 'Cube-arc bot ON — sit back. No time limit.');
}

export function stop(){
  if(!active) return;
  active = false;
  setInputLocked?.(false);
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
  if(mineTimer > 0){ mineTimer -= dt; if(mineTimer <= 0) setMine(false); }

  clearKeys();
  if(joy){ joy.x = 0; joy.y = 0; }
  lastPos = {x: player.pos.x, z: player.pos.z};

  // Always react to nearby threats unless fully done and far
  if(phase !== PHASES.DONE && fightNearby(dt)){
    setStatus('Fighting…');
    return;
  }

  switch(phase){
    case PHASES.TRAVEL: {
      target = vaultTarget();
      setStatus(`To vault · ${distXZ(player.pos.x, player.pos.z, target.x, target.z)|0}m`);
      if(goToXZ(target.x, target.z, dt)){
        setPhase(PHASES.DESCEND, 'Descending into the vault…');
      }
      break;
    }
    case PHASES.DESCEND: {
      target = vaultTarget();
      // stay near xz while digging down
      if(distXZ(player.pos.x, player.pos.z, target.x, target.z) > 2.5){
        goToXZ(target.x, target.z, dt, false);
        break;
      }
      faceToward(target.x, target.z, dt, 1.1); // look down
      keys.KeyW = false;
      if(player.pos.y > target.y + 1.5){
        selectTool('pick');
        // dig block below / in view
        if(!digAhead(dt)){
          // dig straight down under feet
          const bx = Math.round(player.pos.x), by = Math.round(player.pos.y - 0.6), bz = Math.round(player.pos.z);
          if(getBlock(bx, by, bz)){
            // face down more and mine
            setMine(true);
            mineTimer = 0.5;
          }
        }
      } else {
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
      faceToward(target.x, target.z, dt, 0.3);
      setStatus('Mining the vault…');
      selectTool('pick');
      // circle slowly and dig
      keys.KeyW = true;
      keys.KeyA = true;
      digAhead(dt);
      if(phaseT > 90){
        // timeout: climb and retry path
        setPhase(PHASES.ASCEND, 'Vault timed out — resurfacing…');
      }
      break;
    }
    case PHASES.ASCEND: {
      const surf = surfaceY(Math.round(player.pos.x), Math.round(player.pos.z));
      setStatus(`Climbing · y ${player.pos.y|0}→${surf}`);
      if(player.pos.y >= surf - 0.5){
        setPhase(PHASES.GATHER, 'On surface — Keepstone materials…');
        break;
      }
      faceToward(player.pos.x - Math.sin(view.yaw), player.pos.z - Math.cos(view.yaw), dt, -0.6);
      selectTool('pick');
      // dig upward staircase: mine block at head+1 forward
      const fx = Math.round(player.pos.x - Math.sin(view.yaw));
      const fz = Math.round(player.pos.z - Math.cos(view.yaw));
      const hy = Math.round(player.pos.y + 2);
      if(getBlock(fx, hy, fz) || getBlock(fx, hy-1, fz)){
        view.pitch = -0.7;
        digAhead(dt);
      }
      keys.KeyW = true;
      keys.Space = true;
      if(phaseT > 120){
        // emergency teleport-ish: walk any direction up via dig
        view.yaw += 0.5;
        phaseT = 60;
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
      selectTool('pick');
      // dig nearby stone
      faceToward(player.pos.x + Math.sin(phaseT)*4, player.pos.z + Math.cos(phaseT)*4, dt, 0.5);
      keys.KeyW = true;
      digAhead(dt);
      // craft whatever we can each tick
      tryCraftId(IRON_INGOT);
      if(has(STONE, 8) && has(IRON_INGOT, 2) && has(CRYSTAL, 2)) tryCraftId(KEEPSTONE);
      // if low on crystal/iron, dig deeper
      if(!has(CRYSTAL, 2) || !has(IRON_INGOT, 2)){
        if(player.pos.y > 12){
          view.pitch = 0.9;
          digAhead(dt);
        }
      }
      break;
    }
    case PHASES.PLACE: {
      if(!has(KEEPSTONE) && !ensureKeepstoneMats()){
        setPhase(PHASES.GATHER, 'Need Keepstone materials…');
        break;
      }
      // find open surface near us
      const sx = Math.round(player.pos.x - Math.sin(view.yaw) * 2);
      const sz = Math.round(player.pos.z - Math.cos(view.yaw) * 2);
      const sy = surfaceY(sx, sz);
      faceToward(sx, sz, dt, 0.4);
      selectItem(KEEPSTONE);
      keys.KeyW = distXZ(player.pos.x, player.pos.z, sx, sz) > 1.5;
      if(actionCd <= 0){
        placeAction();
        actionCd = 0.6;
      }
      // detect placed stone
      if(keepstones.all().length){
        setPhase(PHASES.SOCKET, 'Socketing the Elder Cube…');
      }
      if(phaseT > 25){
        // try placing at feet
        view.pitch = 0.8;
        placeAction();
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
      faceToward(s.x, s.z, dt, 0.25);
      keys.KeyW = distXZ(player.pos.x, player.pos.z, s.x, s.z) > 2.2;
      if(actionCd <= 0){
        placeAction(); // sockets when looking at stone + carrying cube
        actionCd = 0.5;
      }
      if(keepstones.sieging() || (s.socketed)){
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
      // orbit the stone
      const ang = phaseT * 0.7;
      const ox = s.x + Math.cos(ang) * 6;
      const oz = s.z + Math.sin(ang) * 6;
      if(!fightNearby(dt)){
        goToXZ(ox, oz, dt, false);
      }
      break;
    }
    case PHASES.DONE: {
      setStatus('Claim complete — watching');
      clearKeys();
      // gentle look around
      view.yaw += 0.15 * dt;
      break;
    }
    default:
      break;
  }
}

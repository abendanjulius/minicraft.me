// physics.js — sand/gravel gravity + leaf decay (Minecraft-style)
// No import from render.js (avoids circular deps). Callers rebuild meshes / particles.
import { WH, getBlock, setBlock, wrapC } from './world.js';

export const GRAVITY = new Set([6, 20]); // Sand, Gravel
const LEAF = 5;
const LOG = 4;
const LEAF_RANGE = 4;
const DECAY_SCAN = 5;

let onFx = null; // (x,y,z, typeId) => void  optional particles
export function setPhysicsFx(fn){ onFx = fn; }

function settleColumn(x, z, out){
  x = wrapC(x); z = wrapC(z);
  let moved = false;
  for(let y = 1; y < WH; y++){
    const t = getBlock(x, y, z);
    if(!GRAVITY.has(t)) continue;
    if(getBlock(x, y - 1, z)) continue;
    let dest = 0;
    for(let d = y - 1; d >= 0; d--){
      if(getBlock(x, d, z)){ dest = d + 1; break; }
    }
    if(dest === y) continue;
    setBlock(x, y, z, 0);
    setBlock(x, dest, z, t);
    out.push([x, y, z, 0], [x, dest, z, t]);
    onFx?.(x, y, z, t);
    moved = true;
  }
  return moved;
}

/** Settle gravity in a column. Returns [[x,y,z,t],...] so the caller can record + sync. */
export function afterEdit(x, y, z){
  x = wrapC(x); z = wrapC(z);
  const out = [];
  for(let i = 0; i < WH; i++){
    if(!settleColumn(x, z, out)) break;
  }
  return out;
}

const decayQ = [];

function hasNearbyLog(x, y, z){
  for(let dy = -LEAF_RANGE; dy <= LEAF_RANGE; dy++){
    const ly = y + dy;
    if(ly < 0 || ly >= WH) continue;
    for(let dx = -LEAF_RANGE; dx <= LEAF_RANGE; dx++){
      for(let dz = -LEAF_RANGE; dz <= LEAF_RANGE; dz++){
        if(getBlock(x + dx, ly, z + dz) === LOG) return true;
      }
    }
  }
  return false;
}

export function notifyLogBroken(x, y, z){
  x = wrapC(x); z = wrapC(z);
  for(let dy = -DECAY_SCAN; dy <= DECAY_SCAN; dy++){
    const ly = y + dy;
    if(ly < 0 || ly >= WH) continue;
    for(let dx = -DECAY_SCAN; dx <= DECAY_SCAN; dx++){
      for(let dz = -DECAY_SCAN; dz <= DECAY_SCAN; dz++){
        const lx = wrapC(x + dx), lz = wrapC(z + dz);
        if(getBlock(lx, ly, lz) === LEAF)
          decayQ.push({x: lx, y: ly, z: lz, wait: 0.35 + Math.random() * 1.4});
      }
    }
  }
}

/** Returns array of [x,y,z] leaves that decayed this frame. */
export function tickDecay(dt){
  const gone = [];
  for(let i = decayQ.length - 1; i >= 0; i--){
    const e = decayQ[i];
    e.wait -= dt;
    if(e.wait > 0) continue;
    decayQ.splice(i, 1);
    if(getBlock(e.x, e.y, e.z) !== LEAF) continue;
    if(hasNearbyLog(e.x, e.y, e.z)) continue;
    setBlock(e.x, e.y, e.z, 0);
    gone.push([e.x, e.y, e.z]);
  }
  if(decayQ.length > 900) decayQ.length = 900;
  return gone;
}

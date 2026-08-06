// keepstones.js — the pedestals that do the claiming.
//
// The Elder Cube claims nothing while you carry it. Socket it into a placed
// Keepstone and the stone starts growing a disc of permanently-safe ground
// around itself; the horde escalates the whole time it works. When the disc
// tops out the stone goes dormant and you carry the Cube to the next site.
//
// There is exactly one Cube per world, so at most one Keepstone is ever active.
import { scene, box, placeWrapped, rebuildAt, makeElderCubeMesh } from './render.js';
import { wrapC, CH } from './world.js';
import * as claim from './claim.js';

export const MAX_RADIUS = 24;   // world blocks — the disc a single stone can reach
const SECS_PER_BLOCK = 3;       // radius growth rate → ~72s from bare stone to full

// key "x,y,z" -> {x,y,z, radius, socketed, mesh}
const stones = new Map();
const key = (x,y,z) => wrapC(x)+','+y+','+wrapC(z);

export const get = (x,y,z) => stones.get(key(x,y,z)) || null;
export const all = () => [...stones.values()];
export const activeStone = () => [...stones.values()].find(s => s.socketed) || null;
/** True while a Cube is seated and still working — the horde reads this. */
export const sieging = () => !!(activeStone() && activeStone().radius < MAX_RADIUS);

/** Register a Keepstone that has just been placed in the world. */
export function place(x, y, z){
  const k = key(x,y,z);
  if(stones.has(k)) return stones.get(k);
  const s = {x:wrapC(x), y, z:wrapC(z), radius:0, socketed:false, mesh:null};
  stones.set(k, s);
  return s;
}

/** Forget a Keepstone that was mined. Returns true if it still held the Cube. */
export function remove(x, y, z){
  const k = key(x,y,z);
  const s = stones.get(k);
  if(!s) return false;
  const held = s.socketed;
  dropMesh(s);
  stones.delete(k);
  return held;
}

export function socket(x, y, z){
  const s = get(x,y,z);
  if(!s || s.socketed) return false;
  s.socketed = true;
  makeMesh(s);
  return true;
}

/** Pull the Cube back out. Returns false if this stone doesn't have it. */
export function unsocket(x, y, z){
  const s = get(x,y,z);
  if(!s || !s.socketed) return false;
  s.socketed = false;
  dropMesh(s);
  return true;
}

export const isDone = s => s.radius >= MAX_RADIUS;

/**
 * Re-mesh only the chunks the disc newly reached, so the warm claimed skin
 * appears as the ring sweeps outward. Rebuilding the whole disc every step
 * would re-run buildChunk on the same inner chunks ~24 times per siege.
 */
function remeshRing(x, z, prevR, newR){
  const outer = Math.ceil(newR), inner = Math.floor(prevR);
  const seen = new Set();
  for(let dz = -outer; dz <= outer; dz++){
    for(let dx = -outer; dx <= outer; dx++){
      const d = Math.hypot(dx, dz);
      if(d > outer) continue;
      // skip the interior that was already claimed and meshed last step
      if(d < inner - CH) continue;
      const wx = wrapC(x + dx), wz = wrapC(z + dz);
      const k = (wx >> 4) + ',' + (wz >> 4);
      if(seen.has(k)) continue;
      seen.add(k);
      rebuildAt(wx, wz);
    }
  }
}

// ---- visuals ---------------------------------------------------------------
function makeMesh(s){
  if(s.mesh) return;
  // The seated Cube is the same model as the loose one, riding the cradle, plus
  // a real light so a working Keepstone is visible across the dark.
  const m = makeElderCubeMesh(.46);
  m.position.set(s.x, s.y + 1.0, s.z);
  const lamp = new THREE.PointLight(0xffc873, 1.5, 14);
  m.add(lamp);
  s.mesh = m;
  scene.add(m);
}
function dropMesh(s){
  if(!s.mesh) return;
  scene.remove(s.mesh);
  s.mesh = null;
}

// ---- tick ------------------------------------------------------------------
/**
 * Grow the active stone's disc. `onFull` fires once when a stone tops out.
 * px/pz are the player position, used only to keep the floating Cube drawn on
 * the correct side of the toroidal seam.
 */
export function tick(dt, px, pz, onFull){
  for(const s of stones.values()){
    if(s.mesh){
      s.mesh.rotation.y += dt * 1.1;
      s.mesh.position.y = s.y + 1.0 + Math.sin(performance.now() / 600) * 0.05;
      placeWrapped(s.mesh, s.x, s.mesh.position.y, s.z, px, pz);
    }
    if(!s.socketed || isDone(s)) continue;
    const prev = s.radius;
    s.radius = Math.min(MAX_RADIUS, s.radius + dt / SECS_PER_BLOCK);
    if(Math.floor(s.radius) > Math.floor(prev)){
      claim.claimDisc(s.x, s.z, s.radius);
      remeshRing(s.x, s.z, prev, s.radius);
    }
    if(isDone(s) && prev < MAX_RADIUS){
      claim.claimDisc(s.x, s.z, MAX_RADIUS); // make sure the rim is filled
      remeshRing(s.x, s.z, prev, MAX_RADIUS);
      onFull?.(s);
    }
  }
}

// ---- save / restore --------------------------------------------------------
export function serialize(){
  const out = [...stones.values()].map(s => [s.x, s.y, s.z, +s.radius.toFixed(2), s.socketed?1:0]);
  return out.length ? out : null;
}
export function restore(arr){
  for(const s of stones.values()) dropMesh(s);
  stones.clear();
  if(!Array.isArray(arr)) return;
  for(const [x,y,z,r,sock] of arr){
    const s = {x:wrapC(x), y, z:wrapC(z), radius:r||0, socketed:!!sock, mesh:null};
    stones.set(key(x,y,z), s);
    if(s.socketed) makeMesh(s);
  }
}
export function clear(){
  for(const s of stones.values()) dropMesh(s);
  stones.clear();
}

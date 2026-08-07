// keepstones.js — the pedestals that do the claiming.
//
// The Elder Cube claims nothing while you carry it. Socket it into a placed
// Keepstone and the stone starts growing a disc of permanently-safe ground
// around itself; the horde escalates the whole time it works. When the disc
// tops out the stone goes dormant and you carry the Cube to the next site.
//
// There is exactly one Cube per world, so at most one Keepstone is ever active.
import { scene, box, placeWrapped, makeElderCubeMesh, makeReliquaryMesh } from './render.js';
import { wrapC } from './world.js';
import * as claim from './claim.js';
import { queueChunkRemesh, flushRemeshQueue } from './remeshQueue.js';

export const MAX_RADIUS = 24;   // world blocks — a tier-0 stone's reach
const SECS_PER_BLOCK = 3;       // radius growth rate → ~72s from bare stone to full

// Milestone rewards. Reclaiming compounds: wider discs and quicker sieges, so
// the light gains on a horde whose intel only ever rises. Indexed by claim tier
// (0 = under 1% reclaimed, 4 = 25%+).
const RADIUS_BY_TIER = [24, 28, 28, 32, 32];
const SECS_BY_TIER   = [3, 3, 2.6, 2.6, 2.2];
const tierIdx = () => Math.min(claim.claimTier(), RADIUS_BY_TIER.length - 1);
export const maxRadius   = () => RADIUS_BY_TIER[tierIdx()];
export const secsPerBlock = () => SECS_BY_TIER[tierIdx()];

// key "x,y,z" -> {x,y,z, radius, socketed, mesh}
const stones = new Map();
const key = (x,y,z) => wrapC(x)+','+y+','+wrapC(z);

export const get = (x,y,z) => stones.get(key(x,y,z)) || null;
export const all = () => [...stones.values()];
export const activeStone = () => [...stones.values()].find(s => s.socketed) || null;
/** True while a Cube is seated and still working — the horde reads this. */
export const sieging = () => { const s = activeStone(); return !!(s && !isDone(s)); };

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
  if(!s.target) s.target = maxRadius(); // locked in at the moment of seating
  makeMesh(s);
  return true;
}

/** Pull the Cube back out. Returns false if this stone doesn't have it. */
export function unsocket(x, y, z){
  const s = get(x,y,z);
  if(!s || !s.socketed) return false;
  s.socketed = false;
  dropMesh(s);
  // Spent stone + Cube withdrawn = the reliquary surfaces.
  if(isDone(s)) offerReward(s);
  return true;
}

/** A stone's target is fixed when the Cube is seated, so a later milestone
 *  never retroactively un-finishes a disc that already went dormant. */
export const targetRadius = s => s.target || MAX_RADIUS;
export const isDone = s => s.radius >= targetRadius(s);

/**
 * Re-mesh only the chunks the disc newly reached, so the warm claimed skin
 * appears as the ring sweeps outward. Rebuilding the whole disc every step
 * would re-run buildChunk on the same inner chunks ~24 times per siege.
 */
/**
 * Queue remesh for chunks that intersect the NEW ring only (prevR → newR).
 * Full-disc rebuild every step was O(r²) and hitchy on mobile. Inner chunks
 * already carry correct claim skins from earlier steps; only the expanding
 * annulus gains new claimed cells.
 * Work is drained by flushRemeshQueue() each frame (budgeted).
 */
function remeshRing(s, newR, prevR){
  const outer = Math.ceil(newR);
  const inner = Math.max(0, Math.floor(prevR || 0) - 1); // slight overlap
  const seen = new Set();
  for(let dz = -outer; dz <= outer; dz++){
    for(let dx = -outer; dx <= outer; dx++){
      const d2 = dx*dx + dz*dz;
      if(d2 > newR*newR) continue;
      if(d2 < inner*inner) continue;
      const wx = wrapC(s.x + dx), wz = wrapC(s.z + dz);
      const k = (wx >> 4) + ',' + (wz >> 4);
      if(seen.has(k)) continue;
      seen.add(k);
      queueChunkRemesh(wx, wz);
    }
  }
}

// ---- visuals ---------------------------------------------------------------
function makeMesh(s){
  if(s.mesh) return;
  // The seated Cube is the same model as the loose one, riding the cradle, plus
  // a real light so a working Keepstone is visible across the dark.
  // Seated at +0.38, INSIDE the pedestal's own block cell. It used to ride at
  // +1.0, a full block up in empty air — so a player aiming at the glowing Cube
  // (the obvious target) shot straight through it and could neither click the
  // stone to take the Cube back nor mine it. The artefact must sit in the cradle.
  const m = makeElderCubeMesh(.38);
  m.position.set(s.x, s.y + 0.50, s.z);
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

// ---- reliquary --------------------------------------------------------------
// A stone that finished its work and gave the Cube back leaves a gift: a small
// chest hovering over the empty cradle, holding salvage and a False Cube.
export const hasReward = s => !!s.reward;
export function offerReward(s){
  if(s.reward || s.rewardTaken) return;
  s.reward = makeReliquaryMesh();
  s.reward.position.set(s.x, s.y + 0.95, s.z);
  scene.add(s.reward);
}
// ---- False Cube lamp --------------------------------------------------------
// A spent Keepstone can hold a False Cube. It claims nothing — the ground is
// already permanent — but it burns, turning a dormant stone into a fixed lamp.
export const isLamp = s => !!s.lamp;
export function lightLamp(s){
  if(s.lampMesh) return;
  const m = makeElderCubeMesh(.30);
  m.position.set(s.x, s.y + 0.50, s.z);
  m.traverse(o=>{ if(o.material?.color) o.material = o.material.clone(); });
  m.traverse(o=>{ o.material?.color?.offsetHSL?.(0, -0.25, 0); });
  m.add(new THREE.PointLight(0xffd9a0, 1.2, 12));
  s.lamp = true;
  s.lampMesh = m;
  scene.add(m);
}
export function seatFalseCube(x, y, z){
  const s = get(x,y,z);
  if(!s || s.lamp || s.socketed) return false;
  lightLamp(s);
  return true;
}

export function takeReward(x, y, z){
  const s = get(x,y,z);
  if(!s || !s.reward) return false;
  scene.remove(s.reward);
  s.reward = null;
  s.rewardTaken = true;
  return true;
}

// ---- tick ------------------------------------------------------------------
/**
 * Grow the active stone's disc. `onFull` fires once when a stone tops out.
 * px/pz are the player position, used only to keep the floating Cube drawn on
 * the correct side of the toroidal seam.
 */
export function tick(dt, px, pz, onFull){
  // Tell claim.js which ground is still being fought over, so the spawn gate
  // keeps letting the horde in until this stone actually finishes.
  const act = activeStone();
  claim.setSiegeZone(act && !isDone(act) ? {x:act.x, z:act.z, r:targetRadius(act)} : null);
  for(const s of stones.values()){
    if(s.reward){
      s.reward.rotation.y += dt * 0.7;
      const ry = s.y + 0.95 + Math.sin(performance.now() / 520) * 0.05;
      placeWrapped(s.reward, s.x, ry, s.z, px, pz);
    }
    if(s.lampMesh){
      s.lampMesh.rotation.y += dt * 0.5;
      placeWrapped(s.lampMesh, s.x, s.y + 0.50, s.z, px, pz);
    }
    if(s.mesh){
      s.mesh.rotation.y += dt * 1.1;
      s.mesh.position.y = s.y + 0.50 + Math.sin(performance.now() / 600) * 0.03;
      placeWrapped(s.mesh, s.x, s.mesh.position.y, s.z, px, pz);
    }
    if(!s.socketed || isDone(s)) continue;
    const prev = s.radius;
    const tgt = targetRadius(s);
    s.radius = Math.min(tgt, s.radius + dt / secsPerBlock());
    if(Math.floor(s.radius) > Math.floor(prev)){
      claim.claimDisc(s.x, s.z, s.radius);
      remeshRing(s, s.radius, prev);
    }
    if(isDone(s) && prev < tgt){
      claim.claimDisc(s.x, s.z, tgt); // make sure the rim is filled
      remeshRing(s, tgt, prev);
      onFull?.(s);
    }
  }
  // Drain budgeted chunk rebuilds every frame (siege tint catch-up)
  flushRemeshQueue();
}

// ---- save / restore --------------------------------------------------------
export function serialize(){
  const out = [...stones.values()].map(s =>
    [s.x, s.y, s.z, +s.radius.toFixed(2), s.socketed?1:0, s.target || MAX_RADIUS,
     s.reward?1:0, s.rewardTaken?1:0, s.lamp?1:0]);
  return out.length ? out : null;
}
export function restore(arr){
  for(const s of stones.values()) dropMesh(s);
  stones.clear();
  if(!Array.isArray(arr)) return;
  for(const [x,y,z,r,sock,tgt,rew,rewT,lamp] of arr){
    // Older saves have no target — fall back to the tier-0 reach they were built with.
    const s = {x:wrapC(x), y, z:wrapC(z), radius:r||0, socketed:!!sock, target:tgt || MAX_RADIUS,
               rewardTaken:!!rewT, lamp:!!lamp, mesh:null, reward:null};
    stones.set(key(x,y,z), s);
    if(s.socketed) makeMesh(s);
    if(rew) offerReward(s);
    if(s.lamp) lightLamp(s);
  }
}
export function clear(){
  for(const s of stones.values()){
    dropMesh(s);
    if(s.reward){ scene.remove(s.reward); s.reward = null; }
    if(s.lampMesh){ scene.remove(s.lampMesh); s.lampMesh = null; }
  }
  stones.clear();
  claim.setSiegeZone(null);
}

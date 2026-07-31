// drops.js — ground item entities: drop with Q, walk over to pick up
import { WORLD, wrapC, topY, getBlock } from './world.js';
import { scene, makeBlockCube, makeHeldItemIcon, TYPES, ITEMS, spawnParticles } from './render.js';
import { inventory, addToInventory, renderHotbar, hotbarSlots, sel, renderInv, invOpen } from './ui.js';
import { gm } from './mode.js';
import { sfx } from './audio.js';

const drops = new Map(); // id -> {id, item, n, mesh, x,y,z, bob}
let nextId = 1;
let authority = true;

export function init(isAuthority){
  authority = isAuthority;
  for(const id of [...drops.keys()]) remove(id, false);
  nextId = 1;
}

function makeMesh(itemId){
  const g = new THREE.Group();
  if(itemId < 100 && TYPES[itemId]){
    const m = makeBlockCube(itemId, 0.28);
    g.add(m);
  } else {
    const m = makeHeldItemIcon(itemId, 0.36);
    g.add(m);
  }
  return g;
}

function floorY(x, yFrom, z){
  for(let y = Math.min(47, Math.floor(yFrom)); y >= 0; y--){
    if(getBlock(Math.round(x), y, Math.round(z))) return y + 1;
  }
  return 0;
}

export function spawn(itemId, n, x, y, z, id){
  if(n <= 0) return null;
  const did = id ?? nextId++;
  if(id != null) nextId = Math.max(nextId, id + 1);
  const mesh = makeMesh(itemId);
  const fy = floorY(x, y + 1, z);
  const yy = Math.max(fy, y - 0.2);
  mesh.position.set(x, yy + 0.2, z);
  scene.add(mesh);
  const d = {id: did, item: itemId, n: n|0, mesh, x, y: yy + 0.2, z, bob: Math.random() * 10, age: 0, grace: 1.6};
  drops.set(did, d);
  return d;
}

function remove(id, poof=true){
  const d = drops.get(id);
  if(!d) return;
  if(poof) spawnParticles(d.x, d.y, d.z, TYPES[d.item]?.pc ?? 0xffffff, 6);
  scene.remove(d.mesh);
  drops.delete(id);
}

/** Local player drops 1 of currently held non-tool item. Returns drop payload or null. */
export function tryDropFromHotbar(playerPos, yaw){
  if(gm.forge) return null; // infinite creative — dropping is meaningless
  const s = hotbarSlots[sel.slot];
  if(!s || s.k === 't') return null;
  const itemId = s.id;
  if(!(inventory[itemId] > 0)) return null;
  inventory[itemId]--;
  if(inventory[itemId] <= 0){
    delete inventory[itemId];
    // clear hotbar slot if empty
    hotbarSlots[sel.slot] = null;
  }
  renderHotbar();
  if(invOpen) renderInv();
  sfx.place();

  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const x = playerPos.x + fwd.x * 2.4;
  const z = playerPos.z + fwd.z * 2.4;
  const y = playerPos.y + 1.0;
  const d = spawn(itemId, 1, x, y, z);
  spawnParticles(x, y, z, TYPES[itemId]?.pc ?? 0xffffff, 4);
  return d ? {id: d.id, item: d.item, n: d.n, x: d.x, y: d.y, z: d.z} : null;
}

export function serialize(){
  return [...drops.values()].map(d => [
    d.id, d.item, d.n,
    +d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2),
  ]);
}

export function applyRemote(list){
  const seen = new Set();
  for(const [id, item, n, x, y, z] of list){
    seen.add(id);
    let d = drops.get(id);
    if(!d){
      spawn(item, n, x, y, z, id);
    } else {
      d.item = item; d.n = n;
      d.x = x; d.y = y; d.z = z;
      d.mesh.position.set(x, y, z);
    }
  }
  for(const id of [...drops.keys()]) if(!seen.has(id)) remove(id, false);
}

/** Host/solo: try pick up nearest drop for a player. Returns {item,n,id} or null. */
export function tryPickup(px, py, pz){
  let best = null, bestD = 1.35;
  for(const d of drops.values()){
    if((d.grace||0) > 0) continue; // just dropped — don't instant re-pickup
    const dx = d.x - px, dy = d.y - py, dz = d.z - pz;
    // wrap xz lightly not needed for short range
    let wx = dx, wz = dz;
    if(Math.abs(wx) > WORLD/2) wx -= Math.sign(wx) * WORLD;
    if(Math.abs(wz) > WORLD/2) wz -= Math.sign(wz) * WORLD;
    const dist = Math.hypot(wx, wz);
    if(dist < bestD && Math.abs(dy) < 2.2){
      bestD = dist; best = d;
    }
  }
  if(!best) return null;
  const out = {id: best.id, item: best.item, n: best.n};
  remove(best.id, true);
  return out;
}

export function removeById(id){
  remove(id, true);
}

export function commonTick(dt, time, playerPos){
  for(const d of drops.values()){
    d.age += dt;
    if(d.grace > 0) d.grace -= dt;
    d.bob += dt;
    // settle onto floor if support changed
    const fy = floorY(d.x, d.y + 2, d.z);
    const targetY = fy + 0.2;
    d.y += (targetY - d.y) * Math.min(1, dt * 8);
    d.mesh.position.y = d.y + Math.sin(d.bob * 3) * 0.06;
    d.mesh.position.x = d.x;
    d.mesh.position.z = d.z;
    d.mesh.rotation.y = time * 1.5;
    const dist = Math.hypot(d.x - playerPos.x, d.z - playerPos.z);
    d.mesh.visible = dist < 80;
  }
}

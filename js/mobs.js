// mobs.js — night zombies. Host (or solo) simulates; clients render what the host says.
import { WORLD, topY } from './world.js';
import { scene, makeCharacter, ZOMBIE_SKIN, spawnParticles, VIEW } from './render.js';
import { sfx } from './audio.js';

export const zombies = new Map(); // id -> zombie
let authority = true, nextId = 1, spawnT = 3, groanT = 2;
const MAX_Z = 8;

function makeZombieMesh(){
  const c = makeCharacter(ZOMBIE_SKIN, true);
  c.armL.rotation.x = -1.35; // classic arms-out pose
  c.armR.rotation.x = -1.35;
  return c;
}
function create(x,y,z){
  const c = makeZombieMesh();
  c.g.position.set(x,y,z);
  scene.add(c.g);
  const zb = {id:nextId++, c, yaw:Math.random()*Math.PI*2, hp:6, atkCd:0, tgt:null, phase:Math.random()*9};
  zombies.set(zb.id, zb);
  return zb;
}
function remove(id, poof=true){
  const zb = zombies.get(id);
  if(!zb) return;
  if(poof) spawnParticles(zb.c.g.position.x, zb.c.g.position.y+1, zb.c.g.position.z, 0x57a05a, 14);
  scene.remove(zb.c.g);
  zombies.delete(id);
}
export function init(isAuthority){
  authority = isAuthority;
  for(const id of [...zombies.keys()]) remove(id, false);
}

// Host: apply a hit. Returns 'killed' | 'hit' | null
export function hit(id, dmg){
  const zb = zombies.get(id);
  if(!zb) return null;
  zb.hp -= dmg;
  sfx.zgroan();
  spawnParticles(zb.c.g.position.x, zb.c.g.position.y+1, zb.c.g.position.z, 0x8b2b2b, 6);
  if(zb.hp<=0){ remove(id); return 'killed'; }
  // knockback: shove away, briefly stunned
  zb.atkCd = Math.max(zb.atkCd, .6);
  return 'hit';
}

// Host tick. targets: [{id, x, y, z}] (id 'me' = the host player). Returns hurt events.
export function hostTick(dt, dl, targets){
  const hurts = [];
  if(!authority) return hurts;
  const night = dl < .12;

  if(night && zombies.size < MAX_Z && targets.length){
    spawnT -= dt;
    if(spawnT<=0){
      spawnT = 3.5;
      const t = targets[Math.floor(Math.random()*targets.length)];
      const a = Math.random()*Math.PI*2, r = 16+Math.random()*14;
      const x = t.x+Math.cos(a)*r, z = t.z+Math.sin(a)*r;
      const gy = topY(Math.round(x), Math.round(z));
      if(gy>0) create(x, gy+.5, z);
    }
  }
  if(!night && zombies.size){
    // daylight burns them away
    for(const id of [...zombies.keys()]) remove(id);
    return hurts;
  }

  for(const zb of zombies.values()){
    const p = zb.c.g.position;
    zb.atkCd = Math.max(0, zb.atkCd - dt);
    // nearest target
    let best = null, bestD = 28;
    for(const t of targets){
      const d = Math.hypot(t.x-p.x, t.z-p.z);
      if(d<bestD){ bestD=d; best=t; }
    }
    let speed = 1.0;
    if(best){
      zb.yaw = Math.atan2(best.z-p.z, best.x-p.x);
      speed = 1.7;
      if(bestD < 1.35 && zb.atkCd<=0){
        zb.atkCd = 1.1;
        hurts.push({id:best.id, dmg:3});
      }
    } else if(Math.random()<dt*.4){
      zb.yaw += (Math.random()-.5)*2;
    }
    // move with 1-block step-up, same as animals
    const nx = p.x + Math.cos(zb.yaw)*speed*dt;
    const nz = p.z + Math.sin(zb.yaw)*speed*dt;
    const gy = topY(Math.round(nx), Math.round(nz));
    const cy = Math.round(p.y-.5);
    if(gy<0 || gy-cy>1){ zb.yaw += Math.PI/2 + Math.random(); continue; }
    p.x = nx; p.z = nz;
    if(p.x < -0.5) p.x += WORLD; if(p.x >= WORLD-0.5) p.x -= WORLD;
    if(p.z < -0.5) p.z += WORLD; if(p.z >= WORLD-0.5) p.z -= WORLD;
    p.y += ((gy+.5) - p.y)*Math.min(1, dt*10);
    zb.c.g.rotation.y = -zb.yaw + Math.PI/2;
  }
  return hurts;
}

// Client: reconcile against host's list
export function applyRemote(list){
  const seen = new Set();
  for(const [id,x,y,z,ry] of list){
    seen.add(id);
    let zb = zombies.get(id);
    if(!zb){
      const c = makeZombieMesh();
      c.g.position.set(x,y,z);
      scene.add(c.g);
      zb = {id, c, tgt:null, phase:Math.random()*9};
      zombies.set(id, zb);
    }
    zb.tgt = {x,y,z,ry};
  }
  for(const id of [...zombies.keys()]) if(!seen.has(id)) remove(id);
}
export function serialize(){
  return [...zombies.values()].map(zb=>[
    zb.id,
    +zb.c.g.position.x.toFixed(1), +zb.c.g.position.y.toFixed(1), +zb.c.g.position.z.toFixed(1),
    +zb.c.g.rotation.y.toFixed(2),
  ]);
}

// Runs on everyone: lerp (clients), leg animation, ambient groans
const shortest = d => { if(d > WORLD/2) d -= WORLD; if(d < -WORLD/2) d += WORLD; return d; };
export function commonTick(dt, time, playerPos){
  groanT -= dt;
  for(const zb of zombies.values()){
    const p = zb.c.g.position;
    if(!authority && zb.tgt){
      p.x += shortest(zb.tgt.x-p.x)*Math.min(1,dt*8);
      p.y += (zb.tgt.y-p.y)*Math.min(1,dt*8);
      p.z += shortest(zb.tgt.z-p.z)*Math.min(1,dt*8);
      zb.c.g.rotation.y = zb.tgt.ry;
    }
    const sw = Math.sin(time*7 + zb.phase)*.45;
    zb.c.legL.rotation.x = sw; zb.c.legR.rotation.x = -sw;
    const d = Math.hypot(p.x-playerPos.x, p.z-playerPos.z);
    zb.c.g.visible = d < VIEW;
    if(groanT<=0 && d<11 && Math.random()<.5){ sfx.zgroan(); groanT = 3+Math.random()*4; }
  }
  if(groanT<=0) groanT = 2;
}

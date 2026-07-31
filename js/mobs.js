// mobs.js — the horde. Host-authoritative zombies with a shared intelligence tier.
// T0 shamblers · T1 fast + packs · T2 dig soft blocks · T3 hide from the sun (hunt them by day!)
import { WORLD, topY, getBlock } from './world.js';
import { scene, makeCharacter, ZOMBIE_SKIN, spawnParticles, VIEW, nearestTorchDist, box } from './render.js';
import { sfx } from './audio.js';
import { gm } from './mode.js';

export const zombies = new Map(); // id -> zombie
export const corpses = new Map(); // id -> {mesh, x,y,z, feed}
let authority = true, nextId = 1, nextCorpse = 1, spawnT = 3, groanT = 2;
let intel = 0, killCount = 0;
let announcer = null; // (text, newIntel) => void
const EYE_COLORS = [0x3a3a3a, 0xd8c33a, 0xe07b2a, 0xd23434];
const SOFT = new Set([1,2,5,6,12,19,28,29,30,31,32]); // what T2 can dig through
const maxZombies = ()=>8 + intel*2;

export const getIntel = ()=>intel;
export function setAnnouncer(fn){ announcer = fn; }
const TIER_MSG = [
  null,
  '🧟 The horde has fed… they move faster now, and come in packs.',
  '🧟 The horde grows cunning — they can DIG through soft blocks! Build with stone.',
  '🧟 The horde has learned to survive the sun. Hunt the hiders by day!',
];
function intelUp(){
  if(intel>=3) return;
  intel++;
  announcer?.(TIER_MSG[intel], intel);
  refreshEyes();
}
function intelDown(){
  if(intel<=0) return;
  intel--;
  announcer?.(`⚔️ The horde weakens. (Tier ${intel})`, intel);
  refreshEyes();
}
export function setIntel(n){ // clients follow the host
  if(n===intel) return;
  intel = n;
  refreshEyes();
}
function refreshEyes(){
  for(const zb of zombies.values()) zb.eyes.forEach(m=>m.color.setHex(EYE_COLORS[intel]));
}

// ---- meshes ----
function makeZombieMesh(){
  const c = makeCharacter(ZOMBIE_SKIN, true);
  c.armL.rotation.x = -1.35;
  c.armR.rotation.x = -1.35;
  // glowing eyes show the horde's tier
  const eyes = [];
  for(const ex of [-.1,.1]){
    const e = new THREE.Mesh(new THREE.BoxGeometry(.08,.05,.02), new THREE.MeshBasicMaterial({color:EYE_COLORS[intel]}));
    e.position.set(ex,.02,.23);
    c.head.add(e);
    eyes.push(e.material);
  }
  return {c, eyes};
}
function makeCorpseMesh(x,y,z){
  const g = new THREE.Group();
  g.add(box(.85,.22,.5, 0x5a4a3a, 0,.11,0));
  const b = box(.42,.1,.1, 0xe8e2d0, 0,.26,0); b.rotation.y=.6; g.add(b);
  g.add(box(.1,.1,.28, 0xe8e2d0, .18,.24,.05));
  g.position.set(x,y,z);
  return g;
}

function create(x,y,z){
  const {c, eyes} = makeZombieMesh();
  c.g.position.set(x,y,z);
  scene.add(c.g);
  const zb = {id:nextId++, c, eyes, yaw:Math.random()*Math.PI*2, hp:6+(intel>=3?2:0),
              atkCd:0, dig:null, dormant:false, phase:Math.random()*9, tgt:null};
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
  intel = 0; killCount = 0;
  for(const id of [...zombies.keys()]) remove(id, false);
  for(const id of [...corpses.keys()]) removeCorpse(id, false);
}

// ---- corpses: fallen players feed the horde ----
export function addCorpse(x,y,z){
  const gy = topY(Math.round(x), Math.round(z));
  const cy = gy>0 ? gy+.5 : y;
  const mesh = makeCorpseMesh(x, cy, z);
  scene.add(mesh);
  corpses.set(nextCorpse, {mesh, x, y:cy, z, feed:0});
  return nextCorpse++;
}
function removeCorpse(id, poof=true){
  const c = corpses.get(id);
  if(!c) return;
  if(poof) spawnParticles(c.x, c.y+.4, c.z, 0xe8e2d0, 10);
  scene.remove(c.mesh);
  corpses.delete(id);
}
// A player punched a corpse — recovered before the horde could feed
export function recoverCorpse(id){
  if(!corpses.has(id)) return false;
  removeCorpse(id);
  return true;
}

// ---- combat ----
export function hit(id, dmg){
  const zb = zombies.get(id);
  if(!zb) return null;
  zb.hp -= dmg;
  sfx.zgroan();
  spawnParticles(zb.c.g.position.x, zb.c.g.position.y+1, zb.c.g.position.z, 0x8b2b2b, 6);
  if(zb.hp<=0){
    const wasDormant = zb.dormant;
    remove(id);
    killCount += wasDormant ? 3 : 1; // day-hunting hiders drains the horde faster
    if(killCount>=10){ killCount-=10; intelDown(); }
    return wasDormant ? 'killed_dormant' : 'killed';
  }
  zb.atkCd = Math.max(zb.atkCd, .6);
  if(zb.dormant){ zb.dormant = false; } // waking a hider the hard way
  return 'hit';
}

// ---- host simulation ----
export function hostTick(dt, dl, targets){
  const hurts = [], digs = [];
  if(!authority) return {hurts, digs};
  if(gm.forge){
    for(const id of [...zombies.keys()]) remove(id, false);
    for(const id of [...corpses.keys()]) removeCorpse(id, false);
    return {hurts, digs};
  }
  const night = dl < .12;

  // spawning (packs at higher tiers, never near light)
  if(night && zombies.size < maxZombies() && targets.length){
    spawnT -= dt;
    if(spawnT<=0){
      spawnT = intel>=1 ? 2.6 : 3.5;
      const t = targets[Math.floor(Math.random()*targets.length)];
      const pack = intel>=3 ? 3 : intel>=1 ? 2 : 1;
      for(let i=0;i<pack && zombies.size<maxZombies();i++){
        const a = Math.random()*Math.PI*2, r = 16+Math.random()*14;
        const x = t.x+Math.cos(a)*r, z = t.z+Math.sin(a)*r;
        const gy = topY(Math.round(x), Math.round(z));
        if(gy>0 && nearestTorchDist(x,z) > 10) create(x, gy+.5, z);
      }
    }
  }

  // daylight: burn — unless the horde has learned to hide (T3)
  if(!night && zombies.size){
    if(intel>=3){
      for(const zb of zombies.values()){
        if(!zb.dormant){
          zb.dormant = true;
          zb.dig = null;
          const p = zb.c.g.position;
          const gy = topY(Math.round(p.x), Math.round(p.z));
          if(gy>0) p.y = gy+.5-.55; // half-buried
        }
      }
    } else {
      for(const id of [...zombies.keys()]) remove(id);
      return {hurts, digs};
    }
  }

  const speed = intel>=1 ? 2.1 : 1.7;
  for(const zb of zombies.values()){
    const p = zb.c.g.position;
    zb.atkCd = Math.max(0, zb.atkCd - dt);

    if(zb.dormant){
      if(night){ // wake up
        zb.dormant = false;
        const gy = topY(Math.round(p.x), Math.round(p.z));
        if(gy>0) p.y = gy+.5;
      } else continue;
    }

    // digging through a wall (T2+)
    if(zb.dig){
      zb.dig.t += dt;
      if(zb.dig.t > .3 && Math.random()<dt*6) spawnParticles(zb.dig.x, zb.dig.y, zb.dig.z, 0x8a6a4a, 2);
      if(zb.dig.t >= 2){
        digs.push({x:zb.dig.x, y:zb.dig.y, z:zb.dig.z});
        zb.dig = null;
      }
      continue;
    }

    // choose target: nearest player, or an unattended corpse
    let best = null, bestD = 28, isCorpse = false;
    for(const t of targets){
      const d = Math.hypot(t.x-p.x, t.z-p.z);
      if(d<bestD){ bestD=d; best=t; }
    }
    if((!best || bestD>10) && corpses.size){
      for(const [cid,c] of corpses){
        const d = Math.hypot(c.x-p.x, c.z-p.z);
        if(d<40 && (!best || d<bestD)){ best={x:c.x, z:c.z, corpse:cid}; bestD=d; isCorpse=true; }
      }
    }

    let sp = 1.0;
    if(best){
      zb.yaw = Math.atan2(best.z-p.z, best.x-p.x);
      sp = speed;
      if(isCorpse && bestD < 1.3){
        // feeding
        const c = corpses.get(best.corpse);
        if(c){
          c.feed += dt;
          if(Math.random()<dt*3) spawnParticles(c.x, c.y+.3, c.z, 0x8b2b2b, 2);
          if(c.feed >= 6){ removeCorpse(best.corpse); intelUp(); }
        }
        continue;
      }
      if(!isCorpse && bestD < 1.35 && zb.atkCd<=0){
        zb.atkCd = 1.1;
        hurts.push({id:best.id, dmg:3});
      }
    } else if(Math.random()<dt*.4){
      zb.yaw += (Math.random()-.5)*2;
    }

    // move with step-up; T2 digs what blocks it
    const nx = p.x + Math.cos(zb.yaw)*sp*dt;
    const nz = p.z + Math.sin(zb.yaw)*sp*dt;
    const gy = topY(Math.round(nx), Math.round(nz));
    const cy = Math.round(p.y-.5);
    if(gy<0 || gy-cy>1){
      if(intel>=2 && best && !isCorpse && bestD<14){
        const bx = Math.round(nx), bz = Math.round(nz);
        for(let by=cy+1; by<=Math.min(cy+2, gy); by++){
          const bt = getBlock(bx,by,bz);
          if(bt && SOFT.has(bt)){ zb.dig = {x:bx,y:by,z:bz,t:0}; break; }
        }
      }
      if(!zb.dig) zb.yaw += Math.PI/2 + Math.random();
      continue;
    }
    p.x = nx; p.z = nz;
    if(p.x < -0.5) p.x += WORLD; if(p.x >= WORLD-0.5) p.x -= WORLD;
    if(p.z < -0.5) p.z += WORLD; if(p.z >= WORLD-0.5) p.z -= WORLD;
    p.y += ((gy+.5) - p.y)*Math.min(1, dt*10);
    zb.c.g.rotation.y = -zb.yaw + Math.PI/2;
  }
  return {hurts, digs};
}

// ---- sync ----
export function serialize(){
  return [...zombies.values()].map(zb=>[
    zb.id,
    +zb.c.g.position.x.toFixed(1), +zb.c.g.position.y.toFixed(1), +zb.c.g.position.z.toFixed(1),
    +zb.c.g.rotation.y.toFixed(2), zb.dormant?1:0,
  ]);
}
export function serializeCorpses(){
  return [...corpses.entries()].map(([id,c])=>[id, +c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)]);
}
export function applyRemote(list){
  const seen = new Set();
  for(const [id,x,y,z,ry,dorm] of list){
    seen.add(id);
    let zb = zombies.get(id);
    if(!zb){
      const {c, eyes} = makeZombieMesh();
      c.g.position.set(x,y,z);
      scene.add(c.g);
      zb = {id, c, eyes, tgt:null, dormant:false, phase:Math.random()*9};
      zombies.set(id, zb);
    }
    zb.tgt = {x,y,z,ry};
    zb.dormant = dorm===1;
  }
  for(const id of [...zombies.keys()]) if(!seen.has(id)) remove(id);
}
export function applyCorpses(list){
  const seen = new Set();
  for(const [id,x,y,z] of list){
    seen.add(id);
    if(!corpses.has(id)){
      const mesh = makeCorpseMesh(x,y,z);
      scene.add(mesh);
      corpses.set(id, {mesh, x, y, z, feed:0});
    }
  }
  for(const id of [...corpses.keys()]) if(!seen.has(id)) removeCorpse(id);
}

// ---- everyone: lerp, pose, groans, hider tells ----
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
    const d = Math.hypot(p.x-playerPos.x, p.z-playerPos.z);
    zb.c.g.visible = d < VIEW;
    if(zb.dormant){
      // hiders: arms slack, still legs, breadcrumb dust + close-range groans
      zb.c.armL.rotation.x += (0 - zb.c.armL.rotation.x)*dt*4;
      zb.c.armR.rotation.x += (0 - zb.c.armR.rotation.x)*dt*4;
      zb.c.legL.rotation.x *= .9; zb.c.legR.rotation.x *= .9;
      if(d<20 && Math.random()<dt*.35) spawnParticles(p.x, p.y+.2, p.z, 0x8a6a4a, 1);
      if(groanT<=0 && d<8){ sfx.zgroan(); groanT = 2.5+Math.random()*3; }
      continue;
    }
    zb.c.armL.rotation.x += (-1.35 - zb.c.armL.rotation.x)*dt*5;
    zb.c.armR.rotation.x += (-1.35 - zb.c.armR.rotation.x)*dt*5;
    const sw = Math.sin(time*7 + zb.phase)*.45;
    zb.c.legL.rotation.x = sw; zb.c.legR.rotation.x = -sw;
    if(groanT<=0 && d<11 && Math.random()<.5){ sfx.zgroan(); groanT = 3+Math.random()*4; }
  }
  if(groanT<=0) groanT = 2;
}

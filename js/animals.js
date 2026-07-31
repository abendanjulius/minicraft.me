// animals.js — blocky wildlife. Host (or solo) runs the AI; clients render what the host says.
import { WORLD, CENTER, topY, mulberry32 } from './world.js';
import { scene, box, VIEW, spawnParticles } from './render.js';

const KINDS = ['pig','sheep','chicken'];
export const animals = [];
let authority = true;

function makeAnimal(kind,x,z){
  const g = new THREE.Group();
  let legs = [];
  if(kind==='pig'){
    g.add(box(.9,.55,.55,0xe8a2b0,0,.65,0));
    const head = box(.45,.45,.45,0xe8a2b0,.62,.72,0); g.add(head);
    head.add(box(.18,.14,.08,0xd9899b,.24,-.05,0));
    for(const [lx,lz] of [[.3,.18],[.3,-.18],[-.3,.18],[-.3,-.18]]){
      const l = box(.16,.4,.16,0xd08a98,lx,.2,lz); legs.push(l); g.add(l);
    }
  } else if(kind==='sheep'){
    g.add(box(.95,.6,.6,0xececec,0,.75,0));
    g.add(box(.35,.35,.3,0xd8c8b8,.6,.85,0));
    for(const [lx,lz] of [[.3,.18],[.3,-.18],[-.3,.18],[-.3,-.18]]){
      const l = box(.15,.45,.15,0xcfc4b4,lx,.22,lz); legs.push(l); g.add(l);
    }
  } else {
    g.add(box(.6,.5,.45,0xf5f5f0,0,.55,0));
    const head = box(.28,.35,.28,0xf5f5f0,.35,.85,0); g.add(head);
    head.add(box(.14,.08,.1,0xe8b03a,.2,-.02,0));
    head.add(box(.08,.1,.08,0xc0392b,.06,-.22,0));
    for(const [lx,lz] of [[.12,.1],[.12,-.1]]){
      const l = box(.08,.35,.08,0xe8b03a,lx,.15,lz); legs.push(l); g.add(l);
    }
    g.scale.setScalar(.6);
  }
  const gy = topY(Math.round(x),Math.round(z));
  g.position.set(x, gy+0.5, z);
  scene.add(g);
  animals.push({g, legs, kind, yaw:0, speed:kind==='chicken'?1:1.4, mode:'idle',
                timer:1, phase:Math.random()*10, tgt:null,
                hp:4, alive:true, respawnT:0, fleeT:0});
}

const DROPS = {pig:101, sheep:102, chicken:103}; // food item ids
// Host: apply a hit to animal idx. Returns dropped item id if it died, else null.
export function hit(idx, dmg, fromPos){
  const a = animals[idx];
  if(!a || !a.alive) return null;
  a.hp -= dmg;
  spawnParticles(a.g.position.x, a.g.position.y+.5, a.g.position.z, 0x8b2b2b, 6);
  if(a.hp<=0){
    a.alive = false;
    a.g.visible = false;
    a.respawnT = 60;
    spawnParticles(a.g.position.x, a.g.position.y+.5, a.g.position.z, 0xdddddd, 12);
    return DROPS[a.kind];
  }
  // flee from the attacker
  if(fromPos) a.yaw = Math.atan2(a.g.position.z-fromPos.z, a.g.position.x-fromPos.x);
  a.mode = 'walk'; a.fleeT = 2; a.timer = 2.5;
  return null;
}

export function init(isAuthority, seed){
  authority = isAuthority;
  for(const a of animals) scene.remove(a.g);
  animals.length = 0;
  const rng = mulberry32(seed ^ 0x9e3779b9); // same seed => same herd on every device
  for(let i=0;i<30;i++){
    const ang = rng()*Math.PI*2, r = 10+rng()*80;
    const x = CENTER+Math.cos(ang)*r, z = CENTER+Math.sin(ang)*r;
    if(topY(Math.round(x),Math.round(z))>0) makeAnimal(KINDS[i%3], x, z);
  }
  for(const a of animals){ a.yaw = rng()*Math.PI*2; a.timer = 1+rng()*3; }
}

export function update(dt, time, playerPos){
  for(const a of animals){
    // Host respawns dead animals after a while
    if(authority && !a.alive){
      a.respawnT -= dt;
      if(a.respawnT<=0){
        const gx = Math.round(CENTER+(Math.random()-.5)*160), gz = Math.round(CENTER+(Math.random()-.5)*160);
        const gy = topY(gx,gz);
        if(gy>0){ a.g.position.set(gx, gy+.5, gz); a.alive = true; a.hp = 4; a.g.visible = true; }
        else a.respawnT = 5;
      }
      continue;
    }
    if(!a.alive) continue;
    const ax = a.g.position.x-playerPos.x, az = a.g.position.z-playerPos.z;
    const far = ax*ax+az*az > VIEW*VIEW;
    a.g.visible = !far;

    if(!authority){
      // Client mode: glide toward the host's reported state
      if(a.tgt){
        a.g.visible = a.tgt.alive && !far;
        if(!a.tgt.alive) continue;
        a.g.position.x += (a.tgt.x - a.g.position.x)*Math.min(1,dt*8);
        a.g.position.y += (a.tgt.y - a.g.position.y)*Math.min(1,dt*8);
        a.g.position.z += (a.tgt.z - a.g.position.z)*Math.min(1,dt*8);
        a.g.rotation.y = a.tgt.ry;
        if(!far && a.tgt.m==='walk'){
          const sw = Math.sin(time*8 + a.phase)*.5;
          a.legs.forEach((l,i)=>l.rotation.z = i%2? sw : -sw);
        } else a.legs.forEach(l=>l.rotation.z*=.9);
      }
      continue;
    }
    if(far) continue; // authority skips AI for far animals

    a.fleeT = Math.max(0, a.fleeT - dt);
    a.timer -= dt;
    if(a.timer<=0){
      a.mode = Math.random()<.6 ? 'walk' : 'idle';
      a.yaw = Math.random()*Math.PI*2;
      a.timer = 1.5+Math.random()*3.5;
    }
    if(a.mode==='walk'){
      const sp = a.speed * (a.fleeT>0 ? 2.2 : 1);
      const nx = a.g.position.x + Math.cos(a.yaw)*sp*dt;
      const nz = a.g.position.z + Math.sin(a.yaw)*sp*dt;
      const gy = topY(Math.round(nx), Math.round(nz));
      const cy = Math.round(a.g.position.y-0.5);
      if(gy<0 || gy-cy>1){ a.yaw += Math.PI/2 + Math.random(); continue; }
      a.g.position.x = nx; a.g.position.z = nz;
      if(a.g.position.x < -0.5)       a.g.position.x += WORLD;
      if(a.g.position.x >= WORLD-0.5) a.g.position.x -= WORLD;
      if(a.g.position.z < -0.5)       a.g.position.z += WORLD;
      if(a.g.position.z >= WORLD-0.5) a.g.position.z -= WORLD;
      a.g.position.y += ((gy+0.5) - a.g.position.y)*Math.min(1,dt*10);
      a.g.rotation.y = -a.yaw;
      const sw = Math.sin(time*8 + a.phase)*.5;
      a.legs.forEach((l,i)=>l.rotation.z = i%2? sw : -sw);
    } else {
      a.legs.forEach(l=>l.rotation.z*=.9);
    }
  }
}

// Host → clients
export function serialize(){
  return animals.map(a=>[
    +a.g.position.x.toFixed(1), +a.g.position.y.toFixed(1), +a.g.position.z.toFixed(1),
    +a.g.rotation.y.toFixed(2), a.mode==='walk'?1:0, a.alive?1:0
  ]);
}
export function applyRemote(d){
  for(let i=0;i<d.length && i<animals.length;i++){
    const [x,y,z,ry,m,alive] = d[i];
    animals[i].tgt = {x,y,z,ry, m: m?'walk':'idle', alive:alive!==0};
  }
}

// keg.js — Powder Keg (explosive) + Spark Striker ignition
import { getBlock, setBlock, wrapC, WORLD, WH } from './world.js';
import { applyEdit, spawnParticles, TYPES, rebuildAt } from './render.js';
import { sfx } from './audio.js';
import * as survival from './survival.js';

const lit = new Map(); // "x,y,z" -> {t left, x,y,z}

export function isKeg(t){ return t===57; }

export function ignite(x,y,z){
  const k = wrapC(x)+','+y+','+wrapC(z);
  if(getBlock(x,y,z)!==57) return false;
  if(lit.has(k)) return false;
  lit.set(k, {t: 2.2, x:wrapC(x), y, z:wrapC(z)});
  sfx.craft(); // fizz-ish
  spawnParticles(x, y, z, 0xff6600, 12);
  return true;
}

export function tick(dt, playerPos, onBlast){
  for(const [k,e] of [...lit.entries()]){
    e.t -= dt;
    // fuse sparks
    if(Math.random()<dt*8) spawnParticles(e.x, e.y+.4, e.z, 0xffaa44, 2);
    if(e.t > 0) continue;
    lit.delete(k);
    explode(e.x, e.y, e.z, playerPos, onBlast);
  }
}

function explode(cx, cy, cz, playerPos, onBlast){
  sfx.break?.(3);
  sfx.hurt?.();
  spawnParticles(cx, cy, cz, 0xff4400, 40);
  spawnParticles(cx, cy, cz, 0xffcc00, 24);
  const R = 3;
  const edits = [];
  for(let dy=-R; dy<=R; dy++)
    for(let dx=-R; dx<=R; dx++)
      for(let dz=-R; dz<=R; dz++){
        if(dx*dx+dy*dy+dz*dz > R*R+1) continue;
        const x = cx+dx, y = cy+dy, z = cz+dz;
        if(y<1||y>=WH) continue;
        const t = getBlock(x,y,z);
        if(!t || t===57) continue; // bedrock-ish: keep y=0; remove keg
        // don't erase very hard blocks as much — still clear most
        if(t===23 && Math.random()<0.5) continue; // iron sometimes survives
        edits.push([wrapC(x),y,wrapC(z)]);
      }
  // always clear keg cell
  edits.push([cx,cy,cz]);
  for(const [x,y,z] of edits){
    setBlock(x,y,z,0);
    rebuildAt(x,z);
  }
  // damage player if close
  if(playerPos){
    let dx = playerPos.x-cx, dz = playerPos.z-cz;
    if(dx>WORLD/2) dx-=WORLD; if(dx<-WORLD/2) dx+=WORLD;
    if(dz>WORLD/2) dz-=WORLD; if(dz<-WORLD/2) dz+=WORLD;
    const dist = Math.hypot(dx, playerPos.y-cy, dz);
    if(dist < 5){
      const dmg = Math.max(1, Math.round(14 - dist*2.5));
      survival.damage(dmg, 'fall'); // reuse cause label; message generic
    }
  }
  onBlast?.(edits);
}

export function serializeLit(){
  return [...lit.values()].map(e => [e.x,e.y,e.z, +e.t.toFixed(2)]);
}
export function applyLit(list){
  lit.clear();
  for(const [x,y,z,t] of list||[]) lit.set(x+','+y+','+z, {x,y,z,t});
}

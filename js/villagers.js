// villagers.js — MiniCraft-unique village folk (not Minecraft clones)
import { villageSites, topY, surfaceY, feetY, WORLD, wrapC } from './world.js';
import { scene, box, VIEW, wrapShift, wrapDist } from './render.js';
import { addChat } from './ui.js';
import { addToInventory } from './ui.js';

export const villagers = [];
const spawnedKeys = new Set();

// Unique MiniCraft roles per village kind
const FOLK = {
  market: {
    title: 'Coin Market',
    roles: [
      { name: 'Ledger',  shirt:0xc9a227, pants:0x3a2a10, accent:0xffe08a, job:'tallies trades' },
      { name: 'Barter',  shirt:0xe8c547, pants:0x5c4010, accent:0xfff3c4, job:'haggles cheerfully' },
      { name: 'Scale',   shirt:0xb8860b, pants:0x2a2010, accent:0xd4af37, job:'weighs goods' },
    ],
    lines: [
      'Coins flip luck — but fiber and flint flip dinner.',
      'Welcome to the Coin Market. No emerald nonsense here.',
      'Trade fair, sleep safer. That is the Market rule.',
      'Heard the dunes still hide outposts. Bring water.',
    ],
    gift: [110, 112, 138], // stick, seeds, cloth
  },
  outpost: {
    title: 'Dune Outpost',
    roles: [
      { name: 'Sirocco', shirt:0xd2b48c, pants:0x6b4423, accent:0xf5deb3, job:'watches the gate' },
      { name: 'Mirage',  shirt:0xc4a36a, pants:0x4a3020, accent:0xffe4c4, job:'maps the sands' },
    ],
    lines: [
      'Sand remembers footprints longer than people do.',
      'Stay inside the wall after dusk. The dunes get loud.',
      'Torch pillars mark safe ground. Trust the light.',
      'We are Wardens, not villagers. Different oath.',
    ],
    gift: [15, 119, 6], // sandstone, flint, sand
  },
  haven: {
    title: 'Log Haven',
    roles: [
      { name: 'Moss',   shirt:0x4a7c3f, pants:0x2d4a24, accent:0x8fbc8f, job:'tends the firepit' },
      { name: 'Canopy', shirt:0x5d8a3e, pants:0x3e5c2a, accent:0xc5e1a5, job:'listens to the trees' },
      { name: 'Kindling',shirt:0x6b8e23, pants:0x3a4a18, accent:0xd4e157, job:'keeps embers alive' },
    ],
    lines: [
      'The Grove Kin do not deal in coins — only warmth.',
      'Sit by the firepit. Stories cost nothing.',
      'Leaves fall. We rise. That is Haven math.',
      'If the forest goes quiet, something larger is near.',
    ],
    gift: [5, 114, 115], // leaves, berries, resin
  },
  stilt: {
    title: 'Stilt Rest',
    roles: [
      { name: 'Reed',  shirt:0x556b2f, pants:0x2f4f2f, accent:0x9acd32, job:'repairs the stilts' },
      { name: 'Brack', shirt:0x4a6741, pants:0x1a2f1a, accent:0x8fbc8f, job:'watches the dock' },
    ],
    lines: [
      'Keep your boots dry. The marsh taxes the careless.',
      'Reed Folk sleep high. Floods are old friends.',
      'Thatch holds better secrets than stone.',
      'Fish the edges at dawn — mid-day is for mosquitoes.',
    ],
    gift: [117, 111, 19], // shell, fiber, thatch
  },
};

function makeVillagerMesh(role){
  const g = new THREE.Group();
  // body
  g.add(box(0.55, 0.7, 0.35, role.shirt, 0, 1.05, 0));
  // head
  g.add(box(0.4, 0.4, 0.4, 0xe8c4a0, 0, 1.6, 0));
  // unique accent scarf / sash (MiniCraft signature — not MC robe)
  g.add(box(0.58, 0.12, 0.38, role.accent, 0, 1.25, 0.02));
  // pants
  g.add(box(0.5, 0.55, 0.32, role.pants, 0, 0.55, 0));
  // legs
  const legL = box(0.16, 0.45, 0.16, role.pants, -0.14, 0.2, 0);
  const legR = box(0.16, 0.45, 0.16, role.pants, 0.14, 0.2, 0);
  g.add(legL); g.add(legR);
  // arms
  g.add(box(0.14, 0.5, 0.14, role.shirt, -0.38, 1.0, 0));
  g.add(box(0.14, 0.5, 0.14, role.shirt, 0.38, 1.0, 0));
  // name tag
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(20, 12, 216, 40);
  ctx.fillStyle = '#fff';
  ctx.fillText(role.name, 128, 40);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(1.4, 0.35, 1);
  spr.position.y = 2.15;
  g.add(spr);
  return { g, legL, legR };
}

function groundY(x, z){
  // Highest solid among nearby cells (stilts/pads); ignores plants & water
  let best = -1;
  const ix = Math.round(x), iz = Math.round(z);
  for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){
    const ty = surfaceY(ix + dx, iz + dz);
    if(ty > best) best = ty;
  }
  return (best < 0 ? 20 : best) + 0.5;
}
function spawnAtSite(site){
  if(spawnedKeys.has(site.key)) return;
  spawnedKeys.add(site.key);
  const folk = FOLK[site.kind] || FOLK.market;
  const n = folk.roles.length;
  for(let i = 0; i < n; i++){
    const role = folk.roles[i];
    const ang = (i / n) * Math.PI * 2;
    const x = site.x + Math.cos(ang) * 2.2;
    const z = site.z + Math.sin(ang) * 2.2;
    const y = groundY(x, z);
    const mesh = makeVillagerMesh(role);
    mesh.g.position.set(x, y, z);
    const holder = new THREE.Group();
    holder.add(mesh.g);
    scene.add(holder);
    villagers.push({
      g: mesh.g, holder, legL: mesh.legL, legR: mesh.legR,
      x, z, homeX: x, homeZ: z,
      yaw: ang + Math.PI, mode: 'idle', timer: 1 + Math.random() * 2,
      phase: Math.random() * 10,
      role, kind: site.kind, folk,
      gifted: false,
    });
  }
}

export function init(){
  spawnedKeys.clear();
  for(const v of villagers){
    try { scene.remove(v.holder); } catch(e){}
  }
  villagers.length = 0;
}

let nearHintT = 0;
export function update(dt, time, playerPos){
  nearHintT -= dt;
  // Lazy-spawn when a registered village is nearby
  for(const site of villageSites){
    if(spawnedKeys.has(site.key)) continue;
    if(wrapDist(site.x, site.z, playerPos.x, playerPos.z) < VIEW + 20)
      spawnAtSite(site);
  }

  // Soft "Talk" hint when a folk is in range
  if(nearHintT <= 0){
    const near = pickNear(playerPos, 2.8);
    if(near){
      nearHintT = 6;
      try {
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = 'Talk · place / right-click';
        document.getElementById('toasts')?.appendChild(t);
        setTimeout(()=>t.remove(), 2500);
      } catch(e){}
    }
  }

  for(const v of villagers){
    v.holder.position.set(
      wrapShift(v.g.position.x, playerPos.x),
      0,
      wrapShift(v.g.position.z, playerPos.z)
    );
    const far = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z) > VIEW;
    v.g.visible = !far;
    if(far) continue;
    v.g.position.y = groundY(v.g.position.x, v.g.position.z);

    // Simple home-radius wander (not Minecraft pathing)
    v.timer -= dt;
    if(v.timer <= 0){
      v.mode = Math.random() < 0.55 ? 'walk' : 'idle';
      // prefer staying near home
      const tx = v.homeX + (Math.random() - 0.5) * 5;
      const tz = v.homeZ + (Math.random() - 0.5) * 5;
      v.yaw = Math.atan2(tz - v.g.position.z, tx - v.g.position.x);
      v.timer = 2 + Math.random() * 4;
    }
    if(v.mode === 'walk'){
      const sp = 0.9;
      const nx = v.g.position.x + Math.cos(v.yaw) * sp * dt;
      const nz = v.g.position.z + Math.sin(v.yaw) * sp * dt;
      // stay near home
      if(Math.hypot(nx - v.homeX, nz - v.homeZ) < 4.5){
        v.g.position.x = nx;
        v.g.position.z = nz;
        v.g.position.y = groundY(nx, nz);
        v.g.rotation.y = -v.yaw + Math.PI / 2;
        const sw = Math.sin(time * 7 + v.phase) * 0.4;
        v.legL.rotation.x = sw;
        v.legR.rotation.x = -sw;
      } else {
        v.mode = 'idle';
        v.timer = 1;
      }
    } else {
      v.legL.rotation.x *= 0.85;
      v.legR.rotation.x *= 0.85;
      v.g.position.y = groundY(v.g.position.x, v.g.position.z);
      // face player when close
      const d = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z);
      if(d < 4){
        v.g.rotation.y = Math.atan2(playerPos.x - v.g.position.x, playerPos.z - v.g.position.z);
      }
    }
  }
}

/** Right-click / use on nearby villager */
export function tryTalk(playerPos){
  let best = null, bestD = 3.2;
  for(const v of villagers){
    const d = Math.hypot(
      wrapC(v.g.position.x) - wrapC(playerPos.x),
      wrapC(v.g.position.z) - wrapC(playerPos.z)
    );
    // continuous coords — use wrapDist
    const wd = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z);
    if(wd < bestD){ bestD = wd; best = v; }
  }
  if(!best) return false;
  const line = best.folk.lines[Math.floor(Math.random() * best.folk.lines.length)];
  addChat(best.role.name, `(${best.folk.title}) ${line}`);
  // Visible toast so mobile players know the interaction worked
  try {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = `Talk · ${best.role.name}`;
    document.getElementById('toasts')?.appendChild(t);
    setTimeout(()=>t.remove(), 2200);
  } catch(e){}
  if(!best.gifted && best.folk.gift?.length){
    best.gifted = true;
    const gid = best.folk.gift[Math.floor(Math.random() * best.folk.gift.length)];
    addToInventory(gid);
    addChat('⚙', `${best.role.name} slipped you a small gift.`);
  }
  return true;
}

export function pickNear(playerPos, maxDist = 3){
  let best = null, bestD = maxDist;
  for(const v of villagers){
    const d = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z);
    if(d < bestD){ bestD = d; best = v; }
  }
  return best;
}

/** Nearest registered village site within maxDist, or null */
export function nearestVillage(px, pz, maxDist = 400){
  let best = null, bestD = maxDist;
  for(const s of villageSites){
    const d = wrapDist(s.x, s.z, px, pz);
    if(d < bestD){ bestD = d; best = { ...s, dist: d|0 }; }
  }
  return best;
}

export function getVillageSites(){ return villageSites; }

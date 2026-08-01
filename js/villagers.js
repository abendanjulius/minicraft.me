// villagers.js — MiniCraft-unique village folk (not Minecraft clones)
import { villageSites, topY, surfaceY, feetY, WORLD, wrapC } from './world.js';
import { scene, box, VIEW, wrapShift, wrapDist } from './render.js';
import { addChat, inventory, addToInventory, renderHotbar } from './ui.js';

export const villagers = [];
const spawnedKeys = new Set();
const noticedSites = new Set(); // settlement nearby toast once per site per session

const FOLK = {
  market: {
    title: 'Coin Market',
    roles: [
      { name: 'Ledger',  shirt:0xc9a227, pants:0x3a2a10, accent:0xffe08a, job:'tallies trades', anchor:[0, 0.5] },
      { name: 'Barter',  shirt:0xe8c547, pants:0x5c4010, accent:0xfff3c4, job:'haggles cheerfully', anchor:[-2.2, -2.2] },
      { name: 'Scale',   shirt:0xb8860b, pants:0x2a2010, accent:0xd4af37, job:'weighs goods', anchor:[2.2, -2.2] },
    ],
    lines: [
      'Coins flip luck — but fiber and flint flip dinner.',
      'Welcome to the Coin Market. No emerald nonsense here.',
      'Trade fair, sleep safer. That is the Market rule.',
      'Heard the dunes still hide outposts. Bring water.',
    ],
    // need id, needN, give id, giveN
    trades: [
      { need: 111, needN: 4, give: 114, giveN: 2, label: '4 Fiber → 2 Berries' },
      { need: 110, needN: 8, give: 10,  giveN: 2, label: '8 Sticks → 2 Torches' },
      { need: 119, needN: 2, give: 138, giveN: 1, label: '2 Flint → 1 Cloth' },
    ],
    gift: [110, 112, 138],
  },
  outpost: {
    title: 'Dune Outpost',
    roles: [
      { name: 'Sirocco', shirt:0xd2b48c, pants:0x6b4423, accent:0xf5deb3, job:'watches the gate', anchor:[0, 2.5] },
      { name: 'Mirage',  shirt:0xc4a36a, pants:0x4a3020, accent:0xffe4c4, job:'maps the sands', anchor:[2, 0] },
    ],
    lines: [
      'Sand remembers footprints longer than people do.',
      'Stay inside the wall after dusk. The dunes get loud.',
      'Torch pillars mark safe ground. Trust the light.',
      'We are Wardens, not villagers. Different oath.',
    ],
    trades: [
      { need: 6, needN: 8, give: 15, giveN: 4, label: '8 Sand → 4 Sandstone' },
      { need: 119, needN: 1, give: 10, giveN: 3, label: '1 Flint → 3 Torches' },
    ],
    gift: [15, 119, 6],
  },
  haven: {
    title: 'Log Haven',
    roles: [
      { name: 'Moss',   shirt:0x4a7c3f, pants:0x2d4a24, accent:0x8fbc8f, job:'tends the firepit', anchor:[0, 1.5] },
      { name: 'Canopy', shirt:0x5d8a3e, pants:0x3e5c2a, accent:0xc5e1a5, job:'listens to the trees', anchor:[-2, -1] },
      { name: 'Kindling',shirt:0x6b8e23, pants:0x3a4a18, accent:0xd4e157, job:'keeps embers alive', anchor:[2, -1] },
    ],
    lines: [
      'The Grove Kin do not deal in coins — only warmth.',
      'Sit by the firepit. Stories cost nothing.',
      'Leaves fall. We rise. That is Haven math.',
      'If the forest goes quiet, something larger is near.',
    ],
    trades: [
      { need: 4, needN: 4, give: 114, giveN: 3, label: '4 Logs → 3 Berries' },
      { need: 5, needN: 6, give: 115, giveN: 1, label: '6 Leaves → 1 Resin' },
    ],
    gift: [5, 114, 115],
  },
  stilt: {
    title: 'Stilt Rest',
    roles: [
      { name: 'Reed',  shirt:0x556b2f, pants:0x2f4f2f, accent:0x9acd32, job:'repairs the stilts', anchor:[-1.5, -1.5] },
      { name: 'Brack', shirt:0x4a6741, pants:0x1a2f1a, accent:0x8fbc8f, job:'watches the dock', anchor:[1.5, 2] },
    ],
    lines: [
      'Keep your boots dry. The marsh taxes the careless.',
      'Reed Folk sleep high. Floods are old friends.',
      'Thatch holds better secrets than stone.',
      'Fish the edges at dawn — mid-day is for mosquitoes.',
    ],
    trades: [
      { need: 111, needN: 3, give: 117, giveN: 1, label: '3 Fiber → 1 Shell' },
      { need: 117, needN: 2, give: 114, giveN: 4, label: '2 Shells → 4 Berries' },
    ],
    gift: [117, 111, 19],
  },
};

function toast(msg){
  try {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.getElementById('toasts')?.appendChild(t);
    setTimeout(()=>t.remove(), 2800);
  } catch(e){}
}

function groundY(x, z){
  let best = -1;
  const ix = Math.round(x), iz = Math.round(z);
  for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){
    const ty = surfaceY(ix + dx, iz + dz);
    if(ty > best) best = ty;
  }
  return (best < 0 ? 20 : best) + 0.5;
}

function makeVillagerMesh(role){
  const g = new THREE.Group();
  g.add(box(0.55, 0.7, 0.35, role.shirt, 0, 1.05, 0));
  g.add(box(0.4, 0.4, 0.4, 0xe8c4a0, 0, 1.6, 0));
  g.add(box(0.58, 0.12, 0.38, role.accent, 0, 1.25, 0.02));
  g.add(box(0.5, 0.55, 0.32, role.pants, 0, 0.55, 0));
  const legL = box(0.16, 0.45, 0.16, role.pants, -0.14, 0.2, 0);
  const legR = box(0.16, 0.45, 0.16, role.pants, 0.14, 0.2, 0);
  g.add(legL); g.add(legR);
  g.add(box(0.14, 0.5, 0.14, role.shirt, -0.38, 1.0, 0));
  g.add(box(0.14, 0.5, 0.14, role.shirt, 0.38, 1.0, 0));
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

function makeVillageSign(title, x, y, z){
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(40,28,12,.82)';
  ctx.fillRect(16, 16, 480, 96);
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 6;
  ctx.strokeRect(16, 16, 480, 96);
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffe08a';
  ctx.fillText(title, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  spr.scale.set(3.2, 0.8, 1);
  spr.position.set(x, y + 3.2, z);
  const holder = new THREE.Group();
  holder.add(spr);
  scene.add(holder);
  return { holder, spr, x, z };
}

const villageSigns = [];

function spawnAtSite(site){
  if(spawnedKeys.has(site.key)) return;
  spawnedKeys.add(site.key);
  const folk = FOLK[site.kind] || FOLK.market;

  // Floating name sign for the settlement
  const sy = groundY(site.x, site.z);
  villageSigns.push(makeVillageSign(folk.title, site.x, sy, site.z));

  const n = folk.roles.length;
  for(let i = 0; i < n; i++){
    const role = folk.roles[i];
    const [ax, az] = role.anchor || [Math.cos((i/n)*Math.PI*2)*2.2, Math.sin((i/n)*Math.PI*2)*2.2];
    const x = site.x + ax;
    const z = site.z + az;
    const y = groundY(x, z);
    const mesh = makeVillagerMesh(role);
    mesh.g.position.set(x, y, z);
    const holder = new THREE.Group();
    holder.add(mesh.g);
    scene.add(holder);
    villagers.push({
      g: mesh.g, holder, legL: mesh.legL, legR: mesh.legR,
      x, z, homeX: x, homeZ: z,
      yaw: 0, mode: 'idle', timer: 1 + Math.random() * 2,
      phase: Math.random() * 10,
      role, kind: site.kind, folk,
      gifted: false, tradeIdx: 0,
    });
  }
}

export function init(){
  spawnedKeys.clear();
  noticedSites.clear();
  for(const v of villagers){
    try { scene.remove(v.holder); } catch(e){}
  }
  villagers.length = 0;
  for(const s of villageSigns){
    try { scene.remove(s.holder); } catch(e){}
  }
  villageSigns.length = 0;
}

let nearHintT = 0;
export function update(dt, time, playerPos){
  nearHintT -= dt;

  for(const site of villageSites){
    if(spawnedKeys.has(site.key)) continue;
    if(wrapDist(site.x, site.z, playerPos.x, playerPos.z) < VIEW + 20)
      spawnAtSite(site);
  }

  // Settlement nearby toast (once per site)
  for(const site of villageSites){
    if(noticedSites.has(site.key)) continue;
    const d = wrapDist(site.x, site.z, playerPos.x, playerPos.z);
    if(d < 48){
      noticedSites.add(site.key);
      const folk = FOLK[site.kind] || FOLK.market;
      toast(`Settlement nearby · ${folk.title}`);
      addChat('⚙', `You sense a settlement — ${folk.title}.`);
    }
  }

  // Sign holders follow wrap shift
  for(const s of villageSigns){
    s.holder.position.set(wrapShift(s.x, playerPos.x), 0, wrapShift(s.z, playerPos.z));
  }

  if(nearHintT <= 0){
    const near = pickNear(playerPos, 2.8);
    if(near){
      nearHintT = 7;
      toast('Talk / trade · place or right-click');
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

    // Stay near anchor (small wander only)
    v.timer -= dt;
    if(v.timer <= 0){
      v.mode = Math.random() < 0.4 ? 'walk' : 'idle';
      const tx = v.homeX + (Math.random() - 0.5) * 2.2;
      const tz = v.homeZ + (Math.random() - 0.5) * 2.2;
      v.yaw = Math.atan2(tz - v.g.position.z, tx - v.g.position.x);
      v.timer = 2.5 + Math.random() * 3.5;
    }
    if(v.mode === 'walk'){
      const sp = 0.55;
      const nx = v.g.position.x + Math.cos(v.yaw) * sp * dt;
      const nz = v.g.position.z + Math.sin(v.yaw) * sp * dt;
      if(Math.hypot(nx - v.homeX, nz - v.homeZ) < 1.8){
        v.g.position.x = nx;
        v.g.position.z = nz;
        v.g.position.y = groundY(nx, nz);
        v.g.rotation.y = -v.yaw + Math.PI / 2;
        const sw = Math.sin(time * 7 + v.phase) * 0.35;
        v.legL.rotation.x = sw;
        v.legR.rotation.x = -sw;
      } else {
        v.mode = 'idle';
        v.timer = 1.5;
      }
    } else {
      v.legL.rotation.x *= 0.85;
      v.legR.rotation.x *= 0.85;
      const d = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z);
      if(d < 4){
        v.g.rotation.y = Math.atan2(playerPos.x - v.g.position.x, playerPos.z - v.g.position.z);
      }
    }
  }
}

function invCount(id){ return inventory[id] || 0; }
function invTake(id, n){
  if(invCount(id) < n) return false;
  inventory[id] -= n;
  if(inventory[id] <= 0) delete inventory[id];
  return true;
}

/** Try to complete one affordable trade; list offers in chat. */
function doTrade(v){
  const trades = v.folk.trades || [];
  if(!trades.length) return false;
  // List offers once in a while via chat
  for(const tr of trades){
    addChat(v.role.name, `Offer: ${tr.label}`);
  }
  // Prefer trade they can afford, rotating index
  for(let k = 0; k < trades.length; k++){
    const tr = trades[(v.tradeIdx + k) % trades.length];
    if(invCount(tr.need) >= tr.needN){
      if(!invTake(tr.need, tr.needN)) continue;
      for(let i = 0; i < tr.giveN; i++) addToInventory(tr.give);
      renderHotbar?.();
      addChat('⚙', `Traded with ${v.role.name}: ${tr.label}`);
      toast(`Trade · ${tr.label}`);
      v.tradeIdx = (v.tradeIdx + k + 1) % trades.length;
      return true;
    }
  }
  addChat(v.role.name, 'Bring what the slate asks — then we deal.');
  toast('Need items to trade');
  return false;
}

export function tryTalk(playerPos){
  let best = null, bestD = 3.2;
  for(const v of villagers){
    const wd = wrapDist(v.g.position.x, v.g.position.z, playerPos.x, playerPos.z);
    if(wd < bestD){ bestD = wd; best = v; }
  }
  if(!best) return false;
  const line = best.folk.lines[Math.floor(Math.random() * best.folk.lines.length)];
  addChat(best.role.name, `(${best.folk.title}) ${line}`);
  toast(`Talk · ${best.role.name}`);
  // Trade attempt after greeting
  doTrade(best);
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

export function nearestVillage(px, pz, maxDist = 400){
  let best = null, bestD = maxDist;
  for(const s of villageSites){
    const d = wrapDist(s.x, s.z, px, pz);
    if(d < bestD){ bestD = d; best = { ...s, dist: d|0 }; }
  }
  return best;
}

export function getVillageSites(){ return villageSites; }

/** For ambient: true if a market is near the player */
export function nearMarket(px, pz, maxDist = 28){
  for(const s of villageSites){
    if(s.kind !== 'market') continue;
    if(wrapDist(s.x, s.z, px, pz) < maxDist) return true;
  }
  return false;
}

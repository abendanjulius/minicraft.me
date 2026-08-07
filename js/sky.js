// sky.js — day/night cycle, sky dome, clouds, stars, sun/moon
// Split out of render.js so mesh code and atmosphere stay independent.

import { scene, VIEW, isTouch, ambLight, sun } from './render.js';
import { CH } from './world.js';
import { gm } from './mode.js';

const VIEW_CHUNKS = Math.ceil(VIEW / CH) + 1;

// ---- Day/night cycle ----
export const day = { t: .28 };            // 0..1; .25 ≈ noon
const DAY_LEN = 1200;                     // ~20 min full cycle (was 240 / 4 min)
const skyDay = new THREE.Color(0x87ceeb), skyNight = new THREE.Color(0x0b1026), skyDusk = new THREE.Color(0xe8935a);
// Soft-edged disc (bright core → transparent rim) for sun/moon bodies.
function softDisc(inner, edge){
  const c=document.createElement('canvas'); c.width=c.height=64;
  const g=c.getContext('2d');
  const grd=g.createRadialGradient(32,32,1,32,32,30);
  grd.addColorStop(0, inner); grd.addColorStop(0.45, inner);
  grd.addColorStop(0.72, edge); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle=grd; g.beginPath(); g.arc(32,32,31,0,7); g.fill();
  const t=new THREE.CanvasTexture(c); t.magFilter=t.minFilter=THREE.LinearFilter; return t;
}
// Soft radial halo for glows (additive).
function haloTex(rgb){
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d');
  const grd=g.createRadialGradient(64,64,2,64,64,64);
  grd.addColorStop(0,`rgba(${rgb},0.60)`); grd.addColorStop(0.4,`rgba(${rgb},0.18)`); grd.addColorStop(1,`rgba(${rgb},0)`);
  g.fillStyle=grd; g.fillRect(0,0,128,128);
  const t=new THREE.CanvasTexture(c); t.magFilter=t.minFilter=THREE.LinearFilter; return t;
}
function skySprite(map, opts){
  const s=new THREE.Sprite(new THREE.SpriteMaterial(Object.assign({map, fog:false, depthWrite:false, transparent:true}, opts||{})));
  scene.add(s); return s;
}
// Order matters (no depth write): halos first so the crisp body draws on top.
const sunGlow  = skySprite(haloTex('255,216,140'), {blending:THREE.AdditiveBlending, opacity:.9});  sunGlow.scale.set(40,40,1);
const sunSpr   = skySprite(softDisc('#fffdf2','rgba(255,226,150,0.9)'));                             sunSpr.scale.set(12,12,1);
const moonGlow = skySprite(haloTex('182,202,255'), {blending:THREE.AdditiveBlending, opacity:.7});  moonGlow.scale.set(20,20,1);
const moonSpr  = skySprite(softDisc('#ffffff','rgba(207,217,245,0.9)'));                             moonSpr.scale.set(7,7,1);
// Directional warm band that sits on the horizon under the sun at dawn/dusk.
const horizonGlow = skySprite(haloTex('255,150,84'), {blending:THREE.AdditiveBlending, opacity:0}); horizonGlow.scale.set(150,46,1);

// ---- Sky dome + soft clouds (replaces flat clear-color void) ----
const skyZenithDay = new THREE.Color(0x3d8fd9);
const skyHorizonDay = new THREE.Color(0xc5dff0);
const skyZenithDusk = new THREE.Color(0x2a3a6a);
const skyHorizonDusk = new THREE.Color(0xe8a06a);
const skyZenithNight = new THREE.Color(0x070b18);
const skyHorizonNight = new THREE.Color(0x1a2440);
const _sky = new THREE.Color();
const _zen = new THREE.Color();
const _hor = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _tmpH = new THREE.Vector3();
let _skyT = 0; // sky animation clock (twinkle / drift)

// Vertical sky gradient (v=0 zenith → v=1 lower sky). Crisp stars live in their
// own Points layer, so this stays a smooth multi-stop gradient.
function paintSkyGradient(stops){
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  for(const [p, hex] of stops) grd.addColorStop(p, hex);
  g.fillStyle = grd;
  g.fillRect(0, 0, 8, 256);
  return c;
}

function hexCol(c){
  return '#' + c.getHexString();
}

let _skyLastKey = '';
const skyCanvas = paintSkyGradient([[0,'#3d8fd9'],[1,'#c5dff0']]);
const skyTex = new THREE.CanvasTexture(skyCanvas);
skyTex.magFilter = THREE.LinearFilter;
skyTex.minFilter = THREE.LinearFilter;
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(Math.max(VIEW * 1.85, 140), 24, 16),
  new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  })
);
skyDome.frustumCulled = false;
scene.add(skyDome);

function makeCloudTex(){
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0,0,128,128);
  const blobs = [
    [40,64,28],[64,58,34],[88,64,26],[52,72,22],[76,70,20]
  ];
  for(const [x,y,r] of blobs){
    const grd = g.createRadialGradient(x,y,2,x,y,r);
    grd.addColorStop(0, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  return t;
}
const cloudTex = makeCloudTex();
const cloudGroup = new THREE.Group();
cloudGroup.frustumCulled = false;
scene.add(cloudGroup);
const CLOUD_N = isTouch ? 6 : 10;
for(let i = 0; i < CLOUD_N; i++){
  const mat = new THREE.MeshBasicMaterial({
    map: cloudTex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(28, 14), mat);
  const a = (i / CLOUD_N) * Math.PI * 2;
  const rad = 40 + (i % 3) * 18;
  m.position.set(Math.cos(a) * rad, 28 + (i % 4) * 5, Math.sin(a) * rad);
  m.rotation.order = 'YXZ';
  m.userData.baseA = a;
  m.userData.rad = rad;
  m.userData.y = m.position.y;
  m.userData.spin = 0.015 + (i % 5) * 0.004;
  cloudGroup.add(m);
}

// ---- Starfield (crisp Points; brightness-varied, twinkles at night) ----
const starTex = (()=>{
  const c=document.createElement('canvas'); c.width=c.height=32;
  const g=c.getContext('2d');
  const grd=g.createRadialGradient(16,16,0,16,16,16);
  grd.addColorStop(0,'#fff'); grd.addColorStop(0.4,'rgba(255,255,255,0.85)'); grd.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=grd; g.fillRect(0,0,32,32);
  return new THREE.CanvasTexture(c);
})();
const STAR_N = isTouch ? 320 : 620;
const starGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(STAR_N*3), col = new Float32Array(STAR_N*3);
  const R = Math.max(VIEW*1.8, 138);
  for(let i=0;i<STAR_N;i++){
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos(1 - Math.random()*0.9);   // bias toward the upper dome
    const r = Math.sin(phi);
    pos[i*3]   = Math.cos(theta)*r*R;
    pos[i*3+1] = Math.abs(Math.cos(phi))*R*0.98;     // always above the horizon
    pos[i*3+2] = Math.sin(theta)*r*R;
    const b = 0.45 + Math.random()*0.55;             // brightness variation
    col[i*3]=b; col[i*3+1]=b; col[i*3+2]=Math.min(1,b*1.06);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(col,3));
}
const starField = new THREE.Points(starGeo, new THREE.PointsMaterial({
  size: isTouch?1.8:2.2, map: starTex, vertexColors: true, transparent: true,
  depthWrite: false, fog: false, sizeAttenuation: false, opacity: 0, blending: THREE.AdditiveBlending,
}));
starField.frustumCulled = false;
scene.add(starField);

function refreshSkyTexture(dl, duskF, nightAmt){
  _zen.copy(skyZenithNight).lerp(skyZenithDay, dl).lerp(skyZenithDusk, duskF * 0.65);
  _hor.copy(skyHorizonNight).lerp(skyHorizonDay, dl).lerp(skyHorizonDusk, duskF * 0.75);
  const key = _zen.getHexString() + _hor.getHexString() + (nightAmt*10|0);
  if(key === _skyLastKey) return;
  _skyLastKey = key;
  // Mid tone (smoother zenith→horizon fall-off) + a brighter atmospheric haze
  // band just above the horizon (daytime only) for depth.
  const mid  = _zen.clone().lerp(_hor, 0.55);
  const haze = _hor.clone().lerp(_white, 0.05 + 0.16 * dl);
  const stops = [
    [0.00, hexCol(_zen)],
    [0.40, hexCol(_zen)],
    [0.60, hexCol(mid)],
    [0.82, hexCol(_hor)],
    [0.91, hexCol(haze)],
    [1.00, hexCol(_hor)],
  ];
  const c = paintSkyGradient(stops);
  const ctx = skyCanvas.getContext('2d');
  ctx.clearRect(0,0,8,256);
  ctx.drawImage(c, 0, 0);
  skyTex.needsUpdate = true;
}

export function setDayTime(t){ day.t = ((t%1)+1)%1; _skyLastKey = ''; }

let _underwater = false;
const _uwCol = new THREE.Color(0x7ec8e8); // light water tint while submerged
export function setUnderwater(on){
  _underwater = !!on;
  document.body.classList.toggle('underwater', _underwater);
}

export function updateDayNight(dt, focus){
  if(gm.forge){ day.t = 0.28; }          // Forge: always noon
  else { day.t = (day.t + dt/DAY_LEN) % 1; }
  const ang = day.t*Math.PI*2;
  const dir = new THREE.Vector3(Math.cos(ang), Math.sin(ang), .3).normalize();
  sun.position.copy(dir);
  const dl = Math.max(0, Math.min(1, dir.y*2.2 + .15));       // daylight 0..1
  const duskF = Math.max(0, 1 - Math.abs(dir.y)*4);           // near-horizon warmth
  const nightAmt = Math.max(0, 1 - dl * 1.35);

  // Gradient sky dome (zenith → horizon) + night stars
  refreshSkyTexture(dl, Math.max(0, duskF * (0.4 + dl)), nightAmt);
  if(focus){
    skyDome.position.copy(focus);
    cloudGroup.position.set(focus.x, 0, focus.z);
  }
  // Slow cloud drift
  for(const m of cloudGroup.children){
    m.userData.baseA += m.userData.spin * dt;
    const a = m.userData.baseA;
    m.position.set(
      Math.cos(a) * m.userData.rad,
      m.userData.y,
      Math.sin(a) * m.userData.rad
    );
    m.lookAt(focus.x, m.position.y, focus.z);
    m.material.opacity = 0.15 + 0.55 * dl; // fade at night
    m.material.color.setRGB(1, 1 - duskF * 0.10, 1 - duskF * 0.22); // pink at dusk
    m.visible = dl > 0.05;
  }

  // Fog matches horizon (so distant chunks melt into sky, not a flat wall)
  _hor.copy(skyHorizonNight).lerp(skyHorizonDay, dl).lerp(skyHorizonDusk, Math.max(0, duskF * 0.7));
  _sky.copy(_hor);
  scene.background.copy(_zen.copy(skyZenithNight).lerp(skyZenithDay, dl)); // fallback clear
  scene.fog.color.copy(_hor);
  if(_underwater){
    scene.background.copy(_uwCol);
    scene.fog.color.copy(_uwCol);
    scene.fog.near = 1.5;
    scene.fog.far = 22;
    skyDome.visible = false;
    cloudGroup.visible = false;
  } else {
    skyDome.visible = true;
    cloudGroup.visible = true;
    // Soft horizon: fog must reach full opacity BEFORE the drawn terrain ends,
    // else unloaded space past the edge shows through as a sky band. Cap fog.far
    // to just inside the guaranteed-visible radius (VIEW_CHUNKS chunks).
    scene.fog.near = VIEW * 0.62;
    scene.fog.far = Math.min(VIEW * 1.35, VIEW_CHUNKS * CH - CH * 0.5);
  }
  ambLight.intensity = .18 + .45*dl;
  sun.intensity = .15 + .6*dl;
  _skyT += dt;
  // Sun + warm halo (halo grows and warms as it nears the horizon)
  sunSpr.position.copy(focus).addScaledVector(dir, VIEW*1.55);
  sunGlow.position.copy(sunSpr.position);
  sunSpr.visible = sunGlow.visible = dl > 0.05;
  sunGlow.scale.setScalar(34 + duskF * 30);
  sunGlow.material.opacity = 0.45 + 0.35 * dl + duskF * 0.35;
  sunSpr.material.color.setRGB(1, 1 - duskF * 0.12, 1 - duskF * 0.30);
  // Moon + cool halo
  moonSpr.position.copy(focus).addScaledVector(dir, -VIEW*1.55);
  moonGlow.position.copy(moonSpr.position);
  moonSpr.visible = moonGlow.visible = nightAmt > 0.2;
  moonGlow.material.opacity = 0.3 + 0.5 * nightAmt;
  // Directional sunset/sunrise band low on the horizon, under the sun
  _tmpH.set(dir.x, 0, dir.z); if(_tmpH.lengthSq() > 1e-4) _tmpH.normalize();
  horizonGlow.position.copy(focus).addScaledVector(_tmpH, VIEW*1.75); horizonGlow.position.y = focus.y - 3;
  horizonGlow.material.opacity = duskF * 0.8 * Math.min(1, dl * 2 + 0.15);
  horizonGlow.visible = duskF > 0.04;
  // Starfield: fade in at night, gentle twinkle + very slow celestial drift
  starField.position.copy(focus);
  starField.rotation.y += dt * 0.006;
  starField.visible = nightAmt > 0.05;
  starField.material.opacity = nightAmt * (0.8 + 0.2 * Math.sin(_skyT * 1.7));
  return dl;
}


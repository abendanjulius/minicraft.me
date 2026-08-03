// render.js — scene, textures, block/tool content, chunk meshing, particles
import { WORLD, WH, CH, CHUNKS, CENTER, chunks, cIndex, bIndex, wrapC, occludes, getBlock, setBlock, doorStyleOf, ensureChunk } from './world.js';
import { EXTRA_BLOCKS, EXTRA_ITEMS } from './content.js';
import { gm } from './mode.js';

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const VIEW = isTouch ? 56 : 120;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, VIEW*.55, VIEW*1.15);
export const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, .1, VIEW*2);
scene.add(camera); // so camera children (first-person hand) render
export const renderer = new THREE.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.getElementById('game').appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff, 0)); // placeholder slot; real lights below
const ambLight = new THREE.AmbientLight(0xffffff, .6);
scene.add(ambLight);
const sun = new THREE.DirectionalLight(0xffffff, .7);
sun.position.set(1, 2, .5);
scene.add(sun);

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
addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- Textures (procedural 16x16; per-device pixel noise is cosmetic) ----
function canvasTex(draw){
  const c = document.createElement('canvas'); c.width = c.height = 16;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  return {t, url:c.toDataURL()};
}
const rgb=(r,g,b,a=1)=>`rgba(${Math.min(255,Math.max(0,r|0))},${Math.min(255,Math.max(0,g|0))},${Math.min(255,Math.max(0,b|0))},${a})`;
const pix=(g,fn)=>{for(let y=0;y<16;y++)for(let x=0;x<16;x++){const c=fn(x,y);if(c){g.fillStyle=c;g.fillRect(x,y,1,1);}}};
export const jit=n=>(Math.random()-.5)*n;

const grassTop = canvasTex(g=>pix(g,()=>{const d=jit(30);return rgb(92+d,171+d,60+d)}));
const dirtTex  = canvasTex(g=>pix(g,()=>{const d=jit(24);return rgb(134+d,96+d,67+d)}));
const capDepth = Array.from({length:16},()=>3+Math.floor(Math.random()*2));
const grassSide= canvasTex(g=>pix(g,(x,y)=>{const d=jit(24);return y<capDepth[x]?rgb(92+d,171+d,60+d):rgb(134+d,96+d,67+d)}));
const stoneTex = canvasTex(g=>pix(g,()=>{const d=jit(26),s=Math.random()<.08?-25:0;return rgb(128+d+s,128+d+s,131+d+s)}));
const logSide  = canvasTex(g=>pix(g,(x,y)=>{
  const bark=(x%4===0||x%7===0)?-32:0,d=jit(16);
  const knot=(x>=6&&x<=9&&y>=6&&y<=9)?-25:0;
  return rgb(105+bark+d+knot, 80+bark+d+knot, 46+bark+d+knot);
}));
const logTop   = canvasTex(g=>pix(g,(x,y)=>{const r=Math.max(Math.abs(x-7.5),Math.abs(y-7.5)),ring=Math.floor(r)%2===0?12:-14,d=jit(10);return rgb(160+ring+d,130+ring+d,85+ring+d)}));
const leafTex  = canvasTex(g=>pix(g,(x,y)=>{
  const d=jit(36), hole=Math.random()<.12?-50:0;
  // slight mottling so leaves don't look like solid plastic cubes
  const mott=((x*3+y*5)&7)===0?-18:0;
  return rgb(48+d+hole+mott, 118+d+hole+mott, 36+d+hole+mott);
}));
const sandTex  = canvasTex(g=>pix(g,()=>{const d=jit(20);return rgb(218+d,204+d,150+d)}));
const plankTex = canvasTex(g=>pix(g,(x,y)=>{const seam=(y%4===3)?-40:0,off=((y>>2)%2)*8,end=((x+off)%8===7)?-30:0,d=jit(14);return rgb(178+seam+end+d,138+seam+end+d,90+seam+end+d)}));
const brickTex = canvasTex(g=>pix(g,(x,y)=>{const my=y%4===3,off=((y>>2)%2)*4,mx=(x+off)%8===7;if(my||mx)return rgb(188,188,188);const d=jit(20);return rgb(150+d,70+d,60+d)}));
const glassTex = canvasTex(g=>{g.clearRect(0,0,16,16);pix(g,(x,y)=>{if(x===0||y===0||x===15||y===15)return rgb(200,225,235,.9);if((x+y)%7===0&&x>2&&x<13)return rgb(230,245,255,.5);return rgb(200,230,245,.13)})});
const torchTex = canvasTex(g=>{g.clearRect(0,0,16,16);pix(g,(x,y)=>{
  if(x>=7&&x<=8&&y>=6&&y<=15){const d=jit(16);return rgb(120+d,84+d,45+d);}
  if(x>=6&&x<=9&&y>=3&&y<=5)return rgb(255,208,110);
  if(x>=7&&x<=8&&y===2)return rgb(255,240,180);
  return null;})});
const fenceTex = canvasTex(g=>pix(g,(x,y)=>{
  const post=(x<3||x>12||(x>=7&&x<=8)), bar=(y>=4&&y<=5)||(y>=10&&y<=11);
  if(post||bar){const d=jit(14);return rgb(150+d,112+d,68+d);}
  const d=jit(10);return rgb(105+d,78+d,48+d);}));
const woolTex  = canvasTex(g=>pix(g,()=>{const d=jit(16);return rgb(238+d,236+d,230+d)}));

const M=(x,tr)=>new THREE.MeshLambertMaterial({map:x.t, transparent:!!tr});
const mDirt=M(dirtTex), mGrassTop=M(grassTop), mGrassSide=M(grassSide), mStone=M(stoneTex),
      mLogSide=M(logSide), mLogTop=M(logTop), mLeaf=M(leafTex,true), mSand=M(sandTex),
      mPlank=M(plankTex), mBrick=M(brickTex), mGlass=M(glassTex,true);
const six=m=>[m,m,m,m,m,m];

export const TYPES = {
  1:{name:'Grass', mats:[mGrassSide,mGrassSide,mGrassTop,mDirt,mGrassSide,mGrassSide], icon:grassSide.url, hard:.75, pc:0x5cab3c},
  2:{name:'Dirt',  mats:six(mDirt),  icon:dirtTex.url,  hard:.6,  pc:0x866043},
  3:{name:'Stone', mats:six(mStone), icon:stoneTex.url, hard:3,   pc:0x808080},
  4:{name:'Log',   mats:[mLogSide,mLogSide,mLogTop,mLogTop,mLogSide,mLogSide], icon:logSide.url, hard:1.6, pc:0x6d5432},
  5:{name:'Leaves',mats:six(mLeaf),  icon:leafTex.url,  hard:.3,  pc:0x3a7d28},
  6:{name:'Sand',  mats:six(mSand),  icon:sandTex.url,  hard:.55, pc:0xdacc96},
  7:{name:'Planks',mats:six(mPlank), icon:plankTex.url, hard:1.4, pc:0xb28a5a},
  8:{name:'Brick', mats:six(mBrick), icon:brickTex.url, hard:3,   pc:0x96463c},
  9:{name:'Glass', mats:six(mGlass), icon:glassTex.url, hard:.5,  pc:0xc8e6f5},
  10:{name:'Torch', mats:six(M(torchTex,true)), icon:torchTex.url, hard:.2, pc:0xffb066, light:{c:0xffb066,i:.9}},
  11:{name:'Fence', mats:six(M(fenceTex)), icon:fenceTex.url, hard:1.2, pc:0x96703f, tool:'axe'},
  12:{name:'Wool',  mats:six(M(woolTex)),  icon:woolTex.url,  hard:.4,  pc:0xeeebe6},
};
// ---- Generated textures for content-defined blocks ----
function texFrom(desc){
  const [kind,a,b] = desc;
  const cr = n=>[(n>>16)&255,(n>>8)&255,n&255];
  if(kind==='glassy'){
    const [r,g,bl] = cr(a);
    return canvasTex(gc=>{gc.clearRect(0,0,16,16);pix(gc,(x,y)=>{
      if(x===0||y===0||x===15||y===15) return rgb(r,g,bl,.9);
      if((x+y)%6===0) return rgb(Math.min(255,r+30),Math.min(255,g+30),Math.min(255,bl+30),.45);
      return rgb(r,g,bl,.2);});});
  }
  if(kind==='water'){
    // Soft liquid — no glass-style hard borders
    const [r,g,bl] = cr(a);
    return canvasTex(gc=>{
      gc.clearRect(0,0,16,16);
      pix(gc,(x,y)=>{
        const wave = Math.sin((x + y*0.7)*0.9)*8 + Math.sin((x*0.5 - y)*1.1)*5;
        const d = jit(10) + wave;
        const a = 0.42 + (wave > 0 ? 0.08 : 0) + (y < 3 ? 0.12 : 0); // brighter near "surface" rows
        return rgb(
          Math.min(255, r + d*0.4|0),
          Math.min(255, g + 20 + d*0.5|0),
          Math.min(255, bl + 30 + d*0.3|0),
          Math.max(0.28, Math.min(0.72, a))
        );
      });
    });
  }
  const [r,g,bl] = cr(a);
  if(kind==='noise'){
    const v = b||16;
    return canvasTex(gc=>pix(gc,()=>{const d=jit(v);return rgb(r+d,g+d,bl+d)}));
  }
  if(kind==='bricks'){
    const [mr,mg,mb] = cr(b);
    return canvasTex(gc=>pix(gc,(x,y)=>{
      const my=y%4===3, off=((y>>2)%2)*4, mx=(x+off)%8===7;
      if(my||mx) return rgb(mr,mg,mb);
      const d=jit(18); return rgb(r+d,g+d,bl+d);}));
  }
  if(kind==='planks'){
    return canvasTex(gc=>pix(gc,(x,y)=>{
      const seam=(y%4===3)?-38:0, off=((y>>2)%2)*8, end=((x+off)%8===7)?-28:0, d=jit(12);
      return rgb(r+seam+end+d, g+seam+end+d, bl+seam+end+d);}));
  }
  if(kind==='speckle'){
    const [fr,fg,fb] = cr(b);
    return canvasTex(gc=>pix(gc,()=>{
      if(Math.random()<.16) return rgb(fr+jit(14),fg+jit(14),fb+jit(14));
      const d=jit(14); return rgb(r+d,g+d,bl+d);}));
  }
  if(kind==='bands'){
    const [br,bg,bb] = cr(b);
    return canvasTex(gc=>pix(gc,(x,y)=>{
      const band = (y>>2)%2===1, d=jit(12);
      return band ? rgb(br+d,bg+d,bb+d) : rgb(r+d,g+d,bl+d);}));
  }
  if(kind==='ladder'){
    const [r,g2,bl] = cr(a);
    return canvasTex(gc=>{gc.clearRect(0,0,16,16);pix(gc,(x,y)=>{
      const rail = x===2||x===3||x===12||x===13;
      const rung = (y===2||y===6||y===10||y===14) && x>=2 && x<=13;
      if(rail||rung){const d=jit(14);return rgb(r+d,g2+d,bl+d);}
      return null;});});
  }
  if(kind==='ore'){
    const [r,g2,bl] = cr(a);
    const [fr,fg,fb] = cr(b);
    return canvasTex(gc=>{
      pix(gc,()=>{const d=jit(22);return rgb(r+d,g2+d,bl+d)});
      for(let i=0;i<5;i++){
        const x=1+Math.floor(Math.random()*13), y=1+Math.floor(Math.random()*13);
        gc.fillStyle = rgb(fr+jit(20),fg+jit(20),fb+jit(20));
        gc.fillRect(x,y,2,2);
        gc.fillStyle = rgb(fr+40,fg+40,fb+40);
        gc.fillRect(x,y,1,1);
      }
    });
  }
  if(kind==='checker'){
    const [br,bg,bb] = cr(b);
    return canvasTex(gc=>pix(gc,(x,y)=>{
      const alt = ((x>>2)+(y>>2))%2===1, d=jit(10);
      return alt ? rgb(br+d,bg+d,bb+d) : rgb(r+d,g+d,bl+d);}));
  }
  if(kind==='chest'){
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(12), band=(y>=6&&y<=8)?-35:0;
        gc.fillStyle=rgb(r+band+d,g+band+d,bl+band+d);
        gc.fillRect(x,y,1,1);
      }
      gc.fillStyle=rgb(180,150,40); gc.fillRect(7,7,2,3); // latch
      gc.fillStyle=rgb(r-40,g-40,bl-40); gc.fillRect(0,0,16,1); gc.fillRect(0,15,16,1);
    });
  }
  if(kind==='keg'){
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(14), ring=((y%5)===0)?-40:0;
        gc.fillStyle=rgb(r+ring+d,g+ring+d,bl+ring+d);
        gc.fillRect(x,y,1,1);
      }
      gc.fillStyle=rgb(40,40,40); gc.fillRect(6,1,4,3); // bung
      gc.fillStyle=rgb(200,60,40); gc.fillRect(7,0,2,2); // warning
    });
  }
  if(kind==='bed'){
    // Top-down bed icon: pillow + blanket + wood frame
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(10);
        const edge = x<=1||x>=14||y<=1||y>=14;
        if(edge) gc.fillStyle=rgb(90+d,55+d,28+d);
        else if(y>=11) gc.fillStyle=rgb(235+d,230+d,220+d); // pillow
        else if(y===10) gc.fillStyle=rgb(200+d,200+d,195+d); // seam
        else gc.fillStyle=rgb(r+d, g+d*0.3|0, bl+d*0.3|0); // blanket
        gc.fillRect(x,y,1,1);
      }
      // white stripe on blanket
      gc.fillStyle=rgb(245,245,245);
      for(let x=3;x<13;x++) gc.fillRect(x,5,1,2);
    });
  }
  if(kind==='stairs'){
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(12);
        // stepped silhouette
        const step = Math.floor(y/4);
        const solid = x >= 16 - (step+1)*4;
        gc.fillStyle = solid ? rgb(r+d,g+d,bl+d) : rgb(r-40,g-40,bl-40);
        gc.fillRect(x,y,1,1);
      }
    });
  }
  if(kind==='slab'){
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(12);
        const solid = y >= 8;
        gc.fillStyle = solid ? rgb(r+d,g+d,bl+d) : rgb(40,40,45);
        gc.fillRect(x,y,1,1);
      }
    });
  }
  if(kind==='trapdoor'){
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(12), seam=(x%4===0)?-20:0;
        gc.fillStyle=rgb(r+seam+d,g+seam+d,bl+seam+d);
        gc.fillRect(x,y,1,1);
      }
      gc.fillStyle=rgb(200,180,60); gc.fillRect(7,7,2,2);
    });
  }
  if(kind==='door' || kind==='doortop' || kind==='dooropen' || kind==='doortopopen'){
    const open = kind.includes('open');
    const top = kind.includes('top');
    return canvasTex(gc=>{
      gc.fillStyle = rgb(r, g, bl);
      gc.fillRect(0,0,16,16);
      // wood planks grain
      for(let y=0;y<16;y++) for(let x=0;x<16;x++){
        const d=jit(14), seam=(x%4===0)?-25:0;
        gc.fillStyle = rgb(r+seam+d, g+seam+d, bl+seam+d);
        gc.fillRect(x,y,1,1);
      }
      // frame
      gc.fillStyle = rgb(r-30,g-30,bl-30);
      gc.fillRect(0,0,16,1); gc.fillRect(0,15,16,1); gc.fillRect(0,0,1,16); gc.fillRect(15,0,1,16);
      if(!top){
        // handle
        gc.fillStyle = rgb(200,180,60);
        gc.fillRect(open ? 3 : 12, 7, 2, 3);
      }
      if(open){
        // suggest ajar — dark strip
        gc.fillStyle = rgb(30,30,40,0.55);
        gc.fillRect(0,0,5,16);
      }
    });
  }
}
for(const id in EXTRA_BLOCKS){
  const d = EXTRA_BLOCKS[id];
  const t = texFrom(d.tex);
  TYPES[id] = {name:d.name, mats:six(M(t, d.transparent)), icon:t.url, hard:d.hard, pc:d.pc,
               light:d.light||null, tool:d.tool||null};
}
export const LIGHT_BLOCKS = {10:{c:0xffb066,i:.9}};
// WATER_MAT_OVERRIDE — liquid look (not glass cubes)
if(TYPES[64]){
  const wt = texFrom(['water', 0x2f7eb8]);
  const mk = (opacity, bright=0)=>{
    const m = new THREE.MeshLambertMaterial({
      map: wt.t,
      color: bright ? 0x6ec0f0 : 0x3a8fd0,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    return m;
  };
  // brighter top face, softer sides
  const side = mk(0.48), top = mk(0.58, 1), bot = mk(0.4);
  TYPES[64].mats = [side, side, top, bot, side, side];
  TYPES[64].icon = wt.url;
}

for(const id in TYPES) if(TYPES[id].light) LIGHT_BLOCKS[id] = {c:TYPES[id].light.c, i:TYPES[id].light.i};

export const TOOLS = [
  {id:'hand',   name:'Hand',    icon:'✋',  good:[]},
  {id:'pick',   name:'Pickaxe', icon:'⛏️', good:[3,8,9]},
  {id:'axe',    name:'Axe',     icon:'🪓', good:[4,5,7,11]},
  {id:'shovel', name:'Shovel',  icon:'🪏', good:[1,2,6]},
];
for(const id in TYPES){
  const tl = TYPES[id].tool;
  if(tl){ const t = TOOLS.find(x=>x.id===tl); if(t && !t.good.includes(+id)) t.good.push(+id); }
}
export const SKINS = [
  {name:'Alex',   skin:0xdba97c, hair:0x5b3a1e, shirt:0x2c7fb8, pants:0x3a3f5c, eyes:0x3b6ea5},
  {name:'Scout',  skin:0xd8a271, hair:0x1d1d1d, shirt:0x4caf50, pants:0x33691e, eyes:0x3f7d3a},
  {name:'Miner',  skin:0xc98e5a, hair:0x8a4b1f, shirt:0xe07b39, pants:0x5d4037, eyes:0x5d4a2f},
  {name:'Frost',  skin:0xf0c8a0, hair:0xe8dcb8, shirt:0x90caf9, pants:0x78909c, eyes:0x4f8fc7},
  {name:'Shadow', skin:0x8d6e63, hair:0x0d0d0d, shirt:0x37474f, pants:0x212121, eyes:0xb03a2e},
];

export const ITEMS = { // non-block inventory items
  101:{name:'Porkchop', icon:'🍖', food:8},
  102:{name:'Mutton',   icon:'🥩', food:6},
  103:{name:'Chicken',  icon:'🍗', food:5},
  110:{name:'Stick',    icon:'🥢'},
};
Object.assign(ITEMS, EXTRA_ITEMS);
export const ZOMBIE_SKIN = {key:'zombie', name:'Zombie', skin:0x57a05a, hair:0x2f6d30, shirt:0x2e8b8b, pants:0x5b4a8a, eyes:0x111111};

// ---- Pixel faces & Minecraft-style characters ----
const hex = n=>'#'+n.toString(16).padStart(6,'0');
const skinTexCache = {};
function skinTextures(sk, key){
  if(skinTexCache[key]) return skinTexCache[key];
  const face = canvasTex(g=>{
    pix(g,(x,y)=>{
      if(y<5) return hex(sk.hair);                                    // hair
      if(y===5 && (x<3||x>12)) return hex(sk.hair);                   // fringe corners
      if(y===8 && (x===4||x===5||x===10||x===11)) return '#ffffff';   // eye whites
      const d=jit(14); return rgb((sk.skin>>16)+d, ((sk.skin>>8)&255)+d, (sk.skin&255)+d);
    });
    g.fillStyle = hex(sk.eyes); g.fillRect(5,8,1,1); g.fillRect(10,8,1,1); // pupils
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(6,12,4,1);                 // mouth
  });
  const side = canvasTex(g=>pix(g,(x,y)=>{
    if(y<5) return hex(sk.hair);
    const d=jit(14); return rgb((sk.skin>>16)+d, ((sk.skin>>8)&255)+d, (sk.skin&255)+d);
  }));
  const mSide = M(side), mHair = new THREE.MeshLambertMaterial({color:sk.hair}),
        mSkin = new THREE.MeshLambertMaterial({color:sk.skin});
  // face on +z (character's forward)
  const headMats = [mSide, mSide, mHair, mSkin, M(face), mSide];
  skinTexCache[key] = { headMats, faceURL: face.url };
  return skinTexCache[key];
}
const skinOf = s => (typeof s==='number') ? (SKINS[s]||SKINS[0]) : s;
const keyOf  = s => (typeof s==='number') ? 'idx'+s : (s.key||s.name);
export const faceURL = idx=>skinTextures(skinOf(idx), keyOf(idx)).faceURL;

// A limb pivoting at its top (shoulder/hip) so rotation.x swings naturally
function limb(x, pivotY, w, topH, topCol, botH, botCol){
  const g = new THREE.Group();
  g.position.set(x, pivotY, 0);
  g.add(box(w, topH, w, topCol, 0, -topH/2, 0));
  g.add(box(w, botH, w, botCol, 0, -topH - botH/2, 0));
  return g;
}
export function makeCharacter(skinLike, withHead=true){
  const sk = skinOf(skinLike);
  const g = new THREE.Group();
  const shoe = 0x2b2b2b;
  const legL = limb( .13, .7, .2,  .5, sk.pants, .2, shoe);
  const legR = limb(-.13, .7, .2,  .5, sk.pants, .2, shoe);
  const armL = limb(-.34, 1.4, .16, .25, sk.shirt, .35, sk.skin); // sleeve + forearm
  const armR = limb( .34, 1.4, .16, .25, sk.shirt, .35, sk.skin);
  g.add(legL, legR, armL, armR);
  const torso = box(.5,.7,.28, sk.shirt, 0,1.05,0);
  g.add(torso);
  let head = null;
  if(withHead){
    head = new THREE.Mesh(new THREE.BoxGeometry(.44,.44,.44), skinTextures(sk, keyOf(skinLike)).headMats);
    head.position.set(0,1.62,0);
    g.add(head);
  }
  return {g, head, armL, armR, legL, legR, torso, sk, armorG:null};
}

/** Tint / attach armor meshes so local + remote players show equipped gear */
export function applyCharacterArmor(parts, armor){
  if(!parts?.g) return;
  const a = armor || {};
  // wipe previous attachments
  if(parts.armorG){ parts.g.remove(parts.armorG); }
  parts.armorG = new THREE.Group();
  parts.g.add(parts.armorG);

  const col = (id, fallback) => (id && ITEMS[id]?.color != null) ? ITEMS[id].color : fallback;

  // Chest → torso recolor
  if(parts.torso){
    parts.torso.material.color.setHex(a.chest ? col(a.chest, 0x6B4423) : parts.sk.shirt);
  }
  // Legs → upper leg recolor (first child of limb is the thigh box)
  const pantCol = a.legs ? col(a.legs, 0x5A3A1E) : parts.sk.pants;
  for(const leg of [parts.legL, parts.legR]){
    if(!leg) continue;
    const thigh = leg.children?.[0];
    if(thigh?.material) thigh.material.color.setHex(pantCol);
  }
  // Boots → lower leg / shoe
  const bootCol = a.feet ? col(a.feet, 0x3E2A18) : 0x2b2b2b;
  for(const leg of [parts.legL, parts.legR]){
    if(!leg) continue;
    const shoeM = leg.children?.[1];
    if(shoeM?.material) shoeM.material.color.setHex(bootCol);
  }
  // Helmet on head
  if(a.head){
    const hc = col(a.head, 0x8B5A2B);
    parts.armorG.add(box(.5,.16,.5, hc, 0, 1.82, 0));
    parts.armorG.add(box(.52,.12,.2, hc, 0, 1.72, 0.18)); // brim
  }
  // Shield on left arm
  if(a.off){
    const sc = col(a.off, 0x8B6914);
    const sh = box(.08,.42,.32, sc, -.48, 1.15, .12);
    parts.armorG.add(sh);
    // boss
    parts.armorG.add(box(.04,.1,.1, 0xc0c0c0, -.54, 1.15, .12));
  }
}


// ---- Small helpers used by hand, avatars, animals ----
export function box(w,h,d,color,x,y,z){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshLambertMaterial({color}));
  m.position.set(x,y,z);
  return m;
}
export function makeToolModel(id){
  // 3D prop for remote avatars / third-person
  const g = new THREE.Group();
  if(id==='pick'){
    g.add(box(.06,.48,.06,0x8a5a2b,0,.14,0));
    g.add(box(.42,.08,.08,0xa0a0a0,0,.38,0));
    g.add(box(.08,.1,.08,0x888888,-.18,.34,0));
    g.add(box(.08,.1,.08,0x888888, .18,.34,0));
  } else if(id==='axe'){
    g.add(box(.06,.48,.06,0x8a5a2b,0,.14,0));
    g.add(box(.2,.22,.07,0xa0a0a0,.12,.36,0));
  } else if(id==='shovel'){
    g.add(box(.06,.5,.06,0x8a5a2b,0,.16,0));
    g.add(box(.16,.2,.05,0xb8b8b8,0,.46,0));
  }
  return g;
}

/** First-person tool display — same emoji as the hotbar icon */
export function makeToolIconPlane(toolId, size=1.1){
  const t = TOOLS.find(x => x.id === toolId);
  const emoji = t?.icon || '🔧';
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,256,256);
  ctx.font = '200px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillText(emoji, 132, 140);
  ctx.fillStyle = '#000';
  ctx.fillText(emoji, 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}

// ---- Target outline + ghost placement preview ----------------------------
// A black wireframe on the block under the crosshair (which block you're
// aiming at) plus a translucent ghost cube at the cell where a new block will
// land. Pure visual feedback — the placement math is unchanged.
const _targetOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 }));
_targetOutline.visible = false;
_targetOutline.renderOrder = 999;
scene.add(_targetOutline);

// Slightly oversized so it reads as a highlight ON the block when the ghost
// lands on an occupied cell (flush paving) instead of z-fighting with it.
const _ghostBox = new THREE.Mesh(
  new THREE.BoxGeometry(1.03, 1.03, 1.03),
  new THREE.MeshBasicMaterial({ color: 0x9fd6ff, transparent: true, opacity: 0.3, depthWrite: false }));
_ghostBox.visible = false;
_ghostBox.renderOrder = 998;
scene.add(_ghostBox);
const _ghostEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
_ghostBox.add(_ghostEdges);

/** hit / place are [x,y,z] block cells (or null). Positions the outline + ghost. */
export function updatePlacePreview(hit, place){
  if(hit){ _targetOutline.position.set(hit[0], hit[1], hit[2]); _targetOutline.visible = true; }
  else _targetOutline.visible = false;
  if(place){ _ghostBox.position.set(place[0], place[1], place[2]); _ghostBox.visible = true; }
  else _ghostBox.visible = false;
}

export function makeBlockCube(tid, size=.34){
  const mats = TYPES[tid]?.mats;
  if(!mats){
    // fallback plain cube so missing TYPES never blank the hand
    return new THREE.Mesh(new THREE.BoxGeometry(size,size,size),
      new THREE.MeshLambertMaterial({color:0xaaaaaa}));
  }
  return new THREE.Mesh(new THREE.BoxGeometry(size,size,size), mats);
}

/** First-person held model for non-block items — 3D snacks when possible, else icon plane. */
export function makeHeldItemIcon(itemId, size=.45){
  const it = ITEMS[itemId];
  const id = itemId;
  // Simple 3D food props
  if(it?.food){
    const g = new THREE.Group();
    if(id===101||id===150){ // pork / seared
      g.add(box(.28,.12,.18, 0xc47a5a, 0,0,0));
      g.add(box(.2,.06,.12, 0xe8b896, 0,.06,0));
    } else if(id===113||id===161){ // apple / pie
      g.add(box(.22,.22,.22, 0xd9453d, 0,0,0));
      g.add(box(.04,.1,.04, 0x5a3a1a, 0,.14,0));
      g.add(box(.1,.04,.04, 0x3a9a3a, .06,.12,0));
    } else if(id===114){ // berries
      g.add(box(.1,.1,.1, 0x5b2c8a, -.06,0,0));
      g.add(box(.1,.1,.1, 0x6c3483, .06,0,0));
      g.add(box(.1,.1,.1, 0x4a235a, 0,.08,0));
    } else if(id===103||id===152){ // chicken
      g.add(box(.16,.16,.28, 0xe8d5a3, 0,0,0));
      g.add(box(.08,.06,.08, 0xe67e22, .1,.04,.1));
    } else {
      // generic loaf / bowl
      g.add(box(.28,.1,.2, 0xd4a574, 0,0,0));
      g.add(box(.24,.08,.16, 0xf5c98a, 0,.06,0));
    }
    g.scale.set(1.3,1.3,1.3);
    return g;
  }
  // materials / other — emoji plane
  const icon = it?.icon || '❓';
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0,0,64,64);
  g.font = '52px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthTest: true, side: THREE.DoubleSide,
    alphaTest: 0.1,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}

/** Weapon model tinted by damage tier so each sword looks distinct. */
export function makeWeaponModel(itemId){
  const dmg = ITEMS[itemId]?.dmg || 3;
  // fall through
  const blade =
    dmg >= 8 ? 0xb8f0ff :   // crystal
    dmg >= 6 ? 0xc9cdd2 :   // iron
    dmg >= 5 ? 0xb0b0b0 :   // spear-ish
    dmg >= 4 ? 0x9a9a9a :   // stone/bone
               0xd2b48c;    // wood
  const grip = dmg >= 6 ? 0x4a4a50 : 0x8a5a2b;
  const g = new THREE.Group();
  g.add(box(.05,.16,.05, grip, 0,-.02,0));
  g.add(box(.14,.04,.06, 0x6a6a6a, 0,.07,0));
  g.add(box(.05,.42,.03, blade, 0,.3,0));
  return g;
}

// ---- Chunk meshing ----
const geo = new THREE.BoxGeometry(1,1,1);
const chunkMeshes = new Array(CHUNKS*CHUNKS).fill(null);
const dummy = new THREE.Object3D();

function isCustomMeshBlock(t){
  return t===10 || t===11 || t===44
    || (t>=48&&t<=55) || (t>=70&&t<=93)
    || t===56 || t===58 || t===59 || t===60 || t===61 || t===62 || t===63 || t===65
    || t===66 || t===67 || t===68 || t===69
    || t===64; // water — surface faces only (not glass cubes)
}
let waterFaceMat = null; // top sheet
let waterSideMat = null;
export function tickWaterAnim(dt){
  const tex = waterFaceMat?.userData?.flowTex;
  if(!tex) return;
  // Clearly visible flow
  tex.offset.x = (tex.offset.x + dt * 0.22) % 1;
  tex.offset.y = (tex.offset.y + dt * 0.14) % 1;
}

// ---- Wind on leaves (and tall grass markers) ----
const windMeshes = []; // InstancedMesh with userData.windPts
let windT = 0;
export function tickWind(dt){
  windT += dt;
  for(const im of windMeshes){
    const pts = im.userData.windPts;
    if(!pts || !im.parent) continue;
    for(let i = 0; i < pts.length; i++){
      const [x, y, z] = pts[i];
      const s = Math.sin(windT * 1.7 + x * 0.38 + z * 0.31) * 0.11;
      const c = Math.cos(windT * 1.25 + x * 0.22 + z * 0.18) * 0.07;
      dummy.position.set(x + s, y, z + c);
      dummy.rotation.set(c * 0.35, 0, s * 0.45);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  }
  // Plants (cross-planes) sway gently
  if(typeof specialMeshes !== 'undefined'){
    for(const m of specialMeshes.values()){
      if(!m.userData?.isPlant) continue;
      const bx = m.userData.base?.[0] ?? m.position.x;
      const bz = m.userData.base?.[2] ?? m.position.z;
      m.rotation.z = Math.sin(windT * 2.1 + bx * 0.5) * 0.12;
      m.rotation.x = Math.cos(windT * 1.6 + bz * 0.4) * 0.06;
    }
  }
}
export function buildChunk(cx,cz){
  cx = ((cx % CHUNKS) + CHUNKS) % CHUNKS;
  cz = ((cz % CHUNKS) + CHUNKS) % CHUNKS;
  const ci = cIndex(cx,cz);
  if(chunkMeshes[ci]) for(const m of chunkMeshes[ci]){
    scene.remove(m);
    m.geometry.dispose();
    const wi = windMeshes.indexOf(m);
    if(wi >= 0) windMeshes.splice(wi, 1);
  }
  const chunk = ensureChunk(cx, cz), byType = {}, x0 = cx*CH, z0 = cz*CH;
  for(let y=0;y<WH;y++)for(let lz=0;lz<CH;lz++)for(let lx=0;lx<CH;lx++){
    const t = chunk[bIndex(lx,y,lz)];
    if(!t || isCustomMeshBlock(t)) continue;
    const x = x0+lx, z = z0+lz;
    if(occludes(x+1,y,z)&&occludes(x-1,y,z)&&occludes(x,y+1,z)&&
       occludes(x,y-1,z)&&occludes(x,y,z+1)&&occludes(x,y,z-1)) continue;
    (byType[t] ||= []).push([x,y,z]);
  }
  const list = [];
  const center = new THREE.Vector3(x0+CH/2, WH/2, z0+CH/2);
  const radius = Math.sqrt(CH*CH/2 + WH*WH/4) + 1;
  for(const id in byType){
    const mats = TYPES[id]?.mats;
    if(!mats) continue; // never crash boot on missing material
    const pts = byType[id];
    const g = geo.clone();
    g.boundingSphere = new THREE.Sphere(center.clone(), radius);
    const im = new THREE.InstancedMesh(g, mats, pts.length);
    pts.forEach((p,i)=>{ dummy.position.set(p[0],p[1],p[2]); dummy.rotation.set(0,0,0); dummy.scale.set(1,1,1); dummy.updateMatrix(); im.setMatrixAt(i,dummy.matrix); });
    im.instanceMatrix.needsUpdate = true;
    // Leaves catch the wind
    if(+id === 5 || +id === 98 || +id === 99 || +id === 100 || +id === 101){
      im.userData.windPts = pts.map(p => [p[0], p[1], p[2]]);
      windMeshes.push(im);
    }
    scene.add(im);
    list.push(im);
  }
  // Water — Minecraft-style flowing top texture (not glass cubes)
  {
    const tops = [];
    for(let y=0;y<WH;y++) for(let lz=0;lz<CH;lz++) for(let lx=0;lx<CH;lx++){
      if(chunk[bIndex(lx,y,lz)] !== 64) continue;
      const x = x0+lx, z = z0+lz;
      if(getBlock(x, y+1, z) === 64) continue;
      tops.push([x, y, z]);
    }
    if(tops.length){
      if(!waterFaceMat){
        // Classic-style 16×16 flowing water texture
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d');
        for(let y=0;y<16;y++) for(let x=0;x<16;x++){
          const wave = Math.sin((x + y*1.3)*0.7)*4 + Math.sin((x*0.4 - y)*0.9)*3;
          const band = ((x + y*2 + (wave|0)) % 5);
          // deep blue base → lighter flow streaks
          let R=18, G=70, B=160;
          if(band === 0){ R=40; G=110; B=210; }
          else if(band === 1){ R=28; G=90; B=185; }
          else if(band === 3){ R=22; G=80; B=175; }
          R = Math.max(0, Math.min(255, R + ((x*3+y*7)&3)));
          G = Math.max(0, Math.min(255, G + ((x*5+y*2)&3)));
          B = Math.max(0, Math.min(255, B + ((x+y)&2)));
          g.fillStyle = 'rgb('+R+','+G+','+B+')';
          g.fillRect(x,y,1,1);
        }
        const tex = new THREE.CanvasTexture(c);
        tex.magFilter = tex.minFilter = THREE.NearestFilter;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        waterFaceMat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.92,
          depthWrite: true,
          side: THREE.FrontSide,
        });
        waterFaceMat.userData.flowTex = tex;
      }
      const pgeo = new THREE.PlaneGeometry(1.01, 1.01);
      const im = new THREE.InstancedMesh(pgeo, waterFaceMat, tops.length);
      const orient = new THREE.Object3D();
      tops.forEach((p, i)=>{
        const [x,y,z] = p;
        orient.position.set(x, y + 0.4, z);
        orient.rotation.set(-Math.PI/2, 0, 0);
        orient.updateMatrix();
        im.setMatrixAt(i, orient.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      im.renderOrder = 3;
      scene.add(im);
      list.push(im);
    }
  }
  chunkMeshes[ci] = list;
}
export function buildAllChunks(){
  // Streamed world: small bubble at boot (rest loads while playing)
  const pcx = CENTER >> 4, pcz = CENTER >> 4;
  const R = 4; // 9x9 chunks — fast load; updateChunkVisibility fills the rest
  for(let dz = -R; dz <= R; dz++) for(let dx = -R; dx <= R; dx++){
    const cx = (pcx + dx + CHUNKS) % CHUNKS;
    const cz = (pcz + dz + CHUNKS) % CHUNKS;
    buildChunk(cx, cz);
  }
}
export function disposeChunkMeshes(cx, cz){
  const ci = cIndex(cx, cz);
  if(!chunkMeshes[ci]) return;
  for(const m of chunkMeshes[ci]){
    scene.remove(m);
    m.geometry.dispose();
    const wi = windMeshes.indexOf(m);
    if(wi >= 0) windMeshes.splice(wi, 1);
  }
  chunkMeshes[ci] = null;
}
export function rebuildAt(x,z){
  x = wrapC(x); z = wrapC(z);
  const cx = x>>4, cz = z>>4;
  buildChunk(cx,cz);
  if((x&15)===0)  buildChunk((cx+CHUNKS-1)%CHUNKS, cz);
  if((x&15)===15) buildChunk((cx+1)%CHUNKS, cz);
  if((z&15)===0)  buildChunk(cx, (cz+CHUNKS-1)%CHUNKS);
  if((z&15)===15) buildChunk(cx, (cz+1)%CHUNKS);
}

// Only render chunks within view distance (toroidal-aware)
const VIEW_CHUNKS = Math.ceil(VIEW/CH)+1;
/** Shift v by k*WORLD so it sits as close as possible to ref (continuous player coords OK). */
export function wrapShift(v, ref){
  // nearest copy: v + k*WORLD ≈ ref
  return WORLD * Math.round((ref - v) / WORLD);
}
/** True distance across the wrap. */
export function wrapDist(x, z, px, pz){
  return Math.hypot(x + wrapShift(x,px) - px, z + wrapShift(z,pz) - pz);
}
/** Position a scene object on the near side of the seam, given its logical coords. */
export function placeWrapped(obj, x, y, z, px, pz){
  obj.position.set(x + wrapShift(x,px), y, z + wrapShift(z,pz));
}

export function updateChunkVisibility(px,pz){
  // Logical chunk under player (toroidal)
  const pcx = wrapC(Math.round(px))>>4, pcz = wrapC(Math.round(pz))>>4;
  // Build one ring beyond the visible radius, and keep two more (hysteresis), so
  // every drawn chunk is always meshed. The old min(…,8/10) caps throttled this
  // BELOW the visible radius on desktop, leaving a ring that was drawn but never
  // built — a sky band at the render edge. VIEW is fixed per device, so these are
  // bounded (desktop 10/12, mobile 6/8).
  const loadR = VIEW_CHUNKS + 1;
  const keepR = VIEW_CHUNKS + 3;

  for(let dz = -loadR; dz <= loadR; dz++) for(let dx = -loadR; dx <= loadR; dx++){
    const cx = (pcx + dx + CHUNKS) % CHUNKS;
    const cz = (pcz + dz + CHUNKS) % CHUNKS;
    const ci = cIndex(cx, cz);
    ensureChunk(cx, cz);
    if(!chunkMeshes[ci]) buildChunk(cx, cz);
  }

  // Only touch meshed chunks near the player (scan local ring, not all 16k)
  for(let dz = -keepR - 1; dz <= keepR + 1; dz++) for(let dx = -keepR - 1; dx <= keepR + 1; dx++){
    const cx = (pcx + dx + CHUNKS) % CHUNKS;
    const cz = (pcz + dz + CHUNKS) % CHUNKS;
    const ci = cIndex(cx, cz);
    const list = chunkMeshes[ci];
    if(!list) continue;
    let sx = cx - pcx; if(sx > CHUNKS/2) sx -= CHUNKS; if(sx < -CHUNKS/2) sx += CHUNKS;
    let sz = cz - pcz; if(sz > CHUNKS/2) sz -= CHUNKS; if(sz < -CHUNKS/2) sz += CHUNKS;
    const dist = Math.max(Math.abs(sx), Math.abs(sz));
    if(dist > keepR){
      for(const m of list){ scene.remove(m); m.geometry.dispose(); }
      chunkMeshes[ci] = null;
      continue;
    }
    const vis = dist <= VIEW_CHUNKS;
    // Continuous placement: shift chunk by k*WORLD so it sits nearest the player.
    // Instance matrices store coords in [0,WORLD); mesh.position adds ±k*WORLD.
    // As the player walks past the seam without snapping, k changes with no teleport.
    const baseX = cx * CH, baseZ = cz * CH;
    const offX = WORLD * Math.round((px - baseX) / WORLD);
    const offZ = WORLD * Math.round((pz - baseZ) / WORLD);
    for(const m of list){
      m.visible = vis;
      if(m.position.x !== offX || m.position.z !== offZ) m.position.set(offX, 0, offZ);
    }
  }
  // static block meshes (torches, doors) follow the same rule
  for(const m of torches.values()){
    const b = m.userData.base;
    if(b) placeWrapped(m, b[0], b[1], b[2], px, pz);
  }
  for(const m of doorMeshes.values()){
    const b = m.userData.base;
    if(b) placeWrapped(m, b[0], b[1], b[2], px, pz);
  }
  for(const m of bedMeshes.values()){
    const b = m.userData.base;
    if(b) placeWrapped(m, b[0], b[1], b[2], px, pz);
  }
  for(const m of specialMeshes.values()){
    const b = m.userData.base;
    if(b) placeWrapped(m, b[0], b[1], b[2], px, pz);
  }
}

// ---- Torches: individual small meshes + a pool of real point lights ----
export const torches = new Map(); // "x,y,z" -> mesh group
function makeTorchMesh(x,y,z){
  const g = new THREE.Group();
  g.add(box(.09,.45,.09, 0x7a5430, 0, -.08, 0));
  const tip = new THREE.Mesh(new THREE.BoxGeometry(.13,.13,.13), new THREE.MeshBasicMaterial({color:0xffd77a}));
  tip.position.y = .18; g.add(tip);
  g.position.set(x,y,z);
  g.userData.base = [x,y,z];
  return g;
}
export const lightBlocks = new Map(); // "x,y,z" -> {x,y,z,type}
export function trackTorch(x,y,z,prev,t){
  const k = wrapC(x)+','+y+','+wrapC(z);
  if(LIGHT_BLOCKS[prev]){
    lightBlocks.delete(k);
    if(prev===10 && torches.has(k)){ scene.remove(torches.get(k)); torches.delete(k); }
  }
  if(LIGHT_BLOCKS[t]){
    lightBlocks.set(k, {x:wrapC(x), y, z:wrapC(z), type:t});
    if(t===10 && !torches.has(k)){ const m = makeTorchMesh(wrapC(x),y,wrapC(z)); scene.add(m); torches.set(k,m); }
  }
}
const torchLights = Array.from({length:4},()=>{ const l=new THREE.PointLight(0xffb066, 0, 10); scene.add(l); return l; });
export function updateTorchLights(px,pz){
  const near = [];
  for(const lb of lightBlocks.values()){
    const d = wrapDist(lb.x, lb.z, px, pz);
    if(d<26) near.push([d,lb]);
  }
  near.sort((a,b)=>a[0]-b[0]);
  for(let i=0;i<torchLights.length;i++){
    const l = torchLights[i], e = near[i]?.[1];
    if(e){
      const spec = LIGHT_BLOCKS[e.type];
      placeWrapped(l, e.x, e.y+.4, e.z, px, pz);
      l.color.setHex(spec.c);
      l.intensity = spec.i;
    } else l.intensity = 0;
  }
}
export function nearestTorchDist(x,z){
  let best = 1e9;
  for(const lb of lightBlocks.values()){
    const d = wrapDist(lb.x, lb.z, x, z);
    if(d<best) best = d;
  }
  return best;
}


// ---- Doors: thin hinged panels (not full cubes) ----

// ---- Beds: low custom mesh (not a full cube) ----
export const bedMeshes = new Map();
// facing: 0=+Z, 1=+X, 2=-Z, 3=-X  — bed is 2 long × 1 wide (rectangle)
export const bedFacing = new Map(); // "x,y,z" foot key -> facing 0..3
function makeBedMesh(x, y, z, facing=0){
  const g = new THREE.Group();
  // Local model: length along +Z (foot at z=-0.5, head at z=+0.5), width along X
  // Legs at four corners of the 2×1 footprint
  for(const [lx,lz] of [[-.38,-.85],[-.38,.85],[.38,-.85],[.38,.85]]){
    g.add(box(.12,.2,.12, 0x6b4423, lx, -.4, lz));
  }
  // wood frame
  g.add(box(.9,.1,1.9, 0x8b5a2b, 0, -.25, 0));
  // mattress / blanket
  g.add(box(.84,.14,1.82, 0xc0392b, 0, -.1, 0));
  // white stripe across middle of blanket
  g.add(box(.84,.05,.22, 0xf5f5f5, 0, -.01, -.15));
  // pillow at head (+Z)
  g.add(box(.55,.12,.32, 0xf0ebe3, 0, .02, .72));
  // headboard
  g.add(box(.92,.32,.1, 0x6b4423, 0, -.02, .95));
  // footboard
  g.add(box(.88,.22,.08, 0x7a4a28, 0, -.08, -.95));
  // rotate so length points in facing direction; foot sits on the placed cell
  // model center is between foot and head; offset so foot cell is at origin
  g.children.forEach(ch=>{ ch.position.z += 0.5; }); // shift model so foot is near local 0
  g.rotation.y = facing * Math.PI/2;
  g.position.set(x, y, z);
  g.userData.base = [x, y, z];
  g.userData.facing = facing;
  return g;
}
export function trackBed(x,y,z,prev,t,facing){
  const k = wrapC(x)+','+y+','+wrapC(z);
  // removing foot clears mesh
  if((prev===58) && bedMeshes.has(k)){
    scene.remove(bedMeshes.get(k));
    bedMeshes.delete(k);
    bedFacing.delete(k);
  }
  if(t===58){
    if(bedMeshes.has(k)){ scene.remove(bedMeshes.get(k)); bedMeshes.delete(k); }
    const f = (facing!=null ? facing : bedFacing.get(k)) ?? 0;
    bedFacing.set(k, f);
    const m = makeBedMesh(wrapC(x), y, wrapC(z), f);
    scene.add(m);
    bedMeshes.set(k, m);
  }
  // Head placed: infer facing from adjacent foot and refresh mesh
  if(t===65){
    for(let f=0; f<4; f++){
      const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
      const [dx,dz] = dirs[f];
      const fx = wrapC(x-dx), fz = wrapC(z-dz);
      if(getBlock(fx,y,fz)===58){
        setBedFacing(fx,y,fz,f);
        break;
      }
    }
  }
  // Foot removed already handled; if head removed alone, clear facing leftovers
  if(prev===65 && t===0){ /* foot mesh remains until foot broken */ }
}
export function setBedFacing(x,y,z,facing){
  const k = wrapC(x)+','+y+','+wrapC(z);
  bedFacing.set(k, facing&3);
  // rebuild mesh if present
  if(bedMeshes.has(k)){
    scene.remove(bedMeshes.get(k));
    bedMeshes.delete(k);
  }
  if(getBlock(x,y,z)===58){
    const m = makeBedMesh(wrapC(x), y, wrapC(z), facing&3);
    scene.add(m);
    bedMeshes.set(k, m);
  }
}


// ---- Half-blocks, stairs, trapdoors, chest, fence, ladder (not full cubes) ----
export const specialMeshes = new Map();

function makeSlabMesh(x,y,z,tid){
  const g = new THREE.Group();
  const col = TYPES[tid]?.pc ?? 0xb8894a;
  g.add(box(1, .5, 1, col, 0, -.25, 0));
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
function makeStairsMesh(x,y,z,tid){
  const g = new THREE.Group();
  const col = TYPES[tid]?.pc ?? 0xb8894a;
  // two steps facing +Z
  g.add(box(1, .5, .5, col, 0, -.25, -.25));
  g.add(box(1, 1, .5, col, 0, 0, .25));
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
function makeTrapdoorMesh(x,y,z,open){
  const g = new THREE.Group();
  const wood = 0x8b6914, dark = 0x5c4010;
  const panel = new THREE.Group();
  panel.add(box(.9, .08, .9, wood, 0, 0, 0));
  panel.add(box(.92, .02, .06, dark, 0, .04, -.4));
  panel.add(box(.92, .02, .06, dark, 0, .04, .4));
  panel.add(box(.06, .02, .92, dark, -.4, .04, 0));
  panel.add(box(.06, .02, .92, dark, .4, .04, 0));
  if(open){
    // hinge up against +Z face
    panel.rotation.x = -Math.PI/2;
    panel.position.set(0, .45, .45);
  } else {
    panel.position.set(0, -.42, 0); // flat on floor of cell
  }
  g.add(panel);
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
function makeChestMesh(x,y,z){
  const g = new THREE.Group();
  const body = 0x9a6b3a, dark = 0x6b4423, lock = 0xd4b84a;
  g.add(box(.9, .7, .9, body, 0, -.15, 0));
  g.add(box(.92, .12, .92, dark, 0, .22, 0)); // lid rim
  g.add(box(.2, .12, .08, lock, 0, 0, .46)); // latch
  g.add(box(.88, .08, .88, 0xb8894a, 0, -.48, 0)); // feet plate
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
function makeFenceMesh(x,y,z){
  const g = new THREE.Group();
  const wood = 0x8a6236;
  g.add(box(.18, 1.0, .18, wood, 0, 0, 0)); // post
  g.add(box(.9, .12, .1, wood, 0, .15, 0));
  g.add(box(.9, .12, .1, wood, 0, -.15, 0));
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
function makeLadderMesh(x,y,z){
  const g = new THREE.Group();
  const wood = 0x8a6236;
  g.add(box(.08, 1, .08, wood, -.3, 0, -.42));
  g.add(box(.08, 1, .08, wood, .3, 0, -.42));
  for(let i=0;i<5;i++) g.add(box(.7, .06, .06, wood, 0, -0.35+i*0.18, -.42));
  g.position.set(x,y,z); g.userData.base=[x,y,z];
  return g;
}
export function trackSpecial(x,y,z,prev,t){
  const k = wrapC(x)+','+y+','+wrapC(z);
  const specialIds = new Set([11,44,56,59,60,61,62,63,66,67,68,69]);
  if(specialIds.has(prev) && specialMeshes.has(k)){
    scene.remove(specialMeshes.get(k)); specialMeshes.delete(k);
  }
  if(!specialIds.has(t)) return;
  if(specialMeshes.has(k)){ scene.remove(specialMeshes.get(k)); specialMeshes.delete(k); }
  let m;
  if(t===61) m = makeSlabMesh(wrapC(x),y,wrapC(z),t);
  else if(t===59||t===60) m = makeStairsMesh(wrapC(x),y,wrapC(z),t);
  else if(t===62||t===63) m = makeTrapdoorMesh(wrapC(x),y,wrapC(z),t===63);
  else if(t===56) m = makeChestMesh(wrapC(x),y,wrapC(z));
  else if(t===11) m = makeFenceMesh(wrapC(x),y,wrapC(z));
  else if(t===44) m = makeLadderMesh(wrapC(x),y,wrapC(z));
  else if(t===66||t===67||t===68||t===69) m = makePlantMesh(wrapC(x),y,wrapC(z),t);
  if(m){ scene.add(m); specialMeshes.set(k,m); }
}

function makePlantMesh(x,y,z,tid){
  const g = new THREE.Group();
  // cross planes (Minecraft-style)
  const c = document.createElement('canvas'); c.width=c.height=16;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,16,16);
  if(tid===66){
    // tall grass blades
    for(let i=0;i<5;i++){
      const px = 3+i*2.5;
      ctx.fillStyle = i%2? '#3d8f2e' : '#5bb340';
      ctx.fillRect(px, 4, 1.5, 12);
      ctx.fillRect(px-1, 6, 1, 4);
    }
  } else {
    // stem
    ctx.fillStyle = '#3a7a28';
    ctx.fillRect(7, 8, 2, 8);
    // petals
    const col = tid===67 ? '#e74c3c' : tid===68 ? '#f1c40f' : '#f5f5f5';
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(8, 6, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#f39c12';
    ctx.beginPath(); ctx.arc(8, 6, 1.5, 0, Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  const mat = new THREE.MeshBasicMaterial({ map:tex, transparent:true, alphaTest:0.15, side:THREE.DoubleSide, depthWrite:false });
  const p1 = new THREE.Mesh(new THREE.PlaneGeometry(1,1), mat);
  const p2 = p1.clone(); p2.rotation.y = Math.PI/2;
  g.add(p1); g.add(p2);
  g.position.set(x,y,z);
  g.userData.base=[x,y,z];
  g.userData.isPlant = true;
  return g;
}



export const doorMeshes = new Map(); // "x,y,z" -> group
function makeDoorMesh(x, y, z, facing, open, styleId=0){
  const g = new THREE.Group();
  const panel = new THREE.Group();
  // Everything is modelled AHEAD of the hinge (local +Z)
  const addFrame = (p, col, thick=.13) => {
    p.add(box(thick, 1.95, .06, col, 0, 0.975, .03));
    p.add(box(thick, 1.95, .06, col, 0, 0.975, .87));
    p.add(box(thick, .06, .9, col, 0, 1.92, .45));
    p.add(box(thick, .06, .9, col, 0, .05, .45));
    p.add(box(thick, .06, .9, col, 0, 1.0, .45)); // mid rail
  };
  const handle = (p, col, hx=.12) => p.add(box(.08,.08,.08, col, hx, 0.95, .74));

  if(styleId === 0){
    // Oak — four recessed panels
    const wood=0x9a6b2e, dark=0x5c4010, gold=0xd4b84a;
    panel.add(box(.1, 1.95, .9, wood, 0, 0.975, .45));
    addFrame(panel, dark, .12);
    // 4 panel insets
    panel.add(box(.06, .7, .32, 0xb8894a, -.02, 1.45, .28));
    panel.add(box(.06, .7, .32, 0xb8894a, -.02, 1.45, .62));
    panel.add(box(.06, .7, .32, 0xb8894a, -.02, 0.55, .28));
    panel.add(box(.06, .7, .32, 0xb8894a, -.02, 0.55, .62));
    handle(panel, gold);
  } else if(styleId === 1){
    // Dark — braced timber with X cross
    const wood=0x3e2a18, dark=0x1f150c, iron=0x888888;
    panel.add(box(.12, 1.95, .9, wood, 0, 0.975, .45));
    addFrame(panel, dark, .14);
    // diagonal braces (approx with thin boxes)
    panel.add(box(.08, 1.5, .08, dark, .02, 0.975, .45));
    panel.add(box(.08, .08, .7, dark, .02, 1.4, .45));
    panel.add(box(.08, .08, .7, dark, .02, 0.55, .45));
    // X mark
    panel.add(box(.05, 1.1, .08, 0x2a1c10, .04, 0.975, .45));
    handle(panel, iron, .14);
  } else if(styleId === 2){
    // Glass — wood frame + transparent panes
    const frame=0xc4a36a, dark=0x7a6238, gold=0xe8d48a;
    // outer frame only (no solid leaf)
    addFrame(panel, frame, .14);
    panel.add(box(.14, 1.95, .08, frame, 0, 0.975, .03));
    panel.add(box(.14, 1.95, .08, frame, 0, 0.975, .87));
    // vertical mullion
    panel.add(box(.1, 1.85, .06, dark, 0, 0.975, .45));
    // glass panes (MeshBasicMaterial-ish via box helper color)
    const glass = 0x9fd0e8;
    panel.add(box(.04, .8, .32, glass, 0, 1.42, .24));
    panel.add(box(.04, .8, .32, glass, 0, 1.42, .66));
    panel.add(box(.04, .8, .32, glass, 0, 0.52, .24));
    panel.add(box(.04, .8, .32, glass, 0, 0.52, .66));
    handle(panel, gold);
  } else {
    // Iron — heavy plates, rivets, barred window
    const metal=0x7a8088, dark=0x3a3e44, rust=0x6a5040, gold=0xc0c0c0;
    panel.add(box(.14, 1.95, .9, metal, 0, 0.975, .45));
    addFrame(panel, dark, .15);
    // upper window with bars
    panel.add(box(.04, .45, .4, 0x1a1a20, 0, 1.45, .45)); // dark recess
    panel.add(box(.06, .45, .04, dark, .02, 1.45, .30));
    panel.add(box(.06, .45, .04, dark, .02, 1.45, .45));
    panel.add(box(.06, .45, .04, dark, .02, 1.45, .60));
    // rivets
    for(const ry of [0.25, 0.975, 1.7]) for(const rz of [0.15, 0.75]){
      panel.add(box(.05,.05,.05, gold, .1, ry, rz));
    }
    handle(panel, 0x222222, .16);
  }

  panel.position.set(0, 0, -0.45);
  g.add(panel);
  g.position.set(x, y - 0.5, z);
  g.rotation.y = facing * Math.PI/2;
  panel.rotation.y = open ? -Math.PI/2 : 0;
  g.userData = {panel, facing, open, styleId, base:[x, y - 0.5, z]};
  return g;
}
export function trackDoor(x,y,z,prev,t){
  const k = wrapC(x)+','+y+','+wrapC(z);
  const wasDoor = !!doorStyleOf(prev);
  const style = doorStyleOf(t);
  if(wasDoor && doorMeshes.has(k)){
    scene.remove(doorMeshes.get(k));
    doorMeshes.delete(k);
  }
  if(style){
    // Upper half of a 2-tall door: no separate mesh (bottom owns the full model)
    if(doorStyleOf(getBlock(x, y-1, z))) return;
    const facing = (t - style.base) % 4;
    const open = (t - style.base) >= 4;
    if(doorMeshes.has(k)){ scene.remove(doorMeshes.get(k)); doorMeshes.delete(k); }
    const m = makeDoorMesh(wrapC(x), y, wrapC(z), facing, open, style.id);
    scene.add(m);
    doorMeshes.set(k, m);
  }
}
export function setDoorOpenVisual(x,y,z,open){
  const k = wrapC(x)+','+y+','+wrapC(z);
  const m = doorMeshes.get(k);
  if(!m) return;
  const panel = m.userData.panel;
  if(panel) panel.rotation.y = open ? -Math.PI * 0.55 : 0;
  m.userData.open = open;
}


// ---- Apply a block edit (local or from network). Returns the previous type. ----
let editRecorder = null;
export function setEditRecorder(fn){ editRecorder = fn; }
export function applyEdit(x,y,z,t,burst=true){
  const old = getBlock(x,y,z);
  setBlock(x,y,z,t);
  trackTorch(x,y,z,old,t);
  trackDoor(x,y,z,old,t);
  trackBed(x,y,z,old,t);
  trackSpecial(x,y,z,old,t);
  editRecorder?.(wrapC(x), y, wrapC(z), t);
  rebuildAt(x,z);
  if(burst){
    const color = TYPES[old||t]?.pc ?? 0xffffff;
    spawnParticles(x,y,z,color, old? 22 : 8);
  }
  // Optional physics hook (sand/gravel + leaf decay) — set from main to avoid cycles
  editPhysicsHook?.(x, y, z, old, t);
  return old;
}

/** Apply many edits at once: records them for saving, rebuilds each affected chunk ONCE.
 *  Deliberately does NOT run the physics hook (callers are physics/explosions themselves). */
export function applyEditsBatch(list){
  if(!list || !list.length) return;
  const dirty = new Set();
  const mark = (x,z)=>{
    const cx = x>>4, cz = z>>4;
    dirty.add(cx+','+cz);
    if((x&15)===0)  dirty.add(((cx+CHUNKS-1)%CHUNKS)+','+cz);
    if((x&15)===15) dirty.add(((cx+1)%CHUNKS)+','+cz);
    if((z&15)===0)  dirty.add(cx+','+((cz+CHUNKS-1)%CHUNKS));
    if((z&15)===15) dirty.add(cx+','+((cz+1)%CHUNKS));
  };
  for(const [rx,y,rz,t] of list){
    const x = wrapC(rx), z = wrapC(rz);
    const old = getBlock(x,y,z);
    setBlock(x,y,z,t);
    trackTorch(x,y,z,old,t);
    trackDoor(x,y,z,old,t); trackBed(x,y,z,old,t); trackSpecial(x,y,z,old,t);
    editRecorder?.(x, y, z, t);
    mark(x,z);
  }
  for(const k of dirty){ const [cx,cz] = k.split(',').map(Number); buildChunk(cx,cz); }
}
let editPhysicsHook = null;
export function setEditPhysicsHook(fn){ editPhysicsHook = fn; }


// ---- Particles ----
const pGeo = new THREE.BoxGeometry(.18,.18,.18);
const particles = [];
export function spawnParticles(x,y,z,color,n){
  if(isTouch) n = Math.ceil(n*.5);
  for(let i=0;i<n;i++){
    const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({color}));
    m.position.set(x+jit(.9), y+jit(.9), z+jit(.9));
    m.scale.setScalar(.8+Math.random()*.8);
    scene.add(m);
    particles.push({m, vel:new THREE.Vector3(jit(5.5), 2.5+Math.random()*3, jit(5.5)), life:.75});
  }
}
export function spawnDust(x,y,z,color){
  if(particles.length>220) return;
  const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({color, transparent:true, opacity:.65}));
  m.position.set(x+jit(.35), y, z+jit(.35));
  m.scale.setScalar(.35+Math.random()*.3);
  scene.add(m);
  particles.push({m, vel:new THREE.Vector3(jit(1), .5+Math.random()*.7, jit(1)), life:.4});
}
export function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.life -= dt;
    p.vel.y -= 14*dt;
    p.m.position.addScaledVector(p.vel, dt);
    p.m.scale.multiplyScalar(1 - dt*1.2);
    if(p.life<=0){ scene.remove(p.m); p.m.material.dispose(); particles.splice(i,1); }
  }
}

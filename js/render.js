// render.js — scene, textures, block/tool content, chunk meshing, particles
import { WORLD, WH, CH, CHUNKS, chunks, cIndex, bIndex, wrapC, occludes, getBlock, setBlock } from './world.js';

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const VIEW = isTouch ? 56 : 120;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, VIEW*.4, VIEW);
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
const DAY_LEN = 240;                      // seconds per full day
const skyDay = new THREE.Color(0x87ceeb), skyNight = new THREE.Color(0x0b1026), skyDusk = new THREE.Color(0xe8935a);
function discTex(color){
  const c=document.createElement('canvas'); c.width=c.height=64;
  const g=c.getContext('2d'); g.fillStyle=color; g.beginPath(); g.arc(32,32,26,0,7); g.fill();
  return new THREE.CanvasTexture(c);
}
const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({map:discTex('#ffe9a8'), fog:false}));
sunSpr.scale.set(9,9,1); scene.add(sunSpr);
const moonSpr = new THREE.Sprite(new THREE.SpriteMaterial({map:discTex('#dfe7ff'), fog:false}));
moonSpr.scale.set(5,5,1); scene.add(moonSpr);
const _sky = new THREE.Color();
export function setDayTime(t){ day.t = ((t%1)+1)%1; }
export function updateDayNight(dt, focus){
  day.t = (day.t + dt/DAY_LEN) % 1;
  const ang = day.t*Math.PI*2;
  const dir = new THREE.Vector3(Math.cos(ang), Math.sin(ang), .3).normalize();
  sun.position.copy(dir);
  const dl = Math.max(0, Math.min(1, dir.y*2.2 + .15));       // daylight 0..1
  const duskF = Math.max(0, 1 - Math.abs(dir.y)*4) * dl;      // near-horizon warmth
  _sky.copy(skyNight).lerp(skyDay, dl).lerp(skyDusk, duskF*.55);
  scene.background.copy(_sky);
  scene.fog.color.copy(_sky);
  ambLight.intensity = .18 + .45*dl;
  sun.intensity = .15 + .6*dl;
  sunSpr.position.copy(focus).addScaledVector(dir, VIEW*1.6);
  moonSpr.position.copy(focus).addScaledVector(dir, -VIEW*1.6);
  return dl; // 0 at night (mobs will want this later)
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
const logSide  = canvasTex(g=>pix(g,x=>{const bark=(x%4===0||x%7===0)?-30:0,d=jit(18);return rgb(109+bark+d,84+bark+d,50+bark+d)}));
const logTop   = canvasTex(g=>pix(g,(x,y)=>{const r=Math.max(Math.abs(x-7.5),Math.abs(y-7.5)),ring=Math.floor(r)%2===0?12:-14,d=jit(10);return rgb(160+ring+d,130+ring+d,85+ring+d)}));
const leafTex  = canvasTex(g=>pix(g,()=>{const d=jit(40),hole=Math.random()<.1?-45:0;return rgb(58+d+hole,125+d+hole,40+d+hole)}));
const sandTex  = canvasTex(g=>pix(g,()=>{const d=jit(20);return rgb(218+d,204+d,150+d)}));
const plankTex = canvasTex(g=>pix(g,(x,y)=>{const seam=(y%4===3)?-40:0,off=((y>>2)%2)*8,end=((x+off)%8===7)?-30:0,d=jit(14);return rgb(178+seam+end+d,138+seam+end+d,90+seam+end+d)}));
const brickTex = canvasTex(g=>pix(g,(x,y)=>{const my=y%4===3,off=((y>>2)%2)*4,mx=(x+off)%8===7;if(my||mx)return rgb(188,188,188);const d=jit(20);return rgb(150+d,70+d,60+d)}));
const glassTex = canvasTex(g=>{g.clearRect(0,0,16,16);pix(g,(x,y)=>{if(x===0||y===0||x===15||y===15)return rgb(200,225,235,.9);if((x+y)%7===0&&x>2&&x<13)return rgb(230,245,255,.5);return rgb(200,230,245,.13)})});

const M=(x,tr)=>new THREE.MeshLambertMaterial({map:x.t, transparent:!!tr});
const mDirt=M(dirtTex), mGrassTop=M(grassTop), mGrassSide=M(grassSide), mStone=M(stoneTex),
      mLogSide=M(logSide), mLogTop=M(logTop), mLeaf=M(leafTex), mSand=M(sandTex),
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
};
export const TOOLS = [
  {id:'hand',   name:'Hand',    icon:'✋',  good:[]},
  {id:'pick',   name:'Pickaxe', icon:'⛏️', good:[3,8,9]},
  {id:'axe',    name:'Axe',     icon:'🪓', good:[4,5,7]},
  {id:'shovel', name:'Shovel',  icon:'🪏', good:[1,2,6]},
];

// ---- Small helpers used by hand, avatars, animals ----
export function box(w,h,d,color,x,y,z){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshLambertMaterial({color}));
  m.position.set(x,y,z);
  return m;
}
export function makeToolModel(id){
  const g = new THREE.Group();
  if(id==='pick'){
    g.add(box(.05,.42,.05,0x8a5a2b,0,.12,0));
    g.add(box(.36,.06,.06,0x9a9a9a,0,.33,0));
  } else if(id==='axe'){
    g.add(box(.05,.42,.05,0x8a5a2b,0,.12,0));
    g.add(box(.15,.17,.05,0x9a9a9a,.1,.31,0));
  } else if(id==='shovel'){
    g.add(box(.05,.44,.05,0x8a5a2b,0,.14,0));
    g.add(box(.13,.16,.04,0xb0b0b0,0,.4,0));
  }
  return g;
}
export function makeBlockCube(tid, size=.25){
  return new THREE.Mesh(new THREE.BoxGeometry(size,size,size), TYPES[tid].mats);
}

// ---- Chunk meshing ----
const geo = new THREE.BoxGeometry(1,1,1);
const chunkMeshes = new Array(CHUNKS*CHUNKS).fill(null);
const dummy = new THREE.Object3D();

export function buildChunk(cx,cz){
  const ci = cIndex(cx,cz);
  if(chunkMeshes[ci]) for(const m of chunkMeshes[ci]){ scene.remove(m); m.geometry.dispose(); }
  const chunk = chunks[ci], byType = {}, x0 = cx*CH, z0 = cz*CH;
  for(let y=0;y<WH;y++)for(let lz=0;lz<CH;lz++)for(let lx=0;lx<CH;lx++){
    const t = chunk[bIndex(lx,y,lz)];
    if(!t) continue;
    const x = x0+lx, z = z0+lz;
    if(occludes(x+1,y,z)&&occludes(x-1,y,z)&&occludes(x,y+1,z)&&
       occludes(x,y-1,z)&&occludes(x,y,z+1)&&occludes(x,y,z-1)) continue;
    (byType[t] ||= []).push([x,y,z]);
  }
  const list = [];
  const center = new THREE.Vector3(x0+CH/2, WH/2, z0+CH/2);
  const radius = Math.sqrt(CH*CH/2 + WH*WH/4) + 1;
  for(const id in byType){
    const pts = byType[id];
    const g = geo.clone();
    g.boundingSphere = new THREE.Sphere(center.clone(), radius);
    const im = new THREE.InstancedMesh(g, TYPES[id].mats, pts.length);
    pts.forEach((p,i)=>{ dummy.position.set(p[0],p[1],p[2]); dummy.updateMatrix(); im.setMatrixAt(i,dummy.matrix); });
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    list.push(im);
  }
  chunkMeshes[ci] = list;
}
export function buildAllChunks(){
  for(let cz=0;cz<CHUNKS;cz++)for(let cx=0;cx<CHUNKS;cx++) buildChunk(cx,cz);
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
export function updateChunkVisibility(px,pz){
  const pcx = wrapC(Math.round(px))>>4, pcz = wrapC(Math.round(pz))>>4;
  for(let cz=0;cz<CHUNKS;cz++)for(let cx=0;cx<CHUNKS;cx++){
    let dx = Math.abs(cx-pcx); dx = Math.min(dx, CHUNKS-dx);
    let dz = Math.abs(cz-pcz); dz = Math.min(dz, CHUNKS-dz);
    const vis = dx<=VIEW_CHUNKS && dz<=VIEW_CHUNKS;
    const list = chunkMeshes[cIndex(cx,cz)];
    if(list) for(const m of list) m.visible = vis;
  }
}

// ---- Apply a block edit (local or from network). Returns the previous type. ----
export function applyEdit(x,y,z,t,burst=true){
  const old = getBlock(x,y,z);
  setBlock(x,y,z,t);
  rebuildAt(x,z);
  if(burst){
    const color = TYPES[old||t]?.pc ?? 0xffffff;
    spawnParticles(x,y,z,color, old? 22 : 8);
  }
  return old;
}

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

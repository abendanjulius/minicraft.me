// render.js — scene, textures, block/tool content, chunk meshing, particles
import { WORLD, WH, CH, CHUNKS, chunks, cIndex, bIndex, wrapC, occludes, getBlock, setBlock } from './world.js';
import { EXTRA_BLOCKS, EXTRA_ITEMS } from './content.js';
import { gm } from './mode.js';

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
const DAY_LEN = 1200;                     // ~20 min full cycle (was 240 / 4 min)
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
  if(gm.forge){ day.t = 0.28; }          // Forge: always noon
  else { day.t = (day.t + dt/DAY_LEN) % 1; }
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
    return canvasTex(gc=>{
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=jit(12);
        const isPillow = y>=12;
        const isFrame = y<=2 || x<=1 || x>=14;
        if(isFrame) gc.fillStyle=rgb(110+d,70+d,40+d);
        else if(isPillow) gc.fillStyle=rgb(230+d,220+d,210+d);
        else gc.fillStyle=rgb(r+d,g+d,bl+d);
        gc.fillRect(x,y,1,1);
      }
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
  g.add(box(.5,.7,.28, sk.shirt, 0,1.05,0));
  let head = null;
  if(withHead){
    head = new THREE.Mesh(new THREE.BoxGeometry(.44,.44,.44), skinTextures(sk, keyOf(skinLike)).headMats);
    head.position.set(0,1.62,0);
    g.add(head);
  }
  return {g, head, armL, armR, legL, legR, sk};
}

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
export function makeBlockCube(tid, size=.34){
  const mats = TYPES[tid]?.mats;
  if(!mats){
    // fallback plain cube so missing TYPES never blank the hand
    return new THREE.Mesh(new THREE.BoxGeometry(size,size,size),
      new THREE.MeshLambertMaterial({color:0xaaaaaa}));
  }
  return new THREE.Mesh(new THREE.BoxGeometry(size,size,size), mats);
}

/** First-person held icon for non-block items (food, materials, etc.). */
export function makeHeldItemIcon(itemId, size=.45){
  const it = ITEMS[itemId];
  const icon = it?.icon || '❓';
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0,0,64,64); // fully transparent — no dark backing plate
  g.font = '52px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthTest: true, side: THREE.DoubleSide,
    alphaTest: 0.1, // drop near-empty pixels so no dark fringe remains
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  return mesh;
}

/** Weapon model tinted by damage tier so each sword looks distinct. */
export function makeWeaponModel(itemId){
  const dmg = ITEMS[itemId]?.dmg || 3;
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

export function buildChunk(cx,cz){
  const ci = cIndex(cx,cz);
  if(chunkMeshes[ci]) for(const m of chunkMeshes[ci]){ scene.remove(m); m.geometry.dispose(); }
  const chunk = chunks[ci], byType = {}, x0 = cx*CH, z0 = cz*CH;
  for(let y=0;y<WH;y++)for(let lz=0;lz<CH;lz++)for(let lx=0;lx<CH;lx++){
    const t = chunk[bIndex(lx,y,lz)];
    if(!t || t===10 || (t>=48&&t<=55)) continue; // torches & doors have custom meshes
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
/** Signed shift (0 or ±WORLD) that puts a world X/Z on the near side of the seam. */
export function wrapShift(v, ref){
  const d = v - ref;
  if(d >  WORLD/2) return -WORLD;
  if(d < -WORLD/2) return  WORLD;
  return 0;
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
  const pcx = wrapC(Math.round(px))>>4, pcz = wrapC(Math.round(pz))>>4;
  for(let cz=0;cz<CHUNKS;cz++)for(let cx=0;cx<CHUNKS;cx++){
    // signed chunk delta across the wrap
    let sx = cx-pcx; if(sx >  CHUNKS/2) sx -= CHUNKS; if(sx < -CHUNKS/2) sx += CHUNKS;
    let sz = cz-pcz; if(sz >  CHUNKS/2) sz -= CHUNKS; if(sz < -CHUNKS/2) sz += CHUNKS;
    const vis = Math.abs(sx)<=VIEW_CHUNKS && Math.abs(sz)<=VIEW_CHUNKS;
    const list = chunkMeshes[cIndex(cx,cz)];
    if(!list) continue;
    // Instance matrices hold absolute coords, so shifting the mesh by ±WORLD
    // renders the chunk on the near side of the seam — no gap, no visible edge.
    const offX = (pcx + sx - cx) * CH;
    const offZ = (pcz + sz - cz) * CH;
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
export const doorMeshes = new Map(); // "x,y,z" -> group
function makeDoorMesh(x, y, z, facing, open){
  const g = new THREE.Group();
  // hinge pivot at edge of cell
  const panel = new THREE.Group();
  // door leaf: thin, 2 blocks tall
  const wood = 0x8b6914, dark = 0x5c4010, handle = 0xd4b84a;
  // Everything is modelled AHEAD of the hinge (local +Z), so the panel group's
  // origin IS the hinge line — rotating it swings the door like a real one.
  const leaf = box(.12, 1.95, .9, wood, 0, 0.975, .45);
  panel.add(leaf);
  // frame lines (decorative)
  panel.add(box(.13, 1.95, .06, dark, 0, 0.975, .03));
  panel.add(box(.13, 1.95, .06, dark, 0, 0.975, .87));
  panel.add(box(.13, .06, .9, dark, 0, 1.92, .45));
  panel.add(box(.13, .06, .9, dark, 0, .05, .45));
  // handle sits near the free edge, far from the hinge
  panel.add(box(.08, .08, .08, handle, .1, 0.95, .74));
  // hinge line on the -Z edge of the cell
  panel.position.set(0, 0, -0.45);
  g.add(panel);
  g.position.set(x, y - 0.5, z);
  // base rotation by facing: 0=+Z wall, 1=+X, 2=-Z, 3=-X
  const base = facing * Math.PI/2;
  g.rotation.y = base;
  // open swings ~95°
  panel.rotation.y = open ? -Math.PI/2 : 0;   // swings a clean 90° on the hinge
  g.userData = {panel, facing, open, base:[x, y - 0.5, z]};
  return g;
}
export function trackDoor(x,y,z,prev,t){
  const k = wrapC(x)+','+y+','+wrapC(z);
  const wasDoor = prev>=48 && prev<=55;
  const isDoor = t>=48 && t<=55;
  if(wasDoor && doorMeshes.has(k)){
    scene.remove(doorMeshes.get(k));
    doorMeshes.delete(k);
  }
  if(isDoor){
    const facing = (t-48)%4;
    const open = t>=52;
    // remove any stale
    if(doorMeshes.has(k)){ scene.remove(doorMeshes.get(k)); doorMeshes.delete(k); }
    const m = makeDoorMesh(wrapC(x), y, wrapC(z), facing, open);
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
    trackDoor(x,y,z,old,t);
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

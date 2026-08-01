// player.js — local player: controls, physics, mining, first-person hand + visible body
import { WORLD, WH, CENTER, getBlock, heightAt, isWalkThrough, isDoor, doorFacing, doorOpen, doorType, doorStyleOf, doorItemOf, DOOR_STYLES, wrapC } from './world.js';
import { scene, camera, renderer, TYPES, TOOLS, ITEMS, SKINS, isTouch, box, makeCharacter, makeToolModel, makeBlockCube,
         makeHeldItemIcon, makeWeaponModel, applyEdit, spawnParticles, spawnDust, jit, day, setBedFacing, bedFacing, updateChunkVisibility, updateTorchLights } from './render.js';
import { inventory, hotbarSlots, sel, joy, invOpen, toggleInv, renderHotbar,
         addToInventory, setHeldChangeHook, slotTool, slotBlock, nextToolSlot,
         chat, openChat } from './ui.js';
import { sfx, toggleMusic } from './audio.js';
import { gm } from './mode.js';
import * as net from './net.js';
import * as survival from './survival.js';
import { BLOCK_DROPS } from './content.js';
import { animals } from './animals.js';
import { zombies, corpses } from './mobs.js';
import * as drops from './drops.js';
import * as chests from './chests.js';
import * as keg from './keg.js';

const slotFood = ()=>{ const s = hotbarSlots[sel.slot]; const it = s&&s.k==='f' ? ITEMS[s.id] : null; return (it && (it.food || it.heal)) ? s.id : 0; };

// Aim at a nearby entity (animal or zombie) in front of the crosshair
function pickEntity(){
  const dir = new THREE.Vector3(0,0,-1).applyEuler(new THREE.Euler(view.pitch,view.yaw,0,'YXZ'));
  const eye = player.pos.clone().add(new THREE.Vector3(0,1.6,0));
  const blockHit = castBlock();
  const maxD = blockHit ? blockHit.dist : 3.6;
  let best = null, bestT = Math.min(3.6, maxD);
  const consider = (kind, eid, pos)=>{
    const to = pos.clone().add(new THREE.Vector3(0,.7,0)).sub(eye);
    const t = to.dot(dir);
    if(t<0.3 || t>bestT) return;
    const perp = to.clone().addScaledVector(dir,-t).length();
    if(perp < .85){ best = {kind, eid}; bestT = t; }
  };
  animals.forEach((a,i)=>{ if(a.alive && a.g.visible) consider('a', i, a.g.position); });
  for(const zb of zombies.values()) if(zb.c.g.visible) consider('z', zb.id, zb.c.g.position);
  for(const [cid,c] of corpses) consider('c', cid, c.mesh.position);
  return best;
}

export const player = { pos:new THREE.Vector3(CENTER, 20, CENTER), vel:new THREE.Vector3(), onGround:false };
export const view = { yaw:0, pitch:0 };
export const state = { playing:false, mineHeld:false, mining:null, paused:false, flying:false, sleeping:false };
let sleepSeq = null; // {phase, t, bed:{x,y,z}}
export const keys = {};
let usingLock = false, dragging = false, mouseDown = null;
let handBob = 0, swingT = 0, placeAnim = 0;
let shake = 0, wasGround = true, fallV = 0, stepTimer = 0;
export function addShake(v){ shake = Math.min(.4, Math.max(shake, v)); }
export const skinIdx = ()=>Math.min(SKINS.length-1, Math.max(0, +(localStorage.getItem('mc_skin')||0)));

// ---- First-person hand & held item (Minecraft-style) ----
const handGroup = new THREE.Group();
camera.add(handGroup);
// Anchor in the lower-right of the view
handGroup.position.set(0.42, -0.55, -0.55);
handGroup.rotation.set(0, 0, 0);

// Bare arm: thick forearm coming in from the corner
const armPivot = new THREE.Group();
const armMesh = box(0.22, 0.22, 0.78, 0xdba97c, 0, 0, 0);
// fist / hand at the end of the arm
const fistMesh = box(0.26, 0.22, 0.22, 0xdba97c, 0, -0.02, -0.42);
armPivot.add(armMesh);
armPivot.add(fistMesh);
handGroup.add(armPivot);

const toolModels = {};
for(const t of TOOLS) if(t.id!=='hand'){
  const m = makeToolModel(t.id);
  m.visible = false;
  handGroup.add(m);
  toolModels[t.id] = m;
}
let heldExtra = null;
function clearHeldExtra(){
  if(heldExtra){ handGroup.remove(heldExtra); heldExtra = null; }
}

/** Pose the arm for empty / tool / block modes */
function poseArm(mode){
  // mode: 'empty' | 'tool' | 'block' | 'item'
  if(mode === 'empty'){
    armPivot.visible = true;
    armPivot.position.set(0.18, -0.02, 0.05);
    // diagonal in from bottom-right, matching Minecraft empty hand
    armPivot.rotation.set(1.15, 0.55, 0.35);
  } else if(mode === 'block'){
    // arm mostly tucked; block is the star
    armPivot.visible = true;
    armPivot.position.set(0.28, -0.18, 0.12);
    armPivot.rotation.set(1.0, 0.4, 0.5);
  } else if(mode === 'tool'){
    armPivot.visible = true;
    armPivot.position.set(0.12, -0.05, 0.02);
    armPivot.rotation.set(0.85, 0.35, 0.25);
  } else {
    // item / food icon
    armPivot.visible = true;
    armPivot.position.set(0.14, -0.06, 0.04);
    armPivot.rotation.set(0.95, 0.4, 0.3);
  }
}

function updateHeld(){
  const tool = slotTool();
  const held = hotbarSlots[sel.slot];
  for(const id in toolModels) toolModels[id].visible = false;
  clearHeldExtra();

  // Skin-colored arm
  const sk = SKINS[skinIdx()]?.skin ?? 0xdba97c;
  armMesh.material.color.setHex(sk);
  fistMesh.material.color.setHex(sk);

  // Empty hand
  if(!held || (held.k!=='t' && !gm.forge && !(inventory[held.id]>0))){
    poseArm('empty');
    return;
  }

  // Mining tools
  if(held.k==='t'){
    poseArm('tool');
    const m = toolModels[held.id];
    if(m){
      m.visible = true;
      m.position.set(-0.02, 0.12, -0.35);
      m.rotation.set(-0.9, 0.35, 0.15);
      m.scale.set(1.35, 1.35, 1.35);
    }
    return;
  }

  // Blocks — big cube, classic 3-face angle
  if(held.k==='b'){
    const id = held.id;
    if(!TYPES[id]){ poseArm('empty'); return; }
    if(!gm.forge && !(inventory[id]>0)){ poseArm('empty'); return; }
    poseArm('block');
    // Special blocks: slightly different held scale so they don't all look like full cubes
    const thin = (id===61||id===62||id===63||id===11||id===44);
    heldExtra = makeBlockCube(id, thin ? 0.5 : 0.58);
    if(id===61){ // slab — flatten
      heldExtra.scale.set(1, 0.5, 1);
      heldExtra.position.set(0.08, -0.05, -0.42);
    } else if(id===62||id===63){
      heldExtra.scale.set(1, 0.2, 1);
      heldExtra.position.set(0.08, 0.0, -0.42);
    } else if(id===11){
      heldExtra.scale.set(0.35, 1, 0.35);
      heldExtra.position.set(0.05, 0.02, -0.4);
    } else {
      heldExtra.position.set(0.08, 0.02, -0.42);
    }
    heldExtra.rotation.set(0.35, -0.85, 0.12);
    handGroup.add(heldExtra);
    return;
  }

  // Items (food, materials, weapons)
  if(held.k==='f'){
    const id = held.id;
    if(!ITEMS[id]){ poseArm('empty'); return; }
    if(!gm.forge && !(inventory[id]>0)){ poseArm('empty'); return; }
    if(ITEMS[id].dmg){
      poseArm('tool');
      heldExtra = makeWeaponModel(id);
      heldExtra.scale.set(1.4, 1.4, 1.4);
      heldExtra.position.set(-0.02, 0.14, -0.32);
      heldExtra.rotation.set(-0.85, 0.3, 0.1);
    } else {
      poseArm('item');
      heldExtra = makeHeldItemIcon(id, 0.55);
      heldExtra.position.set(0.02, 0.14, -0.38);
      heldExtra.rotation.set(0.1, 0.2, -0.15);
    }
    handGroup.add(heldExtra);
  }
}
setHeldChangeHook(updateHeld);
updateHeld(); // initial empty-hand pose

// ---- Visible first-person body — pushed back behind the camera like Minecraft's ----
let bodyG = null, bArmL = null, bArmR = null, bLegL = null, bLegR = null, bHead = null;
function buildBody(){
  if(bodyG) scene.remove(bodyG);
  // Head included so sleep animation isn't headless; hidden during normal FP
  const c = makeCharacter(skinIdx(), true);
  bodyG = c.g; bArmL = c.armL; bArmR = c.armR; bLegL = c.legL; bLegR = c.legR; bHead = c.head;
  if(bHead) bHead.visible = false;
  bodyG.visible = false;
  scene.add(bodyG);
  armMesh.material.color.setHex(c.sk.skin); // first-person arm matches skin
}

export function setPosYaw(x,y,z,yaw){
  player.pos.set(x,y,z);
  player.vel.set(0,0,0);
  view.yaw = yaw||0;
}
export function spawn(){
  const bed = survival.getBedSpawn?.();
  if(bed){
    player.pos.set(bed.x + 0.5, bed.y + 1.2, bed.z + 0.5);
  } else {
    player.pos.set(CENTER, heightAt(CENTER,CENTER)+3, CENTER);
  }
  player.vel.set(0,0,0);
  state.flying = false;
  buildBody();
  bodyG.visible = true;
}
export function look(dx,dy){
  view.yaw -= dx; view.pitch -= dy;
  view.pitch = Math.max(-Math.PI/2+.01, Math.min(Math.PI/2-.01, view.pitch));
}
export function setMine(b){
  if(survival.sv.dead){ state.mineHeld=false; state.mining=null; return; }
  if(b){
    const e = pickEntity();
    if(e){
      const held = hotbarSlots[sel.slot];
      const wDmg = (held?.k==='f' && ITEMS[held.id]?.dmg) || 0;
      const dmg = wDmg || (slotTool()!=='hand' ? 3 : 2);
      net.sendHit(e.kind, e.eid, dmg, player.pos.x, player.pos.z);
      placeAnim = 1;      // single chop animation
      sfx.punch();
      return;             // a punch, not a mining hold
    }
  }
  state.mineHeld = b;
  if(!b) state.mining = null;
}
export function relock(){
  if(state.playing && !isTouch){
    try{ renderer.domElement.requestPointerLock()?.catch?.(()=>{}); }catch(e){}
  }
}

export function onModeMaybeChanged(){
  if(!gm.forge){ state.flying = false; }
  // refresh mobile fly button if present
  const bf = document.getElementById('btnFly');
  if(bf){
    bf.style.display = (gm.forge && state.playing) ? 'flex' : 'none';
    bf.classList.toggle('active', state.flying);
  }
}
export function toggleFly(){
  if(!gm.forge || !state.playing) return false;
  state.flying = !state.flying;
  player.vel.y = 0;
  const bf = document.getElementById('btnFly');
  if(bf) bf.classList.toggle('active', state.flying);
  return state.flying;
}
export function setPaused(on){
  state.paused = !!on;
  const el = document.getElementById('pauseMenu');
  if(el) el.style.display = state.paused ? 'flex' : 'none';
  document.body.classList.toggle('paused', state.paused);
  if(state.paused){
    document.exitPointerLock?.();
    for(const k in keys) keys[k]=false;
  } else if(state.playing && !isTouch){
    relock();
  }
}
export function dropHeld(){
  if(survival.sv.dead) return;
  const payload = drops.tryDropFromHotbar(player.pos, view.yaw);
  if(payload) net.sendDrop(payload);
}
export function initControls(){

  document.addEventListener('pointerlockchange', ()=>{ usingLock = !!document.pointerLockElement; });
  document.addEventListener('mousemove', e=>{
    if(isTouch || !state.playing || invOpen || state.paused) return;
    // Pointer lock is the reliable path. Without it, only look while dragging.
    // Always re-request lock on any movement if we lost it (fixes "can strafe but can't turn").
    if(!usingLock && !mouseDown){
      // lost lock silently (Alt-Tab, browser UI) — try reclaim on next intent
      return;
    }
    if(usingLock || mouseDown !== null){
      if(mouseDown !== null && (Math.abs(e.clientX-mouseDown.x)>6 || Math.abs(e.clientY-mouseDown.y)>6)){ dragging = true; state.mineHeld = false; }
      const sens = 0.0025;
      look(e.movementX*sens, e.movementY*sens);
    }
  });
  document.addEventListener('keydown', e=>{
    if(chat.open) return;
    // Pause / unpause
    if(e.code==='Escape' && state.playing){
      e.preventDefault();
      if(invOpen){ toggleInv(false); return; }
      setPaused(!state.paused);
      return;
    }
    if(state.paused) return;
    if(e.code==='Enter' && state.playing){ for(const k in keys) keys[k]=false; openChat(); return; }
    keys[e.code]=true;
    if(e.code.startsWith('Digit')){
      const n = +e.code[5];
      const slot = n===0 ? 9 : n-1;
      if(slot>=0 && slot<10){ sel.slot=slot; renderHotbar(); }
    }
    if(e.code==='KeyE' && state.playing) toggleInv();
    if(e.code==='KeyC' && state.playing) toggleInv(true,'craft');
    if(e.code==='KeyQ' && state.playing && !invOpen){ e.preventDefault(); dropHeld(); }
    if(e.code==='KeyT' && state.playing) nextToolSlot();
    if(e.code==='KeyM') toggleMusic();
    // Forge fly toggle
    if(e.code==='KeyF' && state.playing && gm.forge){
      toggleFly();
    }
  });
  document.addEventListener('keyup', e=>keys[e.code]=false);
  addEventListener('wheel', e=>{
    if(!state.playing || invOpen || chat.open) return;
    sel.slot = (sel.slot + (e.deltaY>0?1:-1) + 10) % 10;
    renderHotbar();
  }, {passive:true});
  document.addEventListener('mousedown', e=>{
    if(isTouch || !state.playing || invOpen) return;
    if(e.target.closest('#hotbar,#inv,#btnQuit')) return;
    if(usingLock){
      if(e.button===0) setMine(true);
      else if(e.button===2) placeAction();
      return;
    }
    mouseDown = {x:e.clientX, y:e.clientY, button:e.button};
    dragging = false;
    if(e.button===0) setMine(true);
  });
  document.addEventListener('mouseup', e=>{
    if(isTouch) return;
    setMine(false);
    if(!state.playing || invOpen || usingLock || mouseDown===null) return;
    if(!dragging && mouseDown.button===2) placeAction();
    mouseDown = null;
    dragging = false;
  });
  document.addEventListener('contextmenu', e=>e.preventDefault());
}

export function jump(b){ keys.Space = b; }

export function castBlock(){
  const dir = new THREE.Vector3(0,0,-1).applyEuler(new THREE.Euler(view.pitch,view.yaw,0,'YXZ'));
  const eye = player.pos.clone().add(new THREE.Vector3(0,1.6,0));
  let prev = null;
  for(let t=0;t<6;t+=.05){
    const p = eye.clone().addScaledVector(dir,t);
    const bx=Math.round(p.x), by=Math.round(p.y), bz=Math.round(p.z);
    if(getBlock(bx,by,bz)) return {hit:[bx,by,bz], place:prev, dist:t};
    prev = [bx,by,bz];
  }
  return null;
}



function yawToFacing(yaw){
  // 0 = +Z, 1 = +X, 2 = -Z, 3 = -X (door sits in the face you look at)
  let f = Math.round(-yaw / (Math.PI/2));
  return ((f % 4) + 4) % 4;
}
function toggleDoorAt(bx,by,bz){
  const t = getBlock(bx,by,bz);
  const style = doorStyleOf(t);
  if(!style) return false;
  const facing = doorFacing(t);
  const open = doorOpen(t);
  const nt = doorType(style.id, facing, !open);
  applyEdit(bx, by, bz, nt, false);
  net.sendEdit(bx, by, bz, nt);
  sfx.place();
  return true;
}

export function placeAction(){
  if(survival.sv.dead) return;
  const food = slotFood();
  if(food){ if(survival.eatSelected(food)) placeAnim = 1; return; }
  const r = castBlock();
  // Click door / crate / powder keg interactions
  if(r && r.hit){
    const [hx,hy,hz] = r.hit;
    const hit = getBlock(hx,hy,hz);
    if(isDoor(hit)){
      toggleDoorAt(hx,hy,hz);
      placeAnim = 1;
      return;
    }
    if(hit===56){ // Crate
      chests.open(hx,hy,hz);
      placeAnim = 1;
      return;
    }
    if(hit===58 || hit===65){ // Bed foot or head — set spawn + sleep
      // normalize to foot position
      let fx=hx, fy=hy, fz=hz;
      if(hit===65){
        // find adjacent foot
        let found=false;
        for(const [dx,dz] of [[0,1],[1,0],[0,-1],[-1,0]]){
          if(getBlock(hx-dx,hy,hz-dz)===58){ fx=hx-dx; fz=hz-dz; found=true; break; }
        }
        if(!found){ fx=hx; fz=hz; }
      }
      survival.setBedSpawn(fx, fy, fz);
      placeAnim = 1;
      sfx.place();
      startSleep(fx, fy, fz);
      return;
    }
    if(hit===62 || hit===63){ // Trapdoor toggle
      const nt = hit===62 ? 63 : 62;
      applyEdit(hx,hy,hz,nt,false);
      net.sendEdit(hx,hy,hz,nt);
      placeAnim = 1;
      sfx.place();
      return;
    }
    // Spark Striker on Powder Keg
    const held = hotbarSlots[sel.slot];
    if(hit===57 && held?.k==='f' && held.id===180){
      if(keg.ignite(hx,hy,hz)){
        placeAnim = 1;
        net.sendKegLit(hx,hy,hz);
      }
      return;
    }
  }
  if(!r || !r.place) return;
  let tid = slotBlock();
  if(!tid) return;
  // Normalize door state ids back to item ids
  for(const s of DOOR_STYLES){
    if(tid>=s.base && tid<s.base+8) tid = s.item;
  }
  if(!gm.forge && !(inventory[tid]>0)) return;
  const [px,py,pz] = r.place;
  if(py<0||py>=WH) return;
  const d = new THREE.Vector3(px,py,pz).sub(player.pos);
  if(Math.abs(d.x)<.9 && Math.abs(d.z)<.9 && d.y>-.5 && d.y<2) return;

  // Place any door style
  const doorStyle = DOOR_STYLES.find(s => s.item === tid);
  if(doorStyle){
    if(py+1>=WH || getBlock(px,py+1,pz)) return;
    if(getBlock(px,py,pz)) return;
    const facing = yawToFacing(view.yaw);
    const dt = doorType(doorStyle.id, facing, false);
    applyEdit(px,py,pz,dt,false);
    if(!gm.forge) inventory[tid]--;
    placeAnim = 1;
    sfx.place();
    survival.note('place', tid);
    renderHotbar();
    net.sendEdit(px,py,pz,dt);
    return;
  }

  // Place bed: 2 cells long × 1 wide rectangle
  if(tid===58){
    if(getBlock(px,py,pz)) return;
    const facing = yawToFacing(view.yaw);
    const dirs = [[0,1],[1,0],[0,-1],[-1,0]]; // 0=+Z,1=+X,2=-Z,3=-X
    const [dx,dz] = dirs[facing];
    const hx = px+dx, hz = pz+dz;
    // need head cell free
    if(getBlock(hx,py,hz)) return;
    applyEdit(px,py,pz,58,false);
    applyEdit(hx,py,hz,65,false); // head marker
    setBedFacing(px,py,pz,facing);
    if(!gm.forge) inventory[58]--;
    placeAnim = 1;
    sfx.place();
    survival.note('place', 58);
    renderHotbar();
    net.sendEdit(px,py,pz,58);
    net.sendEdit(hx,py,hz,65);
    // facing sync: piggyback as chat-free path — clients infer from head offset on apply
    return;
  }
  applyEdit(px,py,pz,tid,false);
  if(!gm.forge) inventory[tid]--;
  placeAnim = 1;
  sfx.place();
  survival.note('place', tid);
  renderHotbar();
  net.sendEdit(px,py,pz,tid);
}

const mineBar = document.getElementById('mineBar');
const mineFill = mineBar.firstElementChild;
function updateMining(dt){
  if(!state.mineHeld || invOpen){ state.mining=null; mineBar.style.display='none'; return; }
  const r = castBlock();
  if(!r){ state.mining=null; mineBar.style.display='none'; return; }
  const [bx,by,bz] = r.hit;
  let m = state.mining;
  if(!m || m.x!==bx || m.y!==by || m.z!==bz){
    const t = getBlock(bx,by,bz);
    const tool = TOOLS.find(x=>x.id===slotTool());
    const speed = tool.good.includes(t) ? 4 : 1;
    const total = gm.forge ? .15 : TYPES[t].hard/speed;
    m = state.mining = {x:bx,y:by,z:bz, progress:0, total, emit:0, snd:0, type:t};
  }
  m.progress += dt;
  m.emit -= dt; m.snd -= dt;
  if(m.emit<=0){ spawnParticles(bx,by,bz,TYPES[m.type].pc,4); m.emit=.1; }
  if(m.snd<=0){ sfx.tick(m.type); m.snd=.2; }
  mineBar.style.display='block';
  mineFill.style.width = Math.min(100, m.progress/m.total*100)+'%';
  if(m.progress >= m.total){
    const old = applyEdit(bx,by,bz,0,true);
    if(old){
      const ORE_YIELD = {45:120, 46:121, 47:122};
      if(doorStyleOf(old)){
        addToInventory(doorItemOf(old));
      } else if(old===58 || old===65){
        // remove paired bed cell
        const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
        if(old===58){
          const f = bedFacing.get(wrapC(bx)+','+by+','+wrapC(bz)) ?? 0;
          const [dx,dz] = dirs[f];
          if(getBlock(bx+dx,by,bz+dz)===65) applyEdit(bx+dx,by,bz+dz,0,false);
        } else {
          for(const [dx,dz] of dirs){
            if(getBlock(bx-dx,by,bz-dz)===58){
              applyEdit(bx-dx,by,bz-dz,0,false);
              break;
            }
          }
        }
        addToInventory(58);
      } else if(old===62 || old===63){
        addToInventory(62);
      } else if(old===56){
        for(const [id,n] of chests.removeAt(bx,by,bz)){
          const p = drops.spill(id, n, bx + (Math.random()-.5)*.6, by + .35, bz + (Math.random()-.5)*.6);
          if(p) net.sendDrop(p);
        }
        addToInventory(56);
      } else if(ORE_YIELD[old]){
        const n = 1 + (Math.random()<.45 ? 1 : 0);
        for(let i=0;i<n;i++) addToInventory(ORE_YIELD[old]);
      } else {
        addToInventory(old);
      }
      sfx.break(old); addShake(.16); survival.note('mine', doorStyleOf(old)?doorItemOf(old):old);
      const rolls = BLOCK_DROPS[old];
      if(rolls) for(const [item,p] of rolls) if(Math.random()<p) addToInventory(item);
    }
    net.sendEdit(bx,by,bz,0);
    state.mining = null;
  }
}

function collide(pos){
  const r=.3;
  for(const ox of [-r,r]) for(const oz of [-r,r]) for(const oy of [0,.9,1.7]){
    const b = getBlock(Math.round(pos.x+ox), Math.round(pos.y+oy), Math.round(pos.z+oz));
    if(b && !isWalkThrough(b)) return true;
  }
  return false;
}


function startSleep(bx, by, bz){
  if(state.sleeping || state.paused || survival.sv.dead) return;
  state.sleeping = true;
  state.flying = false;
  for(const k in keys) keys[k] = false;
  const f0 = bedFacing.get(wrapC(bx)+','+by+','+wrapC(bz)) ?? 0;
  const d0 = [[0,1],[1,0],[0,-1],[-1,0]][f0];
  view.yaw = Math.atan2(d0[0], d0[1]);
  // Show full body (with head) for the sleep sequence; hide FP hand
  if(bHead) bHead.visible = true;
  if(bodyG) bodyG.visible = true;
  handGroup.visible = false;
  sleepSeq = {
    phase: 'approach',
    t: 0,
    bed: {x:bx, y:by, z:bz},
    facing: f0,
    skipNight: !gm.forge && dayIsNight(),
    startYaw: view.yaw,
    startPitch: view.pitch,
  };
  const fade = document.getElementById('sleepFade');
  if(fade){
    fade.innerHTML = '<div class="sleepMsg">Z z z …</div>';
    fade.classList.remove('on');
  }
}
function updateSleep(dt){
  if(!sleepSeq) return;
  const s = sleepSeq;
  s.t += dt;
  const bed = s.bed;
  const f = s.facing ?? (bedFacing.get(wrapC(bed.x)+','+bed.y+','+wrapC(bed.z)) ?? 0);
  const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
  const [dx,dz] = dirs[f];
  // center of the 2×1 mattress
  const targetX = bed.x + 0.5 + dx*0.5;
  const targetY = bed.y + 0.35;
  const targetZ = bed.z + 0.5 + dz*0.5;
  // body yaw so head points toward headboard
  const bodyYaw = Math.atan2(dx, dz) + Math.PI; // feet at footboard

  const poseLying = ()=>{
    if(!bodyG) return;
    bodyG.visible = true;
    if(bHead) bHead.visible = true;
    // Lie flat on the bed (rotate around X)
    bodyG.position.set(targetX, targetY, targetZ);
    bodyG.rotation.set(-Math.PI/2, bodyYaw, 0);
    // arms relaxed at sides
    if(bArmL) bArmL.rotation.x = 0.15;
    if(bArmR) bArmR.rotation.x = 0.15;
    if(bLegL) bLegL.rotation.x = 0.05;
    if(bLegR) bLegR.rotation.x = 0.05;
  };

  if(s.phase === 'approach'){
    player.pos.x += (targetX - player.pos.x) * Math.min(1, dt * 4);
    player.pos.z += (targetZ - player.pos.z) * Math.min(1, dt * 4);
    player.pos.y += ((bed.y + 1.0) - player.pos.y) * Math.min(1, dt * 3);
    player.vel.set(0,0,0);
    // camera eases toward a soft top-down of the bed
    view.pitch += (0.55 - view.pitch) * Math.min(1, dt * 3);
    if(bodyG){
      bodyG.visible = true;
      if(bHead) bHead.visible = true;
      bodyG.position.copy(player.pos);
      bodyG.rotation.set(0, view.yaw + Math.PI, 0);
    }
    if(s.t >= 0.7){ s.phase = 'lie'; s.t = 0; }
  } else if(s.phase === 'lie'){
    player.pos.set(targetX, targetY + 0.2, targetZ);
    player.vel.set(0,0,0);
    poseLying();
    view.pitch = 0.65;
    if(s.t >= 0.5){
      s.phase = 'fadeIn'; s.t = 0;
      document.getElementById('sleepFade')?.classList.add('on');
    }
  } else if(s.phase === 'fadeIn'){
    poseLying();
    if(s.t >= 0.75){
      s.phase = 'rest'; s.t = 0;
      if(s.skipNight) survival.sleepTillDawn();
      else {
        survival.sv.hp = Math.min(20, survival.sv.hp + 2);
        survival.renderVitals?.();
      }
    }
  } else if(s.phase === 'rest'){
    poseLying();
    if(s.t >= (s.skipNight ? 0.6 : 0.35)){
      s.phase = 'fadeOut'; s.t = 0;
      document.getElementById('sleepFade')?.classList.remove('on');
    }
  } else if(s.phase === 'fadeOut'){
    poseLying();
    if(s.t >= 0.8){ s.phase = 'wake'; s.t = 0; }
  } else if(s.phase === 'wake'){
    // sit up next to the bed
    player.pos.set(targetX, bed.y + 1.2, targetZ);
    view.pitch += (0 - view.pitch) * Math.min(1, dt * 4);
    if(bodyG){
      bodyG.position.copy(player.pos);
      bodyG.rotation.set(0, view.yaw + Math.PI, 0);
      if(bArmL) bArmL.rotation.x = 0;
      if(bArmR) bArmR.rotation.x = 0;
    }
    if(s.t >= 0.5){
      state.sleeping = false;
      sleepSeq = null;
      // restore FP: hide head, show hand
      if(bHead) bHead.visible = false;
      handGroup.visible = true;
      if(bodyG) bodyG.visible = true;
      const fade = document.getElementById('sleepFade');
      if(fade){ fade.classList.remove('on'); fade.innerHTML = ''; }
      document.exitPointerLock?.();
      relock();
    }
  }
}


export function update(dt, elapsed){
  if(!state.playing) return;
  if(state.paused) return;
  if(state.sleeping){
    updateSleep(dt);
    // Camera slightly above/beside the lying body so the head is visible
    const elev = sleepSeq ? 1.35 : 0.35;
    const back = sleepSeq ? 1.6 : 0;
    const fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw);
    camera.position.set(
      player.pos.x - fx * back,
      player.pos.y + elev,
      player.pos.z - fz * back
    );
    camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
    return;
  }
  if(!invOpen && !survival.sv.dead){
    // Sprint: hold Shift (or mobile sprint flag) while moving
    const sprinting = !!(keys.ShiftLeft || keys.ShiftRight || keys.sprint);
    let speed = sprinting ? 8.2 : 5;
    if(state.flying && gm.forge) speed = sprinting ? 14 : 9;
    // Water: slower move + mild buoyancy
    const feet = getBlock(Math.round(player.pos.x), Math.round(player.pos.y - 0.1), Math.round(player.pos.z));
    const body = getBlock(Math.round(player.pos.x), Math.round(player.pos.y + 0.6), Math.round(player.pos.z));
    const inWater = feet === 64 || body === 64;
    if(inWater && !(state.flying && gm.forge)) speed *= 0.45;
    const fwd = new THREE.Vector3(-Math.sin(view.yaw),0,-Math.cos(view.yaw));
    const right = new THREE.Vector3(-fwd.z,0,fwd.x);
    const f = (keys.KeyW?1:0)-(keys.KeyS?1:0) - joy.y;
    const s = (keys.KeyD?1:0)-(keys.KeyA?1:0) + joy.x;
    const move = new THREE.Vector3().addScaledVector(fwd,f).addScaledVector(right,s);
    if(move.lengthSq()>1) move.normalize();
    move.multiplyScalar(speed);
    player.vel.x = move.x; player.vel.z = move.z;
    // ladder: gravity off — hold Jump to climb, release to slide gently
    const px0 = Math.round(player.pos.x), pz0 = Math.round(player.pos.z);
    const onLadder = getBlock(px0, Math.round(player.pos.y), pz0)===44 ||
                     getBlock(px0, Math.round(player.pos.y+1), pz0)===44;
    if(state.flying && gm.forge){
      // Creative flight: Space/Jump up, Shift or Sprint down, no gravity
      let vy = 0;
      if(keys.Space) vy += sprinting ? 10 : 6;
      if(keys.ShiftLeft || keys.ShiftRight || keys.sprint) vy -= sprinting ? 10 : 6;
      // if both up+down held, net near zero
      player.vel.y = vy;
      player.onGround = false;
    } else if(onLadder){
      player.vel.y = keys.Space ? 3.2 : -1.4;
      player.onGround = false;
    } else if(inWater){
      player.vel.y -= 4*dt; // light gravity
      if(keys.Space) player.vel.y = Math.min(3.5, player.vel.y + 12*dt); // swim up
      if(keys.ShiftLeft || keys.ShiftRight || keys.sprint) player.vel.y = Math.max(-3, player.vel.y - 10*dt);
      // gentle float toward surface
      if(!keys.Space && !keys.ShiftLeft && !keys.sprint) player.vel.y += 2.2*dt;
      player.onGround = false;
    } else {
      player.vel.y -= 20*dt;
      if(keys.Space && player.onGround){ player.vel.y = 7.5; player.onGround=false; sfx.jump(); survival.jumpCost(); }
    }
    fallV = player.vel.y;

    for(const axis of ['x','z','y']){
      const step = player.vel[axis]*dt;
      player.pos[axis] += step;
      if(collide(player.pos)){
        player.pos[axis] -= step;
        if(axis==='y'){ if(player.vel.y<0) player.onGround=true; player.vel.y=0; }
      } else if(axis==='y' && player.vel.y<0){ player.onGround=false; }
    }
    if(player.onGround && !wasGround && fallV < -8){
      sfx.land();
      addShake(Math.min(.22, -fallV*.015));
      if(fallV < -12 && !(state.flying && gm.forge)) survival.damage(Math.round((-fallV-12)*1.2), 'fall');
    }
    wasGround = player.onGround;

    const movingH = Math.abs(player.vel.x)+Math.abs(player.vel.z) > .5;
    if(movingH && player.onGround){
      stepTimer -= dt;
      if(stepTimer<=0){
        stepTimer = .34;
        const bt = getBlock(Math.round(player.pos.x), Math.round(player.pos.y-1), Math.round(player.pos.z)) || 1;
        sfx.step(bt);
        if(bt===2||bt===6||bt===1) spawnDust(player.pos.x, player.pos.y+.05, player.pos.z, TYPES[bt].pc);
      }
    } else stepTimer = 0;

    // NO visual snap at the seam — player coords stay continuous.
    // getBlock/setBlock already wrapC(); chunks use nearest ±WORLD copy.
    // Only rebase when extremely far to avoid float precision issues.
    if(Math.abs(player.pos.x) > WORLD * 2 || Math.abs(player.pos.z) > WORLD * 2){
      player.pos.x = wrapC(player.pos.x);
      player.pos.z = wrapC(player.pos.z);
      updateChunkVisibility(player.pos.x, player.pos.z);
      updateTorchLights(player.pos.x, player.pos.z);
    }
    if(player.pos.y < -20) spawn();

    updateMining(dt);
  } else {
    mineBar.style.display='none';
  }

  camera.position.copy(player.pos).add(new THREE.Vector3(0,1.6,0));
  camera.rotation.set(view.pitch,view.yaw,0,'YXZ');
  if(shake>0){
    camera.position.x += jit(shake);
    camera.position.y += jit(shake*.7);
    shake = Math.max(0, shake - dt*1.5);
  }

  // Body follows player, offset backward so the torso sits behind the camera line
  if(bodyG){
    if(bHead) bHead.visible = false; // never show own head in FP
    const fwdH = new THREE.Vector3(-Math.sin(view.yaw),0,-Math.cos(view.yaw));
    bodyG.position.copy(player.pos).addScaledVector(fwdH, -0.24);
    bodyG.rotation.set(0, view.yaw + Math.PI, 0);
    const movingNow2 = Math.abs(player.vel.x)+Math.abs(player.vel.z) > .5;
    const miningNow = state.mineHeld && !invOpen;
    if(movingNow2){
      const sw = Math.sin(elapsed*9)*.6;
      bLegL.rotation.x = sw; bLegR.rotation.x = -sw;
      // left arm swings only from walking, and never while mining
      bArmL.rotation.x = miningNow ? bArmL.rotation.x*.8 : -sw*.7;
      if(!miningNow) bArmR.rotation.x = sw*.7;
    } else {
      bLegL.rotation.x *= .8; bLegR.rotation.x *= .8;
      bArmL.rotation.x *= .8;
      if(!miningNow) bArmR.rotation.x *= .8;
    }
    if(miningNow) bArmR.rotation.x = -1 - Math.abs(Math.sin(swingT))*.9;
  }

  // First-person hand animation (idle bob + mine/place swing)
  const movingNow = Math.abs(player.vel.x)+Math.abs(player.vel.z) > .5;
  handBob += dt * (movingNow ? 8 : 2.2);
  let swing = 0;
  if(state.mineHeld && !invOpen && !state.sleeping){
    swingT += dt*14;
    swing = -Math.abs(Math.sin(swingT))*0.95;
  } else swingT = 0;
  if(placeAnim > 0){
    placeAnim -= dt*4;
    swing = Math.min(swing, -Math.sin(Math.max(0,placeAnim)*Math.PI)*0.9);
  }
  // Keep the hand anchored lower-right; bob lightly while moving
  const bobY = Math.sin(handBob)*0.012;
  const bobX = Math.cos(handBob*0.5)*0.008;
  handGroup.position.set(0.42 + bobX, -0.55 + bobY + swing*0.04, -0.55 + swing*0.1);
  handGroup.rotation.set(swing*0.85, swing*0.15, 0);
}

// State snapshot for the network
export function netState(){
  const m = state.mining;
  const held = hotbarSlots[sel.slot];
  const item = (held?.k==='f') ? held.id : 0;
  return {
    x:+player.pos.x.toFixed(2), y:+player.pos.y.toFixed(2), z:+player.pos.z.toFixed(2),
    yaw:+view.yaw.toFixed(2),
    mine: state.mineHeld && m ? [m.x,m.y,m.z,m.type] : 0,
    tool: slotTool(),
    blk: slotBlock(),
    item, // non-block held item (food / weapon / material)
    skin: skinIdx(),
  };
}

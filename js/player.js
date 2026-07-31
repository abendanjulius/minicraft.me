// player.js — local player: controls, physics, mining, first-person hand + visible body
import { WORLD, WH, CENTER, getBlock, heightAt, isWalkThrough, isDoor, doorFacing, doorOpen, doorType } from './world.js';
import { scene, camera, renderer, TYPES, TOOLS, ITEMS, SKINS, isTouch, box, makeCharacter, makeToolModel, makeBlockCube,
         makeHeldItemIcon, makeWeaponModel, applyEdit, spawnParticles, spawnDust, jit, day } from './render.js';
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
export const state = { playing:false, mineHeld:false, mining:null, paused:false, flying:false };
export const keys = {};
let usingLock = false, dragging = false, mouseDown = null;
let handBob = 0, swingT = 0, placeAnim = 0;
let shake = 0, wasGround = true, fallV = 0, stepTimer = 0;
export function addShake(v){ shake = Math.min(.4, Math.max(shake, v)); }
export const skinIdx = ()=>Math.min(SKINS.length-1, Math.max(0, +(localStorage.getItem('mc_skin')||0)));

// ---- First-person hand & held item ----
const handGroup = new THREE.Group();
camera.add(handGroup);
handGroup.position.set(.52,-.5,-.72);
handGroup.rotation.set(-.15,.1,0);
// Arm enters diagonally from the lower-right corner, like Minecraft's
const armPivot = new THREE.Group();
armPivot.rotation.set(.35, -.12, -.55);
const armMesh = box(.19,.19,.62,0xdba97c,0,0,.1);
armPivot.add(armMesh);
handGroup.add(armPivot);
const toolModels = {};
for(const t of TOOLS) if(t.id!=='hand'){
  const m = makeToolModel(t.id);
  m.position.set(0,.06,-.22); m.rotation.x = -.5; m.visible = false;
  handGroup.add(m); toolModels[t.id] = m;
}
let heldExtra = null; // block cube, weapon model, or item icon currently parented to hand
function clearHeldExtra(){
  if(heldExtra){ handGroup.remove(heldExtra); heldExtra = null; }
}
function updateHeld(){
  const tool = slotTool();
  const held = hotbarSlots[sel.slot];
  for(const id in toolModels) toolModels[id].visible = (tool===id);
  clearHeldExtra();
  // bare arm shows on its own; with a block/tool it tucks back so the item reads clearly
  const empty = !held || (held.k!=='t' && !(gm.forge || inventory[held.id]>0));
  armPivot.position.set(0, empty?0:-.06, empty?0:.06);
  if(!held) return;

  // Mining tools already use toolModels
  if(held.k==='t') return;

  // Blocks — show cube (Forge has infinite; survival needs count)
  if(held.k==='b'){
    const id = held.id;
    if(!TYPES[id]) return;
    if(!gm.forge && !(inventory[id]>0)) return;
    heldExtra = makeBlockCube(id, .46);
    heldExtra.position.set(.02,-.02,-.36);
    heldExtra.rotation.set(.2,-.72,.08); // show top + two sides
    handGroup.add(heldExtra);
    return;
  }

  // Items (food, materials, weapons)
  if(held.k==='f'){
    const id = held.id;
    if(!ITEMS[id]) return;
    if(!gm.forge && !(inventory[id]>0)) return;
    if(ITEMS[id].dmg){
      heldExtra = makeWeaponModel(id);
      heldExtra.scale.set(1.25, 1.25, 1.25);
      heldExtra.position.set(0,.08,-.24);
      heldExtra.rotation.x = -.5;
    } else {
      heldExtra = makeHeldItemIcon(id, .48);
      heldExtra.position.set(0,.1,-.32);
      heldExtra.rotation.y = .15;
    }
    handGroup.add(heldExtra);
  }
}
setHeldChangeHook(updateHeld);

// ---- Visible first-person body — pushed back behind the camera like Minecraft's ----
let bodyG = null, bArmL = null, bArmR = null, bLegL = null, bLegR = null;
function buildBody(){
  if(bodyG) scene.remove(bodyG);
  const c = makeCharacter(skinIdx(), false); // headless — the camera is the head
  bodyG = c.g; bArmL = c.armL; bArmR = c.armR; bLegL = c.legL; bLegR = c.legR;
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
  if(!isDoor(t)) return false;
  const facing = doorFacing(t);
  const open = doorOpen(t);
  const nt = doorType(facing, !open);
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
    if(hit===58){ // Bed — set spawn / sleep
      survival.setBedSpawn(hx, hy, hz);
      placeAnim = 1;
      sfx.place();
      // Nightfall: skip night if dark enough
      if(!gm.forge && dayIsNight()){
        survival.sleepTillDawn();
      }
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
  // only hold "Door" item id 48 in inventory; any 48-55 treated as placeable door
  if(tid>=48 && tid<=55) tid = 48;
  if(!gm.forge && !(inventory[tid]>0)) return;
  const [px,py,pz] = r.place;
  if(py<0||py>=WH) return;
  const d = new THREE.Vector3(px,py,pz).sub(player.pos);
  if(Math.abs(d.x)<.9 && Math.abs(d.z)<.9 && d.y>-.5 && d.y<2) return;

  // Place door: one cell marker, thin mesh spans 2 tall — need air above
  if(tid===48){
    if(py+1>=WH || getBlock(px,py+1,pz)) return; // need headroom for the leaf
    if(getBlock(px,py,pz)) return;
    const facing = yawToFacing(view.yaw);
    const dt = doorType(facing, false); // closed
    applyEdit(px,py,pz,dt,false);
    if(!gm.forge) inventory[48]--;
    placeAnim = 1;
    sfx.place();
    survival.note('place', 48);
    renderHotbar();
    net.sendEdit(px,py,pz,dt);
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
      if(old>=48 && old<=55){
        addToInventory(48);
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
      sfx.break(old); addShake(.16); survival.note('mine', (old>=48&&old<=55)?48:old);
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

export function update(dt, elapsed){
  if(!state.playing) return;
  if(state.paused) return;
  if(!invOpen && !survival.sv.dead){
    // Sprint: hold Shift (or mobile sprint flag) while moving
    const sprinting = !!(keys.ShiftLeft || keys.ShiftRight || keys.sprint);
    let speed = sprinting ? 8.2 : 5;
    if(state.flying && gm.forge) speed = sprinting ? 14 : 9;
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

    if(player.pos.x < -0.5)       player.pos.x += WORLD;
    if(player.pos.x >= WORLD-0.5) player.pos.x -= WORLD;
    if(player.pos.z < -0.5)       player.pos.z += WORLD;
    if(player.pos.z >= WORLD-0.5) player.pos.z -= WORLD;
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
    const fwdH = new THREE.Vector3(-Math.sin(view.yaw),0,-Math.cos(view.yaw));
    bodyG.position.copy(player.pos).addScaledVector(fwdH, -0.24);
    bodyG.rotation.y = view.yaw + Math.PI;
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

  // First-person hand animation
  const movingNow = Math.abs(player.vel.x)+Math.abs(player.vel.z) > .5;
  handBob += dt * (movingNow ? 7 : 2);
  let swing = 0;
  if(state.mineHeld && !invOpen){ swingT += dt*13; swing = -Math.abs(Math.sin(swingT))*1.05; }
  else swingT = 0;
  if(placeAnim > 0){ placeAnim -= dt*4; swing = Math.min(swing, -Math.sin(Math.max(0,placeAnim)*Math.PI)*1.05); }
  handGroup.rotation.x = -.2 + swing;
  handGroup.rotation.y = .15 + swing*.2;
  handGroup.position.z = -.8 + swing*.14;
  handGroup.position.y = -.45 + Math.sin(handBob)*.015 + swing*.05;
  handGroup.position.x = .5 + Math.cos(handBob*.5)*.012;
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

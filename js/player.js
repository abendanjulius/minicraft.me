// player.js — local player: controls, physics, mining, first-person hand + visible body
import { WORLD, WH, CENTER, getBlock, heightAt } from './world.js';
import { scene, camera, renderer, TYPES, TOOLS, SKINS, isTouch, box, makeCharacter, makeToolModel, makeBlockCube,
         applyEdit, spawnParticles, spawnDust, jit } from './render.js';
import { inventory, hotbarSlots, sel, joy, invOpen, toggleInv, renderHotbar,
         addToInventory, setHeldChangeHook, slotTool, slotBlock, nextToolSlot,
         chat, openChat } from './ui.js';
import { sfx, toggleMusic } from './audio.js';
import * as net from './net.js';

export const player = { pos:new THREE.Vector3(CENTER, 20, CENTER), vel:new THREE.Vector3(), onGround:false };
export const view = { yaw:0, pitch:0 };
export const state = { playing:false, mineHeld:false, mining:null };
const keys = {};
let usingLock = false, dragging = false, mouseDown = null;
let handBob = 0, swingT = 0, placeAnim = 0;
let shake = 0, wasGround = true, fallV = 0, stepTimer = 0;
export function addShake(v){ shake = Math.min(.4, Math.max(shake, v)); }
export const skinIdx = ()=>Math.min(SKINS.length-1, Math.max(0, +(localStorage.getItem('mc_skin')||0)));

// ---- First-person hand & held item ----
const handGroup = new THREE.Group();
camera.add(handGroup);
handGroup.position.set(.5,-.45,-.8);
handGroup.rotation.set(-.2,.15,0);
const armMesh = box(.16,.16,.5,0xdba97c,0,0,.05);
handGroup.add(armMesh);
const toolModels = {};
for(const t of TOOLS) if(t.id!=='hand'){
  const m = makeToolModel(t.id);
  m.position.set(0,.06,-.22); m.rotation.x = -.5; m.visible = false;
  handGroup.add(m); toolModels[t.id] = m;
}
let heldBlockMesh = null;
function updateHeld(){
  const tool = slotTool(), blk = slotBlock();
  for(const id in toolModels) toolModels[id].visible = (tool===id);
  if(heldBlockMesh){ handGroup.remove(heldBlockMesh); heldBlockMesh = null; }
  if(tool==='hand' && blk && inventory[blk]>0){
    heldBlockMesh = makeBlockCube(blk);
    heldBlockMesh.position.set(0,.05,-.3);
    handGroup.add(heldBlockMesh);
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

export function spawn(){
  player.pos.set(CENTER, heightAt(CENTER,CENTER)+3, CENTER);
  player.vel.set(0,0,0);
  buildBody();
  bodyG.visible = true;
}
export function look(dx,dy){
  view.yaw -= dx; view.pitch -= dy;
  view.pitch = Math.max(-Math.PI/2+.01, Math.min(Math.PI/2-.01, view.pitch));
}
export function setMine(b){ state.mineHeld = b; if(!b) state.mining = null; }
export function relock(){
  if(state.playing && !isTouch){
    try{ renderer.domElement.requestPointerLock()?.catch?.(()=>{}); }catch(e){}
  }
}

export function initControls(){
  document.addEventListener('pointerlockchange', ()=>{ usingLock = !!document.pointerLockElement; });
  document.addEventListener('mousemove', e=>{
    if(isTouch || !state.playing || invOpen) return;
    if(usingLock || (mouseDown !== null)){
      if(mouseDown !== null && (Math.abs(e.clientX-mouseDown.x)>6 || Math.abs(e.clientY-mouseDown.y)>6)){ dragging = true; state.mineHeld = false; }
      look(e.movementX*.002, e.movementY*.002);
    }
  });
  document.addEventListener('keydown', e=>{
    if(chat.open) return;
    if(e.code==='Enter' && state.playing){ for(const k in keys) keys[k]=false; openChat(); return; }
    keys[e.code]=true;
    if(e.code.startsWith('Digit')){
      const n = +e.code[5];
      const slot = n===0 ? 9 : n-1;
      if(slot>=0 && slot<10){ sel.slot=slot; renderHotbar(); }
    }
    if(e.code==='KeyE' && state.playing) toggleInv();
    if(e.code==='KeyQ') nextToolSlot();
    if(e.code==='KeyM') toggleMusic();
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
      if(e.button===0) state.mineHeld = true;
      else if(e.button===2) placeAction();
      return;
    }
    mouseDown = {x:e.clientX, y:e.clientY, button:e.button};
    dragging = false;
    if(e.button===0) state.mineHeld = true;
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
    if(getBlock(bx,by,bz)) return {hit:[bx,by,bz], place:prev};
    prev = [bx,by,bz];
  }
  return null;
}

export function placeAction(){
  const r = castBlock();
  if(!r || !r.place) return;
  const tid = slotBlock();
  if(!tid || !(inventory[tid]>0)) return;
  const [px,py,pz] = r.place;
  if(py<0||py>=WH) return;
  const d = new THREE.Vector3(px,py,pz).sub(player.pos);
  if(Math.abs(d.x)<.9 && Math.abs(d.z)<.9 && d.y>-.5 && d.y<2) return;
  applyEdit(px,py,pz,tid,false);
  inventory[tid]--;
  placeAnim = 1;
  sfx.place();
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
    m = state.mining = {x:bx,y:by,z:bz, progress:0, total:TYPES[t].hard/speed, emit:0, snd:0, type:t};
  }
  m.progress += dt;
  m.emit -= dt; m.snd -= dt;
  if(m.emit<=0){ spawnParticles(bx,by,bz,TYPES[m.type].pc,4); m.emit=.1; }
  if(m.snd<=0){ sfx.tick(m.type); m.snd=.2; }
  mineBar.style.display='block';
  mineFill.style.width = Math.min(100, m.progress/m.total*100)+'%';
  if(m.progress >= m.total){
    const old = applyEdit(bx,by,bz,0,true);
    if(old){ addToInventory(old); sfx.break(old); addShake(.16); }
    net.sendEdit(bx,by,bz,0);
    state.mining = null;
  }
}

function collide(pos){
  const r=.3;
  for(const ox of [-r,r]) for(const oz of [-r,r]) for(const oy of [0,.9,1.7]){
    if(getBlock(Math.round(pos.x+ox), Math.round(pos.y+oy), Math.round(pos.z+oz))) return true;
  }
  return false;
}

export function update(dt, elapsed){
  if(!state.playing) return;
  if(!invOpen){
    const speed = 5;
    const fwd = new THREE.Vector3(-Math.sin(view.yaw),0,-Math.cos(view.yaw));
    const right = new THREE.Vector3(-fwd.z,0,fwd.x);
    const f = (keys.KeyW?1:0)-(keys.KeyS?1:0) - joy.y;
    const s = (keys.KeyD?1:0)-(keys.KeyA?1:0) + joy.x;
    const move = new THREE.Vector3().addScaledVector(fwd,f).addScaledVector(right,s);
    if(move.lengthSq()>1) move.normalize();
    move.multiplyScalar(speed);
    player.vel.x = move.x; player.vel.z = move.z;
    player.vel.y -= 20*dt;
    if(keys.Space && player.onGround){ player.vel.y = 7.5; player.onGround=false; sfx.jump(); }
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
    if(movingNow2){
      const sw = Math.sin(elapsed*9)*.6;
      bLegL.rotation.x = sw; bLegR.rotation.x = -sw;
      bArmL.rotation.x = -sw*.7;
      if(!state.mineHeld) bArmR.rotation.x = sw*.7;
    } else {
      bLegL.rotation.x *= .8; bLegR.rotation.x *= .8;
      bArmL.rotation.x *= .8;
      if(!state.mineHeld) bArmR.rotation.x *= .8;
    }
    if(state.mineHeld && !invOpen) bArmR.rotation.x = -1 - Math.abs(Math.sin(swingT))*.9;
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
  return {
    x:+player.pos.x.toFixed(2), y:+player.pos.y.toFixed(2), z:+player.pos.z.toFixed(2),
    yaw:+view.yaw.toFixed(2),
    mine: state.mineHeld && m ? [m.x,m.y,m.z,m.type] : 0,
    tool: slotTool(),
    blk: slotBlock(),
    skin: skinIdx(),
  };
}

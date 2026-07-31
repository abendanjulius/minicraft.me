// player.js — local player: controls, physics, mining, first-person hand
import { WORLD, WH, CENTER, getBlock, heightAt } from './world.js';
import { camera, renderer, TYPES, TOOLS, isTouch, box, makeToolModel, makeBlockCube,
         applyEdit, spawnParticles } from './render.js';
import { inventory, hotbarSlots, sel, joy, invOpen, toggleInv, renderHotbar, renderTools,
         addToInventory, setToolChangeHook } from './ui.js';
import * as net from './net.js';

export const player = { pos:new THREE.Vector3(CENTER, 20, CENTER), vel:new THREE.Vector3(), onGround:false };
export const view = { yaw:0, pitch:0 };
export const state = { playing:false, mineHeld:false, mining:null }; // mining: {x,y,z,progress,total,emit,type}
const keys = {};
let usingLock = false, dragging = false, mouseDown = null;
let handBob = 0, swingT = 0, placeAnim = 0;

// ---- First-person hand & held item ----
const handGroup = new THREE.Group();
camera.add(handGroup);
handGroup.position.set(.5,-.45,-.8);
handGroup.rotation.set(-.2,.15,0);
handGroup.add(box(.16,.16,.5,0xdba97c,0,0,.05));
const toolModels = {};
for(const t of TOOLS) if(t.id!=='hand'){
  const m = makeToolModel(t.id);
  m.position.set(0,.06,-.22); m.rotation.x = -.5; m.visible = false;
  handGroup.add(m); toolModels[t.id] = m;
}
let heldBlockMesh = null;
function updateHeld(){
  for(const id in toolModels) toolModels[id].visible = (TOOLS[sel.tool].id===id);
  if(heldBlockMesh){ handGroup.remove(heldBlockMesh); heldBlockMesh = null; }
  const tid = hotbarSlots[sel.slot];
  if(TOOLS[sel.tool].id==='hand' && tid && inventory[tid]>0){
    heldBlockMesh = makeBlockCube(tid);
    heldBlockMesh.position.set(0,.05,-.3);
    handGroup.add(heldBlockMesh);
  }
}
setToolChangeHook(updateHeld);

export function spawn(){
  player.pos.set(CENTER, heightAt(CENTER,CENTER)+3, CENTER);
  player.vel.set(0,0,0);
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
    keys[e.code]=true;
    if(e.code.startsWith('Digit')){ const n=+e.code[5]; if(n>=1&&n<=5){ sel.slot=n-1; renderHotbar(); } }
    if(e.code==='KeyE' && state.playing) toggleInv();
    if(e.code==='KeyQ'){ sel.tool=(sel.tool+1)%TOOLS.length; renderTools(); }
  });
  document.addEventListener('keyup', e=>keys[e.code]=false);
  document.addEventListener('mousedown', e=>{
    if(isTouch || !state.playing || invOpen) return;
    if(e.target.closest('#hotbar,#inv,#tools')) return;
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
  const tid = hotbarSlots[sel.slot];
  if(!tid || !(inventory[tid]>0)) return;
  const [px,py,pz] = r.place;
  if(py<0||py>=WH) return;
  const d = new THREE.Vector3(px,py,pz).sub(player.pos);
  if(Math.abs(d.x)<.9 && Math.abs(d.z)<.9 && d.y>-.5 && d.y<2) return;
  applyEdit(px,py,pz,tid,false);
  inventory[tid]--;
  placeAnim = 1;
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
    const tool = TOOLS[sel.tool];
    const speed = tool.good.includes(t) ? 4 : 1;
    m = state.mining = {x:bx,y:by,z:bz, progress:0, total:TYPES[t].hard/speed, emit:0, type:t};
  }
  m.progress += dt;
  m.emit -= dt;
  if(m.emit<=0){ spawnParticles(bx,by,bz,TYPES[m.type].pc,4); m.emit=.1; }
  mineBar.style.display='block';
  mineFill.style.width = Math.min(100, m.progress/m.total*100)+'%';
  if(m.progress >= m.total){
    const old = applyEdit(bx,by,bz,0,true);
    if(old) addToInventory(old);
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
    if(keys.Space && player.onGround){ player.vel.y = 7.5; player.onGround=false; }

    for(const axis of ['x','z','y']){
      const step = player.vel[axis]*dt;
      player.pos[axis] += step;
      if(collide(player.pos)){
        player.pos[axis] -= step;
        if(axis==='y'){ if(player.vel.y<0) player.onGround=true; player.vel.y=0; }
      } else if(axis==='y' && player.vel.y<0){ player.onGround=false; }
    }
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

  // Hand animation
  const movingNow = Math.abs(player.vel.x)+Math.abs(player.vel.z) > .5;
  handBob += dt * (movingNow ? 7 : 2);
  let swing = 0;
  if(state.mineHeld && !invOpen){ swingT += dt*13; swing = -Math.abs(Math.sin(swingT))*.85; }
  else swingT = 0;
  if(placeAnim > 0){ placeAnim -= dt*4; swing = Math.min(swing, -Math.sin(Math.max(0,placeAnim)*Math.PI)*.85); }
  handGroup.rotation.x = -.2 + swing;
  handGroup.position.y = -.45 + Math.sin(handBob)*.015;
  handGroup.position.x = .5 + Math.cos(handBob*.5)*.012;
}

// State snapshot for the network
export function netState(){
  const m = state.mining;
  return {
    x:+player.pos.x.toFixed(2), y:+player.pos.y.toFixed(2), z:+player.pos.z.toFixed(2),
    yaw:+view.yaw.toFixed(2),
    mine: state.mineHeld && m ? [m.x,m.y,m.z,m.type] : 0,
    tool: TOOLS[sel.tool].id,
    blk: hotbarSlots[sel.slot] || 0,
  };
}

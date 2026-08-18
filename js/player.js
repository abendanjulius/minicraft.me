// player.js — local player: controls, physics, mining, first-person hand + visible body
import { WORLD, WH, CENTER, getBlock, heightAt, isWalkThrough, isDoor, doorFacing, doorOpen, doorType, doorStyleOf, doorItemOf, DOOR_STYLES, wrapC } from './world.js';
import { scene, camera, renderer, TYPES, TOOLS, ITEMS, SKINS, isTouch, box, makeCharacter, makeToolModel, makeBlockCube,
         makeHeldItemIcon, makeElderCubeMesh, makeWeaponModel, makeToolIconPlane, applyEdit, spawnParticles, spawnDust, jit, setBedFacing, bedFacing, updateChunkVisibility, updateTorchLights , applyCharacterArmor, updatePlacePreview, aimNDC, refreshAimNDC, screenToNDC } from './render.js';
import { day, setUnderwater } from './sky.js';
import { inventory, hotbarSlots, sel, joy, invOpen, toggleInv, renderHotbar,
         addToInventory, setHeldChangeHook, slotTool, slotBlock, nextToolSlot,
         chat, openChat, addChat, armorSlots, setArmorHook, getArmorSlots } from './ui.js';
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
import * as villagers from './villagers.js';
import * as keepstones from './keepstones.js';
import * as eldercube from './eldercube.js';
import * as claimMap from './map.js';

const slotFood = ()=>{ const s = hotbarSlots[sel.slot]; const it = s&&s.k==='f' ? ITEMS[s.id] : null; return (it && (it.food || it.heal)) ? s.id : 0; };

/**
 * Reliquary loot. Salvage worth the siege but not worth farming: the real prize
 * is the False Cube, which is granted separately and always.
 */
const RELIQUARY_LOOT = [
  [122, 2], [126, 2], [120, 4], [121, 3],   // crystal shards, ingots, coal, iron
  [40, 2], [10, 8], [17, 3], [23, 1],       // lanterns, torches, crystal block, iron block
  [143, 1], [171, 1], [114, 6], [130, 2],   // crystal sword, medkit, berries, tonic
];
function rollReliquary(){
  const pool = [...RELIQUARY_LOOT];
  const out = [];
  for(let i = 0; i < 3 && pool.length; i++){
    const [id, n] = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    out.push([id, 1 + Math.floor(Math.random() * n)]);
  }
  return out;
}

/**
 * Ray direction through the CROSSHAIR pixel (not blindly through the canvas
 * centre). Built analytically from fov/aspect so it never depends on the
 * camera's matrix being up to date this frame. On mobile the canvas and the
 * visual viewport can disagree, which used to aim the ray below the crosshair
 * and target a nearer cell than the player was pointing at.
 */
function dirFromNDC(nx, ny){
  const t = Math.tan(camera.fov * Math.PI / 360);
  return new THREE.Vector3(nx * t * camera.aspect, ny * t, -1)
    .applyEuler(new THREE.Euler(view.pitch, view.yaw, 0, 'YXZ'))
    .normalize();
}

function aimDir(){
  const n = aimNDC();
  return dirFromNDC(n.x, n.y);
}

/**
 * Raycast through an arbitrary screen pixel — the touch-to-place entry point.
 * Longer reach than the crosshair: with no crosshair there is no cue for how
 * far you can build, so a tap on plainly-visible ground must not silently do
 * nothing. Measured on real terrain, 8 blocks answered only ~82% of natural
 * taps; 12 answers ~90%, and taps past that are rare (median tap is ~3.5).
 */
/** Open/close the claim map. Shared by the Tab key and the touch button. */
export function toggleClaimMap(){
  if(!state.playing) return;
  claimMap.toggle(player.pos.x, player.pos.z);
}

export function castScreen(clientX, clientY, maxDist = 12){
  const n = screenToNDC(clientX, clientY);
  if(!n) return null;
  return castBlock(maxDist, dirFromNDC(n.x, n.y));
}

/** Place the held block at the pixel the player tapped. */
export function placeAtScreen(clientX, clientY){
  placeAction(castScreen(clientX, clientY));
}

// Aim at a nearby entity (animal or zombie) in front of the crosshair
function pickEntity(dirIn, blockHitIn){
  const dir = dirIn || aimDir();
  const eye = player.pos.clone().add(new THREE.Vector3(0,1.6,0));
  const blockHit = blockHitIn !== undefined ? blockHitIn : castBlock();
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
export const state = { playing:false, mineHeld:false, mining:null, mineTarget:null, paused:false, flying:false, sleeping:false };
let sleepSeq = null; // {phase, t, bed:{x,y,z}}
export const keys = {};
/** When true, human mouse/keyboard/touch look+move are ignored (AI drives). */
let inputLocked = false;
export function setInputLocked(on){ inputLocked = !!on; }
export const isInputLocked = () => inputLocked;
let usingLock = false, dragging = false, mouseDown = null;
let handBob = 0, swingT = 0, placeAnim = 0;
let shake = 0, wasGround = true, fallV = 0, stepTimer = 0, aimTimer = 0;
export function addShake(v){ shake = Math.min(.4, Math.max(shake, v)); }
export const skinIdx = ()=>Math.min(SKINS.length-1, Math.max(0, +(localStorage.getItem('mc_skin')||0)));

// ---- First-person hand & held item (Minecraft-style) ----
const handGroup = new THREE.Group();
camera.add(handGroup);
// Anchor in the lower-right of the view
handGroup.position.set(0.38, -0.42, -0.50);
handGroup.rotation.set(0, 0, 0);

// Bare arm: thick forearm coming in from the corner
const armPivot = new THREE.Group();
const armMesh = box(0.22, 0.22, 0.78, 0xdba97c, 0, 0, 0);
// fist / hand at the end of the arm
const fistMesh = box(0.26, 0.22, 0.22, 0xdba97c, 0, -0.02, -0.42);
armPivot.add(armMesh);
armPivot.add(fistMesh);
handGroup.add(armPivot);

// ---- Off-hand: the Elder Cube ----
// The Cube is carried in the LEFT hand and stays there regardless of the hotbar,
// so the right hand is free to hold a weapon and fight. It is why you cannot
// build while carrying it: that hand is full.
const offHandGroup = new THREE.Group();
camera.add(offHandGroup);
offHandGroup.position.set(-0.36, -0.30, -0.62);
let cubeInHand = null;
export const carryingCube = ()=> (inventory[186] || 0) > 0;

function updateOffHand(dt){
  const carrying = carryingCube();
  if(carrying && !cubeInHand){
    cubeInHand = makeElderCubeMesh(0.16);
    cubeInHand.rotation.set(-0.15, 0.35, 0.1);
    offHandGroup.add(cubeInHand);
  } else if(!carrying && cubeInHand){
    offHandGroup.remove(cubeInHand);
    // It is a Group of ribs/core/shell now, so dispose the whole tree.
    cubeInHand.traverse(o=>{
      o.material?.map?.dispose?.();
      o.material?.dispose?.();
      o.geometry?.dispose?.();
    });
    cubeInHand = null;
  }
  if(cubeInHand){
    // a slow turn and a shallow float, so it reads as alive rather than stuck on
    cubeInHand.rotation.y += dt * 0.9;
    cubeInHand.position.y = Math.sin(performance.now() / 700) * 0.015;
  }
}

const toolModels = {}; // unused in FP — kept empty so old refs don't break
let heldExtra = null;
function clearHeldExtra(){
  if(heldExtra){
    handGroup.remove(heldExtra);
    if(heldExtra.material){
      heldExtra.material.map?.dispose?.();
      heldExtra.material.dispose?.();
    }
    heldExtra.geometry?.dispose?.();
    heldExtra = null;
  }
}


/** Pose the arm for empty / tool / block modes */
function poseArm(mode){
  // mode: 'empty' | 'tool' | 'block' | 'item'
  // Minecraft-style: empty = hand only; holding anything = item only (no arm)
  if(mode === 'empty'){
    armPivot.visible = true;
    armPivot.position.set(0.18, -0.02, 0.05);
    armPivot.rotation.set(1.15, 0.55, 0.35);
  } else {
    // Hide the arm — only the held block/tool/item is visible
    armPivot.visible = false;
  }
}

function updateHeld(){
  const tool = slotTool();
  const held = hotbarSlots[sel.slot];
  clearHeldExtra();

  // Skin-colored arm
  const sk = SKINS[skinIdx()]?.skin ?? 0xdba97c;
  armMesh.material.color.setHex(sk);
  fistMesh.material.color.setHex(sk);

  // The Elder Cube is off-hand only. It should never reach a hotbar slot, but a
  // save written before that rule could still carry one — strip it rather than
  // draw the Cube in both hands at once.
  if(held?.id === 186){
    hotbarSlots[sel.slot] = null;
    poseArm('empty');
    return;
  }

  // Empty hand
  if(!held || (held.k!=='t' && !gm.forge && !(inventory[held.id]>0))){
    poseArm('empty');
    return;
  }

  // Mining tools — same emoji as hotbar, large + held in lower-right
  if(held.k==='t'){
    poseArm('tool');
    heldExtra = makeToolIconPlane(held.id, 1.15);
    // Offset within handGroup so it sits in the classic FP hold corner
    heldExtra.position.set(0.05, -0.02, -0.15);
    // Tilt so it reads as held, not a flat sticker
    heldExtra.rotation.set(-0.35, 0.55, 0.25);
    handGroup.add(heldExtra);
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
      heldExtra.position.set(0.28, -0.18, -0.5);
    } else if(id===62||id===63){
      heldExtra.scale.set(1, 0.2, 1);
      heldExtra.position.set(0.28, -0.12, -0.5);
    } else if(id===11){
      heldExtra.scale.set(0.35, 1, 0.35);
      heldExtra.position.set(0.26, -0.14, -0.48);
    } else {
      heldExtra.position.set(0.28, -0.14, -0.5);
    }
    heldExtra.rotation.set(0.25, -0.7, 0.15);
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
      heldExtra.position.set(0.04, -0.02, -0.16);
      heldExtra.rotation.set(-0.4, 0.45, 0.2);
      heldExtra.scale.multiplyScalar(1.4);
    } else {
      poseArm('item');
      heldExtra = makeHeldItemIcon(id, 0.95);
      heldExtra.position.set(0.04, -0.02, -0.16);
      heldExtra.rotation.set(-0.2, 0.4, 0.15);
    }
    handGroup.add(heldExtra);
  }
}
setHeldChangeHook(updateHeld);
setArmorHook(()=>applyLocalArmor());
updateHeld(); // initial empty-hand pose

// ---- Visible first-person body — pushed back behind the camera like Minecraft's ----
let bodyG = null, bArmL = null, bArmR = null, bLegL = null, bLegR = null, bHead = null;
let bodyParts = null;
function buildBody(){
  if(bodyG) scene.remove(bodyG);
  // Head included so sleep animation isn't headless; hidden during normal FP
  const c = makeCharacter(skinIdx(), true);
  bodyParts = c;
  bodyG = c.g; bArmL = c.armL; bArmR = c.armR; bLegL = c.legL; bLegR = c.legR; bHead = c.head;
  if(bHead) bHead.visible = false;
  bodyG.visible = false;
  scene.add(bodyG);
  armMesh.material.color.setHex(c.sk.skin); // first-person arm matches skin
  applyLocalArmor();
}
export function applyLocalArmor(){
  if(!bodyParts) return;
  applyCharacterArmor(bodyParts, getArmorSlots?.() || armorSlots);
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
    // Find open air near center (avoid debug pillars / trees)
    let sx = CENTER + 0.5, sz = CENTER + 0.5;
    let sy = heightAt(CENTER, CENTER) + 2;
    const clearAt = (x, z) => {
      const h = heightAt(Math.floor(x), Math.floor(z));
      for(let y = h + 1; y <= h + 3; y++){
        if(getBlock(Math.floor(x), y, Math.floor(z))) return false;
      }
      return true;
    };
    if(!clearAt(sx, sz)){
      for(const [dx, dz] of [[2,0],[-2,0],[0,2],[0,-2],[3,3],[-3,3],[4,0],[-4,0],[0,4]]){
        if(clearAt(CENTER + dx, CENTER + dz)){
          sx = CENTER + dx + 0.5;
          sz = CENTER + dz + 0.5;
          sy = heightAt(CENTER + dx, CENTER + dz) + 2;
          break;
        }
      }
    } else {
      sy = heightAt(CENTER, CENTER) + 2;
    }
    // Final safety: push up until head is free
    for(let i = 0; i < 16; i++){
      if(!getBlock(Math.floor(sx), Math.floor(sy), Math.floor(sz))
        && !getBlock(Math.floor(sx), Math.floor(sy + 1), Math.floor(sz))) break;
      sy += 1;
    }
    player.pos.set(sx, sy, sz);
  }
  player.vel.set(0,0,0);
  state.flying = false;
  buildBody();
  bodyG.visible = true;
}
export function look(dx,dy){
  if(inputLocked) return;
  view.yaw -= dx; view.pitch -= dy;
  view.pitch = Math.max(-Math.PI/2+.01, Math.min(Math.PI/2-.01, view.pitch));
}
/** sx,sy: optional screen pixel (touch). Mining then locks onto the block under
 *  the finger, so dragging to look afterwards doesn't slide the dig elsewhere. */
/** Immediate combat tap at a screen pixel (mobile). Returns true if something was hit. */
export function tryPunchAt(sx, sy){
  if(survival.sv.dead) return false;
  const r = castScreen(sx, sy);
  const e = pickEntity(r ? r.dir : undefined, r);
  if(!e) return false;
  const held = hotbarSlots[sel.slot];
  const wDmg = (held?.k==='f' && ITEMS[held.id]?.dmg) || 0;
  const dmg = wDmg || (slotTool()!=='hand' ? 3 : 2);
  net.sendHit(e.kind, e.eid, dmg, player.pos.x, player.pos.z);
  placeAnim = 1;
  sfx.punch();
  return true;
}

export function setMine(b, sx, sy){
  if(survival.sv.dead){ state.mineHeld=false; state.mining=null; state.mineTarget=null; state.mineScreen=null; return; }
  const atPixel = b && sx !== undefined && sy !== undefined;
  if(b){
    // Mobile dig uses the same reach as desktop crosshair mining (8), not the
    // longer place reach (12) — far-terrain taps were starting digs 10+ blocks out.
    const r = atPixel ? castScreen(sx, sy, 8) : castBlock();
    const e = pickEntity(atPixel && r ? r.dir : undefined, r);
    if(e){
      const held = hotbarSlots[sel.slot];
      const wDmg = (held?.k==='f' && ITEMS[held.id]?.dmg) || 0;
      const dmg = wDmg || (slotTool()!=='hand' ? 3 : 2);
      net.sendHit(e.kind, e.eid, dmg, player.pos.x, player.pos.z);
      placeAnim = 1;      // single chop animation
      sfx.punch();
      return;             // a punch, not a mining hold
    }
    if(atPixel){
      // Finger is a live aim point — store screen pixel; world target is
      // resolved every frame in updateMining so look-drag stays accurate.
      state.mineScreen = [sx, sy];
      state.mineTarget = r && r.hit ? r.hit.slice() : null;
      if(!state.mineTarget){ state.mineHeld = false; state.mining = null; state.mineScreen = null; return; }
    } else {
      state.mineTarget = null;
      state.mineScreen = null;
    }
  } else {
    state.mineTarget = null;
    state.mineScreen = null;
  }
  state.mineHeld = b;
  if(!b) state.mining = null;
}

/** Live finger aim while a mobile dig is held — keeps mine under the fingertip. */
export function setMineAim(sx, sy){
  if(!state.mineHeld) return;
  state.mineScreen = [sx, sy];
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
    if(inputLocked || isTouch || !state.playing || invOpen || state.paused) return;
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
      if(claimMap.isOpen()){ claimMap.close(); return; }
      if(invOpen){ toggleInv(false); return; }
      setPaused(!state.paused);
      return;
    }
    if(state.paused) return;
    if(e.code==='Enter' && state.playing){ for(const k in keys) keys[k]=false; openChat(); return; }
    if(inputLocked) return; // AI drives movement; still allow Escape above
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
    // Claim map. Tab, not M — M is already the music toggle.
    if(e.code==='Tab' && state.playing){
      e.preventDefault();
      toggleClaimMap();
    }
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
    if(inputLocked || isTouch || !state.playing || invOpen) return;
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

/** Solid block you can attach to */
function isSupportBlock(b){
  return !!(b && !isWalkThrough(b) && b !== 64);
}

function hasBlockSupport(x, y, z){
  for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
    if(isSupportBlock(getBlock(x+dx, y+dy, z+dz))) return true;
  }
  return false;
}

/** Center-indexed unit cubes: block at n occupies [n-0.5, n+0.5] */
function placeOverlapsPlayer(px, py, pz){
  const half = 0.3;
  const px0 = player.pos.x - half, px1 = player.pos.x + half;
  const pz0 = player.pos.z - half, pz1 = player.pos.z + half;
  const py0 = player.pos.y + 0.05, py1 = player.pos.y + 1.7;
  return !(px1 <= px-0.5 || px0 >= px+0.5 || py1 <= py-0.5 || py0 >= py+0.5 || pz1 <= pz-0.5 || pz0 >= pz+0.5);
}

function faceAdjacentPlace(hx, hy, hz, dir){
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  if(ay >= ax && ay >= az) return [hx, hy - (dir.y >= 0 ? 1 : -1), hz];
  if(ax >= az) return [hx - (dir.x >= 0 ? 1 : -1), hy, hz];
  return [hx, hy, hz - (dir.z >= 0 ? 1 : -1)];
}

/**
 * Resolve where a placed block will actually land for a given raycast result,
 * mirroring placeAction's validation exactly. Returns [px,py,pz] or null.
 * Shared by placeAction (to place) and the update loop (to preview the ghost),
 * so the ghost always shows the true destination cell.
 */
/** Tall grass & flowers: a placed block swallows them, as in Minecraft. */
const REPLACEABLE = new Set([66, 67, 68, 69]);

function resolvePlaceCell(r){
  if(!r || !r.hit) return null;
  const [hx,hy,hz] = r.hit;

  // Tapped a plant: the block takes its cell. Without this the target is the
  // cell ABOVE a wispy tuft, which has nothing solid to attach to, so tapping
  // grass — everywhere on plains — silently did nothing.
  if(REPLACEABLE.has(getBlock(hx,hy,hz))){
    if(hy < 0 || hy >= WH) return null;
    if(!hasBlockSupport(hx,hy,hz)) return null;
    if(placeOverlapsPlayer(hx,hy,hz)) return null;
    return [hx,hy,hz];
  }

  // Against the face the crosshair entered — top face → on top, side face → on
  // that side. The DDA's `place` IS that cell: it steps one boundary at a time,
  // so the last empty cell before the hit is always exactly face-adjacent.
  // Nothing guesses at neighbours, so a block can never appear off to the side.
  let place = r.place;
  if(!place) place = faceAdjacentPlace(hx, hy, hz, r.dir || aimDir());
  const [px,py,pz] = place;
  if(py<0||py>=WH) return null;

  // Must be free — water and plants are replaceable
  const occ = getBlock(px,py,pz);
  if(occ && occ !== 64 && !REPLACEABLE.has(occ)) return null;

  // No floating blocks — must touch a solid
  if(!hasBlockSupport(px, py, pz)) return null;
  if(placeOverlapsPlayer(px, py, pz)) return null;
  return [px,py,pz];
}

/**
 * Crosshair raycast — voxel DDA (Amanatides–Woo). Blocks are centered on integer
 * coords (Math.round), so cell boundaries sit at n±0.5. Stepping one boundary at
 * a time makes the last empty cell before a hit EXACTLY face-adjacent, so `place`
 * is always on the correct face — no dominant-axis guessing (which mis-placed
 * blocks at diagonal angles). Returns { hit, place, dist }.
 */
export function castBlock(maxDist = 8, dirOverride){
  const dir = dirOverride || aimDir();
  if(dir.lengthSq() < 1e-10) return null;
  // Eye MUST match the camera exactly (main.js sets camera at pos + 1.6), or the
  // ray diverges from the crosshair — most visibly on the ground at shallow angles.
  const eye = new THREE.Vector3(player.pos.x, player.pos.y + 1.6, player.pos.z);

  let bx = Math.round(eye.x), by = Math.round(eye.y), bz = Math.round(eye.z);
  const stepX = dir.x >= 0 ? 1 : -1, stepY = dir.y >= 0 ? 1 : -1, stepZ = dir.z >= 0 ? 1 : -1;
  const bound = (p, d) => d >= 0 ? (Math.round(p) + 0.5) : (Math.round(p) - 0.5);
  let tMaxX = dir.x !== 0 ? (bound(eye.x, dir.x) - eye.x) / dir.x : Infinity;
  let tMaxY = dir.y !== 0 ? (bound(eye.y, dir.y) - eye.y) / dir.y : Infinity;
  let tMaxZ = dir.z !== 0 ? (bound(eye.z, dir.z) - eye.z) / dir.z : Infinity;
  const tDX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

  let px = null, py = 0, pz = 0, t = 0;      // last empty cell = place candidate
  for(let i = 0; i < 512; i++){
    const b = getBlock(bx, by, bz);
    const solid = b && b !== 64;             // air (0) & water (64) are pass-through
    // Ignore a block the camera is sitting inside (first ~0.2 units).
    if(solid && !(t < 0.2 && isSupportBlock(b))){
      return { hit:[bx,by,bz], place: px !== null ? [px,py,pz] : null, dist:t, dir };
    }
    if(!solid){ px = bx; py = by; pz = bz; }
    if(tMaxX <= tMaxY && tMaxX <= tMaxZ){ bx += stepX; t = tMaxX; tMaxX += tDX; }
    else if(tMaxY <= tMaxZ){ by += stepY; t = tMaxY; tMaxY += tDY; }
    else { bz += stepZ; t = tMaxZ; tMaxZ += tDZ; }
    if(t > maxDist) break;
  }
  return null;
}

function yawToFacing(yaw){
  // Door FRONT faces the player (0=+Z, 1=+X, 2=-Z, 3=-X).
  // Player look dir at yaw=0 is -Z; face-toward-player is opposite of look.
  const lookX = -Math.sin(yaw);
  const lookZ = -Math.cos(yaw);
  const faceX = -lookX; // toward player
  const faceZ = -lookZ;
  if(Math.abs(faceZ) >= Math.abs(faceX)) return faceZ >= 0 ? 0 : 2;
  return faceX >= 0 ? 1 : 3;
}
function toggleDoorAt(bx,by,bz){
  const t = getBlock(bx,by,bz);
  const style = doorStyleOf(t);
  if(!style) return false;
  // Resolve to bottom cell if player clicked the upper half
  let by0 = by;
  if(doorStyleOf(getBlock(bx, by-1, bz))) by0 = by - 1;
  const facing = doorFacing(getBlock(bx,by0,bz));
  const open = doorOpen(getBlock(bx,by0,bz));
  const nt = doorType(style.id, facing, !open);
  applyEdit(bx, by0, bz, nt, false);
  applyEdit(bx, by0+1, bz, nt, false);
  net.sendEdit(bx, by0, bz, nt);
  net.sendEdit(bx, by0+1, bz, nt);
  sfx.place();
  return true;
}

/** rIn: an optional pre-computed raycast (touch-to-place passes the tapped ray). */

/** Keep the same hotbar slot selected while swapping empty ↔ water bucket.
 *  In Forge the bucket stays as-is (infinite, Minecraft creative style). */
function swapHeldBucket(fromId, toId){
  if(gm.forge){ renderHotbar(); return; }
  inventory[fromId] = (inventory[fromId] || 0) - 1;
  if(inventory[fromId] <= 0) delete inventory[fromId];
  inventory[toId] = (inventory[toId] || 0) + 1;
  const s = hotbarSlots[sel.slot];
  if(s && s.k === 'f' && s.id === fromId) s.id = toId;
  else if(!hotbarSlots.some(x => x?.k === 'f' && x.id === toId)){
    const empty = hotbarSlots.findIndex(x => x === null);
    if(empty !== -1) hotbarSlots[empty] = {k: 'f', id: toId};
  }
  renderHotbar();
}

export function placeAction(rIn){
  if(survival.sv.dead) return;
  // Talk to nearby Eldercube folk
  if(villagers.tryTalk(player.pos)){ placeAnim = 1; sfx.chat?.(); return; }
  const food = slotFood();
  if(food){ if(survival.eatSelected(food)) placeAnim = 1; return; }
  const r = rIn || castBlock();
  const heldSlot = hotbarSlots[sel.slot];
  const heldItem = (heldSlot?.k === 'f') ? heldSlot.id : 0;

  // ---- Buckets: empty picks up a water source; full places one ----
  if(heldItem === 166 || heldItem === 167){
    if(heldItem === 166 && r && r.hit){
      // Empty bucket → scoop water
      const [hx,hy,hz] = r.hit;
      if(getBlock(hx,hy,hz) === 64){
        applyEdit(hx, hy, hz, 0, false);
        net.sendEdit(hx, hy, hz, 0);
        swapHeldBucket(166, 167);
        placeAnim = 1;
        sfx.place();
        return;
      }
    }
    if(heldItem === 167){
      // Water bucket → place a water source (same rules as a normal block place)
      const cell = resolvePlaceCell(r);
      if(cell){
        const [px,py,pz] = cell;
        applyEdit(px, py, pz, 64, false);
        net.sendEdit(px, py, pz, 64);
        swapHeldBucket(167, 166);
        placeAnim = 1;
        sfx.place();
        return;
      }
    }
    // Holding a bucket but no valid water target — do nothing (don't fall through to block place)
    return;
  }

  // Click door / crate / powder keg interactions
  if(r && r.hit){
    let [hx,hy,hz] = r.hit;
    let hit = getBlock(hx,hy,hz);
    // Forgiving aim for the Keepstone: the seated Cube is the eye-catching part
    // and players aim at it, which can land a cell high. If the cell we hit is
    // empty-ish and a Keepstone sits directly below, treat it as the stone.
    if(hit !== 43 && getBlock(hx, hy-1, hz) === 43 && isWalkThrough(hit)){
      hy -= 1; hit = 43;
    } else if(hit !== 43 && r.place && getBlock(r.place[0], r.place[1]-1, r.place[2]) === 43){
      hx = r.place[0]; hy = r.place[1]-1; hz = r.place[2]; hit = 43;
    }
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
    // Keepstone: socket the Elder Cube to start claiming, or pull it back out.
    // Carrying the Cube does nothing — this click is the only thing that arms it.
    if(hit===43){
      // Nightfall only. Claiming ground from a horde that is asleep, with
      // infinite blocks in hand, would be theatre — so the cradle stays inert.
      if(gm.forge){
        addChat('⚙', 'The Keepstone is cold in Forge. It only wakes in Nightfall.');
        return;
      }
      const st = keepstones.get(hx,hy,hz) || keepstones.place(hx,hy,hz);
      if(st.socketed){
        if(keepstones.unsocket(hx,hy,hz)){
          addToInventory(186, 1);
          eldercube.setCubeOwner(net.myPeerId(), net.myPlayerName());
          renderHotbar();
          addChat('⚙', keepstones.isDone(st)
            ? 'You lift the Elder Cube. This ground is claimed for good.'
            : 'You lift the Elder Cube. The stone goes dark.');
          placeAnim = 1; sfx.place();
        }
        return;
      }
      // A spent stone that gave the Cube back leaves a reliquary. Collect it.
      if(keepstones.hasReward(st)){
        keepstones.takeReward(hx,hy,hz);
        const loot = rollReliquary();
        for(const [id,n] of loot) for(let i=0;i<n;i++) addToInventory(id);
        addToInventory(187);                 // the False Cube is always in there
        renderHotbar();
        addChat('⚙', 'The reliquary opens: ' +
          loot.map(([id,n])=>n+'× '+(TYPES[id]?.name || ITEMS[id]?.name || id)).join(', ') +
          ', and a False Cube.');
        placeAnim = 1; sfx.place();
        return;
      }
      // A spent stone will hold a False Cube as a permanent lamp.
      if(keepstones.isDone(st) && !keepstones.isLamp(st) && inventory[187] > 0){
        if(keepstones.seatFalseCube(hx,hy,hz)){
          inventory[187]--;
          if(inventory[187] <= 0) delete inventory[187];
          for(let i=0;i<hotbarSlots.length;i++) if(hotbarSlots[i]?.id===187 && !(inventory[187]>0)) hotbarSlots[i]=null;
          renderHotbar();
          addChat('⚙', 'The False Cube settles into the spent cradle. It will burn here.');
          placeAnim = 1; sfx.place();
        }
        return;
      }
      if(keepstones.isDone(st)){
        addChat('⚙', keepstones.isLamp(st)
          ? 'This Keepstone burns quietly. Its claiming is long done.'
          : 'This Keepstone has finished its work.');
        return;
      }
      // Keyed on carrying it, not on having it selected — the Cube lives in the
      // off-hand and never occupies a hotbar slot, so there is nothing to select.
      if(carryingCube()){
        keepstones.socket(hx,hy,hz);
        inventory[186]--;
        if(inventory[186] <= 0) delete inventory[186];
        eldercube.setCubeOwner(null); // it belongs to the stone now, not a person
        renderHotbar();
        survival.note('socket');
        addChat('⚙', 'The Elder Cube settles into the stone. Hold this ground.');
        placeAnim = 1; sfx.place();
        return;
      }
      addChat('⚙', 'The cradle is empty. It wants the Elder Cube.');
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
  if(!r || !r.hit) return;
  let tid = slotBlock();
  if(!tid){
    // Holding a tool / empty — interact already handled above; nothing to place
    return;
  }
  // Your left hand is full of Elder Cube. You can still fight — a weapon goes in
  // the right hand — but you cannot build while carrying it.
  //
  // The Keepstone is the one exception, and it has to be: you need a cradle to
  // put the Cube down, so blocking it would strand you holding a Cube you can
  // never seat. Setting down the pedestal is how you free your hands, not a way
  // around the cost.
  if(carryingCube() && tid !== 43){
    addChat('⚙', 'Your hands are full — only a Keepstone can be set down while you carry the Elder Cube.');
    return;
  }
  // Normalize door state ids back to item ids
  for(const s of DOOR_STYLES){
    if(tid>=s.base && tid<s.base+8) tid = s.item;
  }
  if(!gm.forge && !(inventory[tid]>0)) return;

  // Compute / validate place cell against the hit face (shared with the ghost preview)
  const doorStyle = DOOR_STYLES.find(s => s.item === tid);
  const cell = resolvePlaceCell(r);
  if(!cell) return;
  let [px,py,pz] = cell;

  // Place any door style — occupies 2 blocks tall (bottom + top)
  if(doorStyle){
    if(py+1>=WH || getBlock(px,py+1,pz)) return;
    if(getBlock(px,py,pz)) return;
    const facing = yawToFacing(view.yaw);
    const dt = doorType(doorStyle.id, facing, false);
    applyEdit(px,py,pz,dt,false);
    applyEdit(px,py+1,pz,dt,false); // upper half reserved
    if(!gm.forge) inventory[tid]--;
    placeAnim = 1;
    sfx.place();
    survival.note('place', tid);
    renderHotbar();
    net.sendEdit(px,py,pz,dt);
    net.sendEdit(px,py+1,pz,dt);
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
  if(tid===43) keepstones.place(px,py,pz); // empty cradle, waiting for the Cube
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
  let bx, by, bz;
  if(state.mineScreen){
    // Mobile: the finger is a live laser. Re-cast every frame from the current
    // fingertip pixel so dig matches what the player is actually pointing at
    // (look-drag on the same finger used to leave a stale world lock).
    const r = castScreen(state.mineScreen[0], state.mineScreen[1], 8);
    if(!r || !r.hit || !getBlock(...r.hit)){
      state.mining = null;
      mineBar.style.display = 'none';
      return;
    }
    [bx,by,bz] = r.hit;
    if(getBlock(bx,by,bz) !== 43 && getBlock(bx,by-1,bz) === 43 && isWalkThrough(getBlock(bx,by,bz))) by -= 1;
    state.mineTarget = [bx,by,bz];
  } else if(state.mineTarget){
    // World-locked dig (AI / explicit lock). Progress stays on this cell even if
    // the crosshair drifts — required for the bot to finish blocks.
    [bx,by,bz] = state.mineTarget;
    if(!getBlock(bx,by,bz)){
      state.mining = null;
      state.mineTarget = null;
      mineBar.style.display = 'none';
      return;
    }
  } else {
    const r = castBlock();
    if(!r){ state.mining=null; mineBar.style.display='none'; return; }
    [bx,by,bz] = r.hit;
    // Same forgiving aim as placeAction: swinging at the seated Cube should dig
    // the Keepstone holding it, not whatever lies far behind it.
    if(getBlock(bx,by,bz) !== 43 && getBlock(bx,by-1,bz) === 43 && isWalkThrough(getBlock(bx,by,bz))) by -= 1;
    else if(r.place && getBlock(r.place[0], r.place[1]-1, r.place[2]) === 43){
      bx = r.place[0]; by = r.place[1]-1; bz = r.place[2];
    }
  }
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
        // clear the other half of the 2-tall door
        const otherY = doorStyleOf(getBlock(bx, by+1, bz)) ? by+1 : (doorStyleOf(getBlock(bx, by-1, bz)) ? by-1 : null);
        if(otherY !== null){
          applyEdit(bx, otherY, bz, 0, false);
          net.sendEdit(bx, otherY, bz, 0);
        }
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
      } else if(old===43){
        // Mining a Keepstone that still holds the Cube must hand the Cube back —
        // it is the one object in the world that can never be destroyed.
        if(keepstones.remove(bx,by,bz)){
          addToInventory(186);
          addChat('⚙', 'You pry the Elder Cube loose as the stone comes apart.');
        }
        addToInventory(43);
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
  // The Cube is what the night wants. Carry it and every night gets fought,
  // never skipped — this is one of the three costs that make socketing matter.
  if(inventory[186] > 0){
    addChat('⚙', 'You cannot sleep. The Elder Cube will not let the night pass.');
    return;
  }
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
    view.pitch = -Math.PI/2; // top-down
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
    view.pitch = -Math.PI/2;
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
  // Clear the target outline on every path that skips the highlight update
  // below, or it hangs frozen in the world with no crosshair on it.
  if(!state.playing || state.paused || state.sleeping) updatePlacePreview(null);
  if(!state.playing) return;
  if(state.paused) return;
  if(state.sleeping){
    updateSleep(dt);
    // Top-down view of the character in bed
    camera.position.set(player.pos.x, player.pos.y + 4.2, player.pos.z);
    // Look straight down; keep yaw so body orientation matches bed
    camera.rotation.set(-Math.PI/2, view.yaw, 0, 'YXZ');
    return;
  }
  if(!invOpen && !survival.sv.dead){
    // Sprint: hold Shift (or mobile sprint flag) while moving
    const sprinting = !!(keys.ShiftLeft || keys.ShiftRight || keys.sprint);
    let speed = sprinting ? 8.2 : 5;
    if(state.flying && gm.forge) speed = sprinting ? 14 : 9;
    // AI / locked input: human-paced walk (bot looked too frantic)
    if(inputLocked) speed *= sprinting ? 0.62 : 0.58;
    // Water: slower move + mild buoyancy
    const feet = getBlock(Math.round(player.pos.x), Math.round(player.pos.y - 0.1), Math.round(player.pos.z));
    const body = getBlock(Math.round(player.pos.x), Math.round(player.pos.y + 0.6), Math.round(player.pos.z));
    const inWater = feet === 64 || body === 64;
    setUnderwater?.(inWater);
    // Breath is about the HEAD, not the feet — wading chest-deep should not
    // drown you. Eye height is ~1.6 above the player origin.
    const head = getBlock(Math.round(player.pos.x), Math.round(player.pos.y + 1.5), Math.round(player.pos.z));
    survival.setSubmerged(head === 64);
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

  // Re-measure the crosshair now and then: mobile browsers slide their URL bar
  // in and out mid-play, which moves the crosshair relative to the canvas.
  aimTimer -= dt;
  if(aimTimer <= 0){ aimTimer = 0.5; refreshAimNDC(); }

  // Outline the block under the crosshair. Touch has no crosshair — you tap the
  // block you want — so a centre-screen outline would be pointing at nothing.
  if(!isTouch && !invOpen && !survival.sv.dead){
    const r = castBlock();
    updatePlacePreview(r && r.hit ? r.hit : null);
  } else {
    updatePlacePreview(null);
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
  updateOffHand(dt);
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
  handGroup.position.set(0.38 + bobX, -0.42 + bobY + swing*0.03, -0.50 + swing*0.08);
  handGroup.rotation.set(swing*0.7, swing*0.12, 0);
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
    armor: getArmorSlots?.() || armorSlots,
  };
}

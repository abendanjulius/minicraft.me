// net.js — PeerJS rooms: host relays, clients follow. Also renders remote player avatars.
import { WORLD, seed } from './world.js';
import { scene, camera, box, makeCharacter, makeToolModel, makeBlockCube, applyEdit, spawnParticles, TYPES, SKINS,
         day, setDayTime } from './render.js';
import { setBanner, setPlayers, addChat } from './ui.js';
import { sfx } from './audio.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';
import * as mobs from './mobs.js';
import * as survival from './survival.js';
import { MOB_DROPS } from './content.js';
import { addToInventory } from './ui.js';

export let mode = 'solo';           // 'solo' | 'host' | 'client'
let peer = null, conns = [];        // host: all client conns; client: [hostConn]
let myName = 'Player';
const editLog = [];                 // host keeps this for late joiners
const remotes = new Map();          // peerId -> remote player
let posTimer = 0, animTimer = 0;

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const codeToId = c => 'minicraft-me-room-' + c.toLowerCase();
function makeCode(){
  let c = ''; for(let i=0;i<5;i++) c += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];
  return c;
}

// ---- Remote avatar ----
function nameSprite(name){
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px monospace'; g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0,8,256,48);
  g.fillStyle = '#fff'; g.fillText(name.slice(0,12), 128, 42);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({map:t, depthTest:false}));
  s.scale.set(1.6,.4,1);
  return s;
}
function makeAvatar(name, skinIdx=0){
  const c = makeCharacter(skinIdx, true);
  const tag = nameSprite(name); tag.position.y = 2.15; c.g.add(tag);
  const held = new THREE.Group(); held.position.set(.34,.8,.15); c.g.add(held);
  scene.add(c.g);
  return {g:c.g, armR:c.armR, legL:c.legL, legR:c.legR, held, heldKey:'', tgt:null, swing:0, chip:0, name};
}
function setHeldItem(r, tool, blk){
  const key = tool!=='hand' ? 't:'+tool : (blk ? 'b:'+blk : '');
  if(key===r.heldKey) return;
  r.heldKey = key;
  r.held.clear();
  if(key.startsWith('t:')){ const m = makeToolModel(tool); m.rotation.x = -.6; r.held.add(m); }
  else if(key.startsWith('b:') && TYPES[blk]) r.held.add(makeBlockCube(blk, .3));
}
function removeRemote(id){
  const r = remotes.get(id);
  if(r){ scene.remove(r.g); remotes.delete(id); refreshPlayerList(); }
}
function refreshPlayerList(){
  setPlayers([...remotes.values()].map(r=>r.name));
}

// ---- Message handling ----
function handle(msg, fromConn){
  if(msg.t==='pos'){
    let r = remotes.get(msg.id);
    if(!r){ r = makeAvatar(msg.name||'Player', msg.skin|0); remotes.set(msg.id, r); refreshPlayerList(); }
    r.tgt = msg;
    setHeldItem(r, msg.tool, msg.blk);
    if(mode==='host') relay(msg, fromConn);
  } else if(msg.t==='edit'){
    applyEdit(msg.x, msg.y, msg.z, msg.v, true);
    if(mode==='host'){ editLog.push([msg.x,msg.y,msg.z,msg.v]); relay(msg, fromConn); }
  } else if(msg.t==='anim'){
    animals.applyRemote(msg.d);
    if(msg.z) mobs.applyRemote(msg.z);
    if(msg.tod!==undefined) setDayTime(msg.tod);
  } else if(msg.t==='hit' && mode==='host'){
    hostHandleHit(msg.id0, msg.kind, msg.eid, msg.dmg, msg.px, msg.pz);
  } else if(msg.t==='hurt'){
    survival.damage(msg.dmg, msg.cause||'zombie');
  } else if(msg.t==='give'){
    addToInventory(msg.item);
  } else if(msg.t==='kudos'){
    survival.note(msg.what);
  } else if(msg.t==='chat'){
    addChat(msg.name||'Player', String(msg.text).slice(0,120));
    sfx.chat();
    if(mode==='host') relay(msg, fromConn);
  } else if(msg.t==='bye'){
    removeRemote(msg.id);
    if(mode==='host') relay(msg, fromConn);
  }
}
function relay(msg, except){
  // A tab closed without warning can leave a dead conn that still claims to be open.
  // If sending throws, prune it — otherwise one dead conn blocks everyone after it.
  for(let i=conns.length-1;i>=0;i--){
    const c = conns[i];
    if(c===except || !c.open) continue;
    try{ c.send(msg); }
    catch(e){
      conns.splice(i,1);
      try{ c.close(); }catch(_){}
      removeRemote(c.peer);
    }
  }
}
function safeSendHost(msg){
  try{ conns[0]?.open && conns[0].send(msg); }catch(e){ setBanner('Disconnected from host'); }
}
export function sendChat(text){
  if(mode==='solo') return;
  const msg = {t:'chat', id:peer?.id, name:myName, text:String(text).slice(0,120)};
  if(mode==='host') relay(msg, null);
  else safeSendHost(msg);
}

// ---- Combat ----
function sendToPeer(peerId, msg){
  if(peerId==='me' || peerId===peer?.id){ handle(msg, null); return; }
  const c = conns.find(c=>c.peer===peerId);
  if(c?.open){ try{ c.send(msg); }catch(e){} }
}
// Runs on the authority (host or solo). hitterId 'me' = the authority player.
export function hostHandleHit(hitterId, kind, eid, dmg, px, pz){
  const from = {x:px, z:pz};
  if(kind==='a'){
    const drops = animals.hit(eid, dmg, from);
    if(drops) for(const item of drops) sendToPeer(hitterId, {t:'give', item});
  } else if(kind==='z'){
    const res = mobs.hit(eid, dmg);
    if(res==='killed'){
      sendToPeer(hitterId, {t:'kudos', what:'zkill'});
      for(const [item,p] of MOB_DROPS.zombie) if(Math.random()<p) sendToPeer(hitterId, {t:'give', item});
    }
  }
}
export function sendHit(kind, eid, dmg, px, pz){
  if(mode==='client'){ safeSendHost({t:'hit', id0:peer?.id, kind, eid, dmg, px, pz}); }
  else hostHandleHit('me', kind, eid, dmg, px, pz); // solo + host resolve locally
}
// Targets for zombie AI: authority player + all remotes
export function getTargets(myPos){
  const list = [{id:'me', x:myPos.x, y:myPos.y, z:myPos.z}];
  for(const [id,r] of remotes) list.push({id, x:r.g.position.x, y:r.g.position.y, z:r.g.position.z});
  return list;
}
export function dispatchHurts(hurts){
  for(const h of hurts){
    if(h.id==='me') survival.damage(h.dmg, 'zombie');
    else sendToPeer(h.id, {t:'hurt', dmg:h.dmg, cause:'zombie'});
  }
}
export function sendEdit(x,y,z,v){
  if(mode==='solo') return;
  const msg = {t:'edit', x,y,z, v, id:peer?.id};
  if(mode==='host'){ editLog.push([x,y,z,v]); relay(msg,null); }
  else safeSendHost(msg);
}

// ---- Session starters ----
export function startSolo(name){ mode='solo'; myName=name; }

export function startHost(name, newSeed, onReady, onError){
  mode='host'; myName=name;
  const code = makeCode();
  peer = new Peer(codeToId(code));
  peer.on('open', ()=>{
    setBanner(`Hosting · room code: ${code}`);
    onReady(code);
  });
  peer.on('connection', conn=>{
    conn.on('open', ()=>{
      conns.push(conn);
      conn.send({t:'init', seed:newSeed, edits:editLog, tod:day.t});
    });
    conn.on('data', d=>handle(d, conn));
    conn.on('close', ()=>{ conns = conns.filter(c=>c!==conn); removeRemote(conn.peer); });
  });
  peer.on('error', e=>onError?.(e));
}

export function startJoin(name, code, onInit, onError){
  mode='client'; myName=name;
  peer = new Peer();
  peer.on('open', ()=>{
    const conn = peer.connect(codeToId(code.trim()), {reliable:true});
    let gotInit = false;
    conn.on('open', ()=>{ conns=[conn]; setBanner(`Joined room ${code.toUpperCase()}`); });
    conn.on('data', d=>{
      if(d.t==='init' && !gotInit){ gotInit = true; if(d.tod!==undefined) setDayTime(d.tod); onInit(d.seed, d.edits); }
      else handle(d, conn);
    });
    conn.on('close', ()=>setBanner('Disconnected from host'));
    setTimeout(()=>{ if(!gotInit) onError?.(new Error('Could not reach that room code.')); }, 8000);
  });
  peer.on('error', e=>onError?.(e));
}

// ---- Per-frame ----
const shortest = d => { if(d > WORLD/2) d -= WORLD; if(d < -WORLD/2) d += WORLD; return d; };
export function update(dt, elapsed){
  if(mode==='solo') return;

  // send my state ~12x/s
  posTimer -= dt;
  if(posTimer<=0 && peer?.id){
    posTimer = .08;
    const msg = {t:'pos', id:peer.id, name:myName, ...playerMod.netState()};
    if(mode==='host') relay(msg,null);
    else safeSendHost(msg);
  }
  // host broadcasts animals 5x/s
  if(mode==='host'){
    animTimer -= dt;
    if(animTimer<=0){ animTimer = .2; relay({t:'anim', d:animals.serialize(), z:mobs.serialize(), tod:day.t}, null); }
  }

  // animate remote avatars
  for(const r of remotes.values()){
    if(!r.tgt) continue;
    const p = r.g.position;
    p.x += shortest(r.tgt.x - p.x)*Math.min(1,dt*10);
    p.y += (r.tgt.y - p.y)*Math.min(1,dt*10);
    p.z += shortest(r.tgt.z - p.z)*Math.min(1,dt*10);
    r.g.rotation.y = r.tgt.yaw + Math.PI;

    const mining = !!r.tgt.mine;
    if(mining){
      r.swing += dt*13;
      r.armR.rotation.x = -1 - Math.abs(Math.sin(r.swing))*.9;
      r.chip -= dt;
      if(r.chip<=0){
        r.chip = .15;
        const [mx,my,mz,mt] = r.tgt.mine;
        spawnParticles(mx,my,mz, TYPES[mt]?.pc ?? 0xffffff, 3);
      }
    } else {
      r.swing = 0;
      r.armR.rotation.x *= .8;
    }
    // walk legs from horizontal motion
    const moving = Math.hypot(shortest(r.tgt.x-p.x), shortest(r.tgt.z-p.z)) > .02;
    if(moving){
      const sw = Math.sin(elapsed*9)*.6;
      r.legL.rotation.x = sw; r.legR.rotation.x = -sw;
    } else { r.legL.rotation.x *= .8; r.legR.rotation.x *= .8; }
  }
}

addEventListener('beforeunload', ()=>{
  if(peer?.id && mode!=='solo'){
    const msg = {t:'bye', id:peer.id};
    if(mode==='host') relay(msg,null); else safeSendHost(msg);
  }
});

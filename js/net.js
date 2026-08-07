// net.js — PeerJS rooms: host relays, clients follow. Also renders remote player avatars.
import { WORLD, seed } from './world.js';
import { scene, camera, box, makeCharacter, makeToolModel, makeBlockCube, makeHeldItemIcon, makeWeaponModel, applyCharacterArmor,
         applyEdit, applyEditsBatch, spawnParticles, TYPES, ITEMS, SKINS } from './render.js';
import { day, setDayTime } from './sky.js';
import { setBanner, setPlayers, addChat, setHorde, startHordeCountdown } from './ui.js';
import { sfx } from './audio.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';
import * as mobs from './mobs.js';
import * as drops from './drops.js';
import * as chests from './chests.js';
import * as keg from './keg.js';
import * as survival from './survival.js';
import { MOB_DROPS } from './content.js';
import { gm, setMode } from './mode.js';
import { addToInventory, inventory, hotbarSlots, renderHotbar } from './ui.js';
import * as eldercube from './eldercube.js';

export const myPeerId = ()=> (mode==='solo' ? eldercube.SOLO : (peer?.id || eldercube.SOLO));
export const myPlayerName = ()=> myName;

/** Host-side: record who holds the Cube and tell the room. */
function setCubeHolder(id, name){
  eldercube.setCubeOwner(id, name);
  if(mode==='host') relay({t:'cubeowner', id, name}, null);
}

/** Ask the host to hand the Cube to another player by name. */
export function requestCubeGive(toName){
  if(mode==='solo'){ addChat('⚙', 'Nobody else is here to take it.'); return; }
  if(mode==='host') handle({t:'cubegive', id0:peer?.id, to:toName}, null);
  else safeSendHost({t:'cubegive', id0:peer?.id, to:toName});
}

export let mode = 'solo';           // 'solo' | 'host' | 'client'
let peer = null, conns = [];        // host: all client conns; client: [hostConn]
let myName = 'Player';
const editLog = [];                 // host keeps this for late joiners
/** Soft cap: before exceeding, collapse to last-write-wins per cell (no lost final state). */
const EDIT_LOG_SOFT = 6000;
const EDIT_LOG_HARD = 12000;

function compactEditLog(){
  if(editLog.length < EDIT_LOG_SOFT) return;
  const map = new Map();
  for(const e of editLog){
    if(!e || e.length < 4) continue;
    map.set(e[0]+','+e[1]+','+e[2], e);
  }
  editLog.length = 0;
  for(const e of map.values()) editLog.push(e);
  // Absolute ceiling after compaction (very large worlds)
  if(editLog.length > EDIT_LOG_HARD){
    editLog.splice(0, editLog.length - EDIT_LOG_HARD);
  }
}

function pushEditLog(entry){
  editLog.push(entry);
  if(editLog.length >= EDIT_LOG_SOFT) compactEditLog();
}

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
  return {
    g:c.g, head:c.head, armL:c.armL, armR:c.armR, legL:c.legL, legR:c.legR, torso:c.torso, sk:c.sk,
    armorG:null, armorState:null,
    held, heldKey:'', tgt:null, swing:0, chip:0, name
  };
}
function setHeldItem(r, tool, blk, item){
  const key = tool!=='hand' ? 't:'+tool
            : (blk ? 'b:'+blk
            : (item ? 'i:'+item : ''));
  if(key===r.heldKey) return;
  r.heldKey = key;
  r.held.clear();
  if(key.startsWith('t:')){
    const m = makeToolModel(tool); m.rotation.x = -.6; r.held.add(m);
  } else if(key.startsWith('b:') && TYPES[blk]){
    r.held.add(makeBlockCube(blk, .38));
  } else if(key.startsWith('i:') && ITEMS[item]){
    if(ITEMS[item].dmg){
      const m = makeWeaponModel(item); m.rotation.x = -.6; r.held.add(m);
    } else {
      r.held.add(makeHeldItemIcon(item, .42));
    }
  }
}
function removeRemote(id){
  const r = remotes.get(id);
  if(r){ scene.remove(r.g); remotes.delete(id); refreshPlayerList(); }
}
function refreshPlayerList(){
  setPlayers([...remotes.values()].map(r=>r.name));
}
export function getRemotes(){ return [...remotes.values()]; }

// ---- Message handling ----
function handle(msg, fromConn){
  if(msg.t==='pos'){
    // Never spawn a remote avatar of ourselves
    if(msg.id && peer?.id && msg.id===peer.id) return;
    let r = remotes.get(msg.id);
    if(!r){ r = makeAvatar(msg.name||'Player', msg.skin|0); remotes.set(msg.id, r); refreshPlayerList(); }
    // Snap on first packet so the avatar isn't at origin for a frame
    if(!r.tgt){
      r.g.position.set(msg.x||0, msg.y||0, msg.z||0);
      r.g.rotation.y = (msg.yaw||0) + Math.PI;
    }
    r.tgt = msg;
    if(msg.name) r.name = msg.name;
    setHeldItem(r, msg.tool, msg.blk, msg.item);
    if(msg.armor){
      const key = JSON.stringify(msg.armor);
      if(r.armorState !== key){
        r.armorState = key;
        applyCharacterArmor(r, msg.armor);
      }
    }
    if(mode==='host') relay(msg, fromConn);
  } else if(msg.t==='edit'){
    applyEdit(msg.x, msg.y, msg.z, msg.v, true);
    if(mode==='host'){ pushEditLog([msg.x,msg.y,msg.z,msg.v]); relay(msg, fromConn); }
  } else if(msg.t==='edits'){
    applyEditsBatch(msg.list||[]);
    if(mode==='host'){
      for(const e of (msg.list||[])) pushEditLog(e);
      relay(msg, fromConn);
    }
  } else if(msg.t==='anim'){
    animals.applyRemote(msg.d);
    if(msg.z) mobs.applyRemote(msg.z);
    if(msg.c) mobs.applyCorpses(msg.c);
    if(msg.drops) drops.applyRemote(msg.drops);
    if(msg.chests) chests.applyRemote(msg.chests);
    if(msg.iq!==undefined){ mobs.setIntel(msg.iq); setHorde(msg.iq); }
    if(msg.gmF!==undefined) setMode(msg.gmF===1);
    if(msg.tod!==undefined) setDayTime(msg.tod);
  } else if(msg.t==='hit' && mode==='host'){
    hostHandleHit(msg.id0, msg.kind, msg.eid, msg.dmg, msg.px, msg.pz);
  } else if(msg.t==='died' && mode==='host'){
    mobs.addCorpse(msg.x, msg.y, msg.z);
  } else if(msg.t==='hurt'){
    survival.damage(msg.dmg, msg.cause||'zombie');
  } else if(msg.t==='give'){
    addToInventory(msg.item);
  } else if(msg.t==='drop' && mode==='host'){
    // Client dropped an item — spawn and relay state
    const d = drops.spawn(msg.item, msg.n||1, msg.x, msg.y, msg.z, msg.id);
    if(d) relay({t:'drops', list:drops.serialize()}, null);
  } else if(msg.t==='drops'){
    drops.applyRemote(msg.list||[]);
  } else if(msg.t==='chests'){
    chests.applyRemote(msg.list||[]);
  } else if(msg.t==='keg' && mode==='host'){
    keg.ignite(msg.x,msg.y,msg.z);
    relay({t:'keg', x:msg.x,y:msg.y,z:msg.z}, fromConn);
  } else if(msg.t==='keg' && mode==='client'){
    keg.ignite(msg.x,msg.y,msg.z);
  } else if(msg.t==='pickup' && mode==='host'){
    // Host is the authority on the Elder Cube. If someone already holds it, a
    // second pickup is refused and the drop is put back — otherwise a duplicate
    // Cube could exist, and there is only ever one.
    const peek = drops.tryPickup(msg.x, msg.y, msg.z);
    if(peek){
      if(peek.item===186 && eldercube.heldBySomeone()){
        drops.spawn(186, 1, msg.x, msg.y, msg.z);
        relay({t:'drops', list:drops.serialize()}, null);
        sendToPeer(msg.id0, {t:'chat', id:'sys', name:'⚙',
          text:`${eldercube.cubeOwnerName()||'Someone'} already carries the Elder Cube.`});
      } else {
        if(peek.item===186) setCubeHolder(msg.id0, remotes.get(msg.id0)?.name || 'Someone');
        sendToPeer(msg.id0, {t:'give', item:peek.item});
        for(let i=1;i<(peek.n||1);i++) sendToPeer(msg.id0, {t:'give', item:peek.item});
        relay({t:'drops', list:drops.serialize()}, null);
      }
    }
  } else if(msg.t==='cubegive' && mode==='host'){
    // Hand-off: only the current holder can pass it on, and everything that
    // comes with the Cube travels to the new holder.
    if(eldercube.cubeOwner() !== msg.id0){
      sendToPeer(msg.id0, {t:'chat', id:'sys', name:'⚙', text:'You are not carrying the Elder Cube.'});
    } else {
      const target = [...remotes.entries()].find(([,r]) => (r.name||'').toLowerCase() === String(msg.to||'').toLowerCase());
      const toId = (String(msg.to||'').toLowerCase() === myName.toLowerCase()) ? 'me' : target?.[0];
      if(!toId){
        sendToPeer(msg.id0, {t:'chat', id:'sys', name:'⚙', text:`No player here called "${msg.to}".`});
      } else {
        sendToPeer(msg.id0, {t:'takecube'});
        sendToPeer(toId, {t:'give', item:186});
        const toName = toId==='me' ? myName : (target[1].name||'Someone');
        setCubeHolder(toId==='me' ? (peer?.id||eldercube.SOLO) : toId, toName);
        // systemMsg, not a bare relay: relay() only reaches peers, so the host
        // would hand the Cube over and see no confirmation at all.
        systemMsg(`The Elder Cube passes to ${toName}. Its burdens go with it.`);
      }
    }
  } else if(msg.t==='takecube'){
    // The host says the Cube has left our hands.
    if(inventory[186]){ delete inventory[186]; }
    for(let i=0;i<hotbarSlots.length;i++) if(hotbarSlots[i]?.id===186) hotbarSlots[i]=null;
    renderHotbar();
  } else if(msg.t==='cubeowner'){
    eldercube.setCubeOwner(msg.id, msg.name);
  } else if(msg.t==='kudos'){
    survival.note(msg.what);
  } else if(msg.t==='horde'){
    // Host unleashed a horde — every player sees the night fall and the countdown.
    setDayTime(0.72);
    startHordeCountdown(10, ()=>{});   // clients don't spawn; host is authoritative
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
    if(res==='killed' || res==='killed_dormant'){
      sendToPeer(hitterId, {t:'kudos', what: res==='killed_dormant' ? 'dayhunt' : 'zkill'});
      for(const [item,p] of MOB_DROPS.zombie) if(Math.random()<p) sendToPeer(hitterId, {t:'give', item});
    }
  } else if(kind==='c'){
    if(mobs.recoverCorpse(eid)){
      sendToPeer(hitterId, {t:'kudos', what:'recover'});
      systemMsg('🕯 A fallen body was recovered — the horde learns nothing.');
    }
  }
}
export function sendHit(kind, eid, dmg, px, pz){
  if(mode==='client'){ safeSendHost({t:'hit', id0:peer?.id, kind, eid, dmg, px, pz}); }
  else hostHandleHit('me', kind, eid, dmg, px, pz); // solo + host resolve locally
}
export function seedEditLog(arr){
  editLog.length = 0;
  for(const e of arr) pushEditLog(e);
  compactEditLog();
}
export function reportDeath(pos){
  if(mode==='client'){ safeSendHost({t:'died', x:+pos.x.toFixed(1), y:+pos.y.toFixed(1), z:+pos.z.toFixed(1)}); }
  else mobs.addCorpse(pos.x, pos.y, pos.z);
}
// Host tells every client to play the horde countdown (visual only; spawns are host-side).
export function sendHorde(lvl){
  if(mode==='host') relay({t:'horde', lvl}, null);
}
export function systemMsg(text){
  addChat('📢', text);
  if(mode!=='solo'){
    const msg = {t:'chat', id:'sys', name:'📢', text};
    if(mode==='host') relay(msg, null);
    else safeSendHost(msg);
  }
}
/** Apply a batch of world edits (physics, explosions, decay): records for saving, syncs to peers. */
export function syncEdits(list){
  if(!list || !list.length) return;
  applyEditsBatch(list);
  if(mode==='host'){
    for(const e of list) pushEditLog(e);
    relay({t:'edits', list}, null);
  }
}
// The host pushes horde-made block edits into the same pipeline as player edits
export function hostWorldEdit(x,y,z,t){
  applyEdit(x,y,z,t,true);
  if(mode==='host'){ pushEditLog([x,y,z,t]); relay({t:'edit', x,y,z, v:t, id:'horde'}, null); }
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
export function sendChests(){
  const msg = {t:'chests', list:chests.serialize()};
  if(mode==='host') relay(msg, null);
  else if(mode==='client') safeSendHost(msg);
}
export function sendKegLit(x,y,z){
  if(mode==='solo') return;
  if(mode==='host') relay({t:'keg', x,y,z}, null);
  else safeSendHost({t:'keg', x,y,z});
}
export function sendDrop(payload){
  if(mode==='solo') return; // already spawned locally
  if(mode==='host'){
    relay({t:'drops', list:drops.serialize()}, null);
  } else {
    safeSendHost({t:'drop', id0:peer?.id, ...payload});
  }
}
export function sendPickup(x,y,z){
  if(mode==='solo'){
    const got = drops.tryPickup(x,y,z);
    if(got){
      for(let i=0;i<(got.n||1);i++) addToInventory(got.item);
      sfx.place();
      if(got.item===186){ eldercube.setCubeOwner(eldercube.SOLO, myName); survival.note('cube'); }
    }
    return;
  }
  if(mode==='host'){
    const got = drops.tryPickup(x,y,z);
    if(got){
      if(got.item===186 && eldercube.heldBySomeone()){
        // Someone else already carries it — put it straight back down.
        drops.spawn(186, 1, x, y, z);
        relay({t:'drops', list:drops.serialize()}, null);
        addChat('⚙', `${eldercube.cubeOwnerName()||'Someone'} already carries the Elder Cube.`);
        return;
      }
      for(let i=0;i<(got.n||1);i++) addToInventory(got.item);
      if(got.item===186){ setCubeHolder(peer?.id || eldercube.SOLO, myName); survival.note('cube'); }
      relay({t:'drops', list:drops.serialize()}, null);
    }
  } else {
    safeSendHost({t:'pickup', id0:peer?.id, x, y, z});
  }
}
export function sendEdit(x,y,z,v){
  if(mode==='solo') return;
  const msg = {t:'edit', x,y,z, v, id:peer?.id};
  if(mode==='host'){ pushEditLog([x,y,z,v]); relay(msg,null); }
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
      // Seed world + host avatar snapshot so the joiner can see the host immediately
      const hostPos = {t:'pos', id:peer.id, name:myName, ...playerMod.netState()};
      conn.send({
        t:'init', seed:newSeed, edits:editLog, tod:day.t, gmF:gm.forge?1:0,
        chests: chests.serialize(),
        host: hostPos,
      });
      // Also push every other already-connected player so late joiners see them
      for(const [rid, r] of remotes){
        if(r.tgt) conn.send({t:'pos', id:rid, name:r.name, ...r.tgt});
      }
      // And re-send host pos on the next tick path (belt and suspenders)
      try{ conn.send(hostPos); }catch(e){}
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
      if(d.t==='init' && !gotInit){
        gotInit = true;
        if(d.chests) chests.applyRemote(d.chests);
        if(d.tod!==undefined) setDayTime(d.tod);
        setMode(d.gmF===1);
        onInit(d.seed, d.edits);
        // Host avatar from handshake — so joiners always see the host
        if(d.host) handle(d.host, conn);
      } else handle(d, conn);
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
    if(animTimer<=0){ animTimer = .2; relay({t:'anim', d:animals.serialize(), z:mobs.serialize(), c:mobs.serializeCorpses(), drops:drops.serialize(), iq:mobs.getIntel(), tod:day.t, gmF:gm.forge?1:0}, null); }
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

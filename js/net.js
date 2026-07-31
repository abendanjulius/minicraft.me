// net.js — PeerJS rooms: host relays, clients follow. Also renders remote player avatars.
import { WORLD, seed } from './world.js';
import { scene, camera, box, makeToolModel, makeBlockCube, applyEdit, spawnParticles, TYPES } from './render.js';
import { setBanner, setPlayers } from './ui.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';

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
function makeAvatar(name){
  const g = new THREE.Group();
  const shirt = 0x2c7fb8, pants = 0x3a3f5c, skin = 0xdba97c;
  g.add(box(.5,.7,.28,shirt,0,1.05,0));                  // torso
  const head = box(.42,.42,.42,skin,0,1.6,0); g.add(head);
  const armR = box(.16,.6,.16,skin,.34,1.1,0); g.add(armR);
  g.add(box(.16,.6,.16,skin,-.34,1.1,0));
  const legL = box(.2,.7,.2,pants,.13,.35,0); g.add(legL);
  const legR = box(.2,.7,.2,pants,-.13,.35,0); g.add(legR);
  const tag = nameSprite(name); tag.position.y = 2.1; g.add(tag);
  const held = new THREE.Group(); held.position.set(.34,.8,-.15); armR.name='armR'; g.add(held);
  scene.add(g);
  return {g, armR, legL, legR, held, heldKey:'', tgt:null, swing:0, chip:0, name};
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
    if(!r){ r = makeAvatar(msg.name||'Player'); remotes.set(msg.id, r); refreshPlayerList(); }
    r.tgt = msg;
    setHeldItem(r, msg.tool, msg.blk);
    if(mode==='host') relay(msg, fromConn);
  } else if(msg.t==='edit'){
    applyEdit(msg.x, msg.y, msg.z, msg.v, true);
    if(mode==='host'){ editLog.push([msg.x,msg.y,msg.z,msg.v]); relay(msg, fromConn); }
  } else if(msg.t==='anim'){
    animals.applyRemote(msg.d);
  } else if(msg.t==='bye'){
    removeRemote(msg.id);
    if(mode==='host') relay(msg, fromConn);
  }
}
function relay(msg, except){
  for(const c of conns) if(c!==except && c.open) c.send(msg);
}
export function sendEdit(x,y,z,v){
  if(mode==='solo') return;
  const msg = {t:'edit', x,y,z, v, id:peer?.id};
  if(mode==='host'){ editLog.push([x,y,z,v]); relay(msg,null); }
  else conns[0]?.send(msg);
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
      conn.send({t:'init', seed:newSeed, edits:editLog});
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
      if(d.t==='init' && !gotInit){ gotInit = true; onInit(d.seed, d.edits); }
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
    else conns[0]?.open && conns[0].send(msg);
  }
  // host broadcasts animals 5x/s
  if(mode==='host'){
    animTimer -= dt;
    if(animTimer<=0){ animTimer = .2; relay({t:'anim', d:animals.serialize()}, null); }
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
    if(mode==='host') relay(msg,null); else conns[0]?.open && conns[0].send(msg);
  }
});

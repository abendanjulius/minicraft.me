// main.js — menu, boot, game loop
import { generateWorld, setBlock, heightAt, CENTER, WORLD } from './world.js';
import { scene, camera, renderer, isTouch, buildAllChunks, updateChunkVisibility,
         updateParticles, updateDayNight, SKINS, faceURL, trackTorch, updateTorchLights,
         setEditRecorder, setDayTime } from './render.js';
import { initUI, toggleInv, setHud, initChat, addChat, setCompass, setTabHook, setHorde as setHordeHud, restoreInv } from './ui.js';
import { renderCraft, renderGuide } from './craft.js';
import { gm, setMode, onModeChange, modeName } from './mode.js';
import * as persist from './persist.js';
import { inventory, hotbarSlots } from './ui.js';
import { day } from './render.js';
import { sv } from './survival.js';
import { initAudio, startMusic, sfx } from './audio.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';
import * as mobs from './mobs.js';
import * as survival from './survival.js';
import * as net from './net.js';

const $ = id=>document.getElementById(id);

// ---- Version check ----
const APP_VERSION = '1.5.5'; // UPDATE ON EVERY RELEASE (with version.json + sw.js CACHE)
$('verLabel').textContent = 'v' + APP_VERSION;
async function forceUpdate(newVer){
  try{
    if('caches' in window) for(const k of await caches.keys()) await caches.delete(k);
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    for(const r of regs) await r.unregister();
  }catch(e){}
  location.replace(location.pathname + '?v=' + encodeURIComponent(newVer));
}
async function checkVersion(){
  try{
    const res = await fetch('./version.json?t=' + Date.now(), {cache:'no-store'});
    if(!res.ok) return;
    const {version} = await res.json();
    if(!version || version === APP_VERSION) return;
    if(playerMod.state.playing){
      addChat('⚙ System', `Update v${version} available — quit and reload to get it.`);
      return;
    }
    // guard against reload loops if the CDN is still serving old files
    const key = 'mc_reloaded_' + version;
    if(sessionStorage.getItem(key)){
      $('verLabel').textContent = `v${APP_VERSION} (v${version} available — refresh in a minute)`;
      return;
    }
    sessionStorage.setItem(key, '1');
    $('menuStatus').textContent = `Updating to v${version}…`;
    forceUpdate(version);
  }catch(e){}
}
checkVersion();
setInterval(checkVersion, 5*60*1000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) checkVersion(); });

// ---- Character picker ----
function buildSkinRow(){
  const row = $('skinRow');
  const cur = playerMod.skinIdx();
  row.innerHTML = '';
  SKINS.forEach((s,i)=>{
    const d = document.createElement('button');
    d.className = 'skinBtn' + (i===cur?' active':'');
    d.title = s.name;
    d.innerHTML = `<img class="skFace" src="${faceURL(i)}" alt="${s.name}">
                   <span class="skBody" style="background:#${s.shirt.toString(16).padStart(6,'0')}"></span>
                   <span class="skName">${s.name}</span>`;
    d.addEventListener('click', ()=>{ localStorage.setItem('mc_skin', i); buildSkinRow(); });
    row.appendChild(d);
  });
}
buildSkinRow();

// ---- Mode selection ----
function refreshModeRow(){
  const forge = localStorage.getItem('mc_mode')==='forge';
  $('modeNight').classList.toggle('active', !forge);
  $('modeForge').classList.toggle('active', forge);
}
$('modeNight').addEventListener('click', ()=>{ localStorage.setItem('mc_mode','night'); refreshModeRow(); });
$('modeForge').addEventListener('click', ()=>{ localStorage.setItem('mc_mode','forge'); refreshModeRow(); });
refreshModeRow();

onModeChange(forge=>{
  survival.showVitals(playerMod.state.playing && !forge);
  $('btnMode').textContent = forge ? '🔨' : '🌙';
  if(forge){ survival.sv.hp = 20; survival.sv.hunger = 20; }
});
function toggleMode(){
  if(net.mode==='client') return; // host decides for the room
  const toForge = !gm.forge;
  setMode(toForge);
  net.systemMsg(toForge
    ? '🔨 Forge Mode — the horde sleeps. Build freely with unlimited materials.'
    : '🌙 Nightfall Mode — survival rules apply. Watch the sun.');
}
$('btnMode').addEventListener('click', toggleMode);
$('btnMode').addEventListener('touchstart', e=>{ e.preventDefault(); toggleMode(); });

// ---- Quit (saves first) ----
function quitGame(){
  if(!confirm('Quit to menu?')) return;
  saveWorldNow();
  location.reload();
}
$('btnQuit').addEventListener('click', quitGame);
$('btnQuit').addEventListener('touchstart', e=>{ e.preventDefault(); quitGame(); });

// ---- PWA ----
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// ---- Menu ----
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('mc_name') || '';
function getName(){
  const n = nameInput.value.trim() || 'Player';
  localStorage.setItem('mc_name', n);
  return n;
}
function showError(msg){
  $('menuError').textContent = msg;
  setTimeout(()=>$('menuError').textContent='', 6000);
}

// ---- Worlds ----
const MODE_ICON = m=>m==='forge' ? '🔨' : '🌙';
function timeAgo(ts){
  const m = Math.floor((Date.now()-ts)/60000);
  if(m<1) return 'just now';
  if(m<60) return m+'m ago';
  const h = Math.floor(m/60);
  if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function buildWorlds(){
  const box = $('worlds');
  box.innerHTML = '';
  persist.listWorlds().forEach((d,i)=>{
    const card = document.createElement('div');
    card.className = 'worldCard' + (d?'':' empty');
    if(!d){
      card.innerHTML = `<button class="wNew">＋ New World<br><small>starts in ${MODE_ICON(localStorage.getItem('mc_mode')==='forge'?'forge':'night')} ${localStorage.getItem('mc_mode')==='forge'?'Forge':'Nightfall'}</small></button>`;
      card.querySelector('.wNew').addEventListener('click', ()=>{
        const name = prompt('Name your world:', 'World '+(i+1));
        if(name===null) return;
        const mode = localStorage.getItem('mc_mode')==='forge' ? 'forge' : 'night';
        if(!persist.create(i, (name.trim()||('World '+(i+1))).slice(0,20), mode)){ showError('Could not save — storage full?'); return; }
        buildWorlds();
      });
    } else {
      card.innerHTML = `
        <div class="wInfo"><b>${MODE_ICON(d.mode)} ${d.name}</b>
        <small>${(d.edits||[]).length} edits · saved ${timeAgo(d.savedAt||Date.now())}</small></div>
        <div class="wBtns">
          <button class="wPlay" title="Play solo">▶</button>
          <button class="wHost" title="Host for friends">🌐</button>
          <button class="wExp" title="Export file">⬇</button>
          <button class="wDel" title="Delete">🗑</button>
        </div>`;
      card.querySelector('.wPlay').addEventListener('click', ()=>startWorld(i,'solo'));
      card.querySelector('.wHost').addEventListener('click', ()=>startWorld(i,'host'));
      card.querySelector('.wExp').addEventListener('click', ()=>persist.exportWorld(i));
      card.querySelector('.wDel').addEventListener('click', ()=>{
        if(confirm(`Delete "${d.name}" forever? Export it first if unsure.`)){ persist.remove(i); buildWorlds(); }
      });
    }
    box.appendChild(card);
  });
}
buildWorlds();

$('btnImport').addEventListener('click', ()=>$('importFile').click());
$('importFile').addEventListener('change', e=>{
  const f = e.target.files[0];
  if(!f) return;
  persist.importWorld(f, (ok,msg)=>{ ok ? ($('menuStatus').textContent=msg) : showError(msg); buildWorlds(); e.target.value=''; });
});

function startWorld(i, kind){
  const d = persist.open(i);
  if(!d){ showError('Could not load that world.'); return; }
  initAudio();
  if(kind==='solo'){
    net.startSolo(getName());
    begin(d.seed, d.edits, true, d);
  } else {
    $('menuStatus').textContent = 'Creating room…';
    net.startHost(getName(), d.seed,
      ()=>{ net.seedEditLog(d.edits); begin(d.seed, d.edits, true, d); },
      e=>{ $('menuStatus').textContent=''; persist.closeActive(); showError('Could not create room: '+(e?.type||e?.message||'network error')); });
  }
}
$('btnJoin').addEventListener('click', ()=>{
  initAudio();
  const code = $('codeInput').value.trim();
  if(code.length<4){ showError('Enter the room code from your host.'); return; }
  $('menuStatus').textContent = 'Connecting…';
  net.startJoin(getName(), code,
    (seed, edits)=>begin(seed, edits, false, null),
    e=>{ $('menuStatus').textContent=''; showError('Could not join: '+(e?.message||e?.type||'check the code and try again')); });
});

// ---- Save ----
function saveWorldNow(){
  if(persist.activeSlot===null || !playerMod.state.playing) return;
  const p = playerMod.player.pos;
  persist.save({
    mode: gm.forge ? 'forge' : 'night',
    inv: {...inventory},
    slots: hotbarSlots.map(x=>x?{k:x.k,id:x.id}:null),
    pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
    yaw: +playerMod.view.yaw.toFixed(2),
    tod: day.t,
    intel: mobs.getIntel(),
    hp: sv.hp, hunger: sv.hunger,
  });
}
addEventListener('beforeunload', saveWorldNow);
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) saveWorldNow(); });

// ---- Boot the world ----
function begin(seed, edits, authority, saved){
  $('menu').style.display = 'none';
  $('loading').style.display = 'flex';
  setTimeout(async ()=>{
    generateWorld(seed);
    for(const [x,y,z,t] of edits){ setBlock(x,y,z,t); trackTorch(x,y,z,0,t); } // replay history before meshing
    buildAllChunks();
    animals.init(authority, seed);
    mobs.init(authority);
    isAuthority = authority;
    survival.initSurvival({
      onRespawn: ()=>playerMod.spawn(),
      onDeath: ()=>net.reportDeath(playerMod.player.pos),
    });
    mobs.setAnnouncer((text, iq)=>{ net.systemMsg(text); setHordeHud(iq); });
    if(authority && saved) setMode(saved.mode==='forge');
    survival.showVitals(!gm.forge);
    $('btnMode').style.display = (net.mode==='client') ? 'none' : 'flex';
    $('btnMode').textContent = gm.forge ? '🔨' : '🌙';
    playerMod.spawn();
    if(saved){
      if(saved.pos) playerMod.setPosYaw(saved.pos[0], saved.pos[1]+.5, saved.pos[2], saved.yaw);
      restoreInv(saved.inv, saved.slots);
      setDayTime(saved.tod ?? .28);
      mobs.setIntel(saved.intel||0);
      setHordeHud(saved.intel||0);
      survival.restore(saved.hp, saved.hunger);
    }
    playerMod.state.playing = true;
    document.body.classList.add('playing');
    $('loading').style.display = 'none';
    $('hud').style.display = 'block';
    $('btnQuit').style.display = 'flex';
    startMusic();

    if(isTouch){
      try{
        await (document.documentElement.requestFullscreen?.() || document.documentElement.webkitRequestFullscreen?.());
        await screen.orientation?.lock?.('landscape');
      }catch(e){} // iOS: rotate prompt covers it
    } else {
      playerMod.relock();
    }
  }, 60);
}

// ---- Init input & UI ----
setEditRecorder(persist.recordEdit);
playerMod.initControls();
initUI({
  look: (dx,dy)=>playerMod.look(dx,dy),
  jump: b=>playerMod.jump(b),
  mine: b=>playerMod.setMine(b),
  place: ()=>playerMod.placeAction(),
  relock: ()=>playerMod.relock(),
});
setTabHook(tab=>{ if(tab==='craft') renderCraft(); if(tab==='guide') renderGuide(); });
// clicking the canvas re-acquires pointer lock after Esc
$('game').addEventListener('click', ()=>{ if(playerMod.state.playing) playerMod.relock(); });
initChat(text=>{
  addChat(localStorage.getItem('mc_name')||'Me', text);
  net.sendChat(text);
});

// ---- Main loop ----
let last = performance.now(), frames=0, fpsTime=0, elapsed=0, cullTimer=0, isAuthority=true, saveT=30, dripT=5, wasUnderground=false;
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min((now-last)/1000,.05); last=now; elapsed+=dt;

  frames++; fpsTime+=dt;
  if(fpsTime>=1){
    setHud(frames, `${playerMod.player.pos.x|0}, ${playerMod.player.pos.y|0}, ${playerMod.player.pos.z|0}`);
    frames=0; fpsTime=0;
  }

  playerMod.update(dt, elapsed);
  if(playerMod.state.playing){
    const dl = updateDayNight(dt, playerMod.player.pos);
    animals.update(dt, elapsed, playerMod.player.pos);
    if(isAuthority){
      const {hurts, digs} = mobs.hostTick(dt, dl, net.getTargets(playerMod.player.pos));
      net.dispatchHurts(hurts);
      for(const d of digs) net.hostWorldEdit(d.x, d.y, d.z, 0);
    }
    mobs.commonTick(dt, elapsed, playerMod.player.pos);
    const movingH = Math.abs(playerMod.player.vel.x)+Math.abs(playerMod.player.vel.z) > .5;
    survival.tick(dt, movingH, dl);
    net.update(dt, elapsed);
    cullTimer -= dt;
    if(cullTimer<=0){
      updateChunkVisibility(playerMod.player.pos.x, playerMod.player.pos.z);
      updateTorchLights(playerMod.player.pos.x, playerMod.player.pos.z);
      cullTimer=.3;
    }
    // cave ambience + Spelunker
    const ug = playerMod.player.pos.y < heightAt(Math.round(playerMod.player.pos.x), Math.round(playerMod.player.pos.z)) - 2;
    if(ug){
      if(!wasUnderground){ wasUnderground = true; survival.note('cave'); }
      dripT -= dt;
      if(dripT<=0){ dripT = 4 + Math.random()*5; sfx.drip(); }
    } else wasUnderground = false;
    // autosave every 30s (solo & host — clients don't own the world)
    saveT -= dt;
    if(saveT<=0){ saveT = 30; saveWorldNow(); }
    // Compass points home to spawn
    const dx = CENTER - playerMod.player.pos.x, dz = CENTER - playerMod.player.pos.z;
    const angle = Math.atan2(dx, dz) - playerMod.view.yaw;
    setCompass(-angle * 180/Math.PI);
  }
  updateParticles(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

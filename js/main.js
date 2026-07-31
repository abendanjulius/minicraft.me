// main.js — menu, boot, game loop
import { generateWorld, setBlock, heightAt, CENTER, WORLD } from './world.js';
import { scene, camera, renderer, isTouch, buildAllChunks, updateChunkVisibility,
         updateParticles, updateDayNight, SKINS, faceURL } from './render.js';
import { initUI, toggleInv, setHud, initChat, addChat, setCompass } from './ui.js';
import { initAudio, startMusic } from './audio.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';
import * as mobs from './mobs.js';
import * as survival from './survival.js';
import * as net from './net.js';

const $ = id=>document.getElementById(id);

// ---- Version check ----
const APP_VERSION = '1.2.0'; // UPDATE ON EVERY RELEASE (with version.json + sw.js CACHE)
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

// ---- Quit ----
function quitGame(){ if(confirm('Quit to menu? (world is not saved yet)')) location.reload(); }
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

$('btnSolo').addEventListener('click', ()=>{
  initAudio();
  net.startSolo(getName());
  begin((Math.random()*2**31)|0, [], true);
});
$('btnHost').addEventListener('click', ()=>{
  initAudio();
  const s = (Math.random()*2**31)|0;
  $('menuStatus').textContent = 'Creating room…';
  net.startHost(getName(), s,
    ()=>{ begin(s, [], true); },
    e=>{ $('menuStatus').textContent=''; showError('Could not create room: '+(e?.type||e?.message||'network error')); });
});
$('btnJoin').addEventListener('click', ()=>{
  initAudio();
  const code = $('codeInput').value.trim();
  if(code.length<4){ showError('Enter the room code from your host.'); return; }
  $('menuStatus').textContent = 'Connecting…';
  net.startJoin(getName(), code,
    (seed, edits)=>begin(seed, edits, false),
    e=>{ $('menuStatus').textContent=''; showError('Could not join: '+(e?.message||e?.type||'check the code and try again')); });
});

// ---- Boot the world ----
function begin(seed, edits, authority){
  $('menu').style.display = 'none';
  $('loading').style.display = 'flex';
  setTimeout(async ()=>{
    generateWorld(seed);
    for(const [x,y,z,t] of edits) setBlock(x,y,z,t); // replay history before meshing
    buildAllChunks();
    animals.init(authority, seed);
    mobs.init(authority);
    isAuthority = authority;
    survival.initSurvival({ onRespawn: ()=>playerMod.spawn() });
    survival.showVitals(true);
    playerMod.spawn();
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
playerMod.initControls();
initUI({
  look: (dx,dy)=>playerMod.look(dx,dy),
  jump: b=>playerMod.jump(b),
  mine: b=>playerMod.setMine(b),
  place: ()=>playerMod.placeAction(),
  relock: ()=>playerMod.relock(),
});
// clicking the canvas re-acquires pointer lock after Esc
$('game').addEventListener('click', ()=>{ if(playerMod.state.playing) playerMod.relock(); });
initChat(text=>{
  addChat(localStorage.getItem('mc_name')||'Me', text);
  net.sendChat(text);
});

// ---- Main loop ----
let last = performance.now(), frames=0, fpsTime=0, elapsed=0, cullTimer=0, isAuthority=true;
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
      const hurts = mobs.hostTick(dt, dl, net.getTargets(playerMod.player.pos));
      net.dispatchHurts(hurts);
    }
    mobs.commonTick(dt, elapsed, playerMod.player.pos);
    const movingH = Math.abs(playerMod.player.vel.x)+Math.abs(playerMod.player.vel.z) > .5;
    survival.tick(dt, movingH, dl);
    net.update(dt, elapsed);
    cullTimer -= dt;
    if(cullTimer<=0){ updateChunkVisibility(playerMod.player.pos.x, playerMod.player.pos.z); cullTimer=.3; }
    // Compass points home to spawn
    const dx = CENTER - playerMod.player.pos.x, dz = CENTER - playerMod.player.pos.z;
    const angle = Math.atan2(dx, dz) - playerMod.view.yaw;
    setCompass(-angle * 180/Math.PI);
  }
  updateParticles(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

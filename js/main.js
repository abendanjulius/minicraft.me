// main.js — menu, boot, game loop
import { generateWorld, setBlock, getBlock, heightAt, CENTER, WORLD, placeDebugMarkers, DEBUG_MARKERS, wrapC, biomeAt, BIOME_NAME, villageSites } from './world.js';
import { scene, camera, renderer, isTouch, buildAllChunks, updateChunkVisibility, tickWaterAnim, tickWind,
         updateParticles, updateDayNight, SKINS, faceURL, trackTorch, updateTorchLights,
         setEditRecorder, setDayTime, setEditPhysicsHook, rebuildAt, spawnParticles, TYPES, trackDoor, trackBed, trackSpecial } from './render.js';
import { initUI, toggleInv, setHud, initChat, addChat, setCompass, setHorde as setHordeHud, restoreInv, setCraftApi, renderInv, toast, setSaveState, clearLoadout } from './ui.js';
import * as craftMod from './craft.js';
import { gm, setMode, onModeChange, modeName } from './mode.js';
import * as persist from './persist.js';
import { inventory, hotbarSlots, sel } from './ui.js';
import { day } from './render.js';
import { sv } from './survival.js';
import { initAudio, startMusic, sfx, ambientTick } from './audio.js';
import * as playerMod from './player.js';
import * as animals from './animals.js';
import * as mobs from './mobs.js';
import * as survival from './survival.js';
import * as net from './net.js';
import * as physics from './physics.js';
import * as drops from './drops.js';
import * as chests from './chests.js';
import * as keg from './keg.js';
import * as villagers from './villagers.js';
import { tryCommand, setCommandContext } from './commands.js';

const $ = id=>document.getElementById(id);
chests.setChestChangeHook(()=>net.sendChests?.());


// Block physics: sand/gravel settle + leaf decay triggers
physics.setPhysicsFx((x,y,z,tid)=>spawnParticles(x,y,z, TYPES[tid]?.pc ?? 0xdacc96, 3));
setEditPhysicsHook((x,y,z,old,t)=>{
  if(old===4 && t===0) physics.notifyLogBroken(x,y,z);
  if(t===0 || physics.GRAVITY.has(t) || physics.GRAVITY.has(old)){
    net.syncEdits(physics.afterEdit(x,y,z));
  }
  if(t===64 || old===64) physics.notifyWater?.(x,y,z);
});


// ---- Version check ----
const APP_VERSION = '1.12.36'; // UPDATE ON EVERY RELEASE (with version.json + sw.js CACHE)
// FORCE_SW_BUST — drop old caches when version changes
(async () => {
  try {
    const prev = localStorage.getItem('mc_app_ver');
    if (prev && prev !== APP_VERSION) {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all([...regs].map(r => r.unregister()));
      localStorage.setItem('mc_app_ver', APP_VERSION);
      location.reload();
      return;
    }
    localStorage.setItem('mc_app_ver', APP_VERSION);
  } catch (e) {}
})();
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
    if(playerMod.state.playing && !playerMod.state.paused){
      addChat('⚙ System', `Update v${version} available — quit and reload to get it.`);
      return;
    }
    // Soft guard: only block rapid loops within 15s
    const key = 'mc_reloaded_' + version;
    const last = +(sessionStorage.getItem(key) || 0);
    if(last && Date.now() - last < 15000){
      $('verLabel').textContent = `v${APP_VERSION} → updating to v${version}…`;
      return;
    }
    sessionStorage.setItem(key, String(Date.now()));
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

// ---- Home ↔ Setup navigation ----
$('btnPlay').addEventListener('click', ()=>{ $('home').style.display='none'; $('menu').style.display='flex'; });
$('btnBack').addEventListener('click', ()=>{ $('menu').style.display='none'; $('home').style.display='flex'; });

onModeChange(forge=>{
  survival.showVitals(playerMod.state.playing && !forge);
  $('btnMode').textContent = forge ? '🔨' : '🌙';
  if(forge){ survival.sv.hp = 20; survival.sv.hunger = 20; }
  else playerMod.state.flying = false;
  const bf = $('btnFly');
  if(bf){ bf.style.display = (forge && playerMod.state.playing && document.body.classList.contains('touch')) ? 'flex' : 'none';
    bf.classList.toggle('active', playerMod.state.flying); }
  playerMod.onModeMaybeChanged?.();
  // Game rule: Forge gear never enters survival. Crossing INTO Nightfall (on the
  // host and every client) resets the carried loadout to a fresh survival start.
  if(!forge && playerMod.state.playing){
    clearLoadout();
    addChat('⚙ System', 'Entered Nightfall — survival loadout reset. Forge gear stays in Forge.');
  }
});
function toggleMode(){
  if(net.mode==='client') return; // host decides for the room
  const toForge = !gm.forge;
  if(!toForge && !confirm('Enter Nightfall? Survival rules apply and your carried loadout will reset — nothing carries over from Forge.')) return;
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
$('pauseResume')?.addEventListener('click', ()=>playerMod.setPaused(false));
$('pauseInv')?.addEventListener('click', ()=>{ playerMod.setPaused(false); toggleInv(true); });
$('pauseQuit')?.addEventListener('click', ()=>{ playerMod.setPaused(false); quitGame(); });
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
      const m = localStorage.getItem('mc_mode')==='forge' ? 'forge' : 'night';
      card.innerHTML = `<button class="wNew">＋<br>New World<br><small>${MODE_ICON(m)} ${m==='forge'?'Forge':'Nightfall'}</small></button>`;
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
        <small>${(d.edits||[]).length} edits</small>
        <small>${timeAgo(d.savedAt||Date.now())}</small></div>
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
// Populate the world cache from IndexedDB (migrating any legacy localStorage
// worlds) before listing slots, so the menu never flashes empty.
persist.init().then(()=>{
  buildWorlds();
  document.body.classList.add('boot-ok');
  const br = $('bootRecover'); if(br) br.style.display = 'none';
}).catch(err=>{
  console.error('[MiniCraft] storage init failed', err);
  buildWorlds(); // show the menu anyway; worst case slots read empty
  document.body.classList.add('boot-ok');
});

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
    chests: chests.serialize(),
  });
}
addEventListener('beforeunload', saveWorldNow);
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) saveWorldNow(); });

// Debounced save shortly after a burst of edits, so worst-case loss is a few
// seconds of building rather than a whole session (IndexedDB writes are async
// and can't reliably flush on tab-close, so we save continuously instead).
let editSaveTimer = null;
function scheduleSaveSoon(){
  if(editSaveTimer) return;
  editSaveTimer = setTimeout(()=>{ editSaveTimer = null; saveWorldNow(); }, 2500);
}

// ---- Save-health indicator (Phase 0) ----
// Reflect every save in the HUD pip; shout (once per transition) when a world
// stops saving or nears the storage ceiling, so progress is never lost silently.
let lastSaveState = 'ok';
persist.setSaveStatusHook(s=>{
  const state = !s.ok ? 'fail' : s.near ? 'warn' : 'ok';
  setSaveState(state);
  if(state !== lastSaveState){
    if(state === 'fail'){
      toast('⚠ Storage full — this world can’t save! Export it now (menu ⬇) to keep your progress.', 9000);
      addChat('⚙ System', 'Saving failed — storage is full. Quit to the menu and Export this world to back it up.');
    } else if(state === 'warn'){
      toast('💾 This world is getting large — export a backup to be safe.', 6000);
    }
    lastSaveState = state;
  }
});

// ---- Boot the world ----
let worldSeed = 0;
function begin(seed, edits, authority, saved){
  worldSeed = seed;
  $('menu').style.display = 'none';
  $('loading').style.display = 'flex';
  setTimeout(async ()=>{
  try {
    const loadEl = $('loading');
    const setLoad = (t)=>{ if(loadEl) loadEl.textContent = t; };
    setLoad('Generating world…');
    generateWorld(seed);
    setLoad('Applying builds…');
    for(const [x,y,z,t] of edits){ setBlock(x,y,z,t); trackTorch(x,y,z,0,t); trackDoor(x,y,z,0,t); trackBed(x,y,z,0,t); trackSpecial(x,y,z,0,t); }
    setLoad('Placing markers…');
    placeDebugMarkers(); // TEMP test pillars
    setLoad('Meshing terrain…');
    await new Promise(r=>setTimeout(r, 0)); // let UI paint
    buildAllChunks();
    setLoad('Almost ready…');
    updateChunkVisibility(CENTER, CENTER);
    animals.init(authority, seed);
    villagers.init();
    mobs.init(authority);
    drops.init(authority);
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
      if(saved.chests) chests.applyRemote(saved.chests);
      setHordeHud(saved.intel||0);
      survival.restore(saved.hp, saved.hunger);
    }
    playerMod.state.playing = true;
    document.body.classList.add('playing');
    $('loading').style.display = 'none';
    $('hud').style.display = 'block';
    $('btnQuit').style.display = 'flex';
    const bf = $('btnFly');
    if(bf) bf.style.display = (gm.forge && document.body.classList.contains('touch')) ? 'flex' : 'none';
    startMusic();

    if(isTouch){
      try{
        await (document.documentElement.requestFullscreen?.() || document.documentElement.webkitRequestFullscreen?.());
        await screen.orientation?.lock?.('landscape');
      }catch(e){} // iOS: rotate prompt covers it
    } else {
      playerMod.relock();
    }
  } catch(err){
    console.error('[MiniCraft] boot failed', err);
    const loadEl = document.getElementById('loading');
    if(loadEl) loadEl.innerHTML = 'Failed to load world.<br><small style="opacity:.8">'+((err&&err.message)||err)+'</small><br><small>Try a New World or hard-refresh</small>';
  }
  }, 60);
}

// ---- Init input & UI ----
setEditRecorder((x,y,z,t)=>{ persist.recordEdit(x,y,z,t); scheduleSaveSoon(); });
playerMod.initControls();
initUI({
  look: (dx,dy)=>playerMod.look(dx,dy),
  jump: b=>playerMod.jump(b),
  mine: b=>playerMod.setMine(b),
  place: ()=>playerMod.placeAction(),
  drop: ()=>playerMod.dropHeld(),
  sprint: (on)=>{ playerMod.keys.sprint = !!on; },
  fly: ()=>playerMod.toggleFly(),
  jump: (b)=>playerMod.jump(b),
  relock: ()=>playerMod.relock(),
});
setCraftApi(craftMod);
$('chestClose')?.addEventListener('pointerdown', ()=>chests.close());
$('chestDeposit')?.addEventListener('pointerdown', ()=>{
  chests.depositSelected(hotbarSlots, sel);
});
// clicking the canvas re-acquires pointer lock after Esc
$('game').addEventListener('click', ()=>{ if(playerMod.state.playing) playerMod.relock(); });
setCommandContext(()=>({
  player: playerMod.player,
  view: playerMod.view,
  state: playerMod.state,
  spawn: ()=>playerMod.spawn(),
  setPosYaw: (x,y,z,yaw)=>playerMod.setPosYaw(x,y,z,yaw),
  toggleFly: ()=>playerMod.toggleFly(),
  seed: worldSeed,
}));
initChat(text=>{
  if(tryCommand(text)) return; // handled as slash-command
  addChat(localStorage.getItem('mc_name')||'Me', text);
  net.sendChat(text);
});

function updateCompassMap(pos, yaw){
  const cv = document.getElementById('compassMap');
  if(!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W/2, cy = H/2, R = W/2 - 2;
  ctx.clearRect(0,0,W,H);

  // --- Day / night cycle on the outer rim ---
  // day.t: 0..1, ~0.25 = noon (matches render.js sun angle)
  const t = day.t;
  const sunY = Math.sin(t * Math.PI * 2);          // >0 day, <0 night
  const isNight = sunY < 0.05;
  const isDusk = !isNight && sunY < 0.35;

  // Base disc tinted by time
  ctx.fillStyle = isNight ? 'rgba(12,16,36,.55)'
                : isDusk  ? 'rgba(40,24,18,.4)'
                :           'rgba(18,28,22,.25)';
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

  // Outer ring: night arc (dark) + day arc (gold) — full 24h clock
  // 0 at top = midnight-ish mapping: marker moves clockwise with day.t
  ctx.lineWidth = 5;
  ctx.lineCap = 'butt';
  // Night half-ish track (full circle underlay)
  ctx.strokeStyle = 'rgba(40,55,90,.85)';
  ctx.beginPath(); ctx.arc(cx, cy, R - 1.5, 0, Math.PI * 2); ctx.stroke();
  // Daylight arc length proportional to how high the sun is (visual “day amount”)
  // Full golden ring near noon; shrinks toward dusk; gone at night
  if(!isNight){
    const dayAmt = Math.max(0.15, Math.min(1, sunY * 1.2 + 0.15));
    const span = Math.PI * 1.6 * dayAmt; // arc sweep
    const start = -Math.PI / 2 - span / 2;
    ctx.strokeStyle = isDusk ? '#e8935a' : '#f4d35e';
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1.5, start, start + span);
    ctx.stroke();
  }

  // Moving sun / moon pip on the rim (clock position from day.t)
  const a = t * Math.PI * 2 - Math.PI / 2; // t=0.25 → top (noon)
  const pr = R - 3;
  const px = cx + Math.cos(a) * pr;
  const py = cy + Math.sin(a) * pr;
  if(isNight){
    // moon
    ctx.fillStyle = '#dfe7ff';
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(12,16,36,.7)';
    ctx.beginPath(); ctx.arc(px + 1.5, py - 1, 3, 0, Math.PI * 2); ctx.fill();
  } else {
    // sun
    ctx.fillStyle = isDusk ? '#ffb070' : '#ffe9a8';
    ctx.beginPath(); ctx.arc(px, py, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,200,80,.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
  }

  // Tiny day/night letter under the pip for clarity
  ctx.fillStyle = isNight ? 'rgba(180,200,255,.9)' : 'rgba(255,230,150,.9)';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // label at bottom of compass
  ctx.fillText(isNight ? 'NIGHT' : (isDusk ? 'DUSK' : 'DAY'), cx, cy + R * 0.62);

  // range rings
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 1.5;
  for(const f of [.45,.8]){
    ctx.beginPath(); ctx.arc(cx,cy,R*f,0,Math.PI*2); ctx.stroke();
  }

  const RANGE = 48; // blocks to rim
  const shortest = d => { if(d>WORLD/2) d-=WORLD; if(d<-WORLD/2) d+=WORLD; return d; };
  const plot = (wx, wz, color, size, edgeOnly=false)=>{
    let dx = shortest(wx - pos.x), dz = shortest(wz - pos.z);
    const dist = Math.hypot(dx, dz);
    // rotate so "up" on the map is the direction the player faces
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rx =  dx * c - dz * s;
    const rz =  dx * s + dz * c;
    const scale = (R - 6) / RANGE;
    let px = cx + rx * scale;
    let py = cy + rz * scale;
    const pr = Math.hypot(px - cx, py - cy);
    if(dist > RANGE || pr > R - 5){
      // pin to rim so far targets still show as edge pips
      const k = (R - 5) / Math.max(pr, 0.001);
      px = cx + (px - cx) * k;
      py = cy + (py - cy) * k;
      size = Math.max(2, size * 0.85);
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI*2); ctx.fill();
  };

  // Home / spawn (amber ring-dot) — same role as old compass arrow
  plot(CENTER, CENTER, '#ff6b5a', 3.5);

  // Village pips (cyan) — registered settlements
  for(const s of villageSites){
    plot(s.x, s.z, '#5ee0d0', 3.2);
  }

  // Zombies
  for(const zb of mobs.zombies.values()){
    const p = zb.c.g.position;
    plot(p.x, p.z, zb.dormant ? '#e0b84a' : '#ff3b3b', zb.dormant ? 2.8 : 3.4);
  }
  // Other players
  for(const r of net.getRemotes()){
    plot(r.g.position.x, r.g.position.z, '#4fd2ff', 3.6);
  }
  // You at center + facing notch
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 3.5, cy + 2);
  ctx.lineTo(cx + 3.5, cy + 2);
  ctx.closePath();
  ctx.stroke();
}

// ---- Main loop ----
let last = performance.now(), frames=0, fpsTime=0, elapsed=0, cullTimer=0, isAuthority=true, saveT=30, dripT=5, wasUnderground=false, pickupCd=0;



function loop(now){
  requestAnimationFrame(loop); // scheduled first so one bad frame can't kill the game
  const dt = Math.min((now-last)/1000,.05); last=now; elapsed+=dt;

  frames++; fpsTime+=dt;
  if(fpsTime>=1){
    {
      const x = wrapC(playerMod.player.pos.x)|0, y = playerMod.player.pos.y|0, z = wrapC(playerMod.player.pos.z)|0;
      const dx = x - CENTER, dz = z - CENTER;
      const dist = Math.hypot(dx, dz)|0;
      const bio = BIOME_NAME[biomeAt(x,z)] || '';
      const mark = DEBUG_MARKERS ? ` · ${dist}m · pillars@256` : '';
      setHud(frames, `${x}, ${y}, ${z} · ${bio}${mark}`);
    }
    frames=0; fpsTime=0;
  }

  playerMod.update(dt, elapsed);
  if(playerMod.state.playing && !playerMod.state.paused){
    const dl = updateDayNight(dt, playerMod.player.pos);
    animals.update(dt, elapsed, playerMod.player.pos);
    villagers.update(dt, elapsed, playerMod.player.pos);
    if(isAuthority){
      const {hurts, digs} = mobs.hostTick(dt, dl, net.getTargets(playerMod.player.pos));
      net.dispatchHurts(hurts);
      for(const d of digs) net.hostWorldEdit(d.x, d.y, d.z, 0);
    }
    mobs.commonTick(dt, elapsed, playerMod.player.pos);
    drops.commonTick(dt, elapsed, playerMod.player.pos);
    if(isAuthority) keg.tick(dt, playerMod.player.pos, (edits)=>net.syncEdits(edits));
    // auto-pickup when close
    pickupCd = (pickupCd||0) - dt;
    if(pickupCd<=0 && !gm.forge){
      pickupCd = 0.2;
      net.sendPickup(playerMod.player.pos.x, playerMod.player.pos.y, playerMod.player.pos.z);
    }
    if(isAuthority){
      const gone = physics.tickDecay(dt);
      if(gone.length){
        for(const [lx,ly,lz] of gone) spawnParticles(lx,ly,lz, TYPES[5]?.pc ?? 0x3a7d28, 5);
        net.syncEdits(gone.map(([lx,ly,lz])=>[lx,ly,lz,0]));
      }
      const flowed = physics.tickWater?.(dt) || [];
      if(flowed.length){
        for(const e of flowed){
          if(e[3]===64) physics.notifyWater?.(e[0],e[1],e[2]);
        }
        net.syncEdits(flowed);
        for(const [lx,ly,lz,t] of flowed){
          // rebuild meshes around water changes
          rebuildAt(lx, lz);
        }
      }
    }
    const movingH = Math.abs(playerMod.player.vel.x)+Math.abs(playerMod.player.vel.z) > .5;
    survival.tick(dt, movingH, dl);
    {
      const px = playerMod.player.pos.x, pz = playerMod.player.pos.z;
      const bio = biomeAt(Math.round(px), Math.round(pz));
      let nearWater = false;
      for(let dy=0;dy<=2&&!nearWater;dy++) for(let dx=-2;dx<=2&&!nearWater;dx++) for(let dz=-2;dz<=2;dz++){
        if(getBlock(Math.round(px)+dx, Math.round(playerMod.player.pos.y)+dy, Math.round(pz)+dz)===64){ nearWater=true; break; }
      }
      ambientTick?.(dt, { nearWater, biome: bio, nearMarket: villagers.nearMarket(px, pz) });
      tickWaterAnim?.(dt);
      tickWind?.(dt);
    }
    net.update(dt, elapsed);
    // Near the toroidal seam, restitch chunks every frame so the wrap never flashes sky.
    // Far from the edge, throttle to save CPU.
    const px = playerMod.player.pos.x, pz = playerMod.player.pos.z;
    const lx = ((px % WORLD) + WORLD) % WORLD, lz = ((pz % WORLD) + WORLD) % WORLD;
    const nearSeam = (lx < 160 || lx > WORLD - 160 || lz < 160 || lz > WORLD - 160);
    cullTimer -= dt;
    if(nearSeam || cullTimer<=0){
      updateChunkVisibility(px, pz);
      updateTorchLights(px, pz);
      cullTimer = nearSeam ? 0 : 0.15;
    }
    const ug = playerMod.player.pos.y < heightAt(Math.round(playerMod.player.pos.x), Math.round(playerMod.player.pos.z)) - 2;
    if(ug){
      if(!wasUnderground){ wasUnderground = true; survival.note('cave'); }
      dripT -= dt;
      if(dripT<=0){ dripT = 4 + Math.random()*5; sfx.drip(); }
    } else wasUnderground = false;
    saveT -= dt;
    if(saveT<=0){ saveT = 30; saveWorldNow(); }
    const dx = CENTER - playerMod.player.pos.x, dz = CENTER - playerMod.player.pos.z;
    const angle = Math.atan2(dx, dz) - playerMod.view.yaw;
    setCompass(-angle * 180/Math.PI);
    updateCompassMap(playerMod.player.pos, playerMod.view.yaw);
  }
  updateParticles(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

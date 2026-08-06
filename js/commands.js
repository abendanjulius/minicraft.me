// commands.js — chat slash-commands
// Host/solo-only for world-affecting cmds; local cmds for everyone.

import { WORLD, WH, CENTER, getBlock, setBlock, heightAt, wrapC, biomeAt, BIOME_NAME, DEBUG_MARKERS } from './world.js';
import { day, setDayTime, rebuildAt, applyEdit, trackTorch, trackDoor, trackBed, trackSpecial, TYPES, ITEMS } from './render.js';
import { addChat, inventory, hotbarSlots, renderHotbar, renderInv, addToInventory, startHordeCountdown, showCenterNotice } from './ui.js';
import { gm, setMode } from './mode.js';
import * as net from './net.js';
import * as mobs from './mobs.js';
import * as survival from './survival.js';
import * as persist from './persist.js';
import * as eldercube from './eldercube.js';
import * as keepstones from './keepstones.js';
import * as claim from './claim.js';
import * as drops from './drops.js';
import * as villagers from './villagers.js';

/** @type {null | (() => any)} */
let getCtx = null;
export function setCommandContext(fn){ getCtx = fn; }

function reply(msg){ addChat('⚙', msg); }

function isHost(){
  // solo or host may change the shared world; pure clients may not
  return net.mode !== 'client';
}

function needHost(){
  if(isHost()) return true;
  reply('Host only — ask the host to run this.');
  return false;
}

function parseArgs(line){
  const parts = line.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase().replace(/^\//, '');
  return { cmd, args: parts.slice(1) };
}

function resolveItem(token){
  if(!token) return null;
  const n = +token;
  if(Number.isFinite(n) && (TYPES[n] || ITEMS[n])) return n;
  const q = token.toLowerCase();
  for(const [id, t] of Object.entries(TYPES)){
    if(t.name && t.name.toLowerCase().replace(/\s+/g,'') === q.replace(/\s+/g,'')) return +id;
    if(t.name && t.name.toLowerCase().includes(q)) return +id;
  }
  for(const [id, t] of Object.entries(ITEMS)){
    if(t.name && t.name.toLowerCase().replace(/\s+/g,'') === q.replace(/\s+/g,'')) return +id;
    if(t.name && t.name.toLowerCase().includes(q)) return +id;
  }
  return null;
}

function syncBlock(x,y,z,t){
  applyEdit(x,y,z,t,false);
  if(net.mode === 'host' || net.mode === 'solo') net.syncEdits?.([[x,y,z,t]]);
  else net.sendEdit?.(x,y,z,t);
}

/** Flatten a disk to flat dirt (no trees/plants/hills). Persists + syncs. */
function cmdFlat(r, ctx){
  if(!needHost()) return;
  r = Math.max(4, Math.min(64, r|0 || 24));
  const px = Math.round(ctx.player.pos.x);
  const pz = Math.round(ctx.player.pos.z);
  const baseY = Math.max(4, Math.min(WH - 6, heightAt(px, pz)));
  const batch = [];
  let n = 0;
  for(let dx = -r; dx <= r; dx++){
    for(let dz = -r; dz <= r; dz++){
      if(dx*dx + dz*dz > r*r) continue;
      const x = wrapC(px + dx), z = wrapC(pz + dz);
      for(let y = 0; y < WH; y++){
        let t = 0;
        if(y < baseY - 3) t = 3;
        else if(y <= baseY) t = 2;
        else t = 0;
        if(getBlock(x,y,z) !== t){
          setBlock(x,y,z,t);
          persist.recordEdit?.(x, y, z, t);
          batch.push([x, y, z, t]);
          n++;
        }
      }
      rebuildAt(x, z);
    }
  }
  // Sync to multiplayer in chunks so we don't blow the wire
  if(net.syncEdits && batch.length){
    const STEP = 400;
    for(let i = 0; i < batch.length; i += STEP){
      net.syncEdits(batch.slice(i, i + STEP));
    }
  }
  reply(`Flattened dirt radius ${r} at y=${baseY} (${n} cells saved/synced).`);
}

function cmdFill(token, r, ctx){
  if(!needHost()) return;
  const id = resolveItem(token);
  if(id == null || !TYPES[id]){ reply('Unknown block. Try an id or name (e.g. stone, 3).'); return; }
  r = Math.max(1, Math.min(16, r|0 || 3));
  const px = Math.round(ctx.player.pos.x);
  const py = Math.round(ctx.player.pos.y);
  const pz = Math.round(ctx.player.pos.z);
  const batch = [];
  let n = 0;
  for(let dx = -r; dx <= r; dx++)
    for(let dy = -r; dy <= r; dy++)
      for(let dz = -r; dz <= r; dz++){
        if(dx*dx+dy*dy+dz*dz > r*r) continue;
        const x = wrapC(px+dx), y = py+dy, z = wrapC(pz+dz);
        if(y < 0 || y >= WH) continue;
        setBlock(x,y,z,id);
        persist.recordEdit?.(x,y,z,id);
        batch.push([x,y,z,id]);
        n++;
      }
  for(let dx = -r-1; dx <= r+1; dx++)
    for(let dz = -r-1; dz <= r+1; dz++)
      rebuildAt(wrapC(px+dx), wrapC(pz+dz));
  if(net.syncEdits && batch.length){
    const STEP = 400;
    for(let i = 0; i < batch.length; i += STEP) net.syncEdits(batch.slice(i, i + STEP));
  }
  reply(`Filled ${TYPES[id].name} sphere r=${r} (${n} blocks saved/synced).`);
}

export function tryCommand(raw){
  if(!raw || raw[0] !== '/') return false;
  const ctx = getCtx?.();
  if(!ctx){ reply('Commands not ready.'); return true; }
  const { cmd, args } = parseArgs(raw);

  switch(cmd){
    // ---- Local (everyone) ----
    case 'where': {
      const x = wrapC(ctx.player.pos.x)|0;
      const y = ctx.player.pos.y|0;
      const z = wrapC(ctx.player.pos.z)|0;
      const bio = BIOME_NAME[biomeAt(x,z)] || '?';
      reply(`You are at ${x}, ${y}, ${z} · ${bio} · mode=${net.mode}`);
      const nv = villagers.nearestVillage?.(ctx.player.pos.x, ctx.player.pos.z, 600);
      if(nv){
        const names = { market:'Coin Market', outpost:'Dune Outpost', haven:'Log Haven', stilt:'Stilt Rest' };
        reply(`Nearest village: ${names[nv.kind]||nv.kind} · ${nv.dist}m away (${nv.x|0}, ${nv.z|0})`);
      } else {
        reply('No village registered nearby (explore new chunks / biomes).');
      }
      return true;
    }
    case 'fly': {
      ctx.toggleFly?.();
      reply(ctx.state?.flying ? 'Fly ON' : 'Fly OFF');
      return true;
    }
    case 'home': {
      ctx.spawn?.();
      reply('Teleported home.');
      return true;
    }
    case 'tp': {
      if(args.length < 2){ reply('Usage: /tp <x> <z> [y]'); return true; }
      const x = +args[0], z = +args[1];
      if(!Number.isFinite(x) || !Number.isFinite(z)){ reply('Invalid coords.'); return true; }
      let y = args[2] != null ? +args[2] : heightAt(wrapC(x), wrapC(z)) + 2;
      if(!Number.isFinite(y)) y = 30;
      ctx.setPosYaw?.(wrapC(x), y, wrapC(z), ctx.view?.yaw || 0);
      reply(`Teleported to ${wrapC(x)|0}, ${y|0}, ${wrapC(z)|0}`);
      return true;
    }
    case 'heal': {
      if(survival.sv){
        survival.sv.hp = 20;
        survival.sv.hunger = 20;
        survival.renderVitals?.();
      }
      reply('Fully healed.');
      return true;
    }
    case 'cube': {
      // /cube            — who holds the Elder Cube, and how much is reclaimed
      // /cube give <who> — hand it on, penalties and all
      const sub = (args[0]||'').toLowerCase();
      if(sub === 'give'){
        const who = args.slice(1).join(' ').trim();
        if(!who){ reply('Usage: /cube give <player name>'); return true; }
        if(!(inventory[186] > 0)){ reply('You are not carrying the Elder Cube.'); return true; }
        net.requestCubeGive(who);
        return true;
      }
      if(sub === 'get'){
        // Testing shortcut: summon the ONE Cube to your hand rather than mint a
        // second. It is moved, never copied — the invariant still holds.
        if(!needHost()) return true;
        if(gm.forge){ reply('Not in Forge. The Elder Cube only exists in Nightfall.'); return true; }
        if(inventory[186] > 0){ reply('You are already carrying it.'); return true; }
        if(eldercube.heldBySomeone()){
          reply(`${eldercube.cubeOwnerName()||'Another player'} is carrying it — ask them for it.`);
          return true;
        }
        const seated = keepstones.activeStone();
        if(seated){
          reply(`It is seated in a Keepstone at ${seated.x}, ${seated.z}. Pull it out there.`);
          return true;
        }
        // Loose in the world: pick it up from wherever it lies.
        const loose = drops.serialize().find(d => d[1] === 186);
        if(loose) drops.removeById(loose[0]);
        addToInventory(186);
        eldercube.setCubeOwner(net.myPeerId(), net.myPlayerName());
        renderHotbar(); renderInv?.();
        reply(loose
          ? 'The Elder Cube is in your hands. You cannot build or sleep while you hold it.'
          : 'The Elder Cube answers. You cannot build or sleep while you hold it.');
        survival.note('cube');
        return true;
      }
      const holder = eldercube.cubeOwnerName();
      if(inventory[186] > 0) reply('You are carrying the Elder Cube. You cannot build or sleep until you set it down.');
      else if(eldercube.heldBySomeone()) reply(`${holder||'Another player'} is carrying the Elder Cube.`);
      else if(keepstones.activeStone()) reply('The Elder Cube is seated in a Keepstone.');
      else reply('The Elder Cube lies somewhere in the world.');
      reply(`${claim.claimedPercent().toFixed(3)}% of the world is claimed (${claim.claimedCells()} cells).`);
      return true;
    }
    case 'keepstone':
    case 'keepstones': {
      if(!needHost()) return true;
      if(gm.forge){ reply('Not in Forge. Keepstones only mean something in Nightfall.'); return true; }
      const n = Math.max(1, Math.min(16, +args[0] || 1));
      for(let i=0;i<n;i++) addToInventory(43);
      renderHotbar(); renderInv?.();
      reply(`Gave ${n}× Keepstone. Place one, then click it holding the Elder Cube.`);
      return true;
    }
    case 'help':
    case 'commands': {
      reply('Local: /where /fly /home /tp /heal /cube');
      reply('Testing: /cube get · /keepstone [n]  (Nightfall only)');
      reply('Host: /flat /day /night /time /fill /give /clear /god /peace /killmobs /horde /markers /chunk /gm /skip /seed');
      return true;
    }

    // ---- Host-only (shared world / rules) ----
    case 'flat':
      cmdFlat(+args[0] || 24, ctx);
      return true;
    case 'day':
    case 'noon':
      if(!needHost()) return true;
      setDayTime(0.28);
      reply('Time set to day.');
      return true;
    case 'night':
    case 'midnight':
      if(!needHost()) return true;
      setDayTime(0.78);
      reply('Time set to night.');
      return true;
    case 'time': {
      if(!needHost()) return true;
      const a = (args[0]||'').toLowerCase();
      if(a === 'noon' || a === 'day') setDayTime(0.28);
      else if(a === 'midnight' || a === 'night') setDayTime(0.78);
      else if(a === 'dusk' || a === 'sunset') setDayTime(0.48);
      else if(a === 'dawn' || a === 'sunrise') setDayTime(0.08);
      else {
        const v = parseFloat(a);
        if(!Number.isFinite(v)){ reply('Usage: /time noon|night|dusk|dawn|0-1'); return true; }
        setDayTime(v);
      }
      reply(`Time set (${(day.t).toFixed(2)}).`);
      return true;
    }
    case 'skip': {
      if(!needHost()) return true;
      setDayTime(0.22);
      if(survival.sleepTillDawn) survival.sleepTillDawn();
      reply('Skipped to morning.');
      return true;
    }
    case 'fill':
      cmdFill(args[0], +args[1] || 3, ctx);
      return true;
    case 'give': {
      if(!needHost()) return true;
      const id = resolveItem(args[0]);
      const n = Math.max(1, Math.min(64, +args[1] || 1));
      if(id == null){ reply('Usage: /give <id|name> [count]'); return true; }
      // There is one Elder Cube per world and /give would happily mint more,
      // which unravels the whole premise. /cube get moves the real one instead.
      if(id === 186){ reply('The Elder Cube cannot be duplicated. Use /cube get to summon the one that exists.'); return true; }
      for(let i=0;i<n;i++) addToInventory(id);
      renderHotbar(); renderInv?.();
      const name = TYPES[id]?.name || ITEMS[id]?.name || id;
      reply(`Gave ${n}× ${name}`);
      return true;
    }
    case 'clear': {
      if(!needHost()) return true;
      for(const k of Object.keys(inventory)) delete inventory[k];
      for(let i = 0; i < 10; i++) hotbarSlots[i] = null;
      renderHotbar(); renderInv?.();
      reply('Inventory cleared.');
      return true;
    }
    case 'god': {
      if(!needHost()) return true;
      ctx.state.god = !ctx.state.god;
      // setGodMode only — `godMode` is a module export binding and assigning to
      // it throws a TypeError, which aborted the command mid-way.
      survival.setGodMode?.(ctx.state.god);
      reply(ctx.state.god ? 'God mode ON (no damage).' : 'God mode OFF.');
      return true;
    }
    case 'peace': {
      if(!needHost()) return true;
      const on = (args[0]||'on').toLowerCase() !== 'off';
      mobs.setPeaceMode?.(on);
      // fallback flag
      if(!mobs.setPeaceMode) mobs.peaceMode = on;
      reply(on ? 'Peaceful: mob spawns suppressed.' : 'Peaceful OFF.');
      return true;
    }
    case 'killmobs': {
      if(!needHost()) return true;
      let n = 0;
      if(mobs.zombies){
        for(const [id, z] of [...mobs.zombies.entries()]){
          // remove from scene if possible
          try {
            if(z.c?.g) z.c.g.parent?.remove(z.c.g);
          } catch(e){}
          mobs.zombies.delete(id);
          n++;
        }
      }
      reply(`Removed ${n} mobs.`);
      return true;
    }
    case 'horde': {
      if(!needHost()) return true;
      const lvl = Math.max(1, Math.min(3, +args[0] || 3));
      if(gm.forge){
        showCenterNotice('🌙', 'Nightfall Required',
          'The horde only stalks at night.<br>Switch to <b>🌙 Nightfall</b> mode, then try <b>/horde</b> again.');
        reply('The horde only stalks Nightfall — switch to 🌙 Nightfall first.');
        return true;
      }
      mobs.clearZombies?.();                // fresh slate — the wave arrives together
      setDayTime(0.72);                     // plunge into deep night
      mobs.setIntel?.(lvl);
      mobs.setHordeHold?.(true);            // no spawns until the countdown ends
      net.systemMsg?.('🌙 The air turns cold… the horde is coming.');
      net.sendHorde?.(lvl);                 // every connected player sees the countdown too
      reply(`Horde incoming — Tier ${lvl}. Night falls…`);
      startHordeCountdown(10, ()=>{
        mobs.setHordeHold?.(false);         // release natural night spawning
        // Scale the wave by player count: ~8% more per extra player (never doubled),
        // spread across everyone and always at a fair distance.
        const targets = net.getTargets?.(ctx.player.pos) || [{x:ctx.player.pos.x, y:ctx.player.pos.y, z:ctx.player.pos.z}];
        const players = Math.max(1, targets.length);
        const total = Math.round((6 + lvl * 2) * (1 + 0.08 * (players - 1)));
        mobs.surgeBurst?.(targets, total);
        net.systemMsg?.('🧟 THEY COME. Survive the night!');
      });
      return true;
    }
    case 'markers': {
      if(!needHost()) return true;
      // runtime toggle can't easily unplace blocks; inform user
      reply('Markers are placed at world gen. Use a New World with DEBUG_MARKERS off to hide them permanently.');
      return true;
    }
    case 'chunk': {
      if(!needHost()) return true;
      const px = Math.round(ctx.player.pos.x), pz = Math.round(ctx.player.pos.z);
      const R = 3;
      for(let dx = -R; dx <= R; dx++)
        for(let dz = -R; dz <= R; dz++)
          rebuildAt(wrapC(px + dx*16), wrapC(pz + dz*16));
      reply('Remeshed nearby chunks.');
      return true;
    }
    case 'gm':
    case 'mode': {
      if(!needHost()) return true;
      const a = (args[0]||'').toLowerCase();
      if(a === 'forge' || a === 'creative' || a === '1'){
        setMode(true);
        reply('Mode: Forge (creative).');
      } else if(a === 'survival' || a === '0'){
        setMode(false);
        reply('Mode: Survival.');
      } else reply('Usage: /gm forge|survival');
      return true;
    }
    case 'seed': {
      if(!needHost()) return true;
      reply(`Seed: ${ctx.seed ?? '(unknown)'}`);
      return true;
    }
    default:
      reply(`Unknown command /${cmd}. Try /help`);
      return true;
  }
}

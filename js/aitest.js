// aitest.js — scripted self-tests for the bot, reported in chat via /aitest.
//
// Exists because bot behaviour can only really be judged by watching it, and
// round-tripping "it still circles" through a human is slow. These run the same
// code the bot uses and report pass/fail with numbers.
import { WORLD, WH, surfaceY, getBlock, wrapC } from './world.js';
import { findPath, smooth, standable } from './pathfind.js';
import { player, setInputLocked } from './player.js';
import { addChat } from './ui.js';
import * as ai from './ai.js';

const say = t => addChat('🧪', t);
const wrapD = d => { if(d > WORLD/2) d -= WORLD; if(d < -WORLD/2) d += WORLD; return d; };
const distXZ = (ax, az, bx, bz) => Math.hypot(wrapD(bx-ax), wrapD(bz-az));

let live = null;   // running live test

export function isRunning(){ return !!live; }

// ── instant: audit the pathfinder around wherever the player stands ──
export function auditPaths(n = 24){
  const px = Math.round(player.pos.x), pz = Math.round(player.pos.z), py = Math.round(player.pos.y);
  let ok = 0, partial = 0, none = 0, illegal = 0, digs = 0;
  const times = [];
  for(let i = 0; i < n; i++){
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
    const r = 25 + Math.random() * 45;
    const gx = wrapC(Math.round(px + Math.cos(a) * r));
    const gz = wrapC(Math.round(pz + Math.sin(a) * r));
    const gy = surfaceY(gx, gz) + 1;
    const t0 = performance.now();
    const res = findPath(px, py, pz, gx, gy, gz);
    times.push(performance.now() - t0);
    if(!res.path.length){ none++; continue; }
    // legality: every node standable, every step within one block / three down
    let bad = false;
    for(const nd of res.path) if(!standable(nd.x, nd.y, nd.z) && !nd.dig){ bad = true; break; }
    for(let k = 1; !bad && k < res.path.length; k++){
      const A = res.path[k-1], B = res.path[k];
      if(Math.abs(wrapD(B.x-A.x)) > 1 || Math.abs(wrapD(B.z-A.z)) > 1) bad = true;
      else if(B.y - A.y > 1 || B.y - A.y < -3) bad = true;
    }
    digs += res.path.filter(w => w.dig).length;
    if(bad) illegal++;
    else if(res.complete) ok++;
    else partial++;
  }
  times.sort((a,b) => a-b);
  say(`path audit (${n} routes, 25-70 blocks): ${ok} complete · ${partial} partial · ${none} none · ${illegal} illegal`);
  say(`  time median ${times[Math.floor(n/2)].toFixed(1)}ms · worst ${times[n-1].toFixed(1)}ms · dig steps ${digs}`);
  if(illegal) say('  ⚠ illegal paths found — pathfinder bug, tell Claude');
  else if(ok + partial >= n * 0.8) say('  ✅ pathfinder healthy');
  else say('  ⚠ many routes failed — terrain may be very broken here');
}

// ── live: walk to a point and time it ──
export function startTravel(dist = 60){
  ai.stop();
  const a = Math.random() * Math.PI * 2;
  const gx = wrapC(Math.round(player.pos.x + Math.cos(a) * dist));
  const gz = wrapC(Math.round(player.pos.z + Math.sin(a) * dist));
  const gy = surfaceY(gx, gz) + 1;
  setInputLocked?.(true);
  live = {
    kind: 'travel', gx, gz, gy, t: 0, best: Infinity, stall: 0,
    start: {x: player.pos.x, z: player.pos.z},
    limit: Math.max(30, dist * 1.6),
  };
  say(`travel test → ${gx},${gz} (${Math.round(dist)} blocks). Watch it route around obstacles.`);
}

export function stopTest(msg){
  if(!live) return;
  live = null;
  setInputLocked?.(false);
  ai.clearRoute();
  if(msg) say(msg);
}

export function tick(dt){
  if(!live) return;
  live.t += dt;
  if(live.kind === 'travel'){
    const d = distXZ(player.pos.x, player.pos.z, live.gx, live.gz);
    if(d < live.best - 0.5){ live.best = d; live.stall = 0; } else live.stall += dt;

    const arrived = ai.driveTo(live.gx, live.gz, live.gy, dt);
    if(arrived){
      const straight = distXZ(live.start.x, live.start.z, live.gx, live.gz);
      const r = ai.routeInfo();
      stopTest(`✅ arrived in ${live.t.toFixed(1)}s · ${straight.toFixed(0)} blocks straight-line · ${r.digs} dug`);
      return;
    }
    if(live.stall > 12){
      const r = ai.routeInfo();
      stopTest(`❌ stuck ${d.toFixed(0)} blocks short after ${live.t.toFixed(0)}s · route legs ${r.legs} (idx ${r.idx})`);
      return;
    }
    if(live.t > live.limit){
      stopTest(`❌ timed out after ${live.t.toFixed(0)}s · still ${d.toFixed(0)} blocks away (best ${live.best.toFixed(0)})`);
      return;
    }
  }
}

export function help(){
  say('/aitest path — audit the pathfinder here (instant)');
  say('/aitest travel [dist] — walk to a random point and time it');
  say('/aitest stop — abort a running test');
}

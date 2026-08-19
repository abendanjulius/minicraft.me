// pathfind.js — A* over the voxel world for bot navigation.
//
// The old navigator scored 8 compass directions and committed to one for ~2 s,
// digging or flailing when that failed. It cannot see round a wall, so it reads
// as aimless. This searches the actual world: walking, stepping up, dropping,
// and jumping one-block gaps, with terrain costs.
//
// Deliberately free of THREE/DOM imports so it can be tested headlessly.
import { WORLD, WH, getBlock, isWalkThrough, wrapC } from './world.js';

const DIAG = Math.SQRT2;
const MAX_FALL = 3;          // how far the bot will drop without damage worry
const STEP_UP_COST = 0.8;    // jumping costs more than strolling
const FALL_COST = 0.25;      // per block descended
const WATER_COST = 2.5;      // swimming is slow — prefer land
const DIG_COST = 7;          // mining a block: expensive, so it routes around first

const key = (x, y, z) => ((x & 2047) << 19) | ((z & 2047) << 8) | (y & 255);

/** Binary heap — a linear scan of the open set was costing hundreds of ms. */
class MinHeap {
  constructor(){ this.a = []; }
  get size(){ return this.a.length; }
  push(n){
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while(i > 0){
      const p = (i - 1) >> 1;
      if(a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(){
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if(a.length){
      a[0] = last;
      let i = 0;
      for(;;){
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if(l < a.length && a[l].f < a[m].f) m = l;
        if(r < a.length && a[r].f < a[m].f) m = r;
        if(m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const solidAt = (x, y, z) => {
  if(y < 0 || y >= WH) return y < 0;          // below the world counts as floor
  const b = getBlock(x, y, z);
  return b !== 0 && !isWalkThrough(b);
};
const isWater = (x, y, z) => getBlock(x, y, z) === 64;

/** A position the bot's feet can occupy: floor below, two clear blocks for the body. */
export function standable(x, y, z){
  if(y < 1 || y + 1 >= WH) return false;
  // Swimming counts: requiring a solid floor made every lake and river an
  // impassable wall, so anything across water was simply unreachable.
  if(isWater(x, y, z)) return !solidAt(x, y + 1, z);
  if(!solidAt(x, y - 1, z)) return false;
  return !solidAt(x, y, z) && !solidAt(x, y + 1, z);
}

// Neighbour expansion tests the same cells repeatedly; memoising inside one
// search cut the block lookups (the real cost) by roughly 4x.
let memo = null;
function canStand(x, y, z, allowDig){
  if(allowDig){
    // solid floor beneath, and the two body blocks are ordinary terrain we could mine
    if(y < 1 || y + 1 >= WH) return false;
    if(!solidAt(x, y - 1, z)) return false;
    const a = getBlock(x, y, z), b = getBlock(x, y + 1, z);
    return a !== 0 && a !== 64 && b !== 64;
  }
  if(!memo) return standable(x, y, z);
  const k = key(x, y, z);
  let v = memo.get(k);
  if(v === undefined){ v = standable(x, y, z); memo.set(k, v); }
  return v;
}

/** Shortest signed delta across the toroidal seam. */
function wrapDelta(d){
  if(d >  WORLD / 2) d -= WORLD;
  if(d < -WORLD / 2) d += WORLD;
  return d;
}

/** Drop from (x,y,z) to the first standable spot at most MAX_FALL below. */
function settle(x, y, z){
  for(let d = 0; d <= MAX_FALL; d++){
    if(canStand(x, y - d, z)) return y - d;
  }
  return null;
}

const NEIGHBOURS = [
  [ 1, 0, 1], [-1, 0, 1], [ 0, 1, 1], [ 0,-1, 1],
  [ 1, 1, DIAG], [ 1,-1, DIAG], [-1, 1, DIAG], [-1,-1, DIAG],
];

function heuristic(x, y, z, gx, gy, gz){
  const dx = Math.abs(wrapDelta(x - gx));
  const dz = Math.abs(wrapDelta(z - gz));
  const lo = Math.min(dx, dz), hi = Math.max(dx, dz);
  return (hi - lo) + DIAG * lo + Math.abs(y - gy) * 0.6;
}

/**
 * Find a walking route from (sx,sy,sz) to near (gx,gy,gz).
 * Returns { path: [{x,y,z}...], complete: bool, nodes: n } — path is [] if the
 * start itself is unusable. When the goal can't be reached within the node
 * budget the closest reached point is returned instead, so the bot still makes
 * progress rather than standing still.
 */
export function findPath(sx, sy, sz, gx, gy, gz, opts = {}){
  const maxNodes = opts.maxNodes ?? 3000;
  // Hard wall-clock ceiling. Node count alone is a poor proxy for time (block
  // lookups vary with chunk residency), and a search must never eat a frame.
  const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now())
                 + (opts.budgetMs ?? 6);
  const goalR = opts.goalRadius ?? 1.5;
  const canDig = opts.canDig !== false;
  memo = new Map();

  sx = wrapC(Math.round(sx)); sz = wrapC(Math.round(sz)); sy = Math.round(sy);
  gx = wrapC(Math.round(gx)); gz = wrapC(Math.round(gz)); gy = Math.round(gy);

  let startY = settle(sx, sy, sz);
  if(startY === null){
    for(const dy of [1, 2, -1, 3]){                       // in a gap, or under leaves
      if(canStand(sx, sy + dy, sz)){ startY = sy + dy; break; }
    }
  }
  if(startY === null){                                    // nudge to an adjacent column
    outer:
    for(const [ox, oz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
      for(let dy = 0; dy <= 2; dy++){
        const yy = settle(wrapC(sx + ox), sy + dy, wrapC(sz + oz));
        if(yy !== null){ sx = wrapC(sx + ox); sz = wrapC(sz + oz); startY = yy; break outer; }
      }
    }
  }
  if(startY === null){ memo = null; return {path: [], complete: false, nodes: 0}; }

  const startNode = {x: sx, y: startY, z: sz, g: 0, f: heuristic(sx, startY, sz, gx, gy, gz)};
  const open = new MinHeap();
  open.push(startNode);
  const came = new Map();
  const radiusCap = Math.max(24, Math.hypot(wrapDelta(gx - sx), wrapDelta(gz - sz)) + 20);
  const gScore = new Map([[key(sx, startY, sz), 0]]);
  let best = {h: heuristic(sx, startY, sz, gx, gy, gz), node: startNode};
  let nodes = 0;

  while(open.size && nodes < maxNodes){
    if((nodes & 63) === 0 &&
       (typeof performance !== 'undefined' ? performance.now() : Date.now()) > deadline) break;
    const cur = open.pop();
    nodes++;

    const h = heuristic(cur.x, cur.y, cur.z, gx, gy, gz);
    if(h < best.h){ best = {k: key(cur.x, cur.y, cur.z), h, node: cur}; }

    const dxg = Math.abs(wrapDelta(cur.x - gx));
    const dzg = Math.abs(wrapDelta(cur.z - gz));
    if(Math.hypot(dxg, dzg) <= goalR && Math.abs(cur.y - gy) <= 2){
      { const p = rebuild(came, cur); memo = null; return {path: p, complete: true, nodes}; }
    }

    for(const [dx, dz, baseCost] of NEIGHBOURS){
      const nx = wrapC(cur.x + dx), nz = wrapC(cur.z + dz);
      // never wander far outside the corridor between start and goal
      if(Math.abs(wrapDelta(nx - sx)) > radiusCap || Math.abs(wrapDelta(nz - sz)) > radiusCap) continue;

      // no cutting corners diagonally through solid blocks
      if(dx && dz){
        const a = wrapC(cur.x + dx), b = wrapC(cur.z + dz);
        if(solidAt(a, cur.y, cur.z) || solidAt(cur.x, cur.y, b)) continue;
        if(solidAt(a, cur.y + 1, cur.z) || solidAt(cur.x, cur.y + 1, b)) continue;
      }

      let ny = null, extra = 0;
      if(canStand(nx, cur.y, nz)){
        ny = cur.y;
      } else if(canStand(nx, cur.y + 1, nz) && !solidAt(cur.x, cur.y + 2, cur.z)){
        ny = cur.y + 1; extra = STEP_UP_COST;              // step / jump up
      } else {
        const drop = settle(nx, cur.y, nz);                // walk off a ledge
        if(drop !== null && cur.y - drop <= MAX_FALL){ ny = drop; extra = (cur.y - drop) * FALL_COST; }
      }
      // Last resort: tunnel through. Priced high so the search exhausts every
      // walkable route first, but it means a hill or wall is never a dead end.
      let digging = false;
      if(ny === null && canDig){
        if(solidAt(nx, cur.y, nz) && canStand(nx, cur.y, nz, true)){
          ny = cur.y;
          extra = DIG_COST * ((solidAt(nx, cur.y, nz) ? 1 : 0) + (solidAt(nx, cur.y + 1, nz) ? 1 : 0));
          digging = true;
        }
      }
      if(ny === null) continue;

      if(isWater(nx, ny, nz) || isWater(nx, ny + 1, nz)) extra += WATER_COST;

      const nk = key(nx, ny, nz);
      const tentative = cur.g + baseCost + extra;
      if(tentative >= (gScore.get(nk) ?? Infinity)) continue;

      gScore.set(nk, tentative);
      came.set(nk, cur);
      open.push({x: nx, y: ny, z: nz, g: tentative, dig: digging,
                 f: tentative + heuristic(nx, ny, nz, gx, gy, gz) * 1.25});
    }
  }
  // budget spent — hand back the closest approach so the bot keeps moving
  const p = best ? rebuild(came, best.node) : [];
  memo = null;
  return {path: p, complete: false, nodes};
}

function rebuild(came, node){
  const out = [];
  let cur = node;
  const guard = new Set();
  while(cur){
    const k = key(cur.x, cur.y, cur.z);
    if(guard.has(k)) break;
    guard.add(k);
    out.push({x: cur.x, y: cur.y, z: cur.z, dig: !!cur.dig});
    cur = came.get(k);
  }
  return out.reverse();
}

/** Drop waypoints that lie on a straight, unobstructed run — fewer, longer legs. */
export function smooth(path){
  if(path.length < 3) return path;
  const out = [path[0]];
  let i = 0;
  while(i < path.length - 1){
    let j = path.length - 1;
    for(; j > i + 1; j--){
      if(clearRun(path[i], path[j])) break;
    }
    out.push(path[j]);
    i = j;
  }
  return out;
}

function clearRun(a, b){
  if(a.y !== b.y) return false;
  const dx = wrapDelta(b.x - a.x), dz = wrapDelta(b.z - a.z);
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if(steps > 12) return false;
  for(let s = 1; s <= steps; s++){
    const x = wrapC(Math.round(a.x + dx * s / steps));
    const z = wrapC(Math.round(a.z + dz * s / steps));
    if(!standable(x, a.y, z)) return false;
  }
  return true;
}

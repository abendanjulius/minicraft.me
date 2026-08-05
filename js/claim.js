// claim.js — permanent light. The Elder Cube's one power.
//
// A torch suppresses spawning while it burns; pull it and the dark floods back
// (see nearestTorchDist in render.js). A claimed cell is different: it is removed
// from the surface spawn table for good, with no torch and nobody watching it.
//
// Storage is one bit per 4×4 world cell over the 2048² torus:
//   2048/4 = 512 → 512×512 = 262144 bits = 32 KB for the entire world.
// Small enough to sit inside the normal save object.
//
// NOTE: claiming covers the SURFACE only. Caves stay hostile at any hour
// ("underground is always night", mobs.js) — the Cube reclaims the world, not
// the underworld it came from.
import { WORLD, wrapC } from './world.js';

export const CELL = 4;                    // world blocks per claim cell
export const GRID = WORLD / CELL;         // 512
const BYTES = (GRID * GRID) >> 3;         // 32768

let bits = new Uint8Array(BYTES);
let count = 0;                            // claimed cells, tracked incrementally

const cellOf = v => Math.floor(wrapC(Math.floor(v)) / CELL);
const idxOf  = (cx, cz) => cz * GRID + cx;

/** Raw bit grid — the map screen renders this directly. */
export const grid = () => bits;
export const claimedCells = () => count;
export const claimedPercent = () => (count / (GRID * GRID)) * 100;

/** Is this world position on claimed ground? Wraps. */
export function claimed(x, z){
  const i = idxOf(cellOf(x), cellOf(z));
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}

/** Claim one cell by cell-coords. Returns true if it was newly claimed. */
export function claimCell(cx, cz){
  cx = ((cx % GRID) + GRID) % GRID;
  cz = ((cz % GRID) + GRID) % GRID;
  const i = idxOf(cx, cz), b = i >> 3, m = 1 << (i & 7);
  if(bits[b] & m) return false;
  bits[b] |= m;
  count++;
  return true;
}

/**
 * Claim every cell whose centre is within `radius` world-blocks of (x,z).
 * Returns how many cells were newly claimed, so callers can tell when a
 * Keepstone has stopped making progress.
 */
export function claimDisc(x, z, radius){
  const ccx = cellOf(x), ccz = cellOf(z);
  const r = Math.ceil(radius / CELL);
  const r2 = radius * radius;
  let gained = 0;
  for(let dz = -r; dz <= r; dz++){
    for(let dx = -r; dx <= r; dx++){
      // distance from the disc centre to this cell's centre, in world blocks
      const wx = dx * CELL, wz = dz * CELL;
      if(wx * wx + wz * wz > r2) continue;
      if(claimCell(ccx + dx, ccz + dz)) gained++;
    }
  }
  return gained;
}

export function clear(){ bits = new Uint8Array(BYTES); count = 0; }

// ---- save / restore --------------------------------------------------------
// Run-length encoded, then base64. Early worlds are almost entirely zeros, so a
// fresh save costs a handful of bytes rather than 43 KB of encoded emptiness.
export function serialize(){
  if(count === 0) return null;
  const runs = [];
  let cur = bits[0], n = 0;
  for(let i = 0; i < BYTES; i++){
    if(bits[i] === cur && n < 0xffff){ n++; continue; }
    runs.push(cur, n & 0xff, n >> 8);
    cur = bits[i]; n = 1;
  }
  runs.push(cur, n & 0xff, n >> 8);
  let s = '';
  for(let i = 0; i < runs.length; i += 4096) s += String.fromCharCode(...runs.slice(i, i + 4096));
  try{ return btoa(s); }catch(e){ return null; }
}

export function restore(str){
  clear();
  if(!str) return;
  let raw;
  try{ raw = atob(str); }catch(e){ return; }
  let p = 0;
  for(let i = 0; i + 2 < raw.length; i += 3){
    const val = raw.charCodeAt(i);
    const n = raw.charCodeAt(i + 1) | (raw.charCodeAt(i + 2) << 8);
    for(let k = 0; k < n && p < BYTES; k++) bits[p++] = val;
  }
  // recount from the restored grid rather than trusting a stored total
  count = 0;
  for(let i = 0; i < BYTES; i++){
    let b = bits[i];
    while(b){ count += b & 1; b >>= 1; }
  }
}

// eldercube.js — the one Cube: where it is, and the vault it starts in.
//
// There is exactly one Elder Cube per world. It is never destroyed, so every
// path that could lose it (dying, mining the Keepstone that holds it, quitting
// mid-siege) has to hand it back somewhere. This module owns the "it exists
// somewhere" half; keepstones.js owns the "it is seated in a stone" half.
import { WH, CENTER, ensureChunk, setBlock, mulberry32, wrapC } from './world.js';
import * as drops from './drops.js';

export const CUBE_ITEM = 186;

// Where this world's vault was cut. Persisted, because "has the vault been cut
// yet?" cannot be inferred: persist.create() hands back a populated record, so a
// brand-new world already looks saved.
let vault = null;
export const vaultRecord = () => vault;
export function markVault(site){ vault = site ? {x:site.x, y:site.y, z:site.z} : null; }

/** Vault sits below the crystal layer (ores stop at y 9). */
const VAULT_Y = 5;
const R = 3; // chamber half-width

/**
 * Deterministic vault position for a seed. Deliberately far from spawn: the
 * journey down and back is the first act of the arc.
 */
export function vaultSite(seed){
  const rng = mulberry32((seed ^ 0x5e1dc0) >>> 0);
  const ang = rng() * Math.PI * 2;
  const dist = 260 + rng() * 340;
  return {
    x: wrapC(Math.round(CENTER + Math.cos(ang) * dist)),
    z: wrapC(Math.round(CENTER + Math.sin(ang) * dist)),
    y: VAULT_Y,
  };
}

/**
 * Carve the vault and lay the Cube in it. New worlds only — carving writes
 * through setBlock, and the resulting cavity is captured by the normal chunk
 * data, while the Cube itself is persisted as a drop.
 */
export function createVault(seed, onEdit){
  const site = vaultSite(seed);
  const { x, z, y } = site;
  // Writes go through setBlock (cheap, no per-cell mesh rebuild) and are reported
  // to `onEdit` so they land in the save. Callers must run this BEFORE
  // buildAllChunks() so the geometry picks the chamber up for free.
  const put = (bx, by, bz, t)=>{ setBlock(bx, by, bz, t); onEdit?.(bx, by, bz, t); };

  // Make sure every chunk we are about to write into actually exists.
  for(let dx = -R - 1; dx <= R + 1; dx += 8){
    for(let dz = -R - 1; dz <= R + 1; dz += 8){
      ensureChunk((wrapC(x + dx) >> 4), (wrapC(z + dz) >> 4));
    }
  }
  ensureChunk(wrapC(x + R + 1) >> 4, wrapC(z + R + 1) >> 4);

  // Hollow a domed chamber, floored and walled in stone brick so it reads as
  // built, not as a natural cave you stumbled into.
  // Ceiling sits 4 above the plinth deliberately. drops.commonTick looks for a
  // floor starting 2 blocks ABOVE an item, so in a shorter chamber the Cube
  // finds the ceiling instead of the plinth and drifts up through the roof.
  for(let dx = -R; dx <= R; dx++){
    for(let dz = -R; dz <= R; dz++){
      for(let dy = -1; dy <= 4; dy++){
        const wx = wrapC(x + dx), wz = wrapC(z + dz), wy = y + dy;
        if(wy < 1 || wy >= WH) continue;
        const edge = Math.abs(dx) === R || Math.abs(dz) === R || dy === -1 || dy === 4;
        const corner = Math.abs(dx) === R && Math.abs(dz) === R;
        if(edge) put(wx, wy, wz, corner ? 13 : (dy === -1 ? 13 : 14)); // bricks / mossy
        else put(wx, wy, wz, 0);
      }
    }
  }
  // A low plinth for it to rest on, so it is the obvious focal point.
  put(x, y, z, 13);
  return site;
}

/** Drop the Cube into the world at a position (vault, or where a Bearer died). */
export function layAt(x, y, z){
  return drops.spawn(CUBE_ITEM, 1, x, y, z);
}

/** Is the Cube loose in the world right now? */
export function looseInWorld(){
  return drops.serialize().some(d => d[1] === CUBE_ITEM);
}

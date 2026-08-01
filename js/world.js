// world.js — chunked block storage + seeded, deterministic generation
export const WORLD = 2048, WH = 48, CH = 16, CHUNKS = WORLD/CH, CENTER = WORLD/2;
// Sparse chunk storage — null until ensureChunk() generates it (streaming)
export const chunks = new Array(CHUNKS * CHUNKS).fill(null);
/** TEMP test flag — set false / remove markers later */
export const DEBUG_MARKERS = true;
export let seed = 0;

// Deterministic RNG — every device generates the identical world from the same seed
export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const wrapC = v => ((v % WORLD) + WORLD) % WORLD;
export const cIndex = (cx,cz)=>cx + cz*CHUNKS;
export const bIndex = (lx,y,lz)=>lx + lz*CH + y*CH*CH;

export function ensureChunk(cx, cz){
  cx = ((cx % CHUNKS) + CHUNKS) % CHUNKS;
  cz = ((cz % CHUNKS) + CHUNKS) % CHUNKS;
  const i = cIndex(cx, cz);
  if(!chunks[i]){
    chunks[i] = new Uint8Array(CH * CH * WH);
    fillChunk(cx, cz, chunks[i]);
  }
  return chunks[i];
}
export function getBlock(x,y,z){
  if(y<0||y>=WH) return 0;
  x = wrapC(x); z = wrapC(z);
  const ch = ensureChunk(x>>4, z>>4);
  return ch[bIndex(x&15, y, z&15)];
}
export function setBlock(x,y,z,t){
  if(y<0||y>=WH) return;
  x = wrapC(x); z = wrapC(z);
  const ch = ensureChunk(x>>4, z>>4);
  ch[bIndex(x&15, y, z&15)] = t;
}
// glass (9) doesn't hide its neighbours
export const occludes = (x,y,z)=>{ const b = getBlock(x,y,z); return b!==0 && b!==9 && b!==10 && b!==44 && !doorStyleOf(b) && b!==63 && b!==58 && b!==65; };
// walk-through: air, torch, ladder, open doors (52-55)
export const isWalkThrough = b => !b || b===10 || b===44 || doorOpen(b) || b===63 || b===58 || b===65;
// Door styles occupy 8-type bands: base..base+3 closed facing, base+4..base+7 open
export const DOOR_STYLES = [
  { id:0, base:48, item:48, name:'Oak Door' },
  { id:1, base:70, item:70, name:'Dark Door' },
  { id:2, base:78, item:78, name:'Glass Door' },
  { id:3, base:86, item:86, name:'Iron Door' },
];
export function doorStyleOf(b){
  for(const s of DOOR_STYLES) if(b>=s.base && b<s.base+8) return s;
  return null;
}
export const isDoor = b => !!doorStyleOf(b);
export const doorFacing = b => { const s=doorStyleOf(b); return s ? (b-s.base)%4 : 0; };
export const doorOpen = b => { const s=doorStyleOf(b); return s ? (b-s.base)>=4 : false; };
export const doorType = (styleId, facing, open) => {
  const s = DOOR_STYLES[styleId] || DOOR_STYLES[0];
  return s.base + (facing&3) + (open?4:0);
};
export const doorItemOf = b => doorStyleOf(b)?.item ?? 48;

export const isBed = b => b===58 || b===65;
// bed foot facing: stored in a weak side-channel via head offset; mesh uses bedFacing map in render


// Frequencies are exact multiples of 2π/WORLD so terrain tiles seamlessly at the wrap seam
const F = n => Math.PI*2*n/WORLD;
export function heightAt(x,z){
  // surface raised to ~24 in v1.5.5 — old (v1) saves are migrated by shifting edits +16
  return Math.floor(24 + 3*Math.sin(x*F(16))*Math.cos(z*F(15)) + 1.5*Math.sin((x-z)*F(9)) + Math.cos((x+z)*F(6)));
}
export const sandy = (x,z)=>Math.sin(x*F(4)+3)*Math.cos(z*F(4)) > .55;

export function topY(x,z){
  for(let y=WH-1;y>=0;y--) if(getBlock(x,y,z)) return y;
  return -1;
}

export function generateWorld(s){
  seed = s;
  // Do NOT allocate the full 2048² — chunks generate on demand via ensureChunk
  for(let i = 0; i < CHUNKS * CHUNKS; i++) chunks[i] = null;
}

/** Deterministic per-chunk terrain (same formulas as the old full-world gen). */
function fillChunk(cx, cz, chunk){
  const x0 = cx * CH, z0 = cz * CH;
  const co = [];
  const cr = mulberry32(seed ^ 0x51ab);
  for(let i = 0; i < 9; i++) co.push(cr() * Math.PI * 2);

  for(let lx = 0; lx < CH; lx++) for(let lz = 0; lz < CH; lz++){
    const x = x0 + lx, z = z0 + lz;
    const h = heightAt(x, z), sd = sandy(x, z);
    for(let y = 0; y <= h; y++){
      chunk[bIndex(lx, y, lz)] = sd ? (y > h - 3 ? 6 : 3) : (y === h ? 1 : y > h - 3 ? 2 : 3);
    }
    const mouth = Math.sin(x * .021 + co[7]) * Math.sin(z * .019 + co[8]) > .60;
    const yCap = mouth ? h : h - 4;
    for(let y = 2; y <= yCap; y++){
      const w1 = Math.sin(x * .07 + y * .115 + co[0]) + Math.sin(z * .083 - y * .056 + co[1]);
      const w2 = Math.sin(x * .052 - z * .064 + co[2]) + Math.sin(y * .142 + x * .031 + co[3]);
      const tunnel = Math.abs(w1) < .45 && Math.abs(w2) < .5;
      const pocket = Math.sin(x * .043 + co[4]) * Math.sin(y * .087 + co[5]) * Math.sin(z * .048 + co[6]) > .72;
      if(tunnel || pocket) chunk[bIndex(lx, y, lz)] = 0;
    }
  }

  // Ore — density scaled so total ≈ old 512 world when fully explored
  const orng = mulberry32((seed ^ 0x08e5) + cx * 734287 + cz * 912391);
  const veinSpecs = [[45, 3, 10, 22], [46, 2, 4, 15], [47, 1, 2, 9]]; // id, attempts, yMin, yMax
  for(const [oid, attempts, y0, y1] of veinSpecs){
    for(let i = 0; i < attempts; i++){
      let x = x0 + Math.floor(orng() * CH);
      let z = z0 + Math.floor(orng() * CH);
      let y = y0 + Math.floor(orng() * (y1 - y0 + 1));
      const size = 2 + Math.floor(orng() * 3);
      for(let b = 0; b < size; b++){
        if(x >= x0 && x < x0 + CH && z >= z0 && z < z0 + CH && y >= 1 && y < WH){
          const lx = x & 15, lz = z & 15;
          if(chunk[bIndex(lx, y, lz)] === 3) chunk[bIndex(lx, y, lz)] = oid;
        }
        const d = Math.floor(orng() * 6);
        x += d === 0 ? 1 : d === 1 ? -1 : 0;
        y += d === 2 ? 1 : d === 3 ? -1 : 0;
        z += d === 4 ? 1 : d === 5 ? -1 : 0;
        if(y < 1 || y >= WH) break;
      }
    }
  }

  // Trees — ~0.7 per chunk average (matches old density)
  const trng = mulberry32((seed ^ 0xc2a5) + cx * 19349663 + cz * 83492791);
  const treeCount = trng() < 0.55 ? 1 : trng() < 0.25 ? 2 : 0;
  for(let t = 0; t < treeCount; t++){
    const lx = 2 + Math.floor(trng() * (CH - 4));
    const lz = 2 + Math.floor(trng() * (CH - 4));
    const x = x0 + lx, z = z0 + lz;
    // surface height from already-filled column
    let h = 0;
    for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]){ h = y; break; }
    if(chunk[bIndex(lx, h, lz)] !== 1) continue;
    const th = 4 + Math.floor(trng() * 3);
    for(let dy = 1; dy <= th; dy++) if(h + dy < WH) chunk[bIndex(lx, h + dy, lz)] = 4;
    for(let dy = th - 1; dy <= th + 1; dy++)
      for(let dx = -2; dx <= 2; dx++) for(let dz = -2; dz <= 2; dz++){
        if(Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        const nx = lx + dx, nz = lz + dz, ny = h + dy;
        if(nx < 0 || nx >= CH || nz < 0 || nz >= CH || ny >= WH) continue;
        if(!chunk[bIndex(nx, ny, nz)]) chunk[bIndex(nx, ny, nz)] = 5;
      }
  }

  // Ruins — rare, deterministic per chunk (~14 per 512² → similar density)
  const rrng = mulberry32((seed ^ 0x5a1d) + cx * 48271 + cz * 11909);
  if(rrng() < 0.0018){
    const lx0 = 1 + Math.floor(rrng() * (CH - 8));
    const lz0 = 1 + Math.floor(rrng() * (CH - 8));
    const w = 5 + Math.floor(rrng() * 3), dpt = 4 + Math.floor(rrng() * 3);
    let h = 0;
    for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx0, y, lz0)]){ h = y; break; }
    const ht = 2 + Math.floor(rrng() * 2);
    for(let dx = 0; dx < w && lx0 + dx < CH; dx++)
      for(let dz = 0; dz < dpt && lz0 + dz < CH; dz++){
        chunk[bIndex(lx0 + dx, h - 1, lz0 + dz)] = 7;
        for(let dy = 0; dy < ht; dy++){
          const wall = dx === 0 || dx === w - 1 || dz === 0 || dz === dpt - 1;
          if(!wall) continue;
          if(dx === 2 && dz === 0 && dy < 2) continue;
          if(rrng() < .25) continue;
          const win = dy === 1 && (dx === 0 || dx === w - 1) && dz === 2;
          if(h + dy < WH) chunk[bIndex(lx0 + dx, h + dy, lz0 + dz)] = win ? 9 : 8;
        }
      }
  }
}

/** TEMP: pillars every 256 blocks so you can read distance in-world. Remove later with DEBUG_MARKERS. */
export function placeDebugMarkers(){
  if(!DEBUG_MARKERS) return;
  const step = 256;
  const marks = [];
  for(let a = 0; a < WORLD; a += step) marks.push(a);
  // Gold-ish = 45 (crystal?) use brick 8 and glow torch 10, ladder 44 as markers
  // Prefer highly visible: type 8 brick tower + 10 torch + 9 glass tip
  const buildPillar = (x, z, labelAxis) => {
    x = wrapC(x); z = wrapC(z);
    const h = heightAt(x, z);
    for(let y = 1; y <= 12; y++){
      const yy = h + y;
      if(yy >= WH) break;
      // stripe pattern by height so pillars are unique-ish
      let t = 8; // brick
      if(y % 4 === 0) t = 11; // if exists else brick
      // use wool-like: 7 planks band, 8 brick, 45 ore band for color
      if(y <= 2) t = 7;
      else if(y <= 6) t = 8;
      else if(y <= 10) t = 45;
      else t = 9;
      setBlock(x, yy, z, t === 11 ? 8 : t);
    }
    // torch on top
    const top = Math.min(h + 13, WH - 1);
    setBlock(x, top, z, 10);
    // small arm pointing which axis (extra block on +X or +Z)
    if(labelAxis === 'x') setBlock(wrapC(x + 1), h + 6, z, 46);
    else setBlock(x, h + 6, wrapC(z + 1), 47);
  };
  // X-axis line at z = CENTER
  for(const x of marks) buildPillar(x, CENTER, 'x');
  // Z-axis line at x = CENTER
  for(const z of marks) buildPillar(CENTER, z, 'z');
  // Origin special: double height
  const ox = CENTER, oz = CENTER;
  const h = heightAt(ox, oz);
  for(let y = 1; y <= 18; y++){
    const yy = h + y;
    if(yy >= WH) break;
    setBlock(ox, yy, oz, y < 14 ? 45 : 9);
  }
  setBlock(ox, Math.min(h + 19, WH - 1), oz, 10);
}


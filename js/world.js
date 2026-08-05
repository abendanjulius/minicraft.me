// world.js — chunked block storage + seeded, deterministic generation
export const WORLD = 2048, WH = 48, CH = 16, CHUNKS = WORLD/CH, CENTER = WORLD/2;
// Sparse chunk storage — null until ensureChunk() generates it (streaming)
export const chunks = new Array(CHUNKS * CHUNKS).fill(null);
/** TEMP test flag — set false / remove markers later */
export const DEBUG_MARKERS = false;
export let seed = 0;
/** @type {{x:number,z:number,bio:number,kind:string,key:string}[]} */
export const villageSites = [];

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
export const occludes = (x,y,z)=>{ const b = getBlock(x,y,z); return b!==0 && b!==9 && b!==10 && b!==44 && !doorStyleOf(b) && b!==63 && b!==58 && b!==65 && b!==64 && b!==66 && b!==67 && b!==68 && b!==69; };
// walk-through: air, torch, ladder, open doors (52-55)
export const isWalkThrough = b => !b || b===10 || b===44 || doorOpen(b) || b===63 || b===58 || b===65 || b===64 || b===66 || b===67 || b===68 || b===69;
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
/** Biome ids: 0 plains · 1 forest · 2 desert · 3 mountains · 4 swamp */
export function biomeAt(x, z){
  const elev = Math.sin(x*F(8))*Math.cos(z*F(7)) + 0.5*Math.sin((x+z)*F(3));
  const moist = Math.sin(x*F(5)+1.7)*Math.cos(z*F(6)-0.4) + 0.4*Math.sin(x*F(2)-z*F(2));
  if(elev > 0.85) return 3;             // mountains
  if(moist < -0.55 && elev < 0.35) return 2; // desert
  if(moist > 0.55 && elev < 0.25) return 4;  // swamp
  if(moist > 0.15) return 1;            // forest
  return 0;                             // plains
}
export function heightAt(x,z){
  const base = 24 + 3*Math.sin(x*F(16))*Math.cos(z*F(15)) + 1.5*Math.sin((x-z)*F(9)) + Math.cos((x+z)*F(6));
  const b = biomeAt(x, z);
  if(b === 3) return Math.floor(base + 6 + 4*Math.sin(x*F(22))*Math.cos(z*F(19))); // peaks
  if(b === 4) return Math.floor(base - 2); // lower wetlands
  if(b === 2) return Math.floor(base - 0.5);
  return Math.floor(base);
}
export const sandy = (x,z)=> biomeAt(x,z) === 2 || (Math.sin(x*F(4)+3)*Math.cos(z*F(4)) > .55 && biomeAt(x,z) !== 4);
export const BIOME_NAME = ['Plains','Forest','Desert','Mountains','Swamp'];

export function topY(x,z){
  for(let y=WH-1;y>=0;y--) if(getBlock(x,y,z)) return y;
  return -1;
}
/** Highest solid (non–walk-through) block — use for feet on ground (ignores grass, flowers, water, torches). */
export function surfaceY(x,z){
  x = Math.round(x); z = Math.round(z);
  for(let y = WH - 1; y >= 0; y--){
    const b = getBlock(x, y, z);
    if(b && !isWalkThrough(b)) return y;
  }
  return -1;
}
/** World Y for an entity whose model feet are at local y ≈ 0. */
export function feetY(x, z){
  const s = surfaceY(x, z);
  return s < 0 ? 24.5 : s + 0.5; // top face of solid block
}

export function generateWorld(s){
  seed = s;
  villageSites.length = 0;
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
    const h = heightAt(x, z), bio = biomeAt(x, z), sd = sandy(x, z);
    for(let y = 0; y <= h; y++){
      if(bio === 2 || sd){
        chunk[bIndex(lx, y, lz)] = y > h - 3 ? 6 : 3; // desert sand
      } else if(bio === 3){
        // mountains: stone near surface, sparse grass
        if(y === h && h < 30) chunk[bIndex(lx, y, lz)] = 1;
        else if(y === h) chunk[bIndex(lx, y, lz)] = 3;
        else if(y > h - 3) chunk[bIndex(lx, y, lz)] = 3;
        else chunk[bIndex(lx, y, lz)] = 3;
      } else if(bio === 4){
        // swamp: dirt/grass, later water
        chunk[bIndex(lx, y, lz)] = y === h ? 1 : y > h - 2 ? 2 : 3;
      } else {
        chunk[bIndex(lx, y, lz)] = y === h ? 1 : y > h - 3 ? 2 : 3;
      }
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

  // Trees — varied shapes (oak blob / tall / wide), ~0.7–1.2 per chunk
  const trng = mulberry32((seed ^ 0xc2a5) + cx * 19349663 + cz * 83492791);
  const bioC = biomeAt(x0 + 8, z0 + 8);
  let treeChance = 0.4, treeMax = 2;
  if(bioC === 1){ treeChance = 0.88; treeMax = 5; }
  else if(bioC === 0){ treeChance = 0.32; treeMax = 2; }
  else if(bioC === 3){ treeChance = 0.22; treeMax = 1; }
  else if(bioC === 4){ treeChance = 0.28; treeMax = 2; }
  else if(bioC === 2){ treeChance = 0.02; treeMax = 1; }
  const treeCount = trng() < treeChance ? 1 + Math.floor(trng() * treeMax) : 0;

  // log/leaf pairs: oak=4/5, birch=94/98, spruce=95/99, acacia=96/100, dark=97/101
  const putLeaf = (nx, ny, nz, leafId) => {
    if(nx < 0 || nx >= CH || nz < 0 || nz >= CH || ny < 0 || ny >= WH) return;
    if(!chunk[bIndex(nx, ny, nz)]) chunk[bIndex(nx, ny, nz)] = leafId;
  };
  const putLog = (nx, ny, nz, logId) => {
    if(nx < 0 || nx >= CH || nz < 0 || nz >= CH || ny < 0 || ny >= WH) return;
    chunk[bIndex(nx, ny, nz)] = logId;
  };

  for(let t = 0; t < treeCount; t++){
    const lx = 4 + Math.floor(trng() * (CH - 8));
    const lz = 4 + Math.floor(trng() * (CH - 8));
    let h = 0;
    for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]){ h = y; break; }
    if(chunk[bIndex(lx, h, lz)] !== 1) continue;
    if(h + 10 >= WH) continue;

    // Pick species by biome (Minecraft-like)
    // 0 oak, 1 spruce, 2 birch, 3 jungle, 4 acacia, 5 dark oak
    let species;
    if(bioC === 2) species = 4; // desert → acacia
    else if(bioC === 3) species = 1; // mountains → spruce
    else if(bioC === 4) species = trng() < 0.5 ? 1 : 0; // swamp spruce/oak
    else if(bioC === 1){ // forest mix
      const r = trng();
      species = r < 0.35 ? 0 : r < 0.55 ? 2 : r < 0.7 ? 1 : r < 0.85 ? 3 : 5;
    } else { // plains
      const r = trng();
      species = r < 0.55 ? 0 : r < 0.85 ? 2 : 1;
    }

    if(species === 0){
      // OAK — short trunk, round canopy
      const th = 4 + Math.floor(trng() * 2);
      for(let dy = 1; dy <= th; dy++) putLog(lx, h+dy, lz, 4);
      for(let dy = th-2; dy <= th+1; dy++){
        const rad = dy >= th ? 1 : 2;
        for(let dx=-rad; dx<=rad; dx++) for(let dz=-rad; dz<=rad; dz++){
          if(Math.abs(dx)===rad && Math.abs(dz)===rad && rad>1) continue;
          putLeaf(lx+dx, h+dy, lz+dz, 5);
        }
      }
    } else if(species === 1){
      // SPRUCE — tall narrow trunk, layered cone
      const th = 7 + Math.floor(trng() * 4);
      for(let dy = 1; dy <= th; dy++) putLog(lx, h+dy, lz, 95);
      for(let layer = 0; layer < 6; layer++){
        const rad = Math.max(0, 3 - Math.floor(layer * 0.55));
        const ny = h + th - 4 + layer;
        if(ny >= WH) break;
        for(let dx=-rad; dx<=rad; dx++) for(let dz=-rad; dz<=rad; dz++){
          if(rad>=2 && Math.abs(dx)===rad && Math.abs(dz)===rad) continue;
          if(Math.abs(dx)+Math.abs(dz) > rad+1) continue;
          putLeaf(lx+dx, ny, lz+dz, 99);
        }
      }
      putLeaf(lx, h+th+1, lz, 99);
    } else if(species === 2){
      // BIRCH — thin tall trunk, small high canopy
      const th = 5 + Math.floor(trng() * 3);
      for(let dy = 1; dy <= th; dy++) putLog(lx, h+dy, lz, 94);
      for(let dy = th-1; dy <= th+1; dy++){
        const rad = dy === th+1 ? 1 : 2;
        for(let dx=-rad; dx<=rad; dx++) for(let dz=-rad; dz<=rad; dz++){
          if(Math.abs(dx)===rad && Math.abs(dz)===rad) continue;
          putLeaf(lx+dx, h+dy, lz+dz, 98);
        }
      }
    } else if(species === 3){
      // JUNGLE — very tall trunk, bushy top (and maybe small vines as leaves down)
      const th = 8 + Math.floor(trng() * 4);
      for(let dy = 1; dy <= th; dy++) putLog(lx, h+dy, lz, 4);
      for(let dy = th-2; dy <= th+2; dy++)
        for(let dx=-3; dx<=3; dx++) for(let dz=-3; dz<=3; dz++){
          if(Math.abs(dx)+Math.abs(dz)+Math.abs(dy-(th)) > 5) continue;
          if(Math.abs(dx)===3 && Math.abs(dz)===3) continue;
          putLeaf(lx+dx, h+dy, lz+dz, 5);
        }
    } else if(species === 4){
      // ACACIA — forked trunk, flat umbrella canopy
      const th = 4 + Math.floor(trng() * 2);
      for(let dy = 1; dy <= th; dy++) putLog(lx, h+dy, lz, 96);
      // fork
      const dir = trng() < 0.5 ? 1 : -1;
      putLog(lx+dir, h+th, lz, 96);
      putLog(lx+dir*2, h+th+1, lz, 96);
      const cx2 = lx + dir*2, cy2 = h + th + 1;
      for(let dx=-3; dx<=3; dx++) for(let dz=-3; dz<=3; dz++){
        if(Math.abs(dx)+Math.abs(dz) > 4) continue;
        if(Math.abs(dx)===3 && Math.abs(dz)===3) continue;
        putLeaf(cx2+dx, cy2, lz+dz, 100);
        if(Math.abs(dx)+Math.abs(dz) <= 2) putLeaf(cx2+dx, cy2+1, lz+dz, 100);
      }
    } else {
      // DARK OAK — thick 2×2 trunk, wide dense canopy
      const th = 5 + Math.floor(trng() * 2);
      for(let dy = 1; dy <= th; dy++){
        putLog(lx, h+dy, lz, 97);
        putLog(lx+1, h+dy, lz, 97);
        putLog(lx, h+dy, lz+1, 97);
        putLog(lx+1, h+dy, lz+1, 97);
      }
      const cx2 = lx, cz2 = lz;
      for(let dy = th-1; dy <= th+1; dy++)
        for(let dx=-3; dx<=4; dx++) for(let dz=-3; dz<=4; dz++){
          if(Math.abs(dx-0.5)+Math.abs(dz-0.5) > 4.5) continue;
          putLeaf(cx2+dx, h+dy, cz2+dz, 101);
        }
    }
  }

  // Prune any leaf with no log nearby (kills true floaters from edge cases)
  for(let lx = 0; lx < CH; lx++) for(let lz = 0; lz < CH; lz++) for(let y = 1; y < WH; y++){
    const leafHere = chunk[bIndex(lx, y, lz)]; if(leafHere!==5&&leafHere!==98&&leafHere!==99&&leafHere!==100&&leafHere!==101) continue;
    let nearLog = false;
    for(let dy = -3; dy <= 3 && !nearLog; dy++)
      for(let dx = -3; dx <= 3 && !nearLog; dx++)
        for(let dz = -3; dz <= 3; dz++){
          const nx = lx + dx, ny = y + dy, nz = lz + dz;
          if(nx < 0 || nx >= CH || nz < 0 || nz >= CH || ny < 0 || ny >= WH) continue;
          const bb = chunk[bIndex(nx, ny, nz)]; if(bb===4||bb===94||bb===95||bb===96||bb===97){ nearLog = true; break; }
        }
    if(!nearLog) chunk[bIndex(lx, y, lz)] = 0;
  }

  // Water pools in low grass basins
  {
    let sumH = 0, nH = 0;
    for(let lx = 0; lx < CH; lx++) for(let lz = 0; lz < CH; lz++){
      let h = 0;
      for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]){ h = y; break; }
      sumH += h; nH++;
    }
    const avgH = sumH / Math.max(1, nH);
    for(let lx = 0; lx < CH; lx++) for(let lz = 0; lz < CH; lz++){
      let h = 0;
      for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]){ h = y; break; }
      const bio = biomeAt(x0 + lx, z0 + lz);
      if(bio === 2) continue; // no desert lakes
      const thr = bio === 4 ? avgH - 0.5 : avgH - 2; // swamps flood more
      if(h <= thr && h >= 6 && (chunk[bIndex(lx, h, lz)] === 1 || chunk[bIndex(lx, h, lz)] === 2)){
        chunk[bIndex(lx, h, lz)] = 64;
        if(h - 1 >= 1) chunk[bIndex(lx, h - 1, lz)] = 64;
        if(bio === 4 && h - 2 >= 1) chunk[bIndex(lx, h - 2, lz)] = 64;
        if(h - 2 >= 1 && chunk[bIndex(lx, h - 2, lz)] === 3) chunk[bIndex(lx, h - 2, lz)] = 2;
      }
    }
  }

  // Surface decoration: tall grass + flowers on grass (not under trees)
  const prng = mulberry32((seed ^ 0x91a55) + cx * 2654435761 + cz * 1597334677);
  for(let lx = 1; lx < CH - 1; lx++) for(let lz = 1; lz < CH - 1; lz++){
    let h = 0;
    for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]){ h = y; break; }
    if(chunk[bIndex(lx, h, lz)] !== 1) continue;
    if(h + 1 >= WH) continue;
    if(chunk[bIndex(lx, h + 1, lz)]) continue;
    const bio = biomeAt(x0 + lx, z0 + lz);
    if(bio === 2) continue; // barren desert
    const r = prng();
    const grassP = bio === 0 ? 0.26 : bio === 1 ? 0.1 : bio === 4 ? 0.2 : 0.06;
    const flowerP = bio === 0 ? 0.14 : 0.03;
    if(r < grassP) chunk[bIndex(lx, h + 1, lz)] = 66;
    else if(r < grassP + flowerP * 0.35) chunk[bIndex(lx, h + 1, lz)] = 67;
    else if(r < grassP + flowerP * 0.7) chunk[bIndex(lx, h + 1, lz)] = 68;
    else if(r < grassP + flowerP) chunk[bIndex(lx, h + 1, lz)] = 69
  }


  // ---- Eldercube villages (biome-unique, deterministic) ----
  // Chance per chunk; builds a small settlement that fits in this chunk.
  {
    const vrng = mulberry32((seed ^ 0x71a9e) + cx * 374761 + cz * 668265);
    const bio = biomeAt(x0 + 8, z0 + 8);
    // Mountains: no full villages (too steep). Others: rare.
    // ~1 village per ~32×32 chunk region (~512 blocks) — Minecraft-like spacing
    const REGION = 32;
    const cellX = Math.floor(cx / REGION), cellZ = Math.floor(cz / REGION);
    const cellRng = mulberry32((seed ^ 0x51a1e) + cellX * 374761 + cellZ * 668265);
    // Pick one chunk near the middle of the region so neighbors don't cluster
    const pickX = 10 + Math.floor(cellRng() * 12);
    const pickZ = 10 + Math.floor(cellRng() * 12);
    const isVillageChunk = ((cx % REGION + REGION) % REGION === pickX)
                        && ((cz % REGION + REGION) % REGION === pickZ);
    const chance = (!isVillageChunk || bio === 3) ? 0 : 0.7;
    if(vrng() < chance){
      const put = (lx, y, lz, t) => {
        if(lx < 1 || lx >= CH-1 || lz < 1 || lz >= CH-1 || y < 0 || y >= WH) return;
        chunk[bIndex(lx, y, lz)] = t;
      };
      const surfaceY = (lx, lz) => {
        for(let y = WH - 1; y >= 0; y--) if(chunk[bIndex(lx, y, lz)]) return y;
        return 20;
      };
      // Flatten a small pad for the village
      const ox = 1, oz = 1, pad = 14; // near full-chunk village footprint
      let sum = 0, cnt = 0;
      for(let lx = ox; lx < ox + pad; lx++) for(let lz = oz; lz < oz + pad; lz++){
        sum += surfaceY(lx, lz); cnt++;
      }
      const base = Math.max(6, Math.min(WH - 10, Math.round(sum / cnt)));
      for(let lx = ox; lx < ox + pad; lx++) for(let lz = oz; lz < oz + pad; lz++){
        for(let y = 0; y < WH; y++){
          if(y < base - 2) put(lx, y, lz, 3);
          else if(y < base) put(lx, y, lz, 2);
          else if(y === base) put(lx, y, lz, bio === 2 ? 15 : 21); // sandstone path or path
          else put(lx, y, lz, 0);
        }
      }

      // Helper: simple box house
      const house = (hx, hz, w, d, wall, floor, roof, doorFacing) => {
        // floor
        for(let lx = hx; lx < hx + w; lx++) for(let lz = hz; lz < hz + d; lz++) put(lx, base, lz, floor);
        // walls 2 high + roof
        for(let lx = hx; lx < hx + w; lx++) for(let lz = hz; lz < hz + d; lz++){
          const edge = lx === hx || lx === hx+w-1 || lz === hz || lz === hz+d-1;
          if(!edge) continue;
          put(lx, base+1, lz, wall);
          put(lx, base+2, lz, wall);
        }
        // doorway on chosen side
        if(doorFacing === 0){ put(hx + (w>>1), base+1, hz, 0); put(hx + (w>>1), base+2, hz, 0); }
        if(doorFacing === 2){ put(hx + (w>>1), base+1, hz+d-1, 0); put(hx + (w>>1), base+2, hz+d-1, 0); }
        if(doorFacing === 1){ put(hx, base+1, hz + (d>>1), 0); put(hx, base+2, hz + (d>>1), 0); }
        if(doorFacing === 3){ put(hx+w-1, base+1, hz + (d>>1), 0); put(hx+w-1, base+2, hz + (d>>1), 0); }
        // roof slab layer
        for(let lx = hx; lx < hx + w; lx++) for(let lz = hz; lz < hz + d; lz++)
          put(lx, base+3, lz, roof);
        // torch on front
        if(doorFacing === 0) put(hx + (w>>1), base+2, hz - 0, 10);
      };

      let vKind = 'market';
      if(bio === 0){
        vKind = 'market';
        // PLAINS — Coin Market: roads, well, 4 houses, stalls, farm plots
        // Cross roads
        for(let i = 0; i < pad; i++){
          put(ox + i, base, oz + 6, 21);
          put(ox + i, base, oz + 7, 21);
          put(ox + 6, base, oz + i, 21);
          put(ox + 7, base, oz + i, 21);
        }
        // Central well
        put(ox+6, base, oz+6, 13); put(ox+7, base, oz+6, 13);
        put(ox+6, base, oz+7, 13); put(ox+7, base, oz+7, 13);
        put(ox+6, base+1, oz+6, 13);
        // Four houses at corners of the cross
        house(ox+1, oz+1, 4, 4, 7, 7, 8, 2);   // NW, door south
        house(ox+9, oz+1, 4, 4, 7, 7, 8, 2);   // NE
        house(ox+1, oz+9, 4, 4, 7, 7, 8, 0);   // SW, door north
        house(ox+9, oz+9, 4, 4, 7, 7, 8, 0);   // SE
        // Market stalls along road
        for(const [sx,sz] of [[ox+4,oz+4],[ox+8,oz+4],[ox+4,oz+9],[ox+8,oz+9]]){
          put(sx, base+1, sz, 7); put(sx+1, base+1, sz, 7);
          put(sx, base+2, sz, 28); put(sx+1, base+2, sz, 29);
          put(sx, base+3, sz, 10);
        }
        // Farm plots (dirt + wheat-look: tall grass)
        for(let i = 0; i < 3; i++) for(let j = 0; j < 2; j++){
          put(ox+2+i, base, oz+12+j, 2);
          if(base+1 < WH) put(ox+2+i, base+1, oz+12+j, 66);
        }
        // Lamp posts
        put(ox+5, base+1, oz+5, 4); put(ox+5, base+2, oz+5, 10);
        put(ox+8, base+1, oz+8, 4); put(ox+8, base+2, oz+8, 10);
        // Sign post
        put(ox+3, base+1, oz+7, 4);
        put(ox+3, base+2, oz+7, 4);
        put(ox+3, base+3, oz+7, 32);
            } else if(bio === 2){
        vKind = 'outpost';
        // DESERT — "Dune Outpost": sandstone keep + courtyard
        // Main keep
        house(ox+4, oz+4, 6, 6, 15, 15, 15, 0);
        // Wall ring
        for(let i = 0; i < pad; i++){
          put(ox+i, base+1, oz, 15); put(ox+i, base+2, oz, 15);
          put(ox+i, base+1, oz+pad-1, 15); put(ox+i, base+2, oz+pad-1, 15);
          put(ox, base+1, oz+i, 15); put(ox, base+2, oz+i, 15);
          put(ox+pad-1, base+1, oz+i, 15); put(ox+pad-1, base+2, oz+i, 15);
        }
        // Gate
        put(ox+6, base+1, oz, 0); put(ox+7, base+1, oz, 0);
        put(ox+6, base+2, oz, 0); put(ox+7, base+2, oz, 0);
        // Corner towers
        for(const [tx,tz] of [[ox,oz],[ox+pad-1,oz],[ox,oz+pad-1],[ox+pad-1,oz+pad-1]]){
          put(tx, base+3, tz, 15); put(tx, base+4, tz, 10);
        }
        // Storage
        put(ox+10, base+1, oz+5, 56); put(ox+10, base+1, oz+6, 56);
        put(ox+3, base+1, oz+10, 56);
      } else if(bio === 1){
        vKind = 'haven';
        // FOREST — "Log Haven": twin cabins + fence + firepit
        house(ox+1, oz+1, 4, 4, 4, 7, 5, 2);
        house(ox+9, oz+1, 4, 4, 4, 7, 5, 2);
        house(ox+5, oz+8, 4, 4, 4, 7, 5, 0);
        // Path between cabins
        for(let i = 3; i < 11; i++){ put(ox+i, base, oz+5, 21); put(ox+i, base, oz+6, 21); }
        // Fence
        for(let i = 0; i < pad; i++){
          if(i < 5 || i > 8){
            put(ox+i, base+1, oz, 11);
            put(ox+i, base+1, oz+pad-1, 11);
          }
        }
        // Firepit center
        put(ox+6, base, oz+5, 8); put(ox+7, base, oz+5, 8);
        put(ox+6, base, oz+6, 8); put(ox+7, base, oz+6, 8);
        put(ox+6, base+1, oz+5, 10);
        // Benches
        put(ox+4, base+1, oz+5, 4); put(ox+9, base+1, oz+5, 4);
      } else if(bio === 4){
        vKind = 'stilt';
        // SWAMP — "Stilt Rest": raised plank platform + stilts
        for(let lx = ox+1; lx < ox+pad-1; lx++) for(let lz = oz+1; lz < oz+pad-1; lz++){
          put(lx, base+2, lz, 7); // raised floor
        }
        // Stilts
        for(const [sx,sz] of [[ox+1,oz+1],[ox+6,oz+1],[ox+1,oz+6],[ox+6,oz+6],[ox+3,oz+3]]){
          put(sx, base+1, sz, 4);
          put(sx, base, sz, 4);
        }
        // Hut on stilts
        house(ox+2, oz+2, 4, 4, 18, 7, 19, 0); // dark planks + thatch
        // Fix house to sit on raised floor: walls from base+3
        for(let lx = ox+2; lx < ox+6; lx++) for(let lz = oz+2; lz < oz+6; lz++){
          const edge = lx===ox+2||lx===ox+5||lz===oz+2||lz===oz+5;
          if(edge){
            put(lx, base+3, lz, 18);
            put(lx, base+4, lz, 18);
          }
          put(lx, base+5, lz, 19); // thatch roof
        }
        put(ox+3, base+3, oz+2, 0); put(ox+3, base+4, oz+2, 0); // door
        put(ox+4, base+3, oz+5, 10); // torch
        // Dock plank
        for(let i=0;i<3;i++) put(ox+3+i, base+2, oz+7, 7);
      } else {
        vKind = 'market';
        house(ox+2, oz+2, 4, 4, 7, 7, 7, 0);
      }
      // Register for villager spawning
      const vx = x0 + ox + 4, vz = z0 + oz + 4;
      villageSites.push({ x: vx, z: vz, bio, kind: vKind, key: cx+','+cz });
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
  // Only near spawn band so boot stays fast (full 2k line was too heavy)
  const marks = [];
  for(let a = CENTER - 512; a <= CENTER + 512; a += step) marks.push(wrapC(a));
  const buildPillar = (x, z, labelAxis) => {
    x = wrapC(x); z = wrapC(z);
    const h = heightAt(x, z);
    for(let y = 1; y <= 12; y++){
      const yy = h + y;
      if(yy >= WH) break;
      let t = 8;
      if(y <= 2) t = 7;
      else if(y <= 6) t = 8;
      else if(y <= 10) t = 45;
      else t = 9;
      setBlock(x, yy, z, t);
    }
    setBlock(x, Math.min(h + 13, WH - 1), z, 10);
    if(labelAxis === 'x') setBlock(wrapC(x + 1), h + 6, z, 46);
    else setBlock(x, h + 6, wrapC(z + 1), 47);
  };
  for(const x of marks){
    if(x === CENTER) continue; // leave spawn column empty
    buildPillar(x, CENTER, 'x');
  }
  for(const z of marks){
    if(z === CENTER) continue;
    buildPillar(CENTER, z, 'z');
  }
  // Origin marker offset so player is not buried inside it
  const ox = wrapC(CENTER + 3), oz = wrapC(CENTER + 3);
  const h = heightAt(ox, oz);
  for(let y = 1; y <= 18; y++){
    const yy = h + y;
    if(yy >= WH) break;
    setBlock(ox, yy, oz, y < 14 ? 45 : 9);
  }
  setBlock(ox, Math.min(h + 19, WH - 1), oz, 10);

  // Clear a small spawn pad at true center
  const sh = heightAt(CENTER, CENTER);
  for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){
    const sx = wrapC(CENTER + dx), sz = wrapC(CENTER + dz);
    for(let y = sh + 1; y <= sh + 4; y++) if(y < WH) setBlock(sx, y, sz, 0);
  }
}


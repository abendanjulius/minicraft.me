// world.js — chunked block storage + seeded, deterministic generation
export const WORLD = 512, WH = 48, CH = 16, CHUNKS = WORLD/CH, CENTER = WORLD/2;
export const chunks = new Array(CHUNKS*CHUNKS);
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

export function getBlock(x,y,z){
  if(y<0||y>=WH) return 0;
  x = wrapC(x); z = wrapC(z);
  return chunks[cIndex(x>>4, z>>4)][bIndex(x&15, y, z&15)];
}
export function setBlock(x,y,z,t){
  if(y<0||y>=WH) return;
  x = wrapC(x); z = wrapC(z);
  chunks[cIndex(x>>4, z>>4)][bIndex(x&15, y, z&15)] = t;
}
// glass (9) doesn't hide its neighbours
export const occludes = (x,y,z)=>{ const b = getBlock(x,y,z); return b!==0 && b!==9 && b!==10 && b!==44 && b!==49 && b!==51; };
// blocks players/zombies can walk through
export const isWalkThrough = b => !b || b===10 || b===44 || b===49 || b===51;

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
  const rng = mulberry32(s);
  for(let i=0;i<CHUNKS*CHUNKS;i++) chunks[i] = new Uint8Array(CH*CH*WH);

  // Terrain + cave carving (deterministic trig-noise worms & pockets)
  const co = []; const cr = mulberry32(s ^ 0x51ab);
  for(let i=0;i<9;i++) co.push(cr()*Math.PI*2);
  for(let x=0;x<WORLD;x++)for(let z=0;z<WORLD;z++){
    const h = heightAt(x,z), sd = sandy(x,z);
    const chunk = chunks[cIndex(x>>4, z>>4)], lx = x&15, lz = z&15;
    for(let y=0;y<=h;y++){
      chunk[bIndex(lx,y,lz)] = sd ? (y>h-3?6:3) : (y===h?1 : y>h-3?2 : 3);
    }
    // carve: two intersecting worm fields + occasional pockets; mouths breach the surface
    const mouth = Math.sin(x*.021+co[7])*Math.sin(z*.019+co[8]) > .60;
    const yCap = mouth ? h : h-4;
    for(let y=2;y<=yCap;y++){
      const w1 = Math.sin(x*.07 + y*.115 + co[0]) + Math.sin(z*.083 - y*.056 + co[1]);
      const w2 = Math.sin(x*.052 - z*.064 + co[2]) + Math.sin(y*.142 + x*.031 + co[3]);
      const tunnel = Math.abs(w1)<.45 && Math.abs(w2)<.5;
      const pocket = Math.sin(x*.043+co[4])*Math.sin(y*.087+co[5])*Math.sin(z*.048+co[6]) > .72;
      if(tunnel || pocket) chunk[bIndex(lx,y,lz)] = 0;
    }
  }
  // Ore veins (separate rng stream so tree/ruin layouts stay stable across versions)
  const orng = mulberry32(s ^ 0x08e5);
  const veins = [[45, 2600, 10, 22], [46, 1500, 4, 15], [47, 550, 2, 9]]; // id, count, yMin, yMax
  for(const [oid, count, y0, y1] of veins){
    for(let i=0;i<count;i++){
      let x = Math.floor(orng()*WORLD), z = Math.floor(orng()*WORLD);
      let y = y0 + Math.floor(orng()*(y1-y0+1));
      const size = 2 + Math.floor(orng()*3);
      for(let b=0;b<size;b++){
        if(getBlock(x,y,z)===3) setBlock(x,y,z,oid);
        const d = Math.floor(orng()*6);
        x += d===0?1:d===1?-1:0; y += d===2?1:d===3?-1:0; z += d===4?1:d===5?-1:0;
        x = wrapC(x); z = wrapC(z);
        if(y<1||y>=WH) break;
      }
    }
  }
  // Trees — seeded so all players get identical forests
  for(let i=0;i<900;i++){
    const tx = 3+Math.floor(rng()*(WORLD-6)), tz = 3+Math.floor(rng()*(WORLD-6));
    if((Math.abs(tx-CENTER)<4 && Math.abs(tz-CENTER)<4) || sandy(tx,tz)) continue;
    const h = heightAt(tx,tz);
    for(let y=h+1;y<=h+4;y++) setBlock(tx,y,tz,4);
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let dy=4;dy<=5;dy++)
      if(!(dx===0&&dz===0&&dy===4)) setBlock(tx+dx,h+dy,tz+dz,5);
  }
  // Abandoned ruins: plank floor, brick walls, glass windows — house materials
  for(let i=0;i<70;i++){
    const rx = 8+Math.floor(rng()*(WORLD-20)), rz = 8+Math.floor(rng()*(WORLD-20));
    const gapRoll = []; for(let g=0;g<60;g++) gapRoll.push(rng()); // draw rolls even if skipped, keeps rng aligned
    if(Math.abs(rx-CENTER)<8 && Math.abs(rz-CENTER)<8) continue;
    const h = heightAt(rx,rz)+1, w = 5, dpt = 4, ht = 3;
    let roll = 0;
    for(let dx=0;dx<w;dx++)for(let dz=0;dz<dpt;dz++){
      setBlock(rx+dx, h-1, rz+dz, 7);
      for(let dy=0;dy<ht;dy++){
        const wall = dx===0||dx===w-1||dz===0||dz===dpt-1;
        if(!wall) continue;
        if(dx===2 && dz===0 && dy<2) continue;             // doorway
        if(gapRoll[roll++ % 60] < .25) continue;           // ruined gaps
        const win = dy===1 && (dx===0||dx===w-1) && dz===2;
        setBlock(rx+dx, h+dy, rz+dz, win?9:8);
      }
    }
  }
}

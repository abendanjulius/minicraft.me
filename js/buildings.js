// buildings.js — large-scale voxel landmarks for the Builder bot
// Aimed at recognizable real-world silhouettes (huge but buildable).

const STONE = 3, DIRT = 1, LOG = 4, PLANK = 7, BRICK = 8, GLASS = 9, TORCH = 10;
const SBRICK = 13, MOSSY = 14, SAND = 15, QUARTZ = 16, IRON = 23;

/** @returns {{id:string,name:string,icon:string,desc:string}[]} */
export function listBuildings(){
  return [
    {id:'eiffel', name:'Eiffel Tower', icon:'🗼', desc:'Paris — lattice iron tower ~324m'},
    {id:'burj', name:'Burj Khalifa', icon:'🏙️', desc:'Dubai — Y-plan skyscraper ~828m'},
    {id:'pyramid', name:'Great Pyramid', icon:'🔺', desc:'Giza — stepped limestone pyramid'},
    {id:'colosseum', name:'Colosseum', icon:'🏛️', desc:'Rome — elliptical amphitheatre'},
    {id:'bigben', name:'Big Ben', icon:'🕰️', desc:'London — Elizabeth Tower + clock'},
    {id:'statue', name:'Statue of Liberty', icon:'🗽', desc:'NYC — pedestal + torch figure'},
    {id:'taj', name:'Taj Mahal', icon:'🕌', desc:'Agra — white marble mausoleum'},
    {id:'sydney', name:'Sydney Opera', icon:'🐚', desc:'Sydney — shell roof halls'},
  ];
}

export function blueprint(id){
  switch(id){
    case 'eiffel': return eiffel();
    case 'burj': return burj();
    case 'pyramid': return pyramid();
    case 'colosseum': return colosseum();
    case 'bigben': return bigBen();
    case 'statue': return statue();
    case 'taj': return taj();
    case 'sydney': return sydney();
    default: return eiffel();
  }
}

function push(B, x, y, z, id){
  B.push([x|0, y|0, z|0, id]);
}
function dedupe(B){
  const seen = new Set();
  const out = [];
  for(const b of B){
    const k = b[0]+','+b[1]+','+b[2];
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

// ───────────────── Eiffel Tower ─────────────────
// Real: four legs, two main platforms, tapering shaft, top antenna.
function eiffel(){
  const B = [];
  const H = 96; // ~scale model height in blocks
  // Four arched legs from base to first platform (~y 28)
  const legBase = 18;
  for(let y = 0; y < 28; y++){
    const t = y / 28;
    const spread = Math.max(3, Math.floor(legBase * (1 - t * 0.72)));
    const thick = y < 8 ? 2 : 1;
    for(const [sx, sz] of [[-1,-1],[-1,1],[1,-1],[1,1]]){
      for(let tx = -thick; tx <= thick; tx++){
        for(let tz = -thick; tz <= thick; tz++){
          if(Math.abs(tx)+Math.abs(tz) > thick + 1) continue;
          push(B, sx * spread + tx, y, sz * spread + tz, IRON);
        }
      }
      // diagonal lattice struts
      if(y % 3 === 0){
        for(let i = 1; i < spread; i += 2){
          push(B, sx * i, y, sz * spread, IRON);
          push(B, sx * spread, y, sz * i, IRON);
        }
      }
    }
    // arches between legs near base
    if(y >= 4 && y <= 12){
      const arch = legBase - Math.floor((y - 4) * 1.2);
      for(let a = -arch; a <= arch; a++){
        if(Math.abs(a) > arch - 2){
          push(B, a, y, -spread, IRON);
          push(B, a, y, spread, IRON);
          push(B, -spread, y, a, IRON);
          push(B, spread, y, a, IRON);
        }
      }
    }
  }
  // First platform deck
  for(let dx = -10; dx <= 10; dx++)
    for(let dz = -10; dz <= 10; dz++)
      if(Math.abs(dx) > 6 || Math.abs(dz) > 6 || Math.abs(dx)+Math.abs(dz) > 12)
        push(B, dx, 28, dz, IRON);
  // Mid shaft to second platform
  for(let y = 29; y < 55; y++){
    const t = (y - 29) / 26;
    const spread = Math.max(2, Math.floor(8 * (1 - t * 0.55)));
    for(const [sx, sz] of [[-1,-1],[-1,1],[1,-1],[1,1]]){
      push(B, sx * spread, y, sz * spread, IRON);
      push(B, sx * spread, y, 0, IRON);
      push(B, 0, y, sz * spread, IRON);
    }
    if(y % 4 === 0){
      for(let i = -spread; i <= spread; i++){
        push(B, i, y, -spread, IRON);
        push(B, i, y, spread, IRON);
        push(B, -spread, y, i, IRON);
        push(B, spread, y, i, IRON);
      }
    }
  }
  // Second platform
  for(let dx = -5; dx <= 5; dx++)
    for(let dz = -5; dz <= 5; dz++)
      if(Math.abs(dx)===5||Math.abs(dz)===5||Math.abs(dx)+Math.abs(dz)>6)
        push(B, dx, 55, dz, IRON);
  // Upper taper + top
  for(let y = 56; y < H; y++){
    const t = (y - 56) / (H - 56);
    const r = Math.max(0, Math.floor(3 * (1 - t)));
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        if(Math.abs(dx)===r||Math.abs(dz)===r||r===0)
          push(B, dx, y, dz, IRON);
  }
  for(let y = H; y < H + 10; y++) push(B, 0, y, 0, IRON);
  return {name:'Eiffel Tower', blocks: dedupe(B)};
}

// ───────────────── Burj Khalifa ─────────────────
// Real: triple-lobed Y footprint, setbacks, needle spire.
function burj(){
  const B = [];
  const H = 140;
  // Three lobes at 120°
  const lobes = [0, 2.094, 4.189];
  for(let y = 0; y < H; y++){
    const t = y / H;
    // setback tiers
    let wing = 12;
    if(t > 0.15) wing = 10;
    if(t > 0.28) wing = 8;
    if(t > 0.42) wing = 7;
    if(t > 0.55) wing = 5;
    if(t > 0.68) wing = 4;
    if(t > 0.80) wing = 3;
    if(t > 0.90) wing = 2;
    if(t > 0.96) wing = 1;
    const mat = (y % 8 === 0) ? GLASS : SBRICK;
    const glassBand = (y % 8 === 1 || y % 8 === 2);
    // core
    for(let dx = -2; dx <= 2; dx++)
      for(let dz = -2; dz <= 2; dz++)
        push(B, dx, y, dz, glassBand ? GLASS : SBRICK);
    // lobes
    for(const ang of lobes){
      for(let r = 3; r <= wing; r++){
        const x = Math.round(Math.cos(ang) * r);
        const z = Math.round(Math.sin(ang) * r);
        // lobe width shrinks with radius
        const half = Math.max(1, Math.floor(3 * (1 - r / (wing + 1))));
        for(let w = -half; w <= half; w++){
          const px = Math.round(x + Math.cos(ang + Math.PI/2) * w);
          const pz = Math.round(z + Math.sin(ang + Math.PI/2) * w);
          push(B, px, y, pz, glassBand ? GLASS : mat);
        }
      }
    }
  }
  // Spire
  for(let y = H; y < H + 28; y++){
    const r = y < H + 12 ? 1 : 0;
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        push(B, dx, y, dz, IRON);
  }
  return {name:'Burj Khalifa', blocks: dedupe(B)};
}

// ───────────────── Great Pyramid ─────────────────
// Khufu-ish smooth steps, ~51° visual slope, casing edge.
function pyramid(){
  const B = [];
  const base = 51; // odd footprint
  const half = (base - 1) >> 1;
  const H = half + 1;
  for(let y = 0; y < H; y++){
    const r = half - y;
    for(let dx = -r; dx <= r; dx++){
      for(let dz = -r; dz <= r; dz++){
        const edge = Math.abs(dx) === r || Math.abs(dz) === r;
        const fill = Math.abs(dx) < r - 1 && Math.abs(dz) < r - 1;
        // solid mass with denser core, sandstone shell
        if(edge) push(B, dx, y, dz, SAND);
        else if(y === 0 || !fill || (dx*dx+dz*dz) % 5 === 0)
          push(B, dx, y, dz, y < 2 ? STONE : SAND);
      }
    }
  }
  // Capstone
  push(B, 0, H, 0, QUARTZ);
  return {name:'Great Pyramid', blocks: dedupe(B)};
}

// ───────────────── Colosseum ─────────────────
// Ellipse, 4 storeys, arched rings, inner arena wall.
function colosseum(){
  const B = [];
  const RX = 28, RZ = 22; // outer radii
  const rx = 18, rz = 14; // inner arena
  const H = 22;
  for(let y = 0; y < H; y++){
    const tier = y < 6 ? 0 : y < 12 ? 1 : y < 17 ? 2 : 3;
    const outerMat = tier === 3 ? BRICK : SBRICK;
    for(let a = 0; a < 120; a++){
      const ang = (a / 120) * Math.PI * 2;
      // outer ring
      const ox = Math.round(Math.cos(ang) * RX);
      const oz = Math.round(Math.sin(ang) * RZ);
      // arches: leave gaps on lower tiers
      const archGap = (tier < 3 && a % 5 === 2 && (y % 6 === 2 || y % 6 === 3));
      if(!archGap){
        push(B, ox, y, oz, outerMat);
        // thickness
        const ox2 = Math.round(Math.cos(ang) * (RX - 1));
        const oz2 = Math.round(Math.sin(ang) * (RZ - 1));
        push(B, ox2, y, oz2, outerMat);
      } else {
        push(B, ox, y, oz, GLASS); // open arch read
      }
      // inner wall (lower)
      if(y < 10){
        const ix = Math.round(Math.cos(ang) * rx);
        const iz = Math.round(Math.sin(ang) * rz);
        push(B, ix, y, iz, STONE);
      }
    }
    // radial walls every so often
    if(y < 12){
      for(let a = 0; a < 12; a++){
        const ang = (a / 12) * Math.PI * 2;
        for(let r = rx; r <= RX - 1; r++){
          push(B, Math.round(Math.cos(ang)*r), y, Math.round(Math.sin(ang)*r*(RZ/RX)), SBRICK);
        }
      }
    }
  }
  // Arena floor
  for(let dx = -rx + 2; dx <= rx - 2; dx++)
    for(let dz = -rz + 2; dz <= rz - 2; dz++)
      if((dx*dx)/(rx*rx)+(dz*dz)/(rz*rz) < 0.85)
        push(B, dx, 0, dz, DIRT);
  return {name:'Colosseum', blocks: dedupe(B)};
}

// ───────────────── Big Ben (Elizabeth Tower) ─────────────────
function bigBen(){
  const B = [];
  const H = 64;
  // Shaft
  for(let y = 0; y < H - 14; y++){
    for(let dx = -3; dx <= 3; dx++)
      for(let dz = -3; dz <= 3; dz++){
        const edge = Math.abs(dx)===3||Math.abs(dz)===3;
        if(edge || y === 0)
          push(B, dx, y, dz, SBRICK);
        // windows
        if(edge && y > 8 && y % 7 === 0 && (dx===0||dz===0))
          push(B, dx, y, dz, GLASS);
      }
  }
  // Clock section (wider)
  for(let y = H - 14; y < H - 6; y++){
    for(let dx = -4; dx <= 4; dx++)
      for(let dz = -4; dz <= 4; dz++){
        const edge = Math.abs(dx)===4||Math.abs(dz)===4;
        if(edge) push(B, dx, y, dz, SBRICK);
        // clock faces
        if(y === H - 10){
          if(dx === 4 && Math.abs(dz) <= 2) push(B, dx, y, dz, GLASS);
          if(dx === -4 && Math.abs(dz) <= 2) push(B, dx, y, dz, GLASS);
          if(dz === 4 && Math.abs(dx) <= 2) push(B, dx, y, dz, GLASS);
          if(dz === -4 && Math.abs(dx) <= 2) push(B, dx, y, dz, GLASS);
        }
      }
    // fill floor of belfry
    if(y === H - 14)
      for(let dx = -3; dx <= 3; dx++)
        for(let dz = -3; dz <= 3; dz++)
          push(B, dx, y, dz, PLANK);
  }
  // Pyramidal roof + spire
  for(let y = 0; y < 6; y++){
    const r = 3 - Math.floor(y / 2);
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        if(Math.abs(dx)===r||Math.abs(dz)===r||r===0)
          push(B, dx, H - 6 + y, dz, BRICK);
  }
  for(let y = H; y < H + 8; y++) push(B, 0, y, 0, IRON);
  return {name:'Big Ben', blocks: dedupe(B)};
}

// ───────────────── Statue of Liberty ─────────────────
function statue(){
  const B = [];
  // Star pedestal base
  for(let y = 0; y < 4; y++)
    for(let dx = -10; dx <= 10; dx++)
      for(let dz = -10; dz <= 10; dz++){
        const man = Math.abs(dx)+Math.abs(dz);
        if(man <= 12 - y && (man >= 10 - y || y === 0))
          push(B, dx, y, dz, STONE);
      }
  // Pedestal
  for(let y = 4; y < 18; y++)
    for(let dx = -5; dx <= 5; dx++)
      for(let dz = -5; dz <= 5; dz++){
        const edge = Math.abs(dx)===5||Math.abs(dz)===5;
        if(edge || y === 4) push(B, dx, y, dz, SBRICK);
        if(edge && y > 6 && y % 4 === 0 && (dx===0||dz===0))
          push(B, dx, y, dz, GLASS);
      }
  // Feet / robe base
  for(let y = 18; y < 24; y++)
    for(let dx = -3; dx <= 3; dx++)
      for(let dz = -2; dz <= 2; dz++)
        push(B, dx, y, dz, QUARTZ);
  // Body / robe
  for(let y = 24; y < 42; y++){
    const r = y < 36 ? 3 : 2;
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        if(dx*dx+dz*dz <= r*r+1) push(B, dx, y, dz, QUARTZ);
  }
  // Raised arm
  for(let i = 0; i < 14; i++){
    const y = 36 + Math.floor(i * 0.7);
    const x = 3 + Math.floor(i * 0.45);
    push(B, x, y, 0, QUARTZ);
    push(B, x, y + 1, 0, QUARTZ);
  }
  // Torch
  push(B, 9, 48, 0, IRON);
  push(B, 9, 49, 0, TORCH);
  push(B, 9, 50, 0, TORCH);
  // Head + crown spikes
  for(let y = 42; y < 47; y++)
    for(let dx = -2; dx <= 2; dx++)
      for(let dz = -2; dz <= 2; dz++)
        if(dx*dx+dz*dz <= 5) push(B, dx, y, dz, QUARTZ);
  for(let i = 0; i < 7; i++){
    const ang = (i / 7) * Math.PI * 2;
    push(B, Math.round(Math.cos(ang)*3), 47, Math.round(Math.sin(ang)*3), QUARTZ);
    push(B, Math.round(Math.cos(ang)*4), 48, Math.round(Math.sin(ang)*4), QUARTZ);
  }
  // Tablet in other arm
  for(let y = 30; y < 36; y++)
    for(let z = 2; z <= 4; z++)
      push(B, -3, y, z, QUARTZ);
  return {name:'Statue of Liberty', blocks: dedupe(B)};
}

// ───────────────── Taj Mahal ─────────────────
function taj(){
  const B = [];
  // Charbagh platform
  for(let dx = -22; dx <= 22; dx++)
    for(let dz = -22; dz <= 22; dz++){
      push(B, dx, 0, dz, QUARTZ);
      if(Math.abs(dx)===22||Math.abs(dz)===22) push(B, dx, 1, dz, QUARTZ);
    }
  // Reflecting pool strip
  for(let z = -18; z <= -4; z++)
    for(let x = -2; x <= 2; x++)
      push(B, x, 1, z, GLASS);
  // Main plinth
  for(let dx = -12; dx <= 12; dx++)
    for(let dz = -12; dz <= 12; dz++)
      push(B, dx, 2, dz, QUARTZ);
  // Main building walls
  for(let y = 3; y <= 14; y++)
    for(let dx = -8; dx <= 8; dx++)
      for(let dz = -8; dz <= 8; dz++){
        const edge = Math.abs(dx)===8||Math.abs(dz)===8;
        if(!edge) continue;
        // big arched portals
        const portal =
          (Math.abs(dx)===8 && Math.abs(dz) < 3 && y >= 5 && y <= 11) ||
          (Math.abs(dz)===8 && Math.abs(dx) < 3 && y >= 5 && y <= 11);
        push(B, dx, y, dz, portal ? GLASS : QUARTZ);
      }
  // Floor inside
  for(let dx = -7; dx <= 7; dx++)
    for(let dz = -7; dz <= 7; dz++)
      push(B, dx, 3, dz, QUARTZ);
  // Onion dome
  for(let y = 0; y <= 12; y++){
    let r;
    if(y < 3) r = 5 + y;
    else if(y < 8) r = 8 - (y - 3);
    else r = Math.max(0, 3 - (y - 8));
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        if(dx*dx+dz*dz <= r*r+1) push(B, dx, 15 + y, dz, QUARTZ);
  }
  push(B, 0, 28, 0, IRON);
  // Four minarets
  for(const [mx, mz] of [[-18,-18],[-18,18],[18,-18],[18,18]]){
    for(let y = 2; y <= 26; y++){
      for(let dx = -1; dx <= 1; dx++)
        for(let dz = -1; dz <= 1; dz++)
          if(Math.abs(dx)===1||Math.abs(dz)===1||y%5===0)
            push(B, mx+dx, y, mz+dz, QUARTZ);
    }
    for(let y = 27; y <= 30; y++) push(B, mx, y, mz, QUARTZ);
  }
  // Corner chhatris on main roof
  for(const [cx, cz] of [[-7,-7],[-7,7],[7,-7],[7,7]]){
    for(let y = 15; y <= 18; y++)
      for(let dx = -1; dx <= 1; dx++)
        for(let dz = -1; dz <= 1; dz++)
          push(B, cx+dx, y, cz+dz, QUARTZ);
  }
  return {name:'Taj Mahal', blocks: dedupe(B)};
}

// ───────────────── Sydney Opera House ─────────────────
function sydney(){
  const B = [];
  // Podium / platform over water feel
  for(let dx = -20; dx <= 20; dx++)
    for(let dz = -12; dz <= 12; dz++)
      push(B, dx, 0, dz, QUARTZ);
  for(let dx = -20; dx <= 20; dx++)
    for(let dz = -12; dz <= 12; dz++)
      if(Math.abs(dx)===20||Math.abs(dz)===12) push(B, dx, 1, dz, QUARTZ);

  // Series of shell vaults along X — ribbed spherical caps
  const shells = [
    {ox:-12, oz:-2, rx:9, rz:8, h:14},
    {ox:-4,  oz:0,  rx:10,rz:9, h:16},
    {ox:6,   oz:1,  rx:9, rz:8, h:15},
    {ox:14,  oz:-1, rx:7, rz:7, h:11},
    // side shells
    {ox:-10, oz:6,  rx:6, rz:5, h:9},
    {ox:2,   oz:7,  rx:7, rz:5, h:10},
  ];
  for(const s of shells){
    for(let y = 1; y <= s.h; y++){
      const t = y / s.h;
      // rising then closing shell profile
      const scale = Math.sin(t * Math.PI);
      const rx = Math.max(1, Math.floor(s.rx * scale));
      const rz = Math.max(1, Math.floor(s.rz * scale));
      for(let dx = -rx; dx <= rx; dx++)
        for(let dz = -rz; dz <= rz; dz++){
          const nx = dx / (rx || 1), nz = dz / (rz || 1);
          if(nx*nx + nz*nz > 1.05) continue;
          // shell surface only (hollow)
          if(nx*nx + nz*nz > 0.72 || y < 3)
            push(B, s.ox + dx, y + 1, s.oz + dz, y < 3 ? QUARTZ : GLASS);
        }
    }
  }
  // Glass foyer wall facing “harbour”
  for(let x = -8; x <= 8; x++)
    for(let y = 2; y <= 7; y++)
      push(B, x, y, -11, GLASS);
  return {name:'Sydney Opera House', blocks: dedupe(B)};
}

// ──── Creative doodles (unchanged role, slightly richer) ────
export function randomCreative(){
  const pick = Math.floor(Math.random() * 4);
  if(pick === 0) return towerCreative();
  if(pick === 1) return houseCreative();
  if(pick === 2) return spiralCreative();
  return wallCreative();
}
function towerCreative(){
  const B = [], H = 12 + (Math.random() * 16)|0;
  for(let y = 0; y < H; y++){
    const r = y < 3 ? 2 : 1;
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        push(B, dx, y, dz, y % 3 === 0 ? BRICK : PLANK);
  }
  return {name:'Creative Tower', blocks: dedupe(B)};
}
function houseCreative(){
  const B = [];
  for(let y = 0; y < 5; y++)
    for(let dx = -4; dx <= 4; dx++)
      for(let dz = -4; dz <= 4; dz++){
        const wall = Math.abs(dx)===4||Math.abs(dz)===4;
        if(y === 0 || wall) push(B, dx, y, dz, PLANK);
        if(wall && y === 2 && (dx===0||dz===0)) push(B, dx, y, dz, GLASS);
      }
  for(let dx = -5; dx <= 5; dx++)
    for(let dz = -5; dz <= 5; dz++)
      if(Math.abs(dx)+Math.abs(dz) < 8) push(B, dx, 5, dz, LOG);
  return {name:'Creative House', blocks: dedupe(B)};
}
/** Walk from the centre out to (tx,tz) one axis at a time, so every cell is
 *  face-adjacent to the previous one (diagonal steps leave unsupported gaps). */
function armPath(tx, tz){
  const out = [];
  let x = 0, z = 0;
  while(x !== tx || z !== tz){
    if(Math.abs(tx - x) >= Math.abs(tz - z)) x += Math.sign(tx - x);
    else z += Math.sign(tz - z);
    out.push([x, z]);
  }
  return out;
}

/** A spiral STAIRCASE: central pillar + connected steps winding around it.
 *  The old version placed one block per level on a rotating radius, so no two
 *  blocks ever touched — 36 floating dots that couldn't be built in Nightfall. */
function spiralCreative(){
  const B = [];
  const H = 24, R = 4, PER_TURN = 8;
  for(let y = 0; y < H; y++){
    push(B, 0, y, 0, SBRICK);                       // central pillar
    const ang = (y % PER_TURN) * (Math.PI * 2 / PER_TURN);
    const tx = Math.round(Math.cos(ang) * R);
    const tz = Math.round(Math.sin(ang) * R);
    const arm = armPath(tx, tz);
    arm.forEach(([x, z], i) => push(B, x, y, z, i === arm.length - 1 ? PLANK : SBRICK));
    // a lamp on the outer end every half turn, so it reads at night
    if(y % 4 === 0 && arm.length) push(B, tx, y + 1, tz, TORCH);
  }
  push(B, 0, H, 0, TORCH);                          // beacon on top
  return {name:'Creative Spiral', blocks: dedupe(B)};
}
function wallCreative(){
  const B = [];
  for(let x = -10; x <= 10; x++)
    for(let y = 0; y < 6; y++)
      push(B, x, y, 0, y===5 ? BRICK : SBRICK);
  return {name:'Creative Wall', blocks: dedupe(B)};
}

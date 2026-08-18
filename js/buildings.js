// buildings.js — voxel blueprints for the Builder bot profile
// Coordinates are relative to a ground origin (0,0,0) = center of footprint on surface.

/** @returns {{id:string,name:string,icon:string,desc:string}[]} */
export function listBuildings(){
  return [
    {id:'eiffel', name:'Eiffel Tower', icon:'🗼', desc:'Iron lattice tower (Paris)'},
    {id:'burj', name:'Burj Khalifa', icon:'🏙️', desc:'Tall needle skyscraper (Dubai)'},
    {id:'pyramid', name:'Great Pyramid', icon:'🔺', desc:'Stepped pyramid (Giza)'},
    {id:'colosseum', name:'Colosseum', icon:'🏛️', desc:'Oval arena (Rome)'},
    {id:'bigben', name:'Big Ben', icon:'🕰️', desc:'Clock tower (London)'},
    {id:'statue', name:'Statue of Liberty', icon:'🗽', desc:'Torch-bearing figure (NYC)'},
    {id:'taj', name:'Taj Mahal', icon:'🕌', desc:'Domed mausoleum (Agra)'},
    {id:'sydney', name:'Sydney Opera', icon:'🐚', desc:'Shell roofs (Sydney)'},
  ];
}

/**
 * Build a list of [dx, dy, dz, blockId] relative placements.
 * Block ids: 3 stone, 7 planks, 8 brick, 9 glass, 13 stone bricks, 23 iron, 1 dirt, 4 log
 */
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

function push(blocks, x, y, z, id){
  blocks.push([x|0, y|0, z|0, id]);
}

function eiffel(){
  const B = [];
  const H = 36;
  // Four legs tapering to center
  for(let y = 0; y < H; y++){
    const t = y / H;
    const spread = Math.max(1, Math.floor(8 * (1 - t * 0.92)));
    const mat = y > H * 0.85 ? 23 : 13;
    for(const [sx, sz] of [[-1,-1],[-1,1],[1,-1],[1,1]]){
      push(B, sx * spread, y, sz * spread, mat);
      if(spread > 2){
        push(B, sx * spread, y, 0, mat);
        push(B, 0, y, sz * spread, mat);
      }
    }
    // cross braces every few levels
    if(y % 4 === 0 && spread > 2){
      for(let i = -spread; i <= spread; i++){
        push(B, i, y, -spread, 23);
        push(B, i, y, spread, 23);
        push(B, -spread, y, i, 23);
        push(B, spread, y, i, 23);
      }
    }
  }
  // tip
  for(let y = H; y < H + 4; y++) push(B, 0, y, 0, 23);
  return {name:'Eiffel Tower', blocks: B};
}

function burj(){
  const B = [];
  const H = 48;
  for(let y = 0; y < H; y++){
    const t = y / H;
    // stepped setbacks
    let r = 4;
    if(t > 0.25) r = 3;
    if(t > 0.5) r = 2;
    if(t > 0.72) r = 1;
    if(t > 0.9) r = 0;
    const mat = (y % 7 === 0) ? 9 : 13;
    for(let dx = -r; dx <= r; dx++){
      for(let dz = -r; dz <= r; dz++){
        if(Math.abs(dx) === r || Math.abs(dz) === r || r === 0){
          push(B, dx, y, dz, mat);
        }
      }
    }
  }
  for(let y = H; y < H + 6; y++) push(B, 0, y, 0, 23);
  return {name:'Burj Khalifa', blocks: B};
}

function pyramid(){
  const B = [];
  const base = 15; // odd
  const half = (base - 1) >> 1;
  for(let y = 0; y <= half; y++){
    const r = half - y;
    for(let dx = -r; dx <= r; dx++){
      for(let dz = -r; dz <= r; dz++){
        if(Math.abs(dx) === r || Math.abs(dz) === r || y === 0){
          push(B, dx, y, dz, 3);
        }
      }
    }
  }
  return {name:'Great Pyramid', blocks: B};
}

function colosseum(){
  const B = [];
  const R = 10, r = 7, H = 8;
  for(let y = 0; y < H; y++){
    for(let a = 0; a < 64; a++){
      const ang = (a / 64) * Math.PI * 2;
      const x = Math.round(Math.cos(ang) * R);
      const z = Math.round(Math.sin(ang) * R);
      push(B, x, y, z, y === H - 1 ? 8 : 13);
      if(y < 3){
        const xi = Math.round(Math.cos(ang) * r);
        const zi = Math.round(Math.sin(ang) * r);
        push(B, xi, y, zi, 13);
      }
    }
    // arches every few columns on outer ring
    if(y === 2 || y === 5){
      for(let a = 0; a < 16; a++){
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * R);
        const z = Math.round(Math.sin(ang) * R);
        // leave gap by not placing — already placed solid; skip is hard, use glass as arch feel
        push(B, x, y, z, 9);
      }
    }
  }
  return {name:'Colosseum', blocks: B};
}

function bigBen(){
  const B = [];
  const H = 28;
  for(let y = 0; y < H; y++){
    const r = y < H - 6 ? 2 : 1;
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        push(B, dx, y, dz, 13);
  }
  // clock faces
  const cy = H - 8;
  push(B, 3, cy, 0, 9); push(B, -3, cy, 0, 9);
  push(B, 0, cy, 3, 9); push(B, 0, cy, -3, 9);
  // spire
  for(let y = H; y < H + 5; y++) push(B, 0, y, 0, 8);
  return {name:'Big Ben', blocks: B};
}

function statue(){
  const B = [];
  // pedestal
  for(let y = 0; y < 6; y++)
    for(let dx = -3; dx <= 3; dx++)
      for(let dz = -3; dz <= 3; dz++)
        if(Math.abs(dx)===3||Math.abs(dz)===3||y===0) push(B, dx, y, dz, 13);
  // body
  for(let y = 6; y < 16; y++)
    for(let dx = -1; dx <= 1; dx++)
      for(let dz = -1; dz <= 1; dz++)
        push(B, dx, y, dz, 8);
  // head
  for(let y = 16; y < 19; y++)
    for(let dx = -1; dx <= 1; dx++)
      for(let dz = -1; dz <= 1; dz++)
        push(B, dx, y, dz, 8);
  // arm + torch
  for(let i = 0; i < 6; i++) push(B, 2 + (i>3?1:0), 12 + i, 0, 8);
  push(B, 4, 18, 0, 10); // torch
  return {name:'Statue of Liberty', blocks: B};
}

function taj(){
  const B = [];
  // platform
  for(let dx = -8; dx <= 8; dx++)
    for(let dz = -8; dz <= 8; dz++)
      push(B, dx, 0, dz, 13);
  // main cube
  for(let y = 1; y <= 6; y++)
    for(let dx = -4; dx <= 4; dx++)
      for(let dz = -4; dz <= 4; dz++)
        if(Math.abs(dx)===4||Math.abs(dz)===4) push(B, dx, y, dz, 13);
  // dome
  for(let y = 7; y <= 11; y++){
    const r = Math.max(0, 3 - (y - 7));
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        if(dx*dx+dz*dz <= r*r+1) push(B, dx, y, dz, 13);
  }
  // minarets
  for(const [mx,mz] of [[-7,-7],[-7,7],[7,-7],[7,7]]){
    for(let y = 1; y <= 10; y++) push(B, mx, y, mz, 13);
  }
  return {name:'Taj Mahal', blocks: B};
}

function sydney(){
  const B = [];
  // base
  for(let dx = -6; dx <= 6; dx++)
    for(let dz = -4; dz <= 4; dz++)
      push(B, dx, 0, dz, 13);
  // shell arches
  for(let s = 0; s < 3; s++){
    const ox = -4 + s * 4;
    for(let i = 0; i <= 8; i++){
      const t = i / 8;
      const y = Math.round(Math.sin(t * Math.PI) * (6 + s));
      const z = Math.round((t - 0.5) * 6);
      push(B, ox, y, z, 9);
      push(B, ox + 1, y, z, 9);
    }
  }
  return {name:'Sydney Opera House', blocks: B};
}

/** Lightweight random “creative” doodles — returns a small blueprint. */
export function randomCreative(){
  const pick = Math.floor(Math.random() * 4);
  if(pick === 0) return towerCreative();
  if(pick === 1) return houseCreative();
  if(pick === 2) return spiralCreative();
  return wallCreative();
}

function towerCreative(){
  const B = [], H = 8 + (Math.random() * 12)|0;
  for(let y = 0; y < H; y++){
    const r = y < 2 ? 2 : 1;
    for(let dx = -r; dx <= r; dx++)
      for(let dz = -r; dz <= r; dz++)
        push(B, dx, y, dz, y % 3 === 0 ? 8 : 7);
  }
  return {name:'Creative Tower', blocks: B};
}

function houseCreative(){
  const B = [];
  for(let y = 0; y < 4; y++)
    for(let dx = -3; dx <= 3; dx++)
      for(let dz = -3; dz <= 3; dz++){
        const wall = Math.abs(dx)===3||Math.abs(dz)===3;
        if(y === 0 || wall) push(B, dx, y, dz, y===0 ? 7 : 7);
        if(wall && y === 2 && (dx===0||dz===0)) push(B, dx, y, dz, 9);
      }
  for(let dx = -4; dx <= 4; dx++)
    for(let dz = -4; dz <= 4; dz++)
      if(Math.abs(dx)+Math.abs(dz) < 6) push(B, dx, 4, dz, 4);
  return {name:'Creative House', blocks: B};
}

function spiralCreative(){
  const B = [];
  for(let i = 0; i < 24; i++){
    const ang = i * 0.55;
    const r = 2 + i * 0.08;
    push(B, Math.round(Math.cos(ang)*r), i, Math.round(Math.sin(ang)*r), 13);
  }
  return {name:'Creative Spiral', blocks: B};
}

function wallCreative(){
  const B = [];
  for(let x = -6; x <= 6; x++)
    for(let y = 0; y < 5; y++)
      push(B, x, y, 0, y===4 ? 8 : 13);
  return {name:'Creative Wall', blocks: B};
}

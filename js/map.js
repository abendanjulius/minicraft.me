// map.js — the claim map. Press M.
//
// "7.3% claimed" is an abstract number; the payoff of permanence is *seeing* the
// territory. This is nearly free to draw: the claim bitmap is already a 512×512
// grid, so it renders straight to a canvas at 1px per cell.
import * as claim from './claim.js';
import * as keepstones from './keepstones.js';
import { villageSites, WORLD } from './world.js';

let el = null, cv = null, open = false;

function build(){
  if(el) return;
  el = document.createElement('div');
  el.id = 'claimMap';
  el.style.cssText = 'position:fixed;inset:0;z-index:60;display:none;align-items:center;' +
    'justify-content:center;flex-direction:column;gap:10px;background:rgba(8,11,26,.92);' +
    'backdrop-filter:blur(2px);color:#e8ecf8;font-family:monospace;text-align:center';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;letter-spacing:1px;color:#ffca8a';
  title.id = 'claimMapTitle';

  cv = document.createElement('canvas');
  cv.width = cv.height = claim.GRID;
  cv.style.cssText = 'width:min(78vh,78vw);height:min(78vh,78vw);image-rendering:pixelated;' +
    'border:1px solid #2b3550;border-radius:6px;background:#0d1224';

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:#8d97b8';
  hint.textContent = 'Tab or Esc to close  ·  ▣ Keepstone  ·  ◆ village  ·  ✦ you';

  el.append(title, cv, hint);
  document.body.appendChild(el);
}

function draw(px, pz){
  const g = cv.getContext('2d');
  const N = claim.GRID, bits = claim.grid();
  const img = g.createImageData(N, N);
  const d = img.data;
  for(let i = 0; i < N * N; i++){
    const on = (bits[i >> 3] & (1 << (i & 7))) !== 0;
    const o = i * 4;
    if(on){ d[o] = 255; d[o+1] = 200; d[o+2] = 132; d[o+3] = 235; }   // warm, reclaimed
    else   { d[o] = 18;  d[o+1] = 24;  d[o+2] = 52;  d[o+3] = 255; }  // night
  }
  g.putImageData(img, 0, 0);

  const toCell = v => Math.floor(((v % WORLD) + WORLD) % WORLD / claim.CELL);
  const dot = (x, z, color, r) => {
    g.fillStyle = color;
    g.fillRect(toCell(x) - r, toCell(z) - r, r * 2 + 1, r * 2 + 1);
  };

  for(const v of villageSites) dot(v.x, v.z, '#7ee29a', 1);
  for(const s of keepstones.all()){
    dot(s.x, s.z, keepstones.isDone(s) ? '#8d97b8' : '#ffe6bd', 2);
  }
  dot(px, pz, '#ff5d5d', 1);

  document.getElementById('claimMapTitle').textContent =
    `${claim.claimedPercent().toFixed(3)}% RECLAIMED  ·  ${claim.claimedCells()} cells`;
}

export const isOpen = () => open;

export function toggle(px, pz){
  build();
  open = !open;
  el.style.display = open ? 'flex' : 'none';
  if(open) draw(px, pz);
  return open;
}

export function close(){
  if(!open) return;
  open = false;
  if(el) el.style.display = 'none';
}

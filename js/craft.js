// craft.js — recipe-book crafting + materials guide
import { TYPES, ITEMS } from './render.js';
import { inventory, renderHotbar, renderInv, invOpen } from './ui.js';
import { sfx } from './audio.js';
import { note } from './survival.js';
import { gm } from './mode.js';

const $ = id=>document.getElementById(id);

import { RECIPES, EXTRA_GUIDE } from './content.js';
export { RECIPES };
const CATS = [['all','All'],['mat','Materials'],['block','Blocks'],['light','Lights'],['weapon','Weapons'],['food','Food'],['med','Medical']];
let curCat = 'all';

const BASE_GUIDE = [
  {id:1,  where:'Everywhere on the surface. Shovel digs it fastest.', uses:'Basic building.'},
  {id:2,  where:'Just under the grass. Shovel.', uses:'Basic building.'},
  {id:3,  where:'Dig 3+ blocks down, beneath the dirt layer. Bring a pickaxe.', uses:'Craft into Brick.'},
  {id:6,  where:'Light sandy patches where no trees grow. Shovel.', uses:'Craft into Glass.'},
  {id:4,  where:'Trees. Chop with an axe.', uses:'Craft into Planks; part of Torches.'},
  {id:5,  where:'Tree canopies. Breaks fast with anything.', uses:'Hedges and decoration.'},
  {id:7,  where:'Craft from Logs, or raid abandoned ruins.', uses:'Sticks, Fences, building.'},
  {id:8,  where:'Craft from Stone, or mine from ruin walls.', uses:'Strong-looking builds.'},
  {id:9,  where:'Craft from Sand, or mine ruin windows.', uses:'Windows.'},
  {id:12, where:'Punch sheep — they drop it along with mutton.', uses:'Soft white building block.'},
  {id:101,where:'Hunt pigs.',     uses:'Eat to restore 4 hunger.'},
  {id:102,where:'Hunt sheep.',    uses:'Eat to restore 3 hunger.'},
  {id:103,where:'Hunt chickens.', uses:'Eat to restore 2.5 hunger.'},
  {id:110,where:'Craft from Planks.', uses:'Torches and Fences.'},
  {id:10, where:'Craft it (Stick + Log).', uses:'Glows at night. Zombies will not spawn near a torch.'},
  {id:11, where:'Craft it (Sticks + Planks).', uses:'Fences for animal pens and decoration.'},
];
export const GUIDE = [...BASE_GUIDE, ...EXTRA_GUIDE];

const nameOf = id => id>=100 ? (ITEMS[id]?.name || ('Item '+id)) : (TYPES[id]?.name || ('Block '+id));
const iconHTML = id => id>=100
  ? `<span class="ticon">${ITEMS[id]?.icon || '❓'}</span>`
  : `<div class="sw" style="background-image:url(${TYPES[id]?.icon || ''})"></div>`;

export function canCraft(r){ return gm.forge || r.in.every(([id,n])=>(inventory[id]||0)>=n); }
export function craft(r){
  if(!canCraft(r)) return false;
  if(!gm.forge) for(const [id,n] of r.in) inventory[id]-=n;
  inventory[r.out.id] = (inventory[r.out.id]||0) + r.out.n;
  sfx.craft();
  note('craft');
  renderHotbar();
  renderCraft();
  if(invOpen) renderInv();
  return true;
}

export function renderCraft(){
  const bar = $('craftCats');
  if(!bar.childElementCount){
    for(const [id,label] of CATS){
      const b = document.createElement('button');
      b.className = 'itab' + (id===curCat?' active':'');
      b.textContent = label;
      b.addEventListener('pointerdown', e=>{ e.stopPropagation(); curCat = id;
        bar.querySelectorAll('.itab').forEach(x=>x.classList.toggle('active', x===b));
        renderCraft(); });
      bar.appendChild(b);
    }
  }
  const list = $('craftList');
  list.innerHTML = '';
  for(const r of RECIPES){
    if(curCat!=='all' && r.cat!==curCat) continue;
    const ok = canCraft(r);
    const row = document.createElement('div');
    row.className = 'craftRow' + (ok?'':' locked');
    const ins = r.in.map(([id,n])=>{
      const have = inventory[id]||0;
      const label = gm.forge ? '∞' : `${have}/${n}`;
      return `<span class="cIng ${(gm.forge||have>=n)?'':'miss'}">${iconHTML(id)}<b>${label}</b></span>`;
    }).join('<span class="cPlus">+</span>');
    row.innerHTML = `
      <div class="cOut">${iconHTML(r.out.id)}<span>${nameOf(r.out.id)} ×${r.out.n}</span></div>
      <div class="cIns">${ins}</div>
      <button class="cBtn" ${ok?'':'disabled'}>Craft</button>
      <div class="cTip">${r.tip}</div>`;
    row.querySelector('.cBtn').addEventListener('pointerdown', e=>{ e.stopPropagation(); craft(r); });
    list.appendChild(row);
  }
}

export function renderGuide(){
  const list = $('guideList');
  if(list.childElementCount) return; // static, build once
  for(const g of GUIDE){
    const row = document.createElement('div');
    row.className = 'guideRow';
    row.innerHTML = `
      <div class="gIcon">${iconHTML(g.id)}</div>
      <div class="gText"><b>${nameOf(g.id)}</b>
        <span>📍 ${g.where}</span>
        <span>🛠 ${g.uses}</span></div>`;
    list.appendChild(row);
  }
}

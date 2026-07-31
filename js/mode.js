// mode.js — Forge (creation) vs Nightfall (survival). Host-authoritative in multiplayer.
export const gm = { forge:false };
const listeners = [];
export function onModeChange(fn){ listeners.push(fn); }
export function setMode(forge){
  if(gm.forge === forge) return;
  gm.forge = forge;
  for(const f of listeners) f(forge);
}
export const modeName = ()=>gm.forge ? 'Forge' : 'Nightfall';

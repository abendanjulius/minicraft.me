// audio.js — tiny Web Audio synth; zero asset files, zero network
let ctx = null;
export function initAudio(){
  if(!ctx){ try{ ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
  ctx?.resume?.();
}
function env(g,t0,a,d,v){
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(v,t0+a);
  g.gain.exponentialRampToValueAtTime(.0001,t0+a+d);
}
function osc({freq=440,end=freq,type='square',dur=.1,vol=.15}){
  if(!ctx) return;
  const t=ctx.currentTime, o=ctx.createOscillator(), g=ctx.createGain();
  o.type=type;
  o.frequency.setValueAtTime(freq,t);
  o.frequency.exponentialRampToValueAtTime(Math.max(30,end),t+dur);
  env(g,t,.005,dur,vol);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t+dur+.05);
}
let noiseBuf=null;
function noise({dur=.12,vol=.2,freq=800,q=1}){
  if(!ctx) return;
  if(!noiseBuf){
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate*.5|0, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
  }
  const t=ctx.currentTime, s=ctx.createBufferSource(), g=ctx.createGain(), f=ctx.createBiquadFilter();
  s.buffer=noiseBuf; f.type='bandpass'; f.frequency.value=freq; f.Q.value=q;
  env(g,t,.003,dur,vol);
  s.connect(f).connect(g).connect(ctx.destination);
  s.start(t); s.stop(t+dur+.05);
}
// Characteristic pitch per block type (higher = harder/glassier)
const PITCH = {1:700,2:600,3:1400,4:900,5:1800,6:500,7:950,8:1350,9:2400};
let stepAlt=false;
let ambT = 0, birdT = 2, waterT = 0;
export function ambientTick(dt, { nearWater = false, biome = 0 } = {}){
  if(!ctx) return;
  ambT += dt; birdT -= dt; waterT -= dt;
  // birds in plains/forest
  if(birdT <= 0 && (biome === 0 || biome === 1)){
    birdT = 4 + Math.random() * 8;
    sfx.bird();
  }
  if(nearWater && waterT <= 0){
    waterT = 1.2 + Math.random() * 1.5;
    sfx.water();
  }
}
export const sfx = {
  bird: ()=>{
    const base = 1800 + Math.random()*800;
    osc({freq:base, end:base*1.3, type:'sine', dur:.08, vol:.04});
    setTimeout(()=>osc({freq:base*1.15, end:base*.9, type:'sine', dur:.1, vol:.035}), 90);
  },
  water: ()=> noise({dur:.35, vol:.06, freq:400 + Math.random()*200, q:0.6}),

  break: t=>{ noise({dur:.18,vol:.38,freq:(PITCH[t]||800)*.7,q:.8}); osc({freq:(PITCH[t]||800)*.35,end:60,type:'triangle',dur:.15,vol:.15}); },
  tick:  t=>noise({dur:.05,vol:.15,freq:PITCH[t]||900,q:2}),
  place: ()=>{ osc({freq:220,end:160,type:'square',dur:.08,vol:.18}); noise({dur:.05,vol:.12,freq:500,q:1}); },
  step:  t=>{ stepAlt=!stepAlt; noise({dur:.05,vol:.08,freq:(PITCH[t]||700)*.5*(stepAlt?1.15:1),q:1.4}); },
  jump:  ()=>osc({freq:300,end:520,type:'sine',dur:.12,vol:.12}),
  land:  ()=>noise({dur:.09,vol:.2,freq:350,q:.9}),
  chat:  ()=>osc({freq:900,end:1200,type:'sine',dur:.08,vol:.1}),
  punch: ()=>{ noise({dur:.07,vol:.2,freq:300,q:.8}); osc({freq:180,end:90,type:'triangle',dur:.08,vol:.12}); },
  hurt:  ()=>{ osc({freq:240,end:110,type:'sawtooth',dur:.18,vol:.14}); noise({dur:.1,vol:.14,freq:250,q:1}); },
  eat:   ()=>{ noise({dur:.08,vol:.14,freq:900,q:1.2}); osc({freq:500,end:300,type:'triangle',dur:.12,vol:.09}); },
  zgroan:()=>{ osc({freq:120+Math.random()*40,end:70,type:'sawtooth',dur:.5,vol:.07}); },
  craft: ()=>{ noise({dur:.06,vol:.16,freq:700,q:1.5}); osc({freq:520,end:780,type:'sine',dur:.14,vol:.1}); },
  drip:  ()=>{ osc({freq:1400,end:900,type:'sine',dur:.06,vol:.07}); setTimeout(()=>osc({freq:1100,end:700,type:'sine',dur:.09,vol:.04}),110); },
  ach:   ()=>{ osc({freq:660,end:660,type:'sine',dur:.09,vol:.1}); setTimeout(()=>osc({freq:880,end:880,type:'sine',dur:.16,vol:.1}),90); },
};

// ---- Background music: royalty-free track, looped at low volume ----
let musicEl = null, musicOn = false;
export function startMusic(){
  if(!musicEl){
    musicEl = new Audio('./assets/music.mp3');
    musicEl.loop = true;
    musicEl.volume = 0.07; // 50% quieter than before
  }
  musicEl.play().catch(()=>{});
  musicOn = true;
}
export function stopMusic(){
  musicEl?.pause();
  musicOn = false;
}
export function toggleMusic(){ musicOn ? stopMusic() : startMusic(); }

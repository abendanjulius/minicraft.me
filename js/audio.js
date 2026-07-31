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
export const sfx = {
  break: t=>{ noise({dur:.18,vol:.38,freq:(PITCH[t]||800)*.7,q:.8}); osc({freq:(PITCH[t]||800)*.35,end:60,type:'triangle',dur:.15,vol:.15}); },
  tick:  t=>noise({dur:.05,vol:.15,freq:PITCH[t]||900,q:2}),
  place: ()=>{ osc({freq:220,end:160,type:'square',dur:.08,vol:.18}); noise({dur:.05,vol:.12,freq:500,q:1}); },
  step:  t=>{ stepAlt=!stepAlt; noise({dur:.05,vol:.08,freq:(PITCH[t]||700)*.5*(stepAlt?1.15:1),q:1.4}); },
  jump:  ()=>osc({freq:300,end:520,type:'sine',dur:.12,vol:.12}),
  land:  ()=>noise({dur:.09,vol:.2,freq:350,q:.9}),
  chat:  ()=>osc({freq:900,end:1200,type:'sine',dur:.08,vol:.1}),
};

// ---- Background music: slow generative pads + occasional plucks, deliberately quiet ----
let musicOn = false, padTimer = null, pluckTimer = null, musicGain = null, chordIdx = 0;
const CHORDS = [
  [130.81,196.00,261.63],  // C
  [110.00,164.81,220.00],  // Am
  [ 87.31,130.81,174.61],  // F
  [ 98.00,146.83,196.00],  // G
];
const SCALE = [261.63,293.66,329.63,392.00,440.00,523.25]; // C pentatonic
function playPad(){
  if(!musicOn || !ctx) return;
  const notes = CHORDS[chordIdx++ % CHORDS.length];
  for(const f of notes){
    const t=ctx.currentTime, o=ctx.createOscillator(), g=ctx.createGain();
    o.type='sine'; o.frequency.value=f;
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(.02,t+3);
    g.gain.linearRampToValueAtTime(0,t+9);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t+9.5);
  }
  padTimer = setTimeout(playPad, 8000);
}
function playPluck(){
  if(!musicOn || !ctx) return;
  if(Math.random()<.65){
    const f = SCALE[Math.floor(Math.random()*SCALE.length)];
    const t=ctx.currentTime, o=ctx.createOscillator(), g=ctx.createGain();
    o.type='triangle'; o.frequency.value=f;
    g.gain.setValueAtTime(.045,t);
    g.gain.exponentialRampToValueAtTime(.0001,t+1.4);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t+1.5);
  }
  pluckTimer = setTimeout(playPluck, 2500+Math.random()*3500);
}
export function startMusic(){
  if(!ctx || musicOn) return;
  musicOn = true;
  if(!musicGain){ musicGain = ctx.createGain(); musicGain.gain.value = .6; musicGain.connect(ctx.destination); }
  playPad(); playPluck();
}
export function stopMusic(){
  musicOn = false;
  clearTimeout(padTimer); clearTimeout(pluckTimer);
}
export function toggleMusic(){ musicOn ? stopMusic() : startMusic(); }

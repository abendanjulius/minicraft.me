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

// ---- Background music: a composed, calm 12-bar loop (soft piano-ish voice over pads) ----
let musicOn = false, loopTimer = null, musicGain = null;
const BEAT = .75;                 // ~80bpm
// [freq, startBeat, durationBeats] — a gentle C-major theme
const N = {C4:261.63,D4:293.66,E4:329.63,F4:349.23,G4:392.00,A4:440.00,B4:493.88,C5:523.25,D5:587.33,E5:659.25};
const MELODY = [
  [N.E4,0,1],[N.G4,1,1],[N.C5,2,2],
  [N.A4,4,1],[N.C5,5,1],[N.E5,6,2],
  [N.F4,8,1],[N.A4,9,1],[N.C5,10,1],[N.A4,11,1],
  [N.G4,12,2],[N.B4,14,1],[N.D5,15,1],
  [N.C5,16,1],[N.G4,17,1],[N.E4,18,2],
  [N.A4,20,1.5],[N.B4,21.5,.5],[N.C5,22,2],
  [N.A4,24,1],[N.G4,25,1],[N.F4,26,2],
  [N.G4,28,4],
  // bars 9–12: melody rests, pads breathe
];
const BARS = 12;
const CHORDS = [
  [130.81,196.00,261.63],  // C
  [110.00,164.81,220.00],  // Am
  [ 87.31,130.81,174.61],  // F
  [ 98.00,146.83,196.00],  // G
];
function pianoNote(freq, when, durBeats, vol){
  const t = when, d = durBeats*BEAT;
  const f = ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=2000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(vol,t+.02);
  g.gain.exponentialRampToValueAtTime(.0001, t+d*1.15+.3);
  const o1 = ctx.createOscillator(); o1.type='sine';     o1.frequency.value=freq;
  const o2 = ctx.createOscillator(); o2.type='triangle'; o2.frequency.value=freq;
  const g2 = ctx.createGain(); g2.gain.value=.35;
  o1.connect(f); o2.connect(g2).connect(f);
  f.connect(g).connect(musicGain);
  o1.start(t); o2.start(t);
  o1.stop(t+d*1.2+.4); o2.stop(t+d*1.2+.4);
}
function scheduleLoop(){
  if(!musicOn || !ctx) return;
  const t0 = ctx.currentTime + .05;
  // melody
  for(const [f,s,d] of MELODY) pianoNote(f, t0 + s*BEAT, d, .06);
  // pads + bass, one chord per bar
  for(let bar=0; bar<BARS; bar++){
    const chord = CHORDS[bar%4], bt = t0 + bar*4*BEAT;
    for(const f of chord){
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0,bt);
      g.gain.linearRampToValueAtTime(.012, bt+1.2);
      g.gain.linearRampToValueAtTime(0, bt+4*BEAT+.4);
      o.connect(g).connect(musicGain);
      o.start(bt); o.stop(bt+4*BEAT+.6);
    }
    pianoNote(chord[0]/2, bt, 3.5, .028); // soft bass root
  }
  loopTimer = setTimeout(scheduleLoop, BARS*4*BEAT*1000);
}
export function startMusic(){
  if(!ctx || musicOn) return;
  musicOn = true;
  if(!musicGain){ musicGain = ctx.createGain(); musicGain.gain.value = .55; musicGain.connect(ctx.destination); }
  scheduleLoop();
}
export function stopMusic(){
  musicOn = false;
  clearTimeout(loopTimer);
}
export function toggleMusic(){ musicOn ? stopMusic() : startMusic(); }

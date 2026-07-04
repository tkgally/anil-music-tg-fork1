/* =====================================================================
   02 · Drift — audio engine.

   Concept: N loops (default 6), each a single soft tone repeating on
   its own incommensurate period (the Music for Airports trick). Only
   the alignment of the loops evolves; every element repeats exactly.

   Parameter model: one shared state object `ST` (owned by main.js).
   ST.rows[0..7] describe the loops (note, period, level, pan, mute,
   seeded phase + detune-walk); scalars (pace, warmth, air, …) are
   macros. Mixer-ish params apply immediately (setTargetAtTime);
   structural params (pitch, period, palette, timbre) are read at
   schedule time, so they land at each loop's next pass.

   Scheduling: pure lookahead math — for each loop, next fire time =
   phase + n·period; a 500 ms tick schedules every fire inside the
   horizon (6 s visible, 12 s hidden). A continuous bed + air texture
   keep the room from ever going black.
===================================================================== */
(function () {
'use strict';

/* ----- seeded RNG (shared studio idiom) ----- */
function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;
let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;
return((t^(t>>>14))>>>0)/4294967296;};}
class RNG{constructor(s){this.f=mulberry32(s);}next(){return this.f();}
range(a,b){return a+(b-a)*this.f();}int(a,b){return Math.floor(this.range(a,b+1));}
pick(a){return a[Math.floor(this.f()*a.length)];}chance(p){return this.f()<p;}
weighted(pairs){let t=0;for(const p of pairs)t+=p[1];let r=this.f()*t;
for(const p of pairs){r-=p[1];if(r<=0)return p[0];}return pairs[pairs.length-1][0];}}
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const midiToFreq=m=>440*Math.pow(2,(m-69)/12);
function scrap(src,parts){src.onended=()=>{for(const n of parts){try{n.disconnect();}catch(e){}}};}
function hashStr(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}

/* ----- tuning constants (levels chosen against verify.mjs metrics) ----- */
const TONE_PEAK={'choir-glass':0.075,'glass':0.089,'voices':0.33}; // voices: formants eat ~7 dB
const BED_LVL=0.062;        // foundation bed — audible but under the loops, ~ -30 dBFS at the tap
const AIR_MAX=0.9;          // air texture at slider=100
const RV_OUT=1.0;

/* ----- palettes (the four presets) ----- */
/* lvl scales the seeded per-row bus levels; tone trims the synth peak at
   schedule time — tuned so every preset lands within ±1.5 dB RMS */
const PALETTES={
  airport:{label:'Airport',notes:[41,45,48,52,55,57,60,64,65,67],
           perFactor:1.0,timbre:'choir-glass',lvl:1.0,tone:1.0,root:41,maxAboveC4:1},
  undertow:{label:'Undertow',notes:[38,41,45,48,52,55],
           perFactor:1.4,timbre:'voices',lvl:1.0,tone:1.1,root:38,maxAboveC4:0},
  coldstar:{label:'Cold star',notes:[45,48,52,57,59,60,64,69],
           perFactor:1.6,timbre:'glass',lvl:0.78,tone:1.4,root:45,maxAboveC4:2},
  morning:{label:'Morning',notes:[43,50,52,55,57,59,62],
           perFactor:0.8,timbre:'choir-glass',lvl:1.0,tone:1.28,root:43,maxAboveC4:1},
};

/* ----- layout generation (deterministic: seed + palette + reroll#) ----- */
const BASE_PERIODS=[17.8,19.6,20.1,23.5,25.9,29.9,34.2];   // Music for Airports neighborhood
const SIMPLE_RATIOS=[1,2,3/2,4/3];                          // 1:1, 1:2, 2:3, 3:4

/* distance (relative) from the nearest simple ratio; <0.03 counts as aligned */
function ratioBadness(a,b){
  const r=Math.max(a,b)/Math.min(a,b);
  let worst=Infinity;
  for(const f of SIMPLE_RATIOS) worst=Math.min(worst,Math.abs(r/f-1));
  return worst;
}
function nearSimple(a,b){return ratioBadness(a,b)<0.03;}

/* Always generate 8 rows; the Layers slider exposes a prefix. Fewer
   layers = the lower, calmer subset — highs only enter at 7-8. */
function genRows(seed,palKey,ln){
  const pal=PALETTES[palKey]||PALETTES.airport;
  const rng=new RNG(((seed>>>0)^hashStr(palKey)^Math.imul(ln|0,0x9E3779B9))>>>0);
  const NMAX=8;

  // pitches: root anchors, then low/mid-weighted picks; few above C4
  const pool=pal.notes.slice();
  const picks=[pool[0]];
  const count=new Map([[pool[0],1]]);
  let above=0;
  while(picks.length<NMAX){
    const pairs=[];
    for(let i=0;i<pool.length;i++){
      const m=pool[i];
      if(m>60&&above>=pal.maxAboveC4) continue;
      const c=count.get(m)||0;
      if(c>=2) continue;                       // at most two loops share a pitch
      pairs.push([m,(1/(1+i*0.22))/(1+8*c*c)]);
    }
    if(!pairs.length){picks.push(pool[picks.length%pool.length]);continue;}
    const m=rng.weighted(pairs);
    count.set(m,(count.get(m)||0)+1);
    if(m>60) above++;
    picks.push(m);
  }
  picks.sort((a,b)=>a-b);

  // periods: shuffled base pool + one extra, jittered, then made incommensurate.
  // All work happens on 0.1 s-rounded values — rows store tenths, so the
  // no-simple-ratio guarantee must hold on what actually plays.
  const round1=x=>Math.round(x*10)/10;
  const per=BASE_PERIODS.slice();
  for(let i=per.length-1;i>0;i--){const j=rng.int(0,i);[per[i],per[j]]=[per[j],per[i]];}
  per.push(rng.range(18,33));
  for(let i=0;i<per.length;i++) per[i]=round1(per[i]*pal.perFactor*(1+rng.range(-0.045,0.045)));
  // seat(j): search outward from row j's value (alternating up/down in ~1.2%
  // steps, up to ×/÷1.012^span) for a spot ≥3% clear of every `others` row;
  // if the whole range is covered, park on the least-aligned spot found
  const seat=(j,span,others)=>{
    let bad=Infinity;
    for(let i=0;i<per.length;i++) if(others(i)) bad=Math.min(bad,ratioBadness(per[i],per[j]));
    if(bad>=0.03) return true;
    const base=per[j];
    let bestCand=base,bestBad=bad;
    for(let k=0;k<=span;k++){
      const off=(k%2?1:-1)*Math.ceil(k/2);   // 0, +1, -1, +2, -2, …
      const cand=round1(base*Math.pow(1.012,off));
      if(cand<11||cand>56)continue;
      let w=Infinity;
      for(let i=0;i<per.length;i++) if(others(i)) w=Math.min(w,ratioBadness(per[i],cand));
      if(w>bestBad){bestBad=w;bestCand=cand;}
      if(w>=0.03)break;
    }
    per[j]=bestCand;
    return bestBad>=0.03;
  };
  for(let pass=0;pass<3;pass++)
    for(let j=(pass?0:1);j<per.length;j++)
      seat(j,64,i=>i!==j&&(pass>0||i<j));     // ×/÷1.47 of base
  // repair: while any pair is still inside the 3% zone, re-seat either member
  // of the worst pair, searching the whole 11–56 s window — layouts end fully clear
  for(let rep=0;rep<12;rep++){
    let a=-1,b=-1,bad=0.03;
    for(let i=0;i<per.length;i++)for(let j=i+1;j<per.length;j++){
      const w=ratioBadness(per[i],per[j]);
      if(w<bad){bad=w;a=i;b=j;}
    }
    if(a<0)break;
    if(!seat(b,280,i=>i!==b)) seat(a,280,i=>i!==a);
  }

  const rows=[];
  let sign=rng.chance(0.5)?1:-1;
  for(let i=0;i<NMAX;i++){
    // first three loops enter early so the piece speaks within seconds
    const phase=(i===0)?rng.range(0.6,3.0)
              :(i===1)?rng.range(2.5,6.0)
              :(i===2)?rng.range(5,11)
              :rng.range(0,per[i]);
    rows.push({
      note:picks[i],
      per:+per[i].toFixed(1),
      lvl:+(rng.range(0.7,1.0)*pal.lvl).toFixed(2),
      pan:+(sign*(i/(NMAX-1))*0.6).toFixed(2),   // lower notes nearer center
      mute:0,
      phase:+phase.toFixed(2),
      dtT:rng.range(130,320),                     // detune-walk period (s)
      dtP:rng.range(0,Math.PI*2),                 // detune-walk phase
    });
    sign=-sign;
  }
  return rows;
}

/* ----- audio state ----- */
let ctx=null,N=null,ST=null,noiseBuf=null;
let rt=[];                    // per-loop runtime: nextT, q (viz), pending tones
let runRng=null;              // seeded stream for phase nudges
let tickTimer=0;
let running=false;
let transT0=0;                // transport origin — fire times are t0-relative

function bind(S){ST=S;runRng=new RNG(((S.seed>>>0)^0x0badf00d)>>>0);}   // re-seed on every bind/seed change
function paceScale(p){p=clamp(p,0,100);return p<=50?2.0-(p/50):1.0-0.45*((p-50)/50);}
function effPer(row){return clamp(row.per,4,120)*paceScale(ST?ST.pace:50);}
function warmCut(w){return 3200*Math.pow(1200/3200,clamp(w,0,100)/100);}
function tiltDb(){return clamp(6*(0.7-clamp(ST.vol,0,100)/100),0,5);}   // 0 dB at/above default 70%
/* tape-drift jitter: a pure function of (seed, layer, cycle) — NOT a shared
   stream — so which tick a fire falls into (hidden-tab wakes, late timers)
   can never change the draw order; two loads of one URL stay identical */
function driftFactor(i,cyc){
  if(!ST.tape)return 1;
  const depth=0.015*(clamp(ST.dd,0,100)/50);
  const u=mulberry32(((ST.seed>>>0)^Math.imul(i+1,0x9E3779B9)^Math.imul((cyc|0)+1,0x85EBCA6B))>>>0)();
  return 1+depth*(2*u-1);
}

/* impulse response: decayed noise with a lowpass swept down the tail */
function makeImpulse(c,rng,seconds,decay){
  const rate=c.sampleRate,len=Math.floor(rate*seconds),fade=Math.floor(rate*0.02);
  const buf=c.createBuffer(2,len,rate);
  for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);let lp=0;
    for(let i=0;i<len;i++){const t=i/len;
      const k=Math.exp(-2*Math.PI*(10000*Math.pow(0.1,t))/rate); // 10k -> 1k across tail
      lp=k*lp+(1-k)*(rng.next()*2-1);
      d[i]=lp*Math.pow(1-t,decay)*(i<fade?i/fade:1)*3;}}
  return buf;
}

/* ----- graph ----- */
function initAudio(){
  ctx=new (window.AudioContext||window.webkitAudioContext)();
  const agen=mulberry32(((ST.seed>>>0)^0x6d2b79f5)>>>0);
  N={};

  // master chain: sum -> warmth LP -> slow-drift trim -> volume -> quiet-listening
  // tilt -> comp -> limiter -> analyser
  N.preMaster=ctx.createGain();
  N.warmLP=ctx.createBiquadFilter();
  N.warmLP.type='lowpass';N.warmLP.frequency.value=warmCut(ST.warm);N.warmLP.Q.value=0.5;
  N.trim=ctx.createGain();
  N.master=ctx.createGain();N.master.gain.value=0;         // fades in on play
  // equal-loudness tilt: shelves rise as the volume slider falls (Fletcher–Munson)
  N.tiltLo=ctx.createBiquadFilter();N.tiltLo.type='lowshelf';N.tiltLo.frequency.value=150;
  N.tiltHi=ctx.createBiquadFilter();N.tiltHi.type='highshelf';N.tiltHi.frequency.value=8000;
  N.tiltLo.gain.value=N.tiltHi.gain.value=tiltDb();
  N.comp=ctx.createDynamicsCompressor();
  N.comp.threshold.value=-18;N.comp.knee.value=24;N.comp.ratio.value=2.5;
  N.comp.attack.value=0.01;N.comp.release.value=0.25;
  N.limiter=ctx.createDynamicsCompressor();
  N.limiter.threshold.value=-4;N.limiter.knee.value=0;N.limiter.ratio.value=16;
  N.limiter.attack.value=0.001;N.limiter.release.value=0.1;
  N.analyser=ctx.createAnalyser();N.analyser.fftSize=2048;
  N.preMaster.connect(N.warmLP);N.warmLP.connect(N.trim);N.trim.connect(N.master);
  N.master.connect(N.tiltLo);N.tiltLo.connect(N.tiltHi);N.tiltHi.connect(N.comp);
  N.comp.connect(N.limiter);N.limiter.connect(N.analyser);
  N.analyser.connect(ctx.destination);

  // big reverb with ~30 ms predelay; per-bus sends
  N.predelay=ctx.createDelay(0.2);N.predelay.delayTime.value=0.03;
  N.convolver=ctx.createConvolver();
  N.convolver.buffer=makeImpulse(ctx,new RNG((ST.seed^0x5eedc0de)>>>0),clamp(ST.rs,1,6),2.9);
  N.rvOut=ctx.createGain();N.rvOut.gain.value=RV_OUT;
  N.predelay.connect(N.convolver);N.convolver.connect(N.rvOut);N.rvOut.connect(N.preMaster);
  N.sendBus=ctx.createGain();N.sendBus.gain.value=clamp(ST.rm,0,100)/100;
  N.bedSend=ctx.createGain();N.bedSend.gain.value=0;
  N.airSend=ctx.createGain();N.airSend.gain.value=0;
  N.sendBus.connect(N.predelay);N.bedSend.connect(N.predelay);N.airSend.connect(N.predelay);

  // ONE shared looped noise buffer (Daysong idiom)
  noiseBuf=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
  const d=noiseBuf.getChannelData(0);
  for(let i=0;i<d.length;i++)d[i]=agen()*2-1;

  // per-loop buses: level -> pan -> dry + reverb send
  N.layers=[];
  for(let i=0;i<8;i++){
    const lg=ctx.createGain();lg.gain.value=0;
    const pan=ctx.createStereoPanner();
    lg.connect(pan);pan.connect(N.preMaster);pan.connect(N.sendBus);
    N.layers.push({lg,pan});
  }

  buildBed();
  buildAir();
  applyLive();
}

/* foundation bed: root + fifth with the choir-glass treatment, breathing */
function buildBed(){
  const pal=PALETTES[ST.pal]||PALETTES.airport;
  N.bedGain=ctx.createGain();N.bedGain.gain.value=0;
  const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1500;lp.Q.value=0.4;
  const mix=ctx.createGain();mix.gain.value=1;
  mix.connect(lp);lp.connect(N.bedGain);
  N.bedGain.connect(N.preMaster);N.bedGain.connect(N.bedSend);
  N.bedOsc=[];
  const t=ctx.currentTime;
  [[pal.root,0.55],[pal.root+7,0.42]].forEach(([m,amp])=>{
    const f=midiToFreq(m);
    const o=ctx.createOscillator();o.frequency.value=f;
    const og=ctx.createGain();og.gain.value=amp;
    const o2=ctx.createOscillator();o2.type='triangle';o2.frequency.value=f;o2.detune.value=6;
    const o2g=ctx.createGain();o2g.gain.value=amp*0.35;
    o.connect(og);og.connect(mix);o2.connect(o2g);o2g.connect(mix);
    o.start(t);o2.start(t);
    N.bedOsc.push({o,o2});
  });
  // slow breathing (~26 s) on the bed level
  N.bedLfo=ctx.createOscillator();N.bedLfo.frequency.value=1/26;
  N.bedLfoG=ctx.createGain();N.bedLfoG.gain.value=0;
  N.bedLfo.connect(N.bedLfoG);N.bedLfoG.connect(N.bedGain.gain);
  N.bedLfo.start(t);
}

/* air texture: shared noise -> highshelf cut -> very slow bandpass sweep */
function buildAir(){
  const t=ctx.currentTime;
  const src=ctx.createBufferSource();src.buffer=noiseBuf;src.loop=true;
  const hs=ctx.createBiquadFilter();hs.type='highshelf';hs.frequency.value=2500;hs.gain.value=-15;
  N.airBP=ctx.createBiquadFilter();N.airBP.type='bandpass';
  N.airBP.frequency.value=clamp(ST.ac,400,2000);N.airBP.Q.value=1.1;
  N.airGain=ctx.createGain();N.airGain.gain.value=0;
  src.connect(hs);hs.connect(N.airBP);N.airBP.connect(N.airGain);
  N.airGain.connect(N.preMaster);N.airGain.connect(N.airSend);
  N.airLfo=ctx.createOscillator();N.airLfo.frequency.value=1/90;   // ~90 s sweep
  N.airLfoG=ctx.createGain();N.airLfoG.gain.value=0;
  N.airLfo.connect(N.airLfoG);N.airLfoG.connect(N.airBP.frequency);
  src.start(t);N.airLfo.start(t);
}

/* ----- live (mixer-ish) params: applied immediately, smoothed ----- */
function applyLive(){
  if(!ctx)return;
  const now=ctx.currentTime;
  if(running)N.master.gain.setTargetAtTime(Math.pow(clamp(ST.vol,0,100)/100,1.6),now,0.15);
  const sh=tiltDb();
  N.tiltLo.gain.setTargetAtTime(sh,now,0.15);
  N.tiltHi.gain.setTargetAtTime(sh,now,0.15);
  const rm=clamp(ST.rm,0,100)/100;
  N.sendBus.gain.setTargetAtTime(rm,now,0.2);
  N.bedSend.gain.setTargetAtTime(rm*0.5,now,0.2);
  N.airSend.gain.setTargetAtTime(rm*0.6,now,0.2);
  // air
  N.airGain.gain.setTargetAtTime(Math.pow(clamp(ST.air,0,100)/100,1.3)*AIR_MAX,now,0.4);
  const ac=clamp(ST.ac,400,2000);
  N.airBP.frequency.setTargetAtTime(ac,now,0.4);
  N.airLfoG.gain.setTargetAtTime(Math.min(ac-350,ac*0.45),now,0.4);
  // bed (level + breathing depth; root glides on palette change)
  const bl=ST.bed?BED_LVL:0;
  N.bedGain.gain.setTargetAtTime(bl,now,0.8);
  N.bedLfoG.gain.setTargetAtTime(bl*0.15,now,0.8);
  const pal=PALETTES[ST.pal]||PALETTES.airport;
  N.bedOsc.forEach((bo,k)=>{
    const f=midiToFreq(pal.root+(k?7:0));
    bo.o.frequency.setTargetAtTime(f,now,1.0);
    bo.o2.frequency.setTargetAtTime(f,now,1.0);
  });
  // loop buses
  const nAct=clamp(ST.layers,3,8);
  for(let i=0;i<8;i++){
    const row=ST.rows[i],L=N.layers[i];
    if(!row){L.lg.gain.setTargetAtTime(0,now,0.2);continue;}
    const on=i<nAct&&!row.mute;
    L.lg.gain.setTargetAtTime(on?clamp(row.lvl,0,1):0,now,0.2);
    L.pan.pan.setTargetAtTime(clamp(row.pan,-1,1),now,0.2);
  }
}

/* reverb size changes rebuild the impulse (briefly ducked to avoid a glitch) */
function rebuildReverb(){
  if(!ctx)return;
  N.rvOut.gain.setTargetAtTime(0,ctx.currentTime,0.05);
  setTimeout(()=>{
    if(!ctx)return;
    const rng=new RNG(((ST.seed^0x5eedc0de)+Math.round(ST.rs*10))>>>0);
    N.convolver.buffer=makeImpulse(ctx,rng,clamp(ST.rs,1,6),2.9);
    N.rvOut.gain.setTargetAtTime(RV_OUT,ctx.currentTime+0.05,0.15);
  },260);
}

/* ----- voices: every tone is a swell, never a pluck ----- */
function swellGain(t,atk,sus,rel,peak){
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(peak,t+atk);
  g.gain.setTargetAtTime(0,t+atk+sus,rel/5);   // exponential approach to 0 — click-free
  return g;
}

function playTone(t,i,row){
  const L=N.layers[i];
  const f=midiToFreq(row.note);
  const det=3*Math.sin(2*Math.PI*t/row.dtT+row.dtP);     // ±3 cent walk, minutes long
  const dur=clamp(ST.tl,3,10);
  const timbre=TONE_PEAK[ST.timbre]?ST.timbre:'choir-glass';
  let atk,rel;
  if(timbre==='glass'){atk=0.8;rel=Math.max(1.2,dur*0.5);}
  else{atk=dur*clamp(ST.atk,5,60)/100;rel=dur*0.45;}
  const sus=Math.max(0.05,dur-atk-rel);
  // sparser palettes (perFactor > 1) fire less often, so their tones run
  // slightly hotter — keeps all presets within the ±1.5 dB level contract
  const pal=PALETTES[ST.pal]||PALETTES.airport;
  const peak=TONE_PEAK[timbre]*Math.sqrt(pal.perFactor)*pal.tone;
  const stop=t+atk+sus+rel*1.6;
  const g=swellGain(t,atk,sus,rel,peak);
  g.connect(L.lg);
  let srcs=[];

  if(timbre==='glass'){                 // Daysong FM glass, swelled, index halved
    const car=ctx.createOscillator();car.frequency.value=f;car.detune.value=det;
    const mod=ctx.createOscillator();mod.frequency.value=f*3.003;
    const mg=ctx.createGain();
    mg.gain.setValueAtTime(f*1.1,t);
    mg.gain.exponentialRampToValueAtTime(f*0.02,t+dur*0.85);
    mod.connect(mg);mg.connect(car.frequency);
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=2400;lp.Q.value=0.4;
    car.connect(lp);lp.connect(g);
    srcs=[car,mod];
    scrap(car,[g,lp,mg,mod]);
  }else if(timbre==='voices'){          // Daysong choir recipe, swelled
    const mix=ctx.createGain();mix.gain.value=0.5;
    const s1=ctx.createOscillator();s1.type='sawtooth';s1.frequency.value=f;s1.detune.value=det-9;
    const s2=ctx.createOscillator();s2.type='sawtooth';s2.frequency.value=f;s2.detune.value=det+9;
    s1.connect(mix);s2.connect(mix);
    const f1=ctx.createBiquadFilter();f1.type='bandpass';f1.frequency.value=640;f1.Q.value=5;
    const f1g=ctx.createGain();f1g.gain.value=0.9;
    const f2=ctx.createBiquadFilter();f2.type='bandpass';f2.frequency.value=1100;f2.Q.value=6;
    const f2g=ctx.createGain();f2g.gain.value=0.55;
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=750;lp.Q.value=0.7;
    const lpg=ctx.createGain();lpg.gain.value=0.5;
    mix.connect(f1);f1.connect(f1g);f1g.connect(g);
    mix.connect(f2);f2.connect(f2g);f2g.connect(g);
    mix.connect(lp);lp.connect(lpg);lpg.connect(g);
    srcs=[s1,s2];
    scrap(s1,[g,mix,f1,f1g,f2,f2g,lp,lpg,s2]);
  }else{                                // choir-glass: sine + 2nd partial + detuned triangle
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1600;lp.Q.value=0.4;
    const o1=ctx.createOscillator();o1.frequency.value=f;o1.detune.value=det;
    const o2=ctx.createOscillator();o2.frequency.value=f*2.005;o2.detune.value=det;
    const g2=ctx.createGain();g2.gain.value=0.22;
    const o3=ctx.createOscillator();o3.type='triangle';o3.frequency.value=f;o3.detune.value=det+6;
    const g3=ctx.createGain();g3.gain.value=0.4;
    o1.connect(lp);o2.connect(g2);g2.connect(lp);o3.connect(g3);g3.connect(lp);
    lp.connect(g);
    srcs=[o1,o2,o3];
    scrap(o1,[g,lp,g2,o2,g3,o3]);
  }
  for(const s of srcs){s.start(t);s.stop(stop);}
  return {t,stop,g,srcs};
}

/* ----- scheduler ----- */
function startTransport(){
  const t0=ctx.currentTime+0.15;
  transT0=t0;
  rt=[];
  for(let i=0;i<8;i++){
    const row=ST.rows[i];
    const p=effPer(row);
    const nextT=t0+(row.phase%p);
    rt.push({nextT,cyc:0,q:[],prevFire:nextT-p,lastFire:-9,pending:[]});
  }
  tickTimer=setInterval(tick,500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});
  tick();
}

function tick(){
  if(!ctx)return;
  const horizon=document.hidden?12:6;
  const now=ctx.currentTime;
  // ~10 min global drift arc: brightness and ±1.2 dB, barely perceptible
  const arc=Math.sin(2*Math.PI*now/600);
  const arc2=Math.sin(2*Math.PI*now/600+1.3);
  N.warmLP.frequency.setTargetAtTime(warmCut(ST.warm)*(1+0.14*arc),now,0.8);
  N.trim.gain.setTargetAtTime(Math.pow(10,(1.2*arc2)/20),now,0.8);

  const nAct=clamp(ST.layers,3,8);
  for(let i=0;i<8;i++){
    const st=rt[i],row=ST.rows[i];
    if(!st||!row)continue;
    st.pending=st.pending.filter(h=>h.stop>now);
    // prune fire-time history here too — draw() only runs while visible,
    // so a hidden tab would otherwise grow st.q without bound
    while(st.q.length&&st.q[0]<=now-2){st.prevFire=st.q.shift();st.lastFire=st.prevFire;}
    if(i>=nAct||row.mute){ // parked/muted loops keep their phase marching silently
      while(st.nextT<now){st.prevFire=st.nextT;st.nextT+=effPer(row)*driftFactor(i,st.cyc++);}
      continue;
    }
    // woke late: skip the missed fires — no catch-up burst (bed carries the room)
    while(st.nextT<now-0.05){st.prevFire=st.nextT;st.nextT+=effPer(row)*driftFactor(i,st.cyc++);}
    while(st.nextT<now+horizon){
      st.pending.push(playTone(st.nextT,i,row));
      st.q.push(st.nextT);
      st.nextT+=effPer(row)*driftFactor(i,st.cyc++);
    }
  }
}

/* cancel tones scheduled in the future (used when the layout itself changes) */
function killPending(st,now){
  for(const h of st.pending){
    if(h.t>now+0.05){
      try{
        h.g.gain.cancelScheduledValues(0);
        h.g.gain.setValueAtTime(0,now);
        for(const s of h.srcs)s.stop(now+0.02);
      }catch(e){}
    }
  }
  st.pending=st.pending.filter(h=>h.t<=now+0.05);
}

/* new layout (palette / seed / reroll): fresh phases, speaks again quickly */
function onLayout(){
  if(!ctx)return;
  const now=ctx.currentTime;
  for(let i=0;i<8;i++){
    const st=rt[i],row=ST.rows[i];
    if(!st||!row)continue;
    killPending(st,now);
    st.q=st.q.filter(x=>x<=now);
    const p=effPer(row);
    st.nextT=now+0.4+(row.phase%p)*0.5;
    st.prevFire=st.nextT-p;
    st.cyc=0;                     // fresh layout restarts the drift sequence
  }
  applyLive();
  tick();
}

function nudgePhases(){
  if(!ctx)return;
  const now=ctx.currentTime;
  const nAct=clamp(ST.layers,3,8);
  for(let i=0;i<nAct;i++){
    const st=rt[i],row=ST.rows[i];
    if(!st||!row)continue;
    killPending(st,now);
    st.q=st.q.filter(x=>x<=now);
    const p=effPer(row);
    st.nextT=now+runRng.range(0.3,p);
    st.prevFire=st.nextT-p;
    st.cyc=0;
  }
  tick();
}

/* ----- transport ----- */
function play(){
  if(!ctx){initAudio();startTransport();}
  if(ctx.state==='suspended')ctx.resume();
  running=true;
  N.master.gain.setTargetAtTime(Math.pow(clamp(ST.vol,0,100)/100,1.6),ctx.currentTime,0.4);
  window.__studio={ctx,tap:N.analyser,play,pause,version:'02-drift'};
  if(D.onPlayState)D.onPlayState(true);
}
function pause(){
  if(!ctx||!running)return;
  running=false;
  N.master.gain.setTargetAtTime(0,ctx.currentTime,0.08);
  setTimeout(()=>{if(!running&&ctx&&ctx.state==='running')ctx.suspend();},350);
  if(D.onPlayState)D.onPlayState(false);
}
function toggle(){running?pause():play();}

/* ----- repeat horizon: LCM of the loop periods, in tenths of a second ----- */
function gcdBig(a,b){while(b){const t=a%b;a=b;b=t;}return a;}
function repeatHorizon(){
  if(!ST)return -1n;
  if(ST.tape&&ST.dd>0)return null;                 // 'never (tape drift)'
  const ps=ST.rows.slice(0,clamp(ST.layers,3,8)).filter(r=>r&&!r.mute)
    .map(r=>BigInt(Math.max(1,Math.round(effPer(r)*10))));
  if(!ps.length)return -1n;
  let l=ps[0];
  for(let i=1;i<ps.length;i++)l=l/gcdBig(l,ps[i])*ps[i];
  return l;
}

/* ----- exports ----- */
const D=window.Drift={
  RNG,clamp,midiToFreq,PALETTES,genRows,
  bind,play,pause,toggle,applyLive,onLayout,nudgePhases,rebuildReverb,repeatHorizon,effPer,
  isPlaying:()=>running,
  now:()=>ctx?ctx.currentTime:0,
  t0:()=>transT0,
  rt:()=>rt,
  analyser:()=>N?N.analyser:null,
  onPlayState:null,
};
})();

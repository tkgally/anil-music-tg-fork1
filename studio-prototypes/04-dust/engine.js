/* ---------------------------------------------------------------------
   04 · Dust — engine.js  (audio graph, scheduler, voices)

   Concept: the lo-fi hip-hop recipe as *subtraction* — a 4-chord jazz
   loop (one chord per bar, rootless voicings packed in MIDI 55–74)
   played by an FM Rhodes through tape wow+flutter, a lazy swung 2-bar
   drum pattern with no fills ever, vinyl crackle + rain as the bed,
   and everything lowpassed under a wool blanket.

   Parameter model: main.js owns the state object S and calls
   Dust.applyParams(S) on every change. Mix/filter/texture params land
   immediately (setTargetAtTime on static bus nodes); structural params
   (tempo, swing, groove, seed) are read per bar by the scheduler;
   chord set + key latch at the next 4-bar loop boundary.

   Scheduling: lookahead setInterval(500 ms) over ctx.currentTime,
   horizon 6 s visible / 12 s hidden. Every bar is derived
   deterministically from (seed, barIndex) — same seed, same piece,
   robust across pause/resume and hidden-tab throttling.
--------------------------------------------------------------------- */
'use strict';

/* ===== seeded RNG + helpers (Daysong idioms) ===== */
function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;
let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;
return((t^(t>>>14))>>>0)/4294967296;};}
class RNG{constructor(s){this.f=mulberry32(s);}next(){return this.f();}
range(a,b){return a+(b-a)*this.f();}int(a,b){return Math.floor(this.range(a,b+1));}
pick(a){return a[Math.floor(this.f()*a.length)];}chance(p){return this.f()<p;}}
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const midiToFreq=m=>440*Math.pow(2,(m-69)/12);
function scrap(src,parts){src.onended=()=>{for(const n of parts){try{n.disconnect();}catch(e){}}};}
/* mix a seed and an index into a fresh 32-bit stream seed */
function hash2(a,b){let h=(a^0x9E3779B9)>>>0;h=Math.imul(h^(b>>>0),2654435761)>>>0;
h^=h>>>13;h=Math.imul(h,0x5bd1e995)>>>0;h^=h>>>15;return h>>>0;}

/* impulse: exponential decay with a lowpass swept down the tail (air
   absorption) and a short fade-in to soften the direct spike */
function makeImpulse(ctx,rng,seconds,decay){
  const rate=ctx.sampleRate,len=Math.floor(rate*seconds),fade=Math.floor(rate*0.02);
  const buf=ctx.createBuffer(2,len,rate);
  for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);let lp=0;
    for(let i=0;i<len;i++){const t=i/len;
      const k=Math.exp(-2*Math.PI*(10000*Math.pow(0.1,t))/rate); // 10k -> 1k across tail
      lp=k*lp+(1-k)*(rng.next()*2-1);
      d[i]=lp*Math.pow(1-t,decay)*(i<fade?i/fade:1)*3;}}
  return buf;
}

/* ===== harmony ===== */
const NOTE_NAMES=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
/* Each chord: off = root offset from the key (semitones), q = label
   suffix, ints = intervals above the chord root for the rootless
   4-note voicing. scale = melody pool (pentatonic keeps it safe). */
const PROGS={
  attic:{ scale:[0,2,4,7,9], chords:[            // ii9 – V13 – Imaj9 – vi9
    {off:2, q:'m9',   ints:[3,7,10,14]},
    {off:7, q:'13',   ints:[4,10,14,21]},
    {off:0, q:'maj9', ints:[4,7,11,14]},
    {off:9, q:'m9',   ints:[3,7,10,14]} ]},
  rainy:{ scale:[0,3,5,7,10], chords:[           // i9 – bVImaj9 – bIIImaj7 – bVII9
    {off:0, q:'m9',   ints:[3,7,10,14]},
    {off:8, q:'maj9', ints:[4,7,11,14]},
    {off:3, q:'maj7', ints:[4,7,11,14]},
    {off:10,q:'9',    ints:[4,10,14,19]} ]},
  sunday:{ scale:[0,2,4,7,9], chords:[           // Imaj9 – iii7 – IVmaj9 – ii9
    {off:0, q:'maj9', ints:[4,7,11,14]},
    {off:4, q:'m7',   ints:[0,3,7,10]},
    {off:5, q:'maj9', ints:[4,7,11,14]},
    {off:2, q:'m9',   ints:[3,7,10,14]} ]},
};

/* nearest-tone voice-leading into MIDI 55–74 (adapted from Daysong) */
function voiceChord(rootPc,ints,prev){
  const lo=55,hi=74;
  const pcs=[...new Set(ints.map(i=>(rootPc+i)%12))];
  let v;
  if(!prev){
    v=[];let last=lo-1;
    for(const pc of pcs){
      let m=last+1;
      while(((m%12)+12)%12!==pc)m++;
      while(m>hi)m-=12;
      v.push(m);last=Math.max(last,m);
    }
  }else{
    v=pcs.map(pc=>{
      let best=null,bd=1e9;
      for(let m=lo;m<=hi;m++){
        if(m%12!==pc)continue;
        let d=1e9;
        for(const p of prev)d=Math.min(d,Math.abs(m-p));
        if(d<bd){bd=d;best=m;}
      }
      return best;
    });
    v=[...new Set(v)];
    for(const pc of pcs){                        // collisions can drop a tone
      if(v.length>=pcs.length)break;
      for(let m=hi;m>=lo;m--){
        if(m%12===pc&&!v.includes(m)){v.push(m);break;}
      }
    }
  }
  v.sort((a,b)=>a-b);
  return v;
}

/* =====================================================================
   The instrument
===================================================================== */
const Dust={
  ctx:null,playing:false,everPlayed:false,
  P:null,N:{},
  barIndex:0,nextBarTime:0,lastBarDur:3,
  nextPopTime:0,rngPop:null,seedUsed:null,
  curProg:'attic',curKey:5,prevVoicing:null,
  patCache:null,
  barLog:[],popMarks:[],
  wow:{t0:0,f:0.7,phase:0},wobDepth:1,
  elapsedBase:0,resumeMark:0,timer:null,
};

/* ----- graph ----- */
Dust.build=function(){
  const P=this.P;
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  this.ctx=ctx;const N=this.N;const t0=ctx.currentTime+0.05;
  this.seedUsed=P.seed;
  this.rngPop=new RNG(hash2(P.seed,0xC0FFEE));

  /* master: mix -> tone (Dust closes the lid) -> volume -> quiet-listening
     tilt -> glue -> limiter -> analyser -> out */
  N.mix=ctx.createGain();
  N.tone=ctx.createBiquadFilter();N.tone.type='lowpass';N.tone.Q.value=0.5;
  N.tone.frequency.value=4200;
  N.master=ctx.createGain();N.master.gain.value=0;
  N.tiltLo=ctx.createBiquadFilter();N.tiltLo.type='lowshelf';N.tiltLo.frequency.value=150;N.tiltLo.gain.value=0;
  N.tiltHi=ctx.createBiquadFilter();N.tiltHi.type='highshelf';N.tiltHi.frequency.value=8000;N.tiltHi.gain.value=0;
  N.comp=ctx.createDynamicsCompressor();
  N.comp.threshold.value=-18;N.comp.knee.value=24;N.comp.ratio.value=2.5;
  N.comp.attack.value=0.01;N.comp.release.value=0.25;
  N.limiter=ctx.createDynamicsCompressor();
  N.limiter.threshold.value=-4;N.limiter.knee.value=0;N.limiter.ratio.value=16;
  N.limiter.attack.value=0.001;N.limiter.release.value=0.1;
  N.analyser=ctx.createAnalyser();N.analyser.fftSize=2048;
  N.mix.connect(N.tone);N.tone.connect(N.master);N.master.connect(N.tiltLo);
  N.tiltLo.connect(N.tiltHi);N.tiltHi.connect(N.comp);N.comp.connect(N.limiter);
  N.limiter.connect(N.analyser);N.analyser.connect(ctx.destination);

  /* shared noise: ONE seeded 2 s loop; every noise use reads it */
  const nr=new RNG((P.seed^0x9e3779b9)>>>0);
  N.noiseBuf=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
  const nd=N.noiseBuf.getChannelData(0);
  for(let i=0;i<nd.length;i++)nd[i]=nr.next()*2-1;

  /* reverb: small dark room */
  N.convolver=ctx.createConvolver();
  N.convolver.buffer=makeImpulse(ctx,new RNG((P.seed^0x51ed27)>>>0),1.6,3.0);
  N.verbRet=ctx.createGain();N.verbRet.gain.value=1;
  N.convolver.connect(N.verbRet);N.verbRet.connect(N.mix);

  /* sidechain duck: keys + melody + texture ride under the kick */
  N.duck=ctx.createGain();N.duck.gain.value=1;N.duck.connect(N.mix);

  /* tape: keys+melody -> delay whose time is wobbled (wow sine + flutter
     smoothed-random) -> very slow pan drift -> duck. Modulating delayTime
     is the whole tape trick: pitch deviation = d(delay)/dt. */
  N.tapeIn=ctx.createGain();
  N.tape=ctx.createDelay(0.1);N.tape.delayTime.value=0.012;
  N.tapePan=ctx.createStereoPanner();
  N.tapeIn.connect(N.tape);N.tape.connect(N.tapePan);N.tapePan.connect(N.duck);
  N.wowOsc=ctx.createOscillator();N.wowOsc.frequency.value=0.7;
  N.wowG=ctx.createGain();N.wowG.gain.value=0;
  N.wowOsc.connect(N.wowG);N.wowG.connect(N.tape.delayTime);N.wowOsc.start(t0);
  this.wow={t0,f:0.7,phase:0};
  N.flutSrc=ctx.createBufferSource();N.flutSrc.buffer=N.noiseBuf;N.flutSrc.loop=true;
  N.flutSrc.playbackRate.value=7/ctx.sampleRate;   // ~7 fresh samples/s = smoothed-random LFO
  N.flutG=ctx.createGain();N.flutG.gain.value=0;
  N.flutSrc.connect(N.flutG);N.flutG.connect(N.tape.delayTime);N.flutSrc.start(t0);
  N.panLfo=ctx.createOscillator();N.panLfo.frequency.value=0.031;
  N.panLfoG=ctx.createGain();N.panLfoG.gain.value=0.07;
  N.panLfo.connect(N.panLfoG);N.panLfoG.connect(N.tapePan.pan);N.panLfo.start(t0);

  /* keys: notes -> bus -> lowpass 2200 (the wool blanket) -> level -> tape */
  N.keysBus=ctx.createGain();
  N.keysLP=ctx.createBiquadFilter();N.keysLP.type='lowpass';N.keysLP.frequency.value=2200;N.keysLP.Q.value=0.6;
  N.keysLvl=ctx.createGain();
  N.keysBus.connect(N.keysLP);N.keysLP.connect(N.keysLvl);N.keysLvl.connect(N.tapeIn);
  N.keysSend=ctx.createGain();N.keysSend.gain.value=0;
  N.keysLvl.connect(N.keysSend);N.keysSend.connect(N.convolver);
  /* tine partials skip the keys lowpass (they'd vanish) and ride the tape
     directly, very quietly; the master tone still darkens them */
  N.tineG=ctx.createGain();N.tineG.gain.value=1;N.tineG.connect(N.tapeIn);

  /* melody (off by default) */
  N.melBus=ctx.createGain();
  N.melLP=ctx.createBiquadFilter();N.melLP.type='lowpass';N.melLP.frequency.value=1500;N.melLP.Q.value=0.6;
  N.melLvl=ctx.createGain();N.melLvl.gain.value=0;
  N.melBus.connect(N.melLP);N.melLP.connect(N.melLvl);N.melLvl.connect(N.tapeIn);
  N.melSend=ctx.createGain();N.melSend.gain.value=0;
  N.melLvl.connect(N.melSend);N.melSend.connect(N.convolver);

  /* bass: sine + a whisper of saw -> lowpass 150 -> level -> mix (no duck) */
  N.bassBus=ctx.createGain();
  N.bassLP=ctx.createBiquadFilter();N.bassLP.type='lowpass';N.bassLP.frequency.value=150;N.bassLP.Q.value=0.7;
  N.bassLvl=ctx.createGain();
  N.bassBus.connect(N.bassLP);N.bassLP.connect(N.bassLvl);N.bassLvl.connect(N.mix);

  /* drums: per-voice trims -> bus -> lowpass 4200 -> mix (no duck) */
  N.drumBus=ctx.createGain();
  N.drumLP=ctx.createBiquadFilter();N.drumLP.type='lowpass';N.drumLP.frequency.value=4200;N.drumLP.Q.value=0.5;
  N.drumBus.connect(N.drumLP);N.drumLP.connect(N.mix);
  N.kickG=ctx.createGain();N.kickG.connect(N.drumBus);
  N.bbG=ctx.createGain();N.bbG.connect(N.drumBus);
  N.hatG=ctx.createGain();N.hatG.connect(N.drumBus);
  N.rimSend=ctx.createGain();N.rimSend.gain.value=0;N.rimSend.connect(N.convolver);

  /* texture: crackle pops + hiss bed + rain -> duck */
  N.texBus=ctx.createGain();N.texBus.connect(N.duck);
  N.popG=ctx.createGain();N.popG.gain.value=0;N.popG.connect(N.texBus);
  N.hissSrc=ctx.createBufferSource();N.hissSrc.buffer=N.noiseBuf;N.hissSrc.loop=true;
  N.hissLP=ctx.createBiquadFilter();N.hissLP.type='lowpass';N.hissLP.frequency.value=6000;N.hissLP.Q.value=0.5;
  N.hissG=ctx.createGain();N.hissG.gain.value=0;
  N.hissSrc.connect(N.hissLP);N.hissLP.connect(N.hissG);N.hissG.connect(N.texBus);
  N.hissSrc.start(t0);
  /* rain: two decorrelated streams, gently panned, slow density LFO */
  N.rainG=ctx.createGain();N.rainG.gain.value=0;N.rainG.connect(N.texBus);
  N.rainLfo=ctx.createOscillator();N.rainLfo.frequency.value=1/17;
  N.rainLfoG=ctx.createGain();N.rainLfoG.gain.value=0;
  N.rainLfo.connect(N.rainLfoG);N.rainLfoG.connect(N.rainG.gain);N.rainLfo.start(t0);
  for(const[i,rate,pan]of[[0,0.973,-0.3],[1,1.021,0.3]]){
    const src=ctx.createBufferSource();src.buffer=N.noiseBuf;src.loop=true;
    src.playbackRate.value=rate;
    const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=400;hp.Q.value=0.7;
    const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1100;bp.Q.value=0.5;
    const pn=ctx.createStereoPanner();pn.pan.value=pan;
    src.connect(hp);hp.connect(bp);bp.connect(pn);pn.connect(N.rainG);
    src.start(t0,i*0.9);
    N['rainSrc'+i]=src;
  }

  this.applyParams(P);
};

/* =====================================================================
   Live parameter application (no restarts, everything smoothed)
===================================================================== */
Dust.applyParams=function(P){
  this.P=P;
  if(!this.ctx)return;
  const N=this.N,now=this.ctx.currentTime;
  const set=(p,v,tau)=>p.setTargetAtTime(v,now,tau||0.15);
  const d=P.dust/100,g=P.groove/100;
  const lv=x=>Math.pow(x/70,1.6);               // mixer sliders: 70 = tuned mix

  /* volume + quiet-listening tilt (Fletcher–Munson compensation) */
  const v=P.volume/100;
  const vol=Math.pow(v,1.6)*0.88;               // trim tuned against verify.mjs
  if(this.playing)set(N.master.gain,vol,0.08);
  const shelf=clamp(6*(0.7-v),0,5);
  set(N.tiltLo.gain,shelf,0.2);set(N.tiltHi.gain,shelf,0.2);

  /* master tone: Dust closes the lid 6k -> 2.6k (scaled off the adv base) */
  const cut=clamp(P.masterlp*Math.pow(2600/6000,d),1200,9000);
  set(N.tone.frequency,cut,0.2);

  /* tape wobble: wow ±8¢ sine + flutter ±1.5¢ smoothed-random, both
     scaled by Dust (nominal at the default 45) and the depth slider */
  const depth=clamp(d/0.45,0,2.2)*(P.wobdepth/50);
  this.wobDepth=depth;
  const c2a=(c,f)=>(Math.pow(2,c/1200)-1)/(2*Math.PI*Math.max(0.05,f)); // cents -> delay amp
  if(Math.abs(P.wobrate-this.wow.f)>1e-6){       // keep viz phase continuous
    this.wow.phase+=this.wow.f*(now-this.wow.t0);
    this.wow.t0=now;this.wow.f=P.wobrate;
  }
  set(N.wowOsc.frequency,P.wobrate,0.3);
  set(N.wowG.gain,Math.min(0.009,c2a(8*depth,P.wobrate)),0.3);
  set(N.flutG.gain,Math.min(0.002,c2a(1.5*depth,7)*2),0.3);

  /* bus levels */
  set(N.keysLvl.gain,lv(P.keyslvl)*1.05);
  set(N.tineG.gain,lv(P.keyslvl));
  set(N.melLvl.gain,Math.pow(P.melody/100,1.3)*0.55);
  set(N.bassLvl.gain,lv(P.basslvl)*0.68);
  set(N.kickG.gain,lv(P.kicklvl)*0.95);
  set(N.bbG.gain,lv(P.bblvl)*0.8);
  set(N.hatG.gain,lv(P.hatlvl)*(0.5+0.55*g));   // groove leans the hats in
  set(N.popG.gain,Math.pow(d,0.9)*0.38,0.2);
  set(N.hissG.gain,0.008+0.023*d,0.3);
  const rainBase=Math.pow(P.rain/100,1.4)*0.3;
  set(N.rainG.gain,rainBase,0.4);
  set(N.rainLfoG.gain,rainBase*0.21,0.4);       // ±2 dB density breathing

  /* reverb sends */
  const rmix=P.reverb/50;
  set(N.keysSend.gain,0.18*rmix,0.2);
  set(N.melSend.gain,0.3*rmix,0.2);
  set(N.rimSend.gain,0.12*rmix,0.2);

  /* seed change: new pattern/pop streams, fresh voice-leading path */
  if(P.seed!==this.seedUsed){
    this.seedUsed=P.seed;
    this.rngPop=new RNG(hash2(P.seed,0xC0FFEE));
    this.patCache=null;
    this.prevVoicing=null;
  }
};

/* =====================================================================
   Scheduler
===================================================================== */
Dust.tick=function(){
  if(!this.playing||!this.ctx)return;
  const now=this.ctx.currentTime;
  const horizon=document.hidden?12:6;

  /* late wake: resume on a fresh bar boundary, never burst catch-up
     (the hiss/rain/keys-tail bed kept sounding, so no hard gap) */
  if(this.nextBarTime<now-0.05)this.nextBarTime=now+0.25;
  while(this.nextBarTime<now+horizon){
    this.scheduleBar(this.barIndex,this.nextBarTime);
    this.nextBarTime+=this.lastBarDur;
    this.barIndex++;
  }

  /* crackle pops: seeded poisson stream */
  const rate=lerp(3,8,this.P.crackle/100)*(0.75+0.5*this.P.dust/100);
  if(this.nextPopTime<now-0.05)this.nextPopTime=now+0.1;
  while(this.nextPopTime<now+horizon){
    this.schedulePop(this.nextPopTime);
    this.nextPopTime+=Math.max(0.02,-Math.log(1-this.rngPop.next()*0.98)/rate);
  }

  this.popMarks=this.popMarks.filter(m=>m.t>now-2);
};

/* drum-pattern grammar, re-rolled every `varbars` bars */
Dust.pattern=function(block){
  const key=this.P.seed+':'+Math.round(this.P.varbars)+':'+block;
  if(this.patCache&&this.patCache.key===key)return this.patCache.pat;
  const r=new RNG(hash2((this.P.seed^0x51ed2705)>>>0,block));
  const droop=[0.52,0.26,0.42,0.22,0.47,0.24,0.4,0.2];  // hat velocity droop
  const pat={hatU:[],hatV:[]};
  for(let i=0;i<16;i++){                                 // 2 bars of 8ths
    pat.hatV.push(clamp(droop[i%8]*(1+(r.next()*2-1)*0.3),0.06,0.75));
    pat.hatU.push(r.next());                             // skip lottery
  }
  pat.kickExtra={half:r.int(0,1),step:r.pick([5,6])};    // and-3 or beat 4
  pat.kickExtraB={half:r.int(0,1),step:r.pick([3,5,6])}; // A' variant
  pat.kickGhost={half:r.int(0,1),step:r.pick([3,7]),u:r.next()};
  pat.accent=r.int(0,15);
  this.patCache={key,pat};
  return pat;
};

Dust.scheduleBar=function(bar,t){
  const P=this.P,N=this.N,ctx=this.ctx,now=ctx.currentTime;
  if(bar%4===0){this.curProg=P.prog;this.curKey=P.key;}  // loop-boundary latch
  const prog=PROGS[this.curProg]||PROGS.attic;
  const key=this.curKey;
  const spb=60/clamp(P.tempo,50,110);
  const barDur=4*spb;this.lastBarDur=barDur;
  const g=P.groove/100,cyc=bar%8,cbar=bar%4;
  const patt=cyc===7?'turn':(cyc<4?'a':'b');
  const swing=clamp(P.swing+(P.groove-50)*0.08,50,66)/100;
  const st=s=>t+(Math.floor(s/2)+(s%2)*swing)*spb;       // swung 8th-step time
  const later=x=>Math.max(now+0.02,x);
  const rng=new RNG(hash2(P.seed,bar*2+1));
  const varb=clamp(Math.round(P.varbars),2,32);
  const pat=this.pattern(Math.floor(bar/varb));
  const half=bar%2;

  /* ---- KEYS: one rootless voicing per bar, sometimes pushed early ---- */
  const ch=prog.chords[cbar];
  const rootPc=(key+ch.off)%12;
  const voicing=voiceChord(rootPc,ch.ints,this.prevVoicing);
  this.prevVoicing=voicing;
  const pushed=(cbar%2===1)&&rng.chance(P.anticip/100);  // into odd bars
  const on0=pushed?t-(1-swing)*spb:t+rng.range(0,0.008); // push = and-of-4
  const kvel=0.5+rng.range(-0.05,0.05);
  for(let i=0;i<voicing.length;i++){                     // lazy upward strum
    this.playKeyNote(later(on0+i*0.013+rng.range(0,0.006)),voicing[i],
      barDur*(pushed?1.12:1),kvel-i*0.02,i>=voicing.length-2);
  }
  if(rng.chance(0.25)){                                  // soft re-strike, beat 3
    for(let i=1;i<voicing.length;i++){
      this.playKeyNote(later(st(4)+i*0.011),voicing[i],spb*1.6,0.3,false);
    }
  }

  /* ---- MELODY: rare answer phrase, only if asked for ---- */
  if(P.melody>0&&cbar===3)this.playPhrase(rng,prog,key,t,spb,swing);

  /* ---- BASS: dotted root pattern, never busy ---- */
  const bmidi=29+(((rootPc-29)%12)+12)%12;               // MIDI 29..40
  this.playBassNote(later(t+0.002),bmidi,spb*1.55,0.72+g*0.08);
  if(rng.chance(0.3*(0.4+1.2*g)))                        // and-of-2 ghost
    this.playBassNote(later(st(3)),bmidi,spb*0.32,0.3);
  this.playBassNote(later(st(4)),bmidi,spb*1.35,0.55);

  /* ---- DRUMS ---- */
  const duckDip=Math.pow(10,-2.5*(P.sidechain/50)/20);
  const kick=(tt,vel)=>{
    this.playKick(tt,vel);
    if(P.sidechain>0){                                   // sidechain pump
      N.duck.gain.setTargetAtTime(duckDip,tt,0.02);
      N.duck.gain.setTargetAtTime(1,tt+0.09,0.18);
    }
  };
  kick(later(t),0.8);
  const ke=patt==='b'?pat.kickExtraB:pat.kickExtra;
  if(g>0.1&&ke.half===half&&cyc!==7)kick(later(st(ke.step)),0.55+0.15*g);
  if(pat.kickGhost.half===half&&pat.kickGhost.u<0.25*g&&cyc!==7)
    kick(later(st(pat.kickGhost.step)),0.35);

  const bb=P.backbeat==='snare'
    ?(tt,vel,r)=>this.playSnare(tt,vel*0.9,r)
    :(tt,vel,r)=>this.playRim(tt,vel,r);
  const bvel=0.5*(0.8+0.4*g);
  bb(later(st(2)),bvel,rng);
  bb(later(st(6)),bvel*rng.range(0.92,1),rng);

  const dens=clamp((P.hatd/100)*(0.35+1.1*g),0,1);
  const skipP=0.08+(1-dens)*0.55;
  for(let s=0;s<8;s++){
    const idx=half*8+s;
    if(pat.hatU[idx]<skipP)continue;
    let hv=pat.hatV[idx]*(idx===pat.accent?1.3:1);
    if(cyc===7&&s>=4){if(s===4)hv*=0.5;else continue;}   // turnaround = space
    this.playHat(later(st(s)+rng.range(-0.005,0.005)),hv,rng);
  }

  /* ---- log for status line + viz ---- */
  this.barLog.push({t,dur:barDur,bar,label:NOTE_NAMES[rootPc]+ch.q,patt,
                    varIn:varb-(bar%varb)});
  if(this.barLog.length>40)this.barLog.splice(0,this.barLog.length-40);
};

/* =====================================================================
   Voices
===================================================================== */
Dust.noiseSrc=function(t,dur,offset){
  const s=this.ctx.createBufferSource();
  s.buffer=this.N.noiseBuf;s.loop=true;
  s.start(t,offset%2);s.stop(t+dur);
  return s;
};

/* FM Rhodes: 1:1 mod ratio, index enveloped high->low (velocity opens
   it), tine partial ~14:1 quiet & fast (routed past the keys lowpass) */
Dust.playKeyNote=function(t,midi,dur,vel,tine){
  const ctx=this.ctx,f=midiToFreq(midi);
  const car=ctx.createOscillator();car.frequency.value=f;
  const mod=ctx.createOscillator();mod.frequency.value=f;
  const mg=ctx.createGain();
  mg.gain.setValueAtTime(f*(0.55+vel*1.5),t);
  mg.gain.exponentialRampToValueAtTime(f*0.04,t+1.3);
  mod.connect(mg);mg.connect(car.frequency);
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.17*vel,t+0.012);
  g.gain.exponentialRampToValueAtTime(0.17*vel*0.32,t+Math.max(0.4,dur));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.9);
  g.gain.linearRampToValueAtTime(0,t+dur+0.95);
  car.connect(g);g.connect(this.N.keysBus);
  const parts=[g,mg,mod];
  if(tine){
    const tn=ctx.createOscillator();tn.frequency.value=Math.min(f*13.9,11000);
    const tg=ctx.createGain();
    tg.gain.setValueAtTime(0,t);
    tg.gain.linearRampToValueAtTime(0.028*vel,t+0.002);
    tg.gain.exponentialRampToValueAtTime(0.0001,t+0.07);
    tg.gain.linearRampToValueAtTime(0,t+0.075);
    tn.connect(tg);tg.connect(this.N.tineG);
    tn.start(t);tn.stop(t+0.09);
    parts.push(tn,tg);
  }
  car.start(t);mod.start(t);
  car.stop(t+dur+1);mod.stop(t+dur+1);
  scrap(car,parts);
};

Dust.playBassNote=function(t,midi,dur,vel){
  const ctx=this.ctx,f=midiToFreq(midi);
  const sub=ctx.createOscillator();sub.frequency.value=f;
  const saw=ctx.createOscillator();saw.type='sawtooth';saw.frequency.value=f;
  const sawG=ctx.createGain();sawG.gain.value=0.22;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.5*vel,t+0.02);
  g.gain.exponentialRampToValueAtTime(0.5*vel*0.7,t+Math.max(0.1,dur));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.12);
  g.gain.linearRampToValueAtTime(0,t+dur+0.15);
  sub.connect(g);saw.connect(sawG);sawG.connect(g);
  g.connect(this.N.bassBus);
  sub.start(t);saw.start(t);
  sub.stop(t+dur+0.2);saw.stop(t+dur+0.2);
  scrap(sub,[g,saw,sawG]);
};

Dust.playMelNote=function(t,midi,dur,vel){
  const ctx=this.ctx;
  const o=ctx.createOscillator();o.type='triangle';o.frequency.value=midiToFreq(midi);
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.22*vel,t+0.025);
  g.gain.exponentialRampToValueAtTime(0.22*vel*0.3,t+Math.max(0.1,dur));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.3);
  g.gain.linearRampToValueAtTime(0,t+dur+0.33);
  o.connect(g);g.connect(this.N.melBus);
  o.start(t);o.stop(t+dur+0.4);
  scrap(o,[g]);
};

/* 2–3 scale tones, behind the beat — a memory of a melody, not a hook */
Dust.playPhrase=function(rng,prog,key,t,spb,swing){
  const cap=clamp(Math.round(this.P.melcap),60,79);
  const pool=[];
  for(let m=cap-14;m<=cap;m++)
    if(prog.scale.includes(((m-key)%12+12)%12))pool.push(m);
  if(!pool.length)return;
  const count=rng.chance(0.45)?3:2;
  let s=rng.pick([4,5]);
  let idx=pool.length-1-rng.int(0,2);
  for(let i=0;i<count&&s<8;i++){
    const tt=t+(Math.floor(s/2)+(s%2)*swing)*spb+0.03;   // 30 ms lazy
    this.playMelNote(Math.max(this.ctx.currentTime+0.02,tt),
      pool[clamp(idx,0,pool.length-1)],spb*(i===count-1?1.5:0.8),0.35);
    idx+=rng.pick([-2,-1,-1,1]);
    s+=rng.pick([1,2]);
  }
};

/* kick: Daysong's, click removed (the bus lowpass would kill it anyway) */
Dust.playKick=function(t,vel){
  const ctx=this.ctx;
  const o=ctx.createOscillator();
  o.frequency.setValueAtTime(118,t);
  o.frequency.exponentialRampToValueAtTime(41,t+0.1);
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.85*vel,t+0.005);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.3);
  g.gain.linearRampToValueAtTime(0,t+0.32);
  o.connect(g);g.connect(this.N.kickG);
  o.start(t);o.stop(t+0.34);
  scrap(o,[g]);
};

/* rim: 1700 Hz bandpassed click + 620 Hz tone, 35 ms */
Dust.playRim=function(t,vel,rng){
  const ctx=this.ctx;
  const n=this.noiseSrc(t,0.05,rng.range(0,1.9));
  const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1700;bp.Q.value=4.5;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.55*vel,t+0.002);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.035);
  g.gain.linearRampToValueAtTime(0,t+0.04);
  n.connect(bp);bp.connect(g);
  g.connect(this.N.bbG);g.connect(this.N.rimSend);
  const tone=ctx.createOscillator();tone.type='triangle';tone.frequency.value=620;
  const tg=ctx.createGain();
  tg.gain.setValueAtTime(0,t);
  tg.gain.linearRampToValueAtTime(0.2*vel,t+0.003);
  tg.gain.exponentialRampToValueAtTime(0.0001,t+0.05);
  tg.gain.linearRampToValueAtTime(0,t+0.055);
  tone.connect(tg);tg.connect(this.N.bbG);tg.connect(this.N.rimSend);
  tone.start(t);tone.stop(t+0.06);
  scrap(n,[bp,g]);scrap(tone,[tg]);
};

Dust.playSnare=function(t,vel,rng){
  const ctx=this.ctx;
  const n=this.noiseSrc(t,0.17,rng.range(0,1.9));
  const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1900;bp.Q.value=0.9;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.45*vel,t+0.003);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.15);
  g.gain.linearRampToValueAtTime(0,t+0.16);
  n.connect(bp);bp.connect(g);
  g.connect(this.N.bbG);g.connect(this.N.rimSend);
  const tone=ctx.createOscillator();tone.type='triangle';tone.frequency.value=195;
  const tg=ctx.createGain();
  tg.gain.setValueAtTime(0,t);
  tg.gain.linearRampToValueAtTime(0.2*vel,t+0.003);
  tg.gain.exponentialRampToValueAtTime(0.0001,t+0.07);
  tg.gain.linearRampToValueAtTime(0,t+0.08);
  tone.connect(tg);tg.connect(this.N.bbG);
  tone.start(t);tone.stop(t+0.09);
  scrap(n,[bp,g]);scrap(tone,[tg]);
};

/* closed hat, dark by design: 3 kHz highpass into the 4.2 kHz bus lowpass */
Dust.playHat=function(t,vel,rng){
  const ctx=this.ctx;
  const n=this.noiseSrc(t,0.08,rng.range(0,1.9));
  const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=3000;hp.Q.value=0.7;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(0.28*vel,t+0.003);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.055);
  g.gain.linearRampToValueAtTime(0,t+0.06);
  n.connect(hp);hp.connect(g);g.connect(this.N.hatG);
  scrap(n,[hp,g]);
};

/* one vinyl pop: 1–3 ms burst, amp ∝ u², its own band in 1–4 kHz */
Dust.schedulePop=function(t){
  const r=this.rngPop,ctx=this.ctx;
  const dur=0.001+r.next()*0.0025;
  const u=r.next();
  const n=this.noiseSrc(t,dur+0.004,r.range(0,1.9));
  const bp=ctx.createBiquadFilter();bp.type='bandpass';
  bp.frequency.value=1000+r.next()*3000;bp.Q.value=1.1;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(u*u,t+0.0008);
  g.gain.linearRampToValueAtTime(0,t+dur);
  n.connect(bp);bp.connect(g);g.connect(this.N.popG);
  scrap(n,[bp,g]);
  this.popMarks.push({t,u});
};

/* =====================================================================
   Transport + read-only accessors for main.js
===================================================================== */
Dust.play=function(){
  if(!this.ctx)this.build();
  const ctx=this.ctx;
  if(ctx.state==='suspended')ctx.resume();
  if(this.playing)return;
  this.playing=true;
  const now=ctx.currentTime;
  this.resumeMark=now;
  const first=!this.everPlayed;
  if(first){
    this.everPlayed=true;
    this.nextBarTime=now+0.15;
    this.nextPopTime=now+0.3;
    window.__studio={ctx,tap:this.N.analyser,version:'04-dust',
      play:()=>Dust.play(),pause:()=>Dust.pause()};
  }
  /* rise from silence on every (re)start */
  const target=Math.pow(this.P.volume/100,1.6)*0.88;
  this.N.master.gain.cancelScheduledValues(now);
  this.N.master.gain.setValueAtTime(Math.min(this.N.master.gain.value,target*0.25),now);
  this.N.master.gain.setTargetAtTime(target,now,first?0.8:0.4);
  if(!this.timer)this.timer=setInterval(()=>this.tick(),500);
  this.tick();
};

Dust.pause=function(){
  if(!this.playing||!this.ctx)return;
  this.playing=false;
  const ctx=this.ctx,now=ctx.currentTime;
  this.elapsedBase+=now-this.resumeMark;
  this.N.master.gain.cancelScheduledValues(now);
  this.N.master.gain.setTargetAtTime(0.0001,now,0.06);
  setTimeout(()=>{if(!this.playing)ctx.suspend();},280);
};

Dust.elapsed=function(){
  if(!this.ctx)return 0;
  return this.elapsedBase+(this.playing?this.ctx.currentTime-this.resumeMark:0);
};

Dust.currentBarInfo=function(){
  if(!this.ctx||!this.barLog.length)return null;
  const now=this.ctx.currentTime;
  let cur=null;
  for(const b of this.barLog){if(b.t<=now+0.02)cur=b;else break;}
  return cur||this.barLog[0];
};

Dust.cyclePos=function(){                        // 0..1 over the 8-bar cycle
  const b=this.currentBarInfo();
  if(!b||!this.ctx)return 0;
  const f=clamp((this.ctx.currentTime-b.t)/b.dur,0,1);
  return ((b.bar%8)+f)/8;
};

Dust.wobbleValue=function(){                     // wow LFO, tracked analytically
  if(!this.ctx)return 0;
  const w=this.wow;
  return Math.sin(2*Math.PI*(w.phase+w.f*(this.ctx.currentTime-w.t0)));
};

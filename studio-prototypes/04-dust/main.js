/* ---------------------------------------------------------------------
   04 · Dust — main.js
   State, UI wiring, presets, hash/localStorage persistence, the
   spinning-record visualization and the status line. Audio lives in
   engine.js (the Dust object).
--------------------------------------------------------------------- */
'use strict';

/* ----- state ----- */
function todaySeed(){
  const d=new Date();
  return (d.getFullYear()%100)*10000+(d.getMonth()+1)*100+d.getDate();
}

const DEFAULTS={
  seed:todaySeed(),volume:70,preset:'cafe',
  tempo:76,dust:45,groove:50,rain:30,prog:'attic',
  key:5,melody:0,melcap:76,
  swing:57,backbeat:'rim',hatd:60,anticip:40,varbars:8,
  kicklvl:70,bblvl:70,hatlvl:70,basslvl:70,keyslvl:70,
  sidechain:50,wobrate:0.7,wobdepth:50,crackle:50,masterlp:6000,
  reverb:50,
};

/* short keys for the hash */
const HKEYS={
  seed:'seed',volume:'vol',preset:'pr',tempo:'tp',dust:'du',groove:'gr',
  rain:'ra',prog:'ch',key:'ky',melody:'me',melcap:'mc',swing:'sw',
  backbeat:'bk',hatd:'hd',anticip:'an',varbars:'vb',
  kicklvl:'vk',bblvl:'vb2',hatlvl:'vh',basslvl:'vs',keyslvl:'vy',
  sidechain:'sc',wobrate:'wr',wobdepth:'wd',crackle:'cr',masterlp:'lp',
  reverb:'rv',
};
const STRINGS=['preset','prog','backbeat'];
const LSKEY='proto-04-dust';

const PRESETS={
  '3am':   {tempo:68,dust:65,groove:35,rain:60,prog:'rainy'},
  'cafe':  {tempo:76,dust:45,groove:50,rain:30,prog:'attic'},
  'tape':  {tempo:76,dust:85,groove:45,rain:0, prog:'attic'},
  'sunday':{tempo:82,dust:30,groove:60,rain:15,prog:'sunday'},
};
const PRESET_FIELDS=['tempo','dust','groove','rain','prog'];

let S=Object.assign({},DEFAULTS);

/* ----- persistence: hash beats localStorage beats defaults ----- */
function serialize(){
  const parts=['v=1'];
  for(const k in HKEYS){
    const v=S[k];
    if(k!=='seed'&&String(v)===String(DEFAULTS[k]))continue;
    parts.push(HKEYS[k]+'='+encodeURIComponent(v));
  }
  return parts.join('&');
}

function deserialize(str,into){
  const rev={};
  for(const k in HKEYS)rev[HKEYS[k]]=k;
  for(const pair of str.replace(/^#/,'').split('&')){
    const i=pair.indexOf('=');
    if(i<0)continue;
    const k=rev[pair.slice(0,i)];
    if(!k)continue;
    let v=decodeURIComponent(pair.slice(i+1));
    if(STRINGS.includes(k))into[k]=v;
    else{v=Number(v);if(isFinite(v))into[k]=v;}
  }
}

function validate(s){
  const num=(k,lo,hi)=>{s[k]=clamp(Number(s[k])||0,lo,hi);};
  num('volume',0,100);num('tempo',62,92);num('dust',0,100);
  num('groove',0,100);num('rain',0,100);num('key',0,11);
  num('melody',0,100);num('melcap',64,79);num('swing',50,66);
  num('hatd',0,100);num('anticip',0,100);num('varbars',2,16);
  num('kicklvl',0,100);num('bblvl',0,100);num('hatlvl',0,100);
  num('basslvl',0,100);num('keyslvl',0,100);num('sidechain',0,100);
  num('wobrate',0.2,1.5);num('wobdepth',0,100);num('crackle',0,100);
  num('masterlp',2000,9000);num('reverb',0,100);
  const sd=Math.floor(Number(s.seed));                 // 0 is a valid seed
  s.seed=(isFinite(sd)&&sd>=0)?sd:todaySeed();
  s.tempo=Math.round(s.tempo);s.key=Math.round(s.key);
  s.melcap=Math.round(s.melcap);s.varbars=Math.round(s.varbars);
  if(!PROGS[s.prog])s.prog='attic';
  if(s.backbeat!=='rim'&&s.backbeat!=='snare')s.backbeat='rim';
  if(s.preset&&!PRESETS[s.preset])s.preset='';
}

let saveTimer=null;
function save(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    const str=serialize();
    try{history.replaceState(null,'','#'+str);}catch(e){}
    try{localStorage.setItem(LSKEY,str);}catch(e){}
  },150);
}

function load(){
  let src=null;
  if(location.hash.length>2)src=location.hash;
  else{try{src=localStorage.getItem(LSKEY);}catch(e){}}
  if(src)deserialize(src,S);
  validate(S);
}

/* ----- UI wiring ----- */
const $=id=>document.getElementById(id);

const FMT={
  tempo:v=>v+' bpm',swing:v=>v+'%',wobrate:v=>Number(v).toFixed(2)+' Hz',
  masterlp:v=>v+' Hz',varbars:v=>v+' bars',
  melcap:v=>NOTE_NAMES[v%12]+(Math.floor(v/12)-1),
};
const SLIDERS=['volume','tempo','dust','groove','rain','melody','melcap',
  'swing','hatd','anticip','varbars','kicklvl','bblvl','hatlvl','basslvl',
  'keyslvl','sidechain','wobrate','wobdepth','crackle','masterlp','reverb'];

function refreshUI(){
  for(const k of SLIDERS){
    const el=$(k);if(!el)continue;
    el.value=S[k];
    const out=$(k+'-out');
    if(out)out.textContent=FMT[k]?FMT[k](S[k]):String(S[k]);
  }
  $('seed').value=S.seed;
  $('key').value=S.key;
  $('backbeat').value=S.backbeat;
  refreshChips();
}

function refreshChips(){
  const mark=(ch,on)=>{
    ch.classList.toggle('on',on);
    ch.setAttribute('aria-pressed',on?'true':'false');
  };
  document.querySelectorAll('#presets .chip').forEach(ch=>
    mark(ch,ch.dataset.preset===S.preset));
  document.querySelectorAll('#progs .chip').forEach(ch=>
    mark(ch,ch.dataset.prog===S.prog));
}

function changed(fromPreset){
  /* the chip only detaches when a field the presets actually set diverges;
     volume, seed and the other advanced params keep it */
  if(!fromPreset&&S.preset){
    const p=PRESETS[S.preset];
    if(!p||PRESET_FIELDS.some(f=>String(S[f])!==String(p[f])))S.preset='';
  }
  validate(S);
  Dust.applyParams(S);
  refreshChips();
  save();
}

function wire(){
  const keySel=$('key');
  NOTE_NAMES.forEach((n,i)=>{
    const o=document.createElement('option');
    o.value=i;o.textContent=n;
    keySel.appendChild(o);
  });

  for(const k of SLIDERS){
    const el=$(k);if(!el)continue;
    el.addEventListener('input',()=>{
      S[k]=Number(el.value);
      const out=$(k+'-out');
      if(out)out.textContent=FMT[k]?FMT[k](S[k]):String(S[k]);
      changed(false);
    });
  }
  keySel.addEventListener('change',()=>{S.key=Number(keySel.value);changed(false);});
  $('backbeat').addEventListener('change',()=>{S.backbeat=$('backbeat').value;changed(false);});
  $('seed').addEventListener('change',()=>{
    const raw=$('seed').value.trim();
    S.seed=raw===''?todaySeed():Number(raw);       // 0 is a valid seed
    changed(false);                                // validate() vets it
    $('seed').value=S.seed;                        // input shows the seed in use
  });

  $('reroll').addEventListener('click',()=>{
    const r=new RNG((Date.now()^(performance.now()*1000))>>>0);
    S.seed=r.int(1,999999);
    $('seed').value=S.seed;
    changed(false);
  });
  $('reset').addEventListener('click',()=>{
    clearTimeout(saveTimer);                     // a pending save must not undo the reset
    S=Object.assign({},DEFAULTS,{seed:todaySeed()});
    try{localStorage.removeItem(LSKEY);}catch(e){}
    try{history.replaceState(null,'',location.pathname);}catch(e){}
    refreshUI();
    Dust.applyParams(S);
  });

  document.querySelectorAll('#presets .chip').forEach(ch=>{
    ch.addEventListener('click',()=>{
      for(const f of PRESET_FIELDS)S[f]=DEFAULTS[f];
      Object.assign(S,PRESETS[ch.dataset.preset]);
      S.preset=ch.dataset.preset;
      refreshUI();
      changed(true);
    });
  });
  document.querySelectorAll('#progs .chip').forEach(ch=>{
    ch.addEventListener('click',()=>{
      S.prog=ch.dataset.prog;
      changed(false);
    });
  });

  /* transport */
  const playBtn=$('play');
  playBtn.addEventListener('click',toggle);
  document.addEventListener('keydown',e=>{
    if(e.code!=='Space')return;
    const t=e.target,tag=t&&t.tagName;
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||tag==='SUMMARY')return;
    if(t!==playBtn&&tag==='BUTTON')return;
    e.preventDefault();
    toggle();
  });

  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)Dust.tick();
  });
}

function toggle(){
  if(Dust.playing)Dust.pause();else Dust.play();
  const on=Dust.playing;
  $('play').setAttribute('aria-pressed',on?'true':'false');
  $('icon-play').style.display=on?'none':'';
  $('icon-pause').style.display=on?'':'none';
  updateStatus();
}

/* ----- status line + clock (1x per second) ----- */
function updateStatus(){
  const el=$('status');
  const secs=Math.floor(Dust.elapsed());
  $('clock').textContent=Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0');
  if(!Dust.everPlayed){el.textContent='press play — needle down';return;}
  const b=Dust.currentBarInfo();
  if(!b){el.textContent=Dust.playing?'counting in…':'paused';return;}
  const patt=b.patt==='turn'?'turnaround':b.patt;
  el.textContent=(Dust.playing?'':'paused · ')+'bar '+(b.bar+1)+' · '+b.label+
    ' · pattern '+patt+' · next variation '+b.varIn+(b.varIn===1?' bar':' bars');
}
setInterval(()=>{if(!document.hidden)updateStatus();},1000);

/* ----- spinning-record visualization ----- */
const canvas=$('viz');
const cx2d=canvas.getContext('2d');
let vizW=0,vizH=0;

function sizeCanvas(){
  const dpr=Math.min(2,window.devicePixelRatio||1);
  vizW=canvas.clientWidth;vizH=canvas.clientHeight;
  canvas.width=Math.round(vizW*dpr);
  canvas.height=Math.round(vizH*dpr);
  cx2d.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',()=>{sizeCanvas();drawViz();});

/* cosmetic-only seeded streams (never Math.random) */
const vizRng=new RNG(0xBADA55);
const STREAKS=[];
for(let i=0;i<30;i++)STREAKS.push({
  x:vizRng.next(),sp:34+vizRng.next()*46,
  len:26+vizRng.next()*42,off:vizRng.next()*900,a:0.5+vizRng.next()*0.5,
});
const frac=x=>x-Math.floor(x);

function drawViz(){
  const w=vizW,h=vizH;
  cx2d.clearRect(0,0,w,h);
  const now=Dust.ctx?Dust.ctx.currentTime:0;
  const R=Math.min(h*0.42,w*0.24);
  const rot=2*Math.PI*0.35*Dust.elapsed();
  /* eccentric wobble: the disc center orbits at the tape-wow rate, so the
     wobble-rate/depth sliders read directly on the record */
  const ecc=Math.min(2.4,0.6+(Dust.wobDepth||1)*0.9);
  const cx=w*0.5-R*0.55+Dust.wobbleValue(0.25)*ecc;
  const cy=h*0.5+Dust.wobbleValue()*ecc*0.7;

  /* rain streaks over the whole canvas */
  const rainN=Math.round((S.rain/100)*STREAKS.length);
  if(rainN>0){
    cx2d.lineWidth=1;
    for(let i=0;i<rainN;i++){
      const st=STREAKS[i];
      const y=((now*st.sp+st.off)%(h+st.len))-st.len;
      const x=st.x*w;
      cx2d.strokeStyle='rgba(140,165,195,'+(0.05+0.08*(S.rain/100)*st.a).toFixed(3)+')';
      cx2d.beginPath();cx2d.moveTo(x,y);cx2d.lineTo(x,y+st.len);cx2d.stroke();
    }
  }

  /* disc */
  cx2d.beginPath();cx2d.arc(cx,cy,R,0,Math.PI*2);
  cx2d.fillStyle='#12151c';cx2d.fill();
  cx2d.strokeStyle='rgba(201,138,154,0.25)';cx2d.lineWidth=1;cx2d.stroke();
  /* grooves */
  for(const gr of[0.52,0.65,0.78,0.9]){
    cx2d.beginPath();cx2d.arc(cx,cy,R*gr,0,Math.PI*2);
    cx2d.strokeStyle='rgba(255,255,255,0.05)';cx2d.stroke();
  }
  /* a rotating sheen so the spin reads */
  cx2d.beginPath();cx2d.arc(cx,cy,R*0.72,rot,rot+0.85);
  cx2d.strokeStyle='rgba(201,138,154,0.14)';cx2d.lineWidth=R*0.32;cx2d.stroke();
  cx2d.lineWidth=1;

  /* crackle specks on the disc, rotating with it */
  for(const m of Dust.popMarks){
    const age=now-m.t;
    if(age<0||age>1.4)continue;
    const rr=R*(0.42+0.5*frac(m.u*7.31));
    const phi=m.u*97.3+rot;
    const a=(1-age/1.4)*(0.25+0.45*Math.min(1,m.u+0.3));
    cx2d.fillStyle='rgba(232,214,220,'+a.toFixed(3)+')';
    cx2d.fillRect(cx+Math.cos(phi)*rr-1,cy+Math.sin(phi)*rr-1,2,2);
  }

  /* label with the chord name */
  const b=Dust.currentBarInfo();
  cx2d.beginPath();cx2d.arc(cx,cy,R*0.36,0,Math.PI*2);
  cx2d.fillStyle='rgba(201,138,154,0.13)';cx2d.fill();
  cx2d.strokeStyle='rgba(201,138,154,0.3)';cx2d.stroke();
  cx2d.fillStyle='#d9b6bf';
  cx2d.font='600 12px system-ui, sans-serif';
  cx2d.textAlign='center';cx2d.textBaseline='middle';
  cx2d.fillText(b?b.label:'—',cx,cy);
  cx2d.beginPath();cx2d.arc(cx,cy,2,0,Math.PI*2);
  cx2d.fillStyle='#0c0f13';cx2d.fill();

  /* tone arm: sweeps outer -> inner across the 8-bar cycle */
  const p=Dust.cyclePos();
  const px=cx+R*1.45,py=cy-R*0.78;
  const tipR=R*(0.94-0.56*p);
  const ta=-0.62;                                 // tip sits up-right on the disc
  const tx=cx+Math.cos(ta)*tipR,ty=cy+Math.sin(ta)*tipR;
  cx2d.strokeStyle='rgba(207,214,224,0.5)';
  cx2d.lineWidth=2;
  cx2d.beginPath();cx2d.moveTo(px,py);cx2d.lineTo(tx,ty);cx2d.stroke();
  cx2d.lineWidth=1;
  cx2d.beginPath();cx2d.arc(px,py,4.5,0,Math.PI*2);
  cx2d.fillStyle='#2a2f3a';cx2d.fill();
  cx2d.strokeStyle='rgba(207,214,224,0.4)';cx2d.stroke();
  cx2d.beginPath();cx2d.arc(tx,ty,2.5,0,Math.PI*2);
  cx2d.fillStyle='rgba(201,138,154,0.8)';cx2d.fill();

  /* cycle dots: 8 bars, filled = where we are */
  const barNow=b?b.bar%8:-1;
  for(let i=0;i<8;i++){
    const dx=cx+R*1.28+i*11,dy=cy+R*0.82;
    if(dx>w-8)break;
    cx2d.beginPath();cx2d.arc(dx,dy,2.4,0,Math.PI*2);
    cx2d.fillStyle=i===barNow?'rgba(201,138,154,0.9)':'rgba(125,135,148,0.3)';
    cx2d.fill();
  }
}

let lastDraw=0;
function vizLoop(ts){
  requestAnimationFrame(vizLoop);
  if(document.hidden)return;
  if(!Dust.playing&&ts-lastDraw<1000)return;     // frozen when paused
  if(ts-lastDraw<40)return;                      // ~25 fps is plenty
  lastDraw=ts;
  drawViz();
}

/* ----- boot ----- */
load();
wire();
refreshUI();
Dust.applyParams(S);
sizeCanvas();
drawViz();
requestAnimationFrame(vizLoop);

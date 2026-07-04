/* =====================================================================
   02 · Drift — UI, state, persistence, visualization.

   State lives in one flat object S (serialized to the URL hash and
   localStorage on every change; hash beats localStorage beats
   defaults). S.rows always holds 8 loop rows — the Layers slider
   exposes a prefix, so lowering and raising the count round-trips.
   The engine (engine.js) is bound to S and reads it live.
===================================================================== */
(function(){
'use strict';
const D=window.Drift;
const $=s=>document.querySelector(s);

const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName=m=>NOTE_NAMES[m%12]+(Math.floor(m/12)-1);
const clamp=D.clamp;
const STORE_KEY='proto-02-drift';
const TIMBRES=['choir-glass','glass','voices'];

function dateSeed(){const d=new Date();return (d.getFullYear()%100)*10000+(d.getMonth()+1)*100+d.getDate();}

const DEF={v:1,pal:'airport',layers:6,pace:50,warm:60,air:12,vol:70,
  timbre:'choir-glass',tl:6,atk:35,rs:4,rm:50,ac:1000,dd:50,tape:1,bed:1,ln:0,custom:0};
const NUM_KEYS=['layers','pace','warm','air','vol','tl','atk','rs','rm','ac','dd','tape','bed','ln','custom'];

let S=null;

/* ----- state <-> string ----- */
function freshState(seed){
  const s=Object.assign({},DEF,{seed:seed==null?dateSeed():seed});
  s.rows=D.genRows(s.seed,s.pal,s.ln);
  return s;
}
function serialize(){
  const p=new URLSearchParams();
  p.set('v',1);p.set('seed',S.seed);p.set('pal',S.pal);p.set('timbre',S.timbre);
  for(const k of NUM_KEYS)p.set(k,S[k]);
  if(S.custom)p.set('rows',S.rows.map(r=>[r.note,r.per,r.lvl,r.pan,r.mute?1:0].join('~')).join('_'));
  return p.toString();
}
function parseState(str){
  try{
    const p=new URLSearchParams(str);
    if(!p.get('seed'))return null;
    const s=Object.assign({},DEF);
    s.seed=Math.max(1,Math.min(999999,Math.round(+p.get('seed'))||1));
    if(D.PALETTES[p.get('pal')])s.pal=p.get('pal');
    if(TIMBRES.includes(p.get('timbre')))s.timbre=p.get('timbre');
    for(const k of NUM_KEYS){
      const v=p.get(k);
      if(v!=null&&isFinite(+v))s[k]=+v;
    }
    s.layers=clamp(Math.round(s.layers),3,8);
    s.pace=clamp(s.pace,0,100);s.warm=clamp(s.warm,0,100);s.air=clamp(s.air,0,100);
    s.vol=clamp(s.vol,0,100);s.tl=clamp(s.tl,3,10);s.atk=clamp(s.atk,10,60);
    s.rs=clamp(s.rs,2,6);s.rm=clamp(s.rm,0,100);s.ac=clamp(s.ac,400,2000);
    s.dd=clamp(s.dd,0,100);s.tape=s.tape?1:0;s.bed=s.bed?1:0;
    s.ln=Math.max(0,Math.round(s.ln));s.custom=s.custom?1:0;
    s.rows=D.genRows(s.seed,s.pal,s.ln);   // base rows carry phase + detune walk
    if(s.custom&&p.get('rows')){
      const parts=p.get('rows').split('_');
      if(parts.length===8){
        parts.forEach((rs,i)=>{
          const f=rs.split('~').map(Number);
          if(f.length===5&&f.every(isFinite)){
            s.rows[i].note=clamp(Math.round(f[0]),26,84);
            s.rows[i].per=clamp(f[1],6,60);
            s.rows[i].lvl=clamp(f[2],0,1);
            s.rows[i].pan=clamp(f[3],-1,1);
            s.rows[i].mute=f[4]?1:0;
          }
        });
      }else s.custom=0;
    }
    return s;
  }catch(e){return null;}
}
function persist(){
  const str=serialize();
  try{history.replaceState(null,'','#'+str);}catch(e){try{location.hash=str;}catch(e2){}}
  try{localStorage.setItem(STORE_KEY,str);}catch(e){}
}
function loadState(){
  const h=location.hash.replace(/^#/,'');
  let s=h?parseState(h):null;
  if(!s){try{s=parseState(localStorage.getItem(STORE_KEY)||'');}catch(e){}}
  return s||freshState();
}

/* ----- regenerate the loop layout ----- */
function regenRows(){
  S.rows=D.genRows(S.seed,S.pal,S.ln);
  S.custom=0;
}

/* ----- controls ----- */
const chipEls={};
function buildChips(){
  const box=$('#chips');
  for(const key of Object.keys(D.PALETTES)){
    const b=document.createElement('button');
    b.className='chip';b.textContent=D.PALETTES[key].label;
    b.setAttribute('aria-pressed','false');
    b.addEventListener('click',()=>{
      S.pal=key;S.timbre=D.PALETTES[key].timbre;
      regenRows();D.onLayout();D.applyLive();
      syncUI();statusTick();persist();
    });
    box.appendChild(b);chipEls[key]=b;
  }
}

function fmtVal(k,v){
  if(k==='tl'||k==='rs')return (+v).toFixed(1)+' s';
  if(k==='atk')return Math.round(v)+'%';
  if(k==='ac')return Math.round(v)+' Hz';
  return String(Math.round(v));
}
function wireSlider(id,key,after){
  const el=$('#'+id),out=$('#'+id+'V');
  el.addEventListener('input',()=>{
    S[key]=+el.value;
    if(out)out.textContent=fmtVal(key,el.value);
    D.applyLive();
    if(after)after();
    persist();
  });
}
function wireCheck(id,key){
  const el=$('#'+id);
  el.addEventListener('change',()=>{
    S[key]=el.checked?1:0;
    D.applyLive();statusTick();persist();
  });
}

/* ----- layer table ----- */
let dotEls=[];
function noteOptions(){
  const pal=D.PALETTES[S.pal];
  const set=new Set();
  for(const m of pal.notes){set.add(m);if(m-12>=26)set.add(m-12);if(m+12<=84)set.add(m+12);}
  return [...set].sort((a,b)=>a-b);
}
function buildTable(){
  const tb=$('#ltable tbody');
  tb.innerHTML='';dotEls=[];
  const opts=noteOptions();
  for(let i=0;i<S.layers;i++){
    const r=S.rows[i];
    const tr=document.createElement('tr');

    const tdDot=document.createElement('td');
    const dot=document.createElement('span');
    dot.className='ldot';dot.textContent='●';
    tdDot.appendChild(dot);dotEls.push(dot);

    const tdNote=document.createElement('td');
    const sel=document.createElement('select');
    sel.setAttribute('aria-label','loop '+(i+1)+' note');
    const all=opts.includes(r.note)?opts:[...opts,r.note].sort((a,b)=>a-b);
    for(const m of all){
      const o=document.createElement('option');
      o.value=m;o.textContent=noteName(m);
      sel.appendChild(o);
    }
    sel.value=r.note;
    sel.addEventListener('change',()=>{r.note=+sel.value;S.custom=1;persist();});
    tdNote.appendChild(sel);

    const tdPer=document.createElement('td');
    const per=document.createElement('input');
    per.type='number';per.min=6;per.max=60;per.step=0.1;per.value=r.per;
    per.setAttribute('aria-label','loop '+(i+1)+' period seconds');
    per.addEventListener('change',()=>{
      r.per=clamp(+per.value||r.per,6,60);per.value=r.per;
      S.custom=1;statusTick();persist();
    });
    tdPer.appendChild(per);

    const tdLvl=document.createElement('td');
    const lvl=document.createElement('input');
    lvl.type='range';lvl.min=0;lvl.max=1;lvl.step=0.01;lvl.value=r.lvl;
    lvl.setAttribute('aria-label','loop '+(i+1)+' level');
    lvl.addEventListener('input',()=>{r.lvl=+lvl.value;S.custom=1;D.applyLive();persist();});
    tdLvl.appendChild(lvl);

    const tdPan=document.createElement('td');
    const pan=document.createElement('input');
    pan.type='range';pan.min=-1;pan.max=1;pan.step=0.05;pan.value=r.pan;
    pan.setAttribute('aria-label','loop '+(i+1)+' pan');
    pan.addEventListener('input',()=>{r.pan=+pan.value;S.custom=1;D.applyLive();persist();});
    tdPan.appendChild(pan);

    const tdMute=document.createElement('td');
    const mu=document.createElement('input');
    mu.type='checkbox';mu.checked=!!r.mute;
    mu.setAttribute('aria-label','mute loop '+(i+1));
    mu.addEventListener('change',()=>{r.mute=mu.checked?1:0;S.custom=1;D.applyLive();statusTick();persist();});
    tdMute.appendChild(mu);

    tr.append(tdDot,tdNote,tdPer,tdLvl,tdPan,tdMute);
    tb.appendChild(tr);
  }
}

/* ----- sync every input to S ----- */
function syncUI(){
  for(const [k,el] of Object.entries(chipEls)){
    el.classList.toggle('on',S.pal===k);
    el.setAttribute('aria-pressed',S.pal===k?'true':'false');
  }
  for(const [id,key] of [['pace','pace'],['layers','layers'],['warm','warm'],['air','air'],
      ['vol','vol'],['tl','tl'],['atk','atk'],['rs','rs'],['rm','rm'],['ac','ac'],['dd','dd']]){
    $('#'+id).value=S[key];
    const out=$('#'+id+'V');
    if(out)out.textContent=fmtVal(key,S[key]);
  }
  $('#timbre').value=S.timbre;
  $('#tape').checked=!!S.tape;
  $('#bed').checked=!!S.bed;
  $('#seed').value=S.seed;
  buildTable();
}

/* ----- status line + repeat horizon ----- */
function humanize(tenths){
  const CENT=BigInt(Math.round(100*365.25*86400*10));
  if(tenths>CENT)return 'centuries';
  const s=Number(tenths)/10;
  if(s<120)return Math.round(s)+' s';
  if(s<7200)return Math.round(s/60)+' min';
  if(s<172800)return (s/3600<10?(s/3600).toFixed(1):String(Math.round(s/3600)))+' hours';
  if(s<2*365.25*86400)return Math.round(s/86400)+' days';
  return Math.round(s/31557600)+' years';
}
function fmtTime(s){return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');}
let lastStatus='';
function statusTick(){
  const active=S.rows.slice(0,S.layers).filter(r=>!r.mute).length;
  const h=D.repeatHorizon();
  let rep;
  if(h===null)rep='pattern repeats: never (tape drift)';
  else if(h<0n)rep='all loops muted';
  else rep='pattern repeats in ≈ '+humanize(h);
  const t=D.now();
  const tail=(t>0||D.isPlaying())?'running '+fmtTime(t):'press play';
  const txt=active+(active===1?' loop':' loops')+' · '+rep+' · '+tail;
  if(txt!==lastStatus){$('#status').textContent=txt;lastStatus=txt;}
}
let lastTime='';
setInterval(()=>{
  if(document.hidden)return;
  const t=fmtTime(D.now());
  if(t!==lastTime){$('#time').textContent=t;lastTime=t;}
  statusTick();
},500);

/* ----- transport ----- */
$('#play').addEventListener('click',()=>D.toggle());
D.onPlayState=(on)=>{
  $('#icoPlay').style.display=on?'none':'block';
  $('#icoPause').style.display=on?'block':'none';
  const b=$('#play');
  b.setAttribute('aria-pressed',on?'true':'false');
  b.setAttribute('aria-label',on?'pause':'play');
};
document.addEventListener('keydown',e=>{
  if(e.code!=='Space')return;
  const t=e.target;
  if(t&&(/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName)||t.isContentEditable))return;
  e.preventDefault();
  D.toggle();
});

/* ----- visualization: orbit rings, one per loop ----- */
const cv=$('#viz'),gx=cv.getContext('2d');
let vizH=180;
function sizeCanvas(){
  const dpr=window.devicePixelRatio||1;
  vizH=cv.clientHeight||180;
  cv.width=Math.max(1,cv.clientWidth*dpr);
  cv.height=Math.max(1,vizH*dpr);
  gx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',sizeCanvas);
const tdData=new Uint8Array(2048);
function draw(){
  requestAnimationFrame(draw);
  if(document.hidden)return;
  const W=cv.clientWidth,H=vizH;
  if(!W)return;
  gx.clearRect(0,0,W,H);
  const now=D.now(),rts=D.rt();
  const n=S.layers;
  const effs=[];
  for(let i=0;i<n;i++)effs.push(D.effPer(S.rows[i]));
  const mn=Math.min(...effs),mx=Math.max(...effs);
  const cx=W/2,cy=H/2,rMin=22,rMax=Math.max(rMin+8,H/2-10);

  // the strike line: loops sound as their dot crosses 12 o'clock
  gx.strokeStyle='rgba(207,214,224,0.09)';
  gx.beginPath();gx.moveTo(cx,cy-rMax-6);gx.lineTo(cx,cy-rMin+10);gx.stroke();

  for(let i=0;i<n;i++){
    const row=S.rows[i],st=rts&&rts[i];
    const r=mn===mx?(rMin+rMax)/2:rMin+(rMax-rMin)*(effs[i]-mn)/(mx-mn);
    const muted=!!row.mute;
    gx.strokeStyle=muted?'rgba(125,135,148,0.10)':'rgba(157,140,255,0.16)';
    gx.beginPath();gx.arc(cx,cy,r,0,Math.PI*2);gx.stroke();

    let prog;
    if(st&&now>0){
      while(st.q.length&&st.q[0]<=now){st.prevFire=st.q.shift();st.lastFire=st.prevFire;}
      const nx=st.q.length?st.q[0]:st.nextT;
      const pv=st.prevFire!=null?st.prevFire:nx-effs[i];
      prog=clamp((now-pv)/Math.max(0.001,nx-pv),0,1);
    }else{
      prog=1-(row.phase%effs[i])/effs[i];
    }
    const a=-Math.PI/2+prog*2*Math.PI;
    const x=cx+r*Math.cos(a),y=cy+r*Math.sin(a);

    if(st&&!muted&&now-st.lastFire<1.6){       // bloom as the loop sounds
      const d=(now-st.lastFire)/1.6;
      const rad=8+26*d;
      const grad=gx.createRadialGradient(x,y,0,x,y,rad);
      grad.addColorStop(0,'rgba(157,140,255,'+(0.45*(1-d)*(0.4+0.6*row.lvl)).toFixed(3)+')');
      grad.addColorStop(1,'rgba(157,140,255,0)');
      gx.fillStyle=grad;
      gx.beginPath();gx.arc(x,y,rad,0,Math.PI*2);gx.fill();
    }
    gx.fillStyle=muted?'rgba(125,135,148,0.30)'
      :'rgba(157,140,255,'+(0.35+0.55*clamp(row.lvl,0,1)).toFixed(3)+')';
    gx.beginPath();gx.arc(x,y,3.2,0,Math.PI*2);gx.fill();

    if(dotEls[i])dotEls[i].classList.toggle('hot',!!st&&!muted&&now-st.lastFire<0.7);
  }

  // faint total-level pulse in the center, from the analyser
  const an=D.analyser();
  if(an){
    an.getByteTimeDomainData(tdData);
    let sum=0;
    for(let i=0;i<tdData.length;i+=4){const v=(tdData[i]-128)/128;sum+=v*v;}
    const rms=Math.sqrt(sum/(tdData.length/4));
    gx.fillStyle='rgba(157,140,255,0.13)';
    gx.beginPath();gx.arc(cx,cy,4+rms*110,0,Math.PI*2);gx.fill();
  }
}

/* ----- advanced wiring ----- */
function wireAdvanced(){
  wireSlider('vol','vol');
  wireSlider('pace','pace',statusTick);
  wireSlider('layers','layers',()=>{buildTable();statusTick();});
  wireSlider('warm','warm');
  wireSlider('air','air');
  wireSlider('tl','tl');
  wireSlider('atk','atk');
  wireSlider('rm','rm');
  wireSlider('ac','ac');
  wireSlider('dd','dd',statusTick);
  let rsT=0;
  wireSlider('rs','rs',()=>{clearTimeout(rsT);rsT=setTimeout(()=>D.rebuildReverb(),300);});
  wireCheck('tape','tape');
  wireCheck('bed','bed');
  $('#timbre').addEventListener('change',()=>{S.timbre=$('#timbre').value;persist();});

  $('#addLayer').addEventListener('click',()=>{
    if(S.layers>=8)return;
    S.layers++;
    D.applyLive();syncUI();statusTick();persist();
  });
  $('#rerollLayout').addEventListener('click',()=>{
    S.ln++;regenRows();D.onLayout();D.applyLive();
    syncUI();statusTick();persist();
  });
  $('#nudge').addEventListener('click',()=>D.nudgePhases());

  $('#seed').addEventListener('change',()=>{
    const v=Math.max(1,Math.min(999999,Math.round(+$('#seed').value)||1));
    S.seed=v;regenRows();D.onLayout();D.applyLive();
    syncUI();statusTick();persist();
  });
  $('#reroll').addEventListener('click',()=>{
    S.seed=randSeed();regenRows();D.onLayout();D.applyLive();
    syncUI();statusTick();persist();
  });
  $('#reset').addEventListener('click',()=>{
    S=freshState();
    D.bind(S);D.onLayout();D.applyLive();
    syncUI();statusTick();
    try{localStorage.removeItem(STORE_KEY);}catch(e){}
    try{history.replaceState(null,'',location.pathname);}catch(e){}
  });
}
let rerollN=0;
function randSeed(){
  try{const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]%899999+100000;}
  catch(e){return ((Date.now()^(++rerollN*7919))>>>0)%899999+100000;}
}

/* ----- boot ----- */
S=loadState();
D.bind(S);
buildChips();
wireAdvanced();
syncUI();
statusTick();
sizeCanvas();
requestAnimationFrame(draw);
})();

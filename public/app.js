/* ============================================================
   Lesjaelva fiskedashboard – datahenting, modellering, rendering
   ============================================================ */

const $ = id => document.getElementById(id);
const fmt1 = x => (x==null||isNaN(x)) ? "–" : (Math.round(x*10)/10).toString().replace(".",",");
const fmt0 = x => (x==null||isNaN(x)) ? "–" : Math.round(x).toString();

const STATE = {
  cfg:null, weather:null, station:null,
  discharge:null, watertemp:null,        // {latest, trend24, dist:[], unit, measured}
  days:[],                                // 14 dagstilstander
  now:null,                               // sanntidstilstand
  selected:null,                          // null = "Nå", ellers dagindeks
};

/* ---------- små hjelpere ---------- */
const DOW = ["søn","man","tir","ons","tor","fre","lør"];
const MON = ["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"];
function isoDate(d){ return d.toISOString().slice(0,10); }
function osloDateKey(d){
  // YYYY-MM-DD i norsk tidssone
  return d.toLocaleDateString("sv-SE",{timeZone:"Europe/Oslo"});
}
function osloHour(d){
  return parseInt(d.toLocaleString("en-GB",{timeZone:"Europe/Oslo",hour:"2-digit",hour12:false}),10);
}
function symEmoji(code){
  if(!code) return "·";
  const c=code.toLowerCase();
  if(c.includes("thunder")) return "⛈️";
  if(c.includes("sleet")) return "🌨️";
  if(c.includes("snow")) return "❄️";
  if(c.includes("rainshowers")||c.includes("rain_showers")) return "🌦️";
  if(c.includes("rain")) return "🌧️";
  if(c.includes("fog")) return "🌫️";
  if(c.includes("cloudy")) return "☁️";
  if(c.includes("partlycloudy")) return "⛅";
  if(c.includes("fair")) return "🌤️";
  if(c.includes("clear")) return "☀️";
  return "·";
}
function timeWindowNow(){
  const h=osloHour(new Date());
  if(h<6||h>=21) return "lowlight";
  if(h<10||h>=18) return "mid";
  return "midday";
}

/* --- vind: kompass + pil + sirkulær middelverdi --- */
const COMPASS=["N","NØ","Ø","SØ","S","SV","V","NV"];
function degToCompass(d){ if(d==null||isNaN(d)) return "–"; return COMPASS[Math.round(d/45)%8]; }
function meanDir(arr){
  if(!arr||!arr.length) return null;
  let x=0,y=0,n=0;
  for(const d of arr){ if(d==null||isNaN(d)) continue; x+=Math.cos(d*Math.PI/180); y+=Math.sin(d*Math.PI/180); n++; }
  if(!n) return null;
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
/* liten pil som peker dit vinden BLÅSER (fra-retning + 180°), nord = opp */
function windArrow(fromDir,size,color){
  if(fromDir==null||isNaN(fromDir)) return `<span style="color:var(--mut2)">–</span>`;
  const to=(fromDir+180)%360;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${to}deg);vertical-align:middle">
    <path d="M12 2 L12 21 M12 2 L6.5 9 M12 2 L17.5 9" stroke="${color||'var(--teal)'}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* klimatologisk lufttemp ved ~575 moh (Dombås/Lesja), månedsmiddel interpolert */
const AIR_MONTH=[-8,-7,-3,1,6,10.5,12,11,7,3,-3,-6];
function seasonalAir(date){
  const m=date.getMonth(), day=date.getDate(), dim=new Date(date.getFullYear(),m+1,0).getDate();
  const f=(day-1)/dim;
  const a=AIR_MONTH[m], b=AIR_MONTH[(m+1)%12];
  return a+(b-a)*f;
}
/* fallback-estimat for vanntemp hvis stasjonen ikke måler det */
const WTEMP_MONTH=[1,1,1.5,3,5.5,8.5,12,11.5,8,5,2.5,1.5];
function estimateWaterTemp(date){
  const m=date.getMonth(), day=date.getDate(), dim=new Date(date.getFullYear(),m+1,0).getDate();
  const f=(day-1)/dim;
  const a=WTEMP_MONTH[m], b=WTEMP_MONTH[(m+1)%12];
  return a+(b-a)*f;
}

/* ---------- datahenting ---------- */
async function getJSON(url){
  const r=await fetch(url);
  return r.json();
}
async function loadConfig(){ STATE.cfg=await getJSON("/api/config"); return STATE.cfg; }

async function loadWeather(){
  const c=STATE.cfg;
  STATE.weather=await getJSON(`/api/met?lat=${c.lat}&lon=${c.lon}&altitude=${c.altitude}`);
  return STATE.weather;
}
/* Frost: faktisk MÅLT vind + lufttemp fra nærmeste stasjon (E136 Lora) */
async function loadObserved(){
  STATE.obsStn=null;
  if(!STATE.cfg.hasFrost) return;
  try{
    const d=await getJSON(`/api/obs?source=SN16845&elements=air_temperature,wind_speed,wind_from_direction`);
    if(d&&d.values&&!d.error){
      STATE.obsStn={label:"Lora (målt)", air:d.values.air_temperature, wind:d.values.wind_speed,
                    windDir:d.values.wind_from_direction, time:d.time};
    }
  }catch(e){}
}
/* lokale MET-værpunkt (Brustugubrue, Leirmo): lufttemp + vind nå */
async function loadWeatherPoints(){
  STATE.wpts=[];
  const pts=STATE.cfg.weatherPoints||[];
  for(const p of pts){
    try{
      const wx=await getJSON(`/api/met?lat=${p.lat}&lon=${p.lon}&altitude=${p.altitude}`);
      const ts=wx&&wx.properties&&wx.properties.timeseries;
      if(!ts||!ts.length){ STATE.wpts.push({label:p.label}); continue; }
      const det=ts[0].data.instant.details||{};
      const n1=ts[0].data.next_1_hours, n6=ts[0].data.next_6_hours;
      const sym=(n1&&n1.summary&&n1.summary.symbol_code)||(n6&&n6.summary&&n6.summary.symbol_code);
      STATE.wpts.push({label:p.label, air:det.air_temperature, wind:det.wind_speed,
                       windDir:det.wind_from_direction, symbol:sym});
    }catch(e){ STATE.wpts.push({label:p.label}); }
  }
}
function findParam(seriesList, names, fallbackCode){
  if(!seriesList) return fallbackCode;
  const s=seriesList.find(x=>{
    const n=((x.parameterName||"")+" "+(x.parameterNameEng||"")).toLowerCase();
    return names.some(k=>n.includes(k));
  });
  return s ? s.parameter : fallbackCode;
}
/* bygg en serie {latest,trend24,dist,unit} fra et NVE data[]-element */
function seriesFromObs(d){
  if(!d || !d.observations) return null;
  const obs=d.observations.filter(o=>o.value!=null);
  if(!obs.length) return null;
  const vals=obs.map(o=>o.value);
  const latest=obs[obs.length-1];
  const tLast=new Date(latest.time).getTime();
  let prev=null;
  for(let i=obs.length-1;i>=0;i--){ if(tLast-new Date(obs[i].time).getTime()>=22*36e5){prev=obs[i];break;} }
  return {latest:latest.value, time:latest.time, trend24:prev?latest.value-prev.value:0,
          dist:vals.slice(), unit:d.unit||"", measured:true};
}
/* hent temp/vannføring/vannstand for én stasjon i ETT kall (komma-separerte params) */
async function fetchStationObs(stationId, codes, ref){
  const params=[codes.tmp,codes.dis,codes.stg].join(",");
  const r=await getJSON(`/api/nve/Observations?StationId=${stationId}&Parameter=${params}&ResolutionTime=1440&ReferenceTime=${ref}`);
  const out={};
  if(r.error || !r.data) return out;
  for(const d of r.data){
    const s=seriesFromObs(d);
    if(d.parameter===codes.tmp) out.temp=s;
    else if(d.parameter===codes.dis) out.discharge=s;
    else if(d.parameter===codes.stg) out.stage=s;
  }
  return out;
}
/* last metadata + observasjoner for alle konfigurerte stasjoner */
async function loadWater(){
  STATE.water={};
  const stations=(STATE.cfg.stations&&STATE.cfg.stations.length)?STATE.cfg.stations:[{id:STATE.cfg.station,label:STATE.cfg.station}];
  STATE.primary=stations[0].id;
  if(!STATE.cfg.hasKey) return;
  const to=new Date(), from=new Date(to.getTime()-60*864e5);
  const ref=`${isoDate(from)}/${isoDate(to)}`;
  for(const st of stations){
    const W={id:st.id, label:st.label};
    const meta=await getJSON(`/api/nve/Stations?StationId=${st.id}`);
    if(meta && meta.data && meta.data[0]) W.meta=meta.data[0];
    const sl=W.meta ? (W.meta.seriesList||W.meta.serieList||W.meta.seriesListMin) : null;
    const codes={
      tmp:findParam(sl,["vanntemperatur","water temperature"],1003),
      dis:findParam(sl,["vannføring","discharge"],1001),
      stg:findParam(sl,["vannstand","stage","water level"],1000)
    };
    const obs=await fetchStationObs(st.id, codes, ref);
    W.temp=obs.temp; W.discharge=obs.discharge; W.stage=obs.stage;
    STATE.water[st.id]=W;
  }
  // primærstasjon driver Fiskeindeksen (buildDays/renderMeta bruker disse)
  const P=STATE.water[STATE.primary];
  if(P){ STATE.station=P.meta; STATE.discharge=P.discharge; STATE.watertemp=P.temp; }
}
/* vannføringskategori for en gitt stasjon (egen 60-dagers fordeling) */
function stationFlowCat(W){
  if(!W||!W.discharge) return null;
  const lvl=percentileRank(W.discharge.dist, W.discharge.latest);
  const warm=W.temp?W.temp.latest>=7:true;
  return flowCat(lvl, Math.sign(W.discharge.trend24)*0.04, warm);
}

/* percentil-rang (0..1) av siste verdi i fordelingen */
function percentileRank(dist, v){
  if(!dist||!dist.length) return 0.5;
  const below=dist.filter(x=>x<=v).length;
  return below/dist.length;
}

/* ---------- bygg MET dags-aggregater + nå-snapshot ---------- */
function parseWeather(){
  const ts=STATE.weather && STATE.weather.properties && STATE.weather.properties.timeseries;
  if(!ts||!ts.length) return {now:null, days:[]};

  // nå-snapshot: nærmeste tidspunkt
  const n0=ts[0];
  const det=n0.data.instant.details||{};
  const next1=(n0.data.next_1_hours||{});
  const next6=(n0.data.next_6_hours||{});
  const precipNow=(next1.details&&next1.details.precipitation_amount) ??
                  (next6.details&&next6.details.precipitation_amount) ?? 0;
  // trykktrend: endring fram i tid ~6t
  let pNow=det.air_pressure_at_sea_level, p6=pNow;
  const t0=new Date(n0.time).getTime();
  for(const e of ts){ if(new Date(e.time).getTime()-t0>=6*36e5){ p6=e.data.instant.details.air_pressure_at_sea_level; break; } }
  const now={
    air:det.air_temperature, cloud:det.cloud_area_fraction, wind:det.wind_speed,
    windDir:det.wind_from_direction,
    hum:det.relative_humidity, press:pNow, dPress:(p6-pNow),
    precip:precipNow, symbol:(next1.summary&&next1.summary.symbol_code)||(next6.summary&&next6.summary.symbol_code)
  };

  // grupper per norsk dato
  const groups={};
  for(const e of ts){
    const d=new Date(e.time);
    const key=osloDateKey(d);
    const g=groups[key]||(groups[key]={key,airs:[],clouds:[],winds:[],dirs:[],press:[],precip:0,sym:null,symDist:99});
    const dt=e.data.instant.details||{};
    if(dt.air_temperature!=null) g.airs.push(dt.air_temperature);
    if(dt.cloud_area_fraction!=null) g.clouds.push(dt.cloud_area_fraction);
    if(dt.wind_speed!=null) g.winds.push(dt.wind_speed);
    if(dt.wind_from_direction!=null) g.dirs.push(dt.wind_from_direction);
    if(dt.air_pressure_at_sea_level!=null) g.press.push(dt.air_pressure_at_sea_level);
    const n1=e.data.next_1_hours, n6=e.data.next_6_hours;
    if(n1&&n1.details&&n1.details.precipitation_amount!=null) g.precip+=n1.details.precipitation_amount;
    else if(n6&&n6.details&&n6.details.precipitation_amount!=null) g.precip+=n6.details.precipitation_amount;
    // symbol nær kl 12
    const hr=osloHour(d), dist=Math.abs(hr-12);
    const sc=(n1&&n1.summary&&n1.summary.symbol_code)||(n6&&n6.summary&&n6.summary.symbol_code);
    if(sc && dist<g.symDist){ g.sym=sc; g.symDist=dist; }
  }
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const max=a=>a.length?Math.max(...a):null;
  const min=a=>a.length?Math.min(...a):null;
  const days=Object.values(groups).map(g=>({
    key:g.key, date:new Date(g.key+"T12:00:00"),
    airMean:mean(g.airs), airMax:max(g.airs), airMin:min(g.airs),
    cloud:mean(g.clouds), wind:mean(g.winds), windDir:meanDir(g.dirs), press:mean(g.press),
    precip:Math.round(g.precip*10)/10, sym:g.sym, clim:false
  })).sort((a,b)=>a.date-b.date);

  return {now, days};
}

/* ---------- modellér 14 dager (vanntemp + vannføring framover) ---------- */
function buildDays(){
  const {now, days:metDays}=parseWeather();
  STATE.metNow=now;

  // start-tilstand vann: målt > manuell overstyring > sesongestimat
  let wt = STATE.watertemp ? STATE.watertemp.latest
         : (STATE.cfg.tempOverride!=null ? STATE.cfg.tempOverride : null);
  const wtMeasured = !!(STATE.watertemp && STATE.watertemp.measured);
  let flowLevel = 0.55;
  let warmStart=false;
  if(STATE.discharge){
    flowLevel = percentileRank(STATE.discharge.dist, STATE.discharge.latest);
  }

  // bygg 14 dager fra og med i dag
  const out=[];
  const today=new Date(); today.setHours(12,0,0,0);
  let prev=null;
  for(let i=0;i<14;i++){
    const date=new Date(today.getTime()+i*864e5);
    const key=osloDateKey(date);
    let md=metDays.find(d=>d.key===key);
    let clim=false;
    if(!md){
      clim=true;
      const air=seasonalAir(date);
      md={key, date, airMean:air, airMax:air+4, airMin:air-4, cloud:60, wind:3, windDir:null, press:1010, precip:1.2, sym:"partlycloudy_day", clim:true};
    }
    // --- modellér vanntemp ---
    if(i===0 && wt==null){ wt=estimateWaterTemp(date); }
    if(i>0 || wt==null){
      const base = (i===0 ? (wt!=null?wt:estimateWaterTemp(date)) : prev.wt);
      // mål: lufttemp minus ~1, med smeltevannsgulv ved høy vannføring
      let target = md.airMean - 1.0;
      let floor = flowLevel>0.6 ? 6 : (flowLevel>0.42 ? 4.5 : -99);
      target = Math.max(target, floor);
      target = Math.max(0, Math.min(19, target));
      wt = base + 0.3*(target-base);
    }
    const warm = wt>=7;

    // --- modellér vannføring framover ---
    if(i>0){
      flowLevel *= 0.96;                                 // resesjon
      flowLevel += Math.min(0.28, md.precip/60);         // nedbørsrespons
      flowLevel = Math.max(0, Math.min(1, flowLevel));
    }
    const rising = prev ? (flowLevel-prev.flowLevel) : (STATE.discharge? Math.sign(STATE.discharge.trend24)*0.03 : 0);
    const fcat = (STATE.cfg.hasKey || i>0) ? flowCat(flowLevel, rising, warm) : "optimal";

    // --- klarhet, klekking, lys, vind, trykk, stabilitet ---
    const recentRain = md.precip + (prev?0.4*prev.precip:0);
    const clarity = STATE.cfg.clarityOverride || clarityFromFlow(fcat, recentRain);
    const dP = prev ? (md.press-prev.press) : (now?now.dPress:0);
    const pcat = pressCat(md.press, dP);
    const dCloud = prev ? (md.cloud-prev.cloud) : 0;
    const scat = stabCat(dCloud, dP);
    const hs = hatchState(date, wt, md.cloud, md.precip);

    const st={
      temp:wt, cloud:cloudCat(md.cloud), time:timeWindow(), press:pcat,
      flow:fcat, clarity, hatch:hs.cat, wind:windCat(md.wind),
      stab:scat, season:seasonFromTemp(wt)
    };
    const idx=computeIndex(st);

    const day={ i, date, key, clim, md, wt, wtMeasured:(i===0&&wtMeasured), flowLevel, fcat,
                clarity, state:st, idx, precip:md.precip, hatch:hs };
    out.push(day);
    prev={...day, precip:md.precip};
  }
  STATE.days=out;

  // --- nå-tilstand (sanntid) ---
  if(now){
    const wtNow = (STATE.watertemp?STATE.watertemp.latest:out[0].wt);
    const warm=wtNow>=7;
    const fcatNow = STATE.cfg.hasKey ? flowCat(flowLevel0(), nowFlowTrend(), warm) : null;
    const fcat = fcatNow || out[0].fcat;
    const recentRain = now.precip;
    const clarity = STATE.cfg.clarityOverride || clarityFromFlow(fcat, recentRain);
    const st={
      temp:wtNow, cloud:cloudCat(now.cloud), time:timeWindowNow(),
      press:pressCat(now.press, now.dPress), flow:fcat, clarity,
      hatch:hatchState(new Date(), wtNow, now.cloud, now.precip).cat,
      wind:windCat(now.wind), stab:"stable", season:seasonFromTemp(wtNow)
    };
    STATE.now={ state:st, idx:computeIndex(st), wtNow, wtMeasured, fcat, clarity, windDir:now.windDir,
                hatch:hatchAdvice(new Date(), wtNow, now.cloud, now.precip), now };
  }
}
function flowLevel0(){ return STATE.discharge ? percentileRank(STATE.discharge.dist, STATE.discharge.latest) : 0.55; }
function nowFlowTrend(){ return STATE.discharge ? Math.sign(STATE.discharge.trend24)*0.04 : 0; }

/* ============================================================
   RENDERING
   ============================================================ */
function setLive(status, txt){
  $("liveDot").className="livedot "+status;
  $("liveTxt").textContent=txt;
}

const FLOW_LABEL={optimal:"Optimal",risingfromlow:"Stigende fra lav",high:"Litt høy",lowclear:"Lav & klar",flood:"Flom",drought:"Svært lav"};
const CLAR_LABEL={tinge:"Lett farget",gin:"Krystallklart",stained:"Moderat grumset",muddy:"Sjokoladebrun"};
const HATCH_LABEL={active:"Aktiv klekking",likely:"Sannsynlig",sparse:"Sparsom",none:"Ingen"};
const PRESS_LABEL={falling:"Fallende",stable:"Stabilt",slowrise:"Sakte stigende",bluebird:"Klart etter front",lowflat:"Lavt/flatt"};

function trendArrow(v,eps){ if(v>eps)return "↑"; if(v<-eps)return "↓"; return "→"; }

function renderHero(){
  const sel=STATE.selected;
  let idx, label, st, sub="";
  if(sel==null && STATE.now){
    idx=STATE.now.idx; st=STATE.now.state; label="Nå";
  } else {
    const d=STATE.days[sel==null?0:sel];
    idx=d.idx; st=d.state;
    label=dayLabel(d.date)+(d.clim?" · klimatologi":"");
  }
  $("score").textContent=idx.score;
  const [vt,vc]=verdict(idx.score);
  $("verdict").textContent=vt; $("verdict").style.color=vc;
  $("fill").style.width=idx.score+"%"; $("fill").style.background=vc;
  $("gaugeWhen").innerHTML = (sel==null?"Nå":`<span class="reset" id="resetNow" style="cursor:pointer;color:var(--teal)">‹ Nå</span> · ${label}`);
  const lim=idx.limiting;
  $("limiting").innerHTML = `Begrensende faktor: <b>${PART_LABELS[lim.key]}</b> (delskår ${lim.s.toFixed(2)})`;
  if($("resetNow")) $("resetNow").onclick=()=>selectDay(null);

  // gate
  const gate=$("gate");
  if(idx.msg){ gate.className="gate "+idx.cls; gate.textContent=(idx.g<1?`Portvokter aktiv (×${idx.g.toFixed(2)}). `:"")+idx.msg; }
  else { gate.className="gate"; gate.textContent=""; }

  renderNowChips();
  renderBreakdown(idx, label);
  renderHatch(sel);
}

function chip(ct,cv,cu,cs,csClass){
  return `<div class="chip"><div class="ct">${ct}</div><div class="cv">${cv}${cu?`<span class="cu">${cu}</span>`:""}</div>${cs?`<div class="cs ${csClass||""}">${cs}</div>`:""}</div>`;
}
/* boks med én rad per stasjon: [{label,val,cls}] */
function chipStations(title, rows, footer){
  const body=rows.map(r=>`<div class="cv2"><span class="cl">${r.label}</span><span class="cvv ${r.cls||''}">${r.val}</span></div>`).join("");
  return `<div class="chip"><div class="ct">${title}</div>${body}${footer?`<div class="cs">${footer}</div>`:""}</div>`;
}
function renderNowChips(){
  const g=$("nowGrid");
  const now=STATE.now;
  if(!now){ g.innerHTML=`<div class="chip"><div class="cs">Venter på værdata …</div></div>`; return; }
  const w=now.now;
  const sts=(STATE.cfg.stations&&STATE.cfg.stations.length)?STATE.cfg.stations:[{id:STATE.primary,label:STATE.primary}];

  // --- vanntemperatur, én rad per stasjon ---
  const tempRows=sts.map(st=>{
    const W=STATE.water[st.id];
    if(W&&W.temp){ const a=trendArrow(W.temp.trend24,0.2);
      return {label:st.label, val:`${fmt1(W.temp.latest)}° ${a}`, cls:a==="↑"?"up":(a==="↓"?"down":"")}; }
    if(st.id===STATE.primary && now.wtNow!=null) return {label:st.label, val:`${fmt1(now.wtNow)}°`, cls:""};
    return {label:st.label, val:"–", cls:""};
  });
  const hasPrimTemp=STATE.water[STATE.primary]&&STATE.water[STATE.primary].temp;
  const tempFoot = hasPrimTemp ? "målt · NVE"
                 : (STATE.cfg.tempOverride!=null ? "manuelt satt" : (STATE.cfg.hasKey?"estimat (modell)":"estimat · legg inn nøkkel"));

  // --- vannføring, én rad per stasjon (med kategori) ---
  const flowRows=sts.map(st=>{
    const W=STATE.water[st.id];
    if(W&&W.discharge){ const tr=W.discharge.trend24, a=trendArrow(tr,0.3), cat=stationFlowCat(W);
      return {label:st.label, cls:tr>0.3?"up":(tr<-0.3?"down":""),
        val:`${fmt1(W.discharge.latest)} ${a} <span class="catx">${FLOW_LABEL[cat]}</span>`}; }
    return {label:st.label, val:"–", cls:""};
  });
  const flowFoot = STATE.cfg.hasKey ? "m³/s · kategori vs 60 dager" : "krever NVE-nøkkel";

  // --- lufttemp + vind, én rad per lokalt værpunkt (Brustugubrue, Leirmo) ---
  const wpts=STATE.wpts||[];
  const tempRows2=wpts.length ? wpts.map(p=>({label:p.label,
      val: p.air!=null?`${fmt1(p.air)}° ${symEmoji(p.symbol)}`:"–"})) : [{label:"–",val:"–"}];
  const windRows2=wpts.length ? wpts.map(p=>({label:p.label,
      val: p.wind!=null?`${windArrow(p.windDir,14,'#4fb6a8')} ${fmt1(p.wind)}${p.windDir!=null?" "+degToCompass(p.windDir):""}`:"–"})) : [{label:"–",val:"–"}];
  // faktisk målt (Frost) – legges til som egen rad
  const O=STATE.obsStn;
  if(O&&O.air!=null) tempRows2.push({label:O.label, val:`${fmt1(O.air)}°`, cls:"meas"});
  if(O&&O.wind!=null) windRows2.push({label:O.label,
      val:`${windArrow(O.windDir,14,'#e0935a')} ${fmt1(O.wind)}${O.windDir!=null?" "+degToCompass(O.windDir):""}`, cls:"meas"});
  const tempFoot2 = O ? "modell (MET) + målt (Frost)" : `MET ved fiskesonen · ${fmt0(w.cloud)}% skydekke`;
  const windFoot2 = O ? "modell (MET) + målt (Frost)" : "m/s · retning (MET)";

  g.innerHTML=[
    chipStations("Vanntemperatur", tempRows, tempFoot),
    chipStations("Vannføring", flowRows, flowFoot),
    chipStations("Lufttemp", tempRows2, tempFoot2),
    chipStations("Vind", windRows2, windFoot2),
    chip("Vannklarhet", CLAR_LABEL[now.clarity], "", STATE.cfg.clarityOverride?"manuelt satt":`utledet · ${sts[0].label}`),
    chip("Nedbør (nå)", fmt1(w.precip), "mm/t", w.hum!=null?`${fmt0(w.hum)}% fukt`:""),
    chip("Lufttrykk", fmt0(w.press), "hPa", `${PRESS_LABEL[pressCat(w.press,w.dPress)]} ${trendArrow(w.dPress,0.8)}`),
    chip("Klekking", HATCH_LABEL[now.state.hatch], "", "nå-vurdering"),
  ].join("");
}

function renderBreakdown(idx, label){
  $("bdWhen").textContent="· "+label;
  const maxc=Math.max(...idx.parts.map(p=>p.w*p.s));
  $("bars").innerHTML=idx.parts.map(p=>{
    const c=p.w*p.s, pct=(c/maxc*100).toFixed(0);
    return `<div class="bar"><div class="barhead"><span class="nm">${PART_LABELS[p.key]}</span>
      <span class="vl">${p.s.toFixed(2)} × ${p.w.toFixed(2)} = ${c.toFixed(3)}</span></div>
      <div class="btrack"><div class="bfill" style="width:${pct}%"></div></div></div>`;
  }).join("");
}

function renderHatch(sel){
  let adv, when;
  if(sel==null && STATE.now){ adv=STATE.now.hatch; when="nå"; }
  else { const d=STATE.days[sel==null?0:sel]; adv=hatchAdvice(d.date, d.wt, d.md.cloud, d.precip); when=dayLabel(d.date); }
  $("hatchWhen").textContent="· "+when;
  const flies=adv.flies.map(f=>`<li><b>${f[0]}</b> — ${f[1]}</li>`).join("");
  $("hatchBox").innerHTML=`
    <span class="htag ${adv.state.cat}">${HATCH_LABEL[adv.state.cat]}</span>
    <p>${adv.primary}</p>
    <h4>Flueforslag</h4><ul>${flies}</ul>
    <h4>Taktikk</h4><p>${adv.tactic}</p>
    ${adv.note?`<p style="color:var(--teal)">${adv.note}</p>`:""}`;
}

function dayLabel(d){ return `${DOW[d.getDay()]} ${d.getDate()}. ${MON[d.getMonth()]}`; }

function renderForecast(){
  const strip=$("fcStrip");
  strip.innerHTML=STATE.days.map(d=>{
    const [vt,vc]=verdict(d.idx.score);
    const sel=(STATE.selected===d.i)?"sel":"";
    const wtTxt=`${fmt1(d.wt)}°`;
    const wd=d.md.windDir;
    const windLine=`${windArrow(wd,15,vc)} ${fmt1(d.md.wind)} m/s${wd!=null?` ${degToCompass(wd)}`:""}`;
    return `<div class="fcday ${d.clim?'clim':''} ${sel}" data-i="${d.i}">
      <div class="dow">${DOW[d.date.getDay()]}</div>
      <div class="dt">${d.date.getDate()}.${d.date.getMonth()+1}</div>
      <div class="ico">${symEmoji(d.md.sym)}</div>
      <div class="fsc" style="color:${vc}">${d.idx.score}</div>
      <div class="fvd" style="color:${vc}">${vt}</div>
      <div class="fmeta"><span class="wt">${wtTxt}</span> · ${FLOW_LABEL[d.fcat]}<br>${fmt0(d.md.cloud)}% · ${fmt1(d.precip)}mm<br><span class="fwind">${windLine}</span></div>
    </div>`;
  }).join("");
  strip.querySelectorAll(".fcday").forEach(el=>{
    el.onclick=()=>selectDay(parseInt(el.dataset.i,10));
  });
  renderSpark();
}

function renderSpark(){
  const days=STATE.days, W=1080, H=70, pad=6;
  const n=days.length, step=(W-2*pad)/(n-1);
  const pts=days.map((d,i)=>{ const x=pad+i*step, y=H-pad-(d.idx.score/100)*(H-2*pad); return [x,y]; });
  const path=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  const dots=pts.map((p,i)=>{ const [,vc]=verdict(days[i].idx.score); return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${vc}"/>`; }).join("");
  $("fcSpark").innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:70px" preserveAspectRatio="none">
    <line x1="${pad}" y1="${H-pad-0.5*(H-2*pad)}" x2="${W-pad}" y2="${H-pad-0.5*(H-2*pad)}" stroke="rgba(126,154,152,.2)" stroke-dasharray="3 4"/>
    <path d="${path}" fill="none" stroke="var(--teal-dim)" stroke-width="1.5"/>${dots}</svg>`;
}

function selectDay(i){ STATE.selected=i; renderHero(); renderForecast(); renderMap(); }

/* ---------- vindkart ---------- */
function renderMap(){
  const img=$("mapImg"), phold=$("mapPhold"), rose=$("windRose"), cap=$("mapCap");
  const mf=STATE.cfg && STATE.cfg.mapFile;
  if(!mf){
    img.style.display="none"; phold.style.display="flex"; rose.style.display="none"; cap.style.display="none";
    $("mapWhen").textContent="";
    return;
  }
  if(img.dataset.src!==mf){ img.src="/"+mf+"?v="+Date.now(); img.dataset.src=mf; }
  img.style.display="block"; phold.style.display="none";

  const sel=STATE.selected; let dir,spd,label;
  if(sel==null && STATE.now){ dir=STATE.now.windDir; spd=STATE.now.now.wind; label="Nå"; }
  else if(STATE.days.length){ const d=STATE.days[sel==null?0:sel]; dir=d.md.windDir; spd=d.md.wind; label=dayLabel(d.date)+(d.clim?" · klimatologi":""); }
  else { rose.style.display="none"; cap.style.display="none"; return; }

  $("mapWhen").textContent="· "+label;
  drawWindRose(dir);
  rose.style.display="block";
  if(dir!=null){
    cap.innerHTML=`<b>${label}</b> · vind fra <b>${degToCompass(dir)}</b> (${Math.round(dir)}°) · <span class="ms">${fmt1(spd)} m/s</span> · blåser mot ${degToCompass((dir+180)%360)}`;
  } else {
    cap.innerHTML=`<b>${label}</b> · vindretning n/a (klimatologi) · <span class="ms">${fmt1(spd)} m/s</span>`;
  }
  cap.style.display="block";
}
function drawWindRose(dir){
  const c=70, R=52;
  let labels="";
  [["N",0],["Ø",90],["S",180],["V",270]].forEach(([t,a])=>{
    const rad=(a-90)*Math.PI/180;
    const lx=c+Math.cos(rad)*(R-2), ly=c+Math.sin(rad)*(R-2);
    labels+=`<text x="${lx.toFixed(1)}" y="${(ly+4).toFixed(1)}" text-anchor="middle" font-size="13" font-family="ui-monospace,monospace" fill="${t==='N'?'#4fb6a8':'#7e9a98'}" font-weight="${t==='N'?700:500}">${t}</text>`;
  });
  let arrow;
  if(dir!=null){
    const to=(dir+180)%360;
    arrow=`<g transform="rotate(${to} ${c} ${c})">
      <line x1="${c}" y1="${c+28}" x2="${c}" y2="${c-30}" stroke="#e0935a" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M${c} ${c-40} L${c-8} ${c-26} L${c+8} ${c-26} Z" fill="#e0935a"/>
      <circle cx="${c}" cy="${c}" r="3.4" fill="#e0935a"/></g>`;
  } else {
    arrow=`<text x="${c}" y="${c+4}" text-anchor="middle" font-size="11" fill="#52706e">n/a</text>`;
  }
  $("windRose").innerHTML=
    `<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="rgba(79,182,168,0.25)"/>`+
    `<circle cx="${c}" cy="${c}" r="${R-12}" fill="none" stroke="rgba(126,154,152,0.14)"/>`+
    arrow+labels;
}

/* ---------- station-sub + footer ---------- */
function renderMeta(){
  const c=STATE.cfg;
  const sts=(c.stations&&c.stations.length)?c.stations:[{id:c.station,label:c.station}];
  const parts=sts.map((st,i)=>{
    const W=STATE.water&&STATE.water[st.id];
    let m=`${st.label} (${st.id}`;
    if(W&&W.meta&&W.meta.masl!=null) m+=`, ${Math.round(W.meta.masl)} moh`;
    m+=")";
    if(i===0) m="primær: "+m;
    return m;
  });
  let txt="Stasjoner — "+parts.join(" · ");
  if(!c.hasKey) txt+=" · ⚠ NVE-nøkkel mangler (vanndata utilgjengelig)";
  $("stationSub").textContent=txt;
  const now=new Date();
  $("updated").textContent="Sist oppdatert "+now.toLocaleString("no-NO",{timeZone:"Europe/Oslo"});
}

/* ============================================================
   LASTING
   ============================================================ */
async function refresh(){
  setLive("warn","henter data …");
  try{
    await loadConfig();
    // vær + alle vannstasjoner + lokale værpunkt + målt (Frost) parallelt
    await Promise.all([loadWeather(), loadWater(), loadWeatherPoints(), loadObserved()]);
    buildDays();
    STATE.selected=null;
    renderMeta(); renderHero(); renderForecast(); renderMap();
    logForecast();
    loadDombasChart().then(renderDombasChart).catch(()=>{});
    loadPressureChart().then(renderPressureChart).catch(()=>{});
    const okWater = STATE.cfg.hasKey && (STATE.discharge||STATE.watertemp);
    if(!STATE.cfg.hasKey) setLive("warn","vær OK · NVE-nøkkel mangler");
    else if(!okWater) setLive("warn","vær OK · ingen vann-serie funnet");
    else setLive("ok","live");
  }catch(e){
    console.error(e);
    setLive("err","feil ved henting");
  }
}

/* ---------- settings modal ---------- */
function openModal(){
  const c=STATE.cfg||{};
  $("latInput").value=c.lat??""; $("lonInput").value=c.lon??""; $("altInput").value=c.altitude??"";
  $("keyInput").value="";
  $("clarityOverride").value=c.clarityOverride||"";
  $("tempOverride").value=c.tempOverride||"";
  $("modalStatus").textContent=c.hasKey?"NVE-nøkkel er allerede lagret (skjult).":"Ingen NVE-nøkkel lagret ennå.";
  $("modalBg").classList.add("on");
}
function closeModal(){ $("modalBg").classList.remove("on"); }
async function saveModal(){
  const body={
    lat:parseFloat($("latInput").value), lon:parseFloat($("lonInput").value),
    altitude:parseFloat($("altInput").value),
    clarityOverride:$("clarityOverride").value||null,
    tempOverride: $("tempOverride").value!=="" ? parseFloat($("tempOverride").value) : null
  };
  const k=$("keyInput").value.trim();
  if(k) body.nveApiKey=k;
  $("modalStatus").textContent="Lagrer …";
  await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  // tempOverride/clarityOverride lagres i config men leses fra STATE.cfg etter reload
  closeModal();
  await refresh();
}

/* ---------- init ---------- */
/* ============================================================
   DOMBÅS-GRAF: 14d vannstand+vannføring + 7d vannstandsprognose
   ============================================================ */
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }

function metDailyPrecip(wx){
  const ts=wx&&wx.properties&&wx.properties.timeseries, m={};
  if(!ts) return m;
  for(const e of ts){
    const key=osloDateKey(new Date(e.time));
    const n1=e.data.next_1_hours, n6=e.data.next_6_hours;
    let p=null;
    if(n1&&n1.details&&n1.details.precipitation_amount!=null) p=n1.details.precipitation_amount;
    else if(n6&&n6.details&&n6.details.precipitation_amount!=null) p=n6.details.precipitation_amount;
    if(p!=null) m[key]=(m[key]||0)+p;
  }
  return m;
}
function doyFromKey(key){ const p=key.split("-").map(Number); const s=Date.UTC(p[0],0,0); return Math.floor((Date.UTC(p[0],p[1]-1,p[2])-s)/864e5); }
function normAt(arr,doy){ if(!arr) return null; if(arr[doy]!=null) return arr[doy]; for(let w=1;w<=6;w++){ if(arr[((doy-1+w)%366)+1]!=null) return arr[((doy-1+w)%366)+1]; if(arr[((doy-1-w+366)%366)+1]!=null) return arr[((doy-1-w+366)%366)+1]; } return null; }

/* vannstandsmodell: resesjon mot FLERÅRIG baseflow + nedbørsrespons.
   baseflow forankres i 15-års årsminimum (normals), ikke bare siste 30d. */
function forecastStage(stageVals, precipByDay, lastDate, normals){
  const sorted=[...stageVals].sort((a,b)=>a-b);
  const staticB=sorted[Math.max(0,Math.floor(sorted.length*0.1))];   // fallback: 30d p10
  // flerårig sommer-baseflow = laveste p25 i åpenvanns-sesongen (doy 121–305 ≈ mai–okt).
  // NB: hele-året-minimum unngås bevisst (vinter-isforhold gir kunstig lave vannstander).
  let B=staticB;
  if(normals&&normals.stage&&normals.stage.p25){
    const arr=normals.stage.p25, lows=[];
    for(let doy=121;doy<=305;doy++){ if(arr[doy]!=null) lows.push(arr[doy]); }
    if(lows.length) B=Math.min(...lows);
  }
  B=Math.min(B, stageVals[stageVals.length-1]);   // aldri over dagens nivå (resesjon går nedover)
  const ks=[];
  for(let i=1;i<stageVals.length;i++){
    if(stageVals[i]<stageVals[i-1] && stageVals[i-1]>B+0.01) ks.push((stageVals[i]-B)/(stageVals[i-1]-B));
  }
  let k=ks.length?median(ks):0.92; k=Math.min(0.97,Math.max(0.6,k));
  const alpha=0.004;                                           // m vannstand per mm nedbør (grovt)
  let L=stageVals[stageVals.length-1];
  const out=[];
  for(let d=1; d<=7; d++){
    const date=new Date(lastDate.getTime()+d*864e5);
    const key=osloDateKey(date);
    const p=precipByDay[key]||0;
    const pPrev=precipByDay[osloDateKey(new Date(lastDate.getTime()+(d-1)*864e5))]||0;
    if(L>B) L=B+(L-B)*k;                                       // resesjon kun nedover
    L+=alpha*p + alpha*0.3*pPrev;
    const band=0.03+0.02*d;
    out.push({date, stage:L, lo:Math.max(B*0.9,L-band), hi:L+band, precip:p});
  }
  return {forecast:out, B, k};
}
async function loadDombasChart(){
  STATE.dombas=null;
  if(!STATE.cfg.hasKey) return;
  const to=new Date(), from=new Date(to.getTime()-30*864e5);
  const ref=`${isoDate(from)}/${isoDate(to)}`;
  const r=await getJSON(`/api/nve/Observations?StationId=2.303.0&Parameter=1000,1001&ResolutionTime=1440&ReferenceTime=${ref}`);
  if(r.error||!r.data) return;
  let stageSeries=[], flowSeries=[];
  for(const d of r.data){
    const arr=(d.observations||[]).filter(o=>o.value!=null).map(o=>({date:o.time.slice(0,10), v:o.value}));
    if(d.parameter===1000) stageSeries=arr; else if(d.parameter===1001) flowSeries=arr;
  }
  if(!stageSeries.length) return;
  const [wx, normals]=await Promise.all([
    getJSON(`/api/met?lat=62.087&lon=9.101&altitude=568`),
    getJSON(`/api/normals?station=2.303.0`)
  ]);
  const norm=(normals && !normals.error) ? normals : null;
  const precipByDay=metDailyPrecip(wx);
  const lastDate=new Date(stageSeries[stageSeries.length-1].date+"T12:00:00");
  const fc=forecastStage(stageSeries.map(s=>s.v), precipByDay, lastDate, norm);
  STATE.dombas={stageSeries, flowSeries, fc, normals:norm};
}
function renderDombasChart(){
  const host=$("dombasChart"), cap=$("dombasCap"), leg=$("dombasLegend"), D=STATE.dombas;
  if(!STATE.cfg.hasKey){ host.innerHTML=""; leg.innerHTML=""; cap.textContent="Krever NVE-nøkkel for vanndata."; return; }
  if(!D||!D.stageSeries.length){ host.innerHTML=""; cap.textContent="Ingen data tilgjengelig."; return; }

  const histS=D.stageSeries.slice(-14);
  const flowByDate={}; D.flowSeries.forEach(f=>flowByDate[f.date]=f.v);
  const fc=D.fc.forecast, B=D.fc.B;
  const N=histS.length+fc.length, iToday=histS.length-1;
  const allDates=histS.map(s=>s.date).concat(fc.map(f=>osloDateKey(f.date)));

  // flerårig sesongnormal langs de plottede datoene
  const nS=D.normals&&D.normals.stage;
  const np25=[],np50=[],np75=[];
  if(nS){ allDates.forEach(dk=>{ const dy=doyFromKey(dk); np25.push(normAt(nS.p25,dy)); np50.push(normAt(nS.p50,dy)); np75.push(normAt(nS.p75,dy)); }); }
  const hasNorm=nS && np50.some(v=>v!=null);

  let stageAll=histS.map(s=>s.v).concat(fc.map(f=>f.stage),fc.map(f=>f.lo),fc.map(f=>f.hi),[B]);
  if(hasNorm) stageAll=stageAll.concat(np25.filter(v=>v!=null),np75.filter(v=>v!=null));
  let sMin=Math.min(...stageAll), sMax=Math.max(...stageAll);
  const sPad=(sMax-sMin)*0.12||0.1; sMin-=sPad; sMax+=sPad;
  const flowVals=histS.map(s=>flowByDate[s.date]).filter(v=>v!=null);
  let fMax=(flowVals.length?Math.max(...flowVals):1)*1.15||1;

  const W=1000,H=320,pL=48,pR=56,pT=14,pB=42, pw=W-pL-pR, ph=H-pT-pB;
  const x=i=>pL+i*(pw/(N-1));
  const yS=v=>pT+ph*(1-(v-sMin)/(sMax-sMin));
  const yF=v=>pT+ph*(1-v/fMax);
  const fmt2=v=>(Math.round(v*100)/100).toString().replace(".",",");

  // akse-ticks
  let grid="", axL="", axR="";
  for(let t=0;t<=4;t++){
    const sv=sMin+(sMax-sMin)*t/4, fv=fMax*t/4, yy=yS(sv);
    grid+=`<line x1="${pL}" y1="${yy.toFixed(1)}" x2="${pL+pw}" y2="${yy.toFixed(1)}" stroke="rgba(126,154,152,.13)"/>`;
    axL+=`<text x="${pL-6}" y="${(yy+3).toFixed(1)}" text-anchor="end" font-size="11" fill="#7e9a98" font-family="ui-monospace,monospace">${fmt2(sv)}</text>`;
    axR+=`<text x="${pL+pw+6}" y="${(yF(fv)+3).toFixed(1)}" text-anchor="start" font-size="11" fill="#5e86b0" font-family="ui-monospace,monospace">${Math.round(fv)}</text>`;
  }
  // sesongnormal: bånd p25–p75 + median p50
  let normBand="", normMed="";
  if(hasNorm){
    const top=[],bot=[]; const medPts=[];
    for(let i=0;i<N;i++){ if(np75[i]!=null) top.push([x(i),yS(np75[i])]); if(np25[i]!=null) bot.push([x(i),yS(np25[i])]); if(np50[i]!=null) medPts.push([x(i),yS(np50[i])]); }
    if(top.length&&bot.length){
      const poly=top.concat(bot.slice().reverse());
      normBand=`<polygon points="${poly.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ")}" fill="rgba(126,154,152,.12)" stroke="none"/>`;
    }
    normMed=`<path d="${medPts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ")}" fill="none" stroke="rgba(126,154,152,.6)" stroke-width="1.4" stroke-dasharray="2 4"/>`;
  }

  // x-datoer (hver 3.)
  let xlab="";
  for(let i=0;i<N;i+=3){ const dd=allDates[i]; xlab+=`<text x="${x(i).toFixed(1)}" y="${H-pB+16}" text-anchor="middle" font-size="10.5" fill="#52706e" font-family="ui-monospace,monospace">${dd.slice(8)}.${dd.slice(5,7)}</text>`; }

  // usikkerhetsbånd (forecast)
  let bandPts=[];
  bandPts.push([x(iToday),yS(histS[histS.length-1].v)]);
  fc.forEach((f,j)=>bandPts.push([x(iToday+1+j),yS(f.hi)]));
  for(let j=fc.length-1;j>=0;j--) bandPts.push([x(iToday+1+j),yS(fc[j].lo)]);
  bandPts.push([x(iToday),yS(histS[histS.length-1].v)]);
  const band=`<polygon points="${bandPts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ")}" fill="rgba(224,147,90,.13)" stroke="none"/>`;

  // nedbørsbjelker (forecast) – nederst
  let bars="";
  const pMax=Math.max(1,...fc.map(f=>f.precip));
  fc.forEach((f,j)=>{ if(f.precip>0.05){ const bh=(f.precip/pMax)*40; const xx=x(iToday+1+j); bars+=`<rect x="${(xx-5).toFixed(1)}" y="${(H-pB-bh).toFixed(1)}" width="10" height="${bh.toFixed(1)}" fill="rgba(94,134,176,.45)"/>`; } });

  // linjer
  const stageHistPath=histS.map((s,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+yS(s.v).toFixed(1)).join(" ");
  const fcLinePts=[[x(iToday),yS(histS[histS.length-1].v)]].concat(fc.map((f,j)=>[x(iToday+1+j),yS(f.stage)]));
  const stageFcPath=fcLinePts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  let flowPath="", started=false, flowDots="";
  histS.forEach((s,i)=>{ const v=flowByDate[s.date]; if(v==null) return; flowPath+=(started?"L":"M")+x(i).toFixed(1)+" "+yF(v).toFixed(1)+" "; started=true; });

  const todayX=x(iToday).toFixed(1);
  const baseY=yS(B).toFixed(1);

  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:320px">
    ${grid}
    ${normBand}${normMed}
    <line x1="${pL}" y1="${baseY}" x2="${pL+pw}" y2="${baseY}" stroke="rgba(126,154,152,.4)" stroke-dasharray="2 5"/>
    <text x="${pL+4}" y="${(parseFloat(baseY)-4)}" font-size="10" fill="#52706e">baseflow ~${fmt2(B)} m (15 år)</text>
    ${bars}
    <line x1="${todayX}" y1="${pT}" x2="${todayX}" y2="${H-pB}" stroke="rgba(79,182,168,.5)" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="${todayX}" y="${pT+10}" text-anchor="middle" font-size="10" fill="#4fb6a8">i dag</text>
    ${band}
    <path d="${flowPath.trim()}" fill="none" stroke="#5e86b0" stroke-width="1.6" opacity="0.85"/>
    <path d="${stageHistPath}" fill="none" stroke="#4fb6a8" stroke-width="2.4"/>
    <path d="${stageFcPath}" fill="none" stroke="#e0935a" stroke-width="2.4" stroke-dasharray="6 4"/>
    <circle cx="${todayX}" cy="${yS(histS[histS.length-1].v)}" r="3.6" fill="#4fb6a8"/>
    ${axL}${axR}${xlab}
    <text x="${pL-6}" y="${pT-2}" text-anchor="end" font-size="10" fill="#7e9a98">m</text>
    <text x="${pL+pw+6}" y="${pT-2}" text-anchor="start" font-size="10" fill="#5e86b0">m³/s</text>
  </svg>`;

  leg.innerHTML=`
    <span class="lg"><span class="sw" style="border-color:#4fb6a8"></span>Vannstand (målt)</span>
    <span class="lg"><span class="sw" style="border-color:#e0935a;border-top-style:dashed"></span>Vannstand (prognose)</span>
    <span class="lg"><span class="sw" style="border-color:#5e86b0"></span>Vannføring (målt)</span>`+
    (hasNorm?`<span class="lg"><span class="sw" style="border-color:rgba(126,154,152,.7);border-top-style:dashed"></span>Normal p25–p75 (${D.normals.years[0]}–${D.normals.years[1]})</span>`:``)+
    `<span class="lg"><span class="sw" style="border-color:rgba(94,134,176,.5)"></span>Nedbør (prognose)</span>`;

  const now=histS[histS.length-1].v, end=fc[fc.length-1].stage;
  const dir = end<now-0.02 ? "synkende" : (end>now+0.02 ? "stigende" : "flat");
  const rainDays=fc.filter(f=>f.precip>=2).map(f=>osloDateKey(f.date).slice(8,10)+"."+osloDateKey(f.date).slice(5,7));
  // sammenlign mot sesongnormal i dag
  let normTxt="";
  if(hasNorm){
    const dy=doyFromKey(histS[histS.length-1].date);
    const med=normAt(nS.p50,dy), p10=normAt(nS.p10,dy);
    if(med){
      const pct=Math.round((now-med)/med*100);
      const under10=(p10!=null && now<p10);
      normTxt=` Mot normalen for årstiden (median ${fmt2(med)} m) ligger elva nå <b>${pct>0?"+":""}${pct}%</b>`+
        (under10?` — <b>under 10-persentilen</b>, et utpreget lavvanns-/tidlig resesjonsår.`:`.`);
    }
  }
  cap.innerHTML=`Vannstand nå <b>${fmt2(now)} m</b> (vannføring ${fmt2(flowByDate[histS[histS.length-1].date]||0)} m³/s).`+normTxt+
    ` Prognose: <b>${dir}</b> mot <b>~${fmt2(end)} m</b> om 7 døgn. `+
    (rainDays.length?`Nedbør ${rainDays.join(", ")} demper nedgangen.`:`Lite nedbør ventet — jevn resesjon.`)+
    ` <span class="muted">Baseflow ~${fmt2(B)} m forankret i flerårig sommer-lavvann (p25, mai–okt, ${D.normals?D.normals.years[0]+"–"+D.normals.years[1]:"15 år"}); resesjon (k=${(Math.round(D.fc.k*100)/100).toString().replace(".",",")}) fra 30-dagers trend + MET-nedbør. Grovt estimat — usikkerheten øker med tid.</span>`;
}

/* ============================================================
   LUFTTRYKK-TREND: 14d historikk + 7d prognose (Open-Meteo)
   ============================================================ */
function osloNowISO(){ return new Date().toLocaleString("sv-SE",{timeZone:"Europe/Oslo"}).replace(" ","T").slice(0,13); }
function pressTrendWord(d){ if(d<=-3)return "fallende"; if(d<=-1)return "svakt fallende"; if(d>=3)return "stigende"; if(d>=1)return "svakt stigende"; return "stabilt"; }

async function loadPressureChart(){
  STATE.press=null;
  const c=STATE.cfg;
  const d=await getJSON(`/api/pressure?lat=${c.lat}&lon=${c.lon}`);
  const h=d&&d.hourly;
  if(!h||!h.time||!h.pressure_msl) return;
  const pts=[];
  for(let i=0;i<h.time.length;i++){ if(h.pressure_msl[i]!=null) pts.push({t:h.time[i], v:h.pressure_msl[i]}); }
  if(!pts.length) return;
  let obs=null;
  if(STATE.cfg.hasFrost){
    try{
      const o=await getJSON(`/api/obsseries?source=SN16400&element=air_pressure_at_sea_level&days=14`);
      if(o&&o.points&&o.points.length) obs=o.points;   // {t (UTC), v}
    }catch(e){}
  }
  STATE.press={pts, obs};
}
function renderPressureChart(){
  const host=$("pressChart"), cap=$("pressCap"), leg=$("pressLegend"), P=STATE.press;
  if(!P||!P.pts.length){ host.innerHTML=""; if(leg) leg.innerHTML=""; cap.textContent="Ingen trykkdata."; return; }
  const pts=P.pts.map(p=>({t:p.t, tm:new Date(p.t).getTime(), v:p.v})), N=pts.length, nowISO=osloNowISO();
  let split=P.pts.findIndex(p=>p.t.slice(0,13)>=nowISO); if(split<0) split=N-1;
  const t0=pts[0].tm, t1=pts[N-1].tm;
  const obs=(P.obs||[]).map(p=>({tm:new Date(p.t).getTime(), v:p.v})).filter(p=>p.tm>=t0&&p.tm<=t1);
  const vals=pts.map(p=>p.v).concat(obs.map(p=>p.v));
  let lo=Math.min(...vals), hi=Math.max(...vals); const pad=(hi-lo)*0.12||2; lo-=pad; hi+=pad;
  const W=1000,H=300,pL=46,pR=16,pT=14,pB=40,pw=W-pL-pR,ph=H-pT-pB;
  const xt=tm=>pL+(tm-t0)/(t1-t0)*pw, y=v=>pT+ph*(1-(v-lo)/(hi-lo));

  let grid="",axL="";
  for(let t=0;t<=4;t++){ const vv=lo+(hi-lo)*t/4, yy=y(vv);
    grid+=`<line x1="${pL}" y1="${yy.toFixed(1)}" x2="${pL+pw}" y2="${yy.toFixed(1)}" stroke="rgba(126,154,152,.13)"/>`;
    axL+=`<text x="${pL-6}" y="${(yy+3).toFixed(1)}" text-anchor="end" font-size="11" fill="#7e9a98" font-family="ui-monospace,monospace">${Math.round(vv)}</text>`; }
  let refs="";
  [[1013,"1013 standard"],[1000,"1000 lavt"]].forEach(([rv,lbl])=>{ if(rv>lo&&rv<hi){
    refs+=`<line x1="${pL}" y1="${y(rv).toFixed(1)}" x2="${pL+pw}" y2="${y(rv).toFixed(1)}" stroke="rgba(126,154,152,.3)" stroke-dasharray="2 6"/><text x="${pL+4}" y="${(y(rv)-4).toFixed(1)}" font-size="10" fill="#52706e">${lbl}</text>`; } });
  let xlab="",lastDay="";
  pts.forEach((p)=>{ const day=p.t.slice(0,10); if(day!==lastDay){ lastDay=day; if(parseInt(day.slice(8),10)%3===0) xlab+=`<text x="${xt(p.tm).toFixed(1)}" y="${H-pB+16}" text-anchor="middle" font-size="10.5" fill="#52706e" font-family="ui-monospace,monospace">${day.slice(8)}.${day.slice(5,7)}</text>`; } });
  const histPath=pts.slice(0,split+1).map((p,i)=>(i?"L":"M")+xt(p.tm).toFixed(1)+" "+y(p.v).toFixed(1)).join(" ");
  const fcPath=pts.slice(split).map((p,i)=>(i?"L":"M")+xt(p.tm).toFixed(1)+" "+y(p.v).toFixed(1)).join(" ");
  const obsPath=obs.length?obs.map((p,i)=>(i?"L":"M")+xt(p.tm).toFixed(1)+" "+y(p.v).toFixed(1)).join(" "):"";
  const nowX=xt(pts[split].tm).toFixed(1);
  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:300px">
    ${grid}${refs}
    <line x1="${nowX}" y1="${pT}" x2="${nowX}" y2="${H-pB}" stroke="rgba(79,182,168,.5)" stroke-dasharray="4 3"/>
    <text x="${nowX}" y="${pT+10}" text-anchor="middle" font-size="10" fill="#4fb6a8">nå</text>
    ${obsPath?`<path d="${obsPath}" fill="none" stroke="#5e86b0" stroke-width="1.4" opacity="0.9"/>`:""}
    <path d="${histPath}" fill="none" stroke="#4fb6a8" stroke-width="2"/>
    <path d="${fcPath}" fill="none" stroke="#e0935a" stroke-width="2" stroke-dasharray="6 4"/>
    ${axL}${xlab}<text x="${pL-6}" y="${pT-2}" text-anchor="end" font-size="10" fill="#7e9a98">hPa</text>
  </svg>`;
  if(leg) leg.innerHTML=`
    <span class="lg"><span class="sw" style="border-color:#4fb6a8"></span>Modell historikk</span>
    <span class="lg"><span class="sw" style="border-color:#e0935a;border-top-style:dashed"></span>Modell prognose</span>`+
    (obs.length?`<span class="lg"><span class="sw" style="border-color:#5e86b0"></span>Målt (Dovre-Lannem)</span>`:``);

  // analyse
  const nowV=pts[split].v;
  const d24back=nowV-pts[Math.max(0,split-24)].v;
  const d24=pts[Math.min(N-1,split+24)].v-nowV;
  const d72=pts[N-1].v-nowV;
  let worst=0,worstAt=-1;
  for(let i=split;i<N-12;i++){ const drop=pts[i+12].v-pts[i].v; if(drop<worst){worst=drop;worstAt=i;} }
  let frontTxt="";
  if(worst<=-5){ const day=pts[worstAt].t.slice(8,10)+"."+pts[worstAt].t.slice(5,7);
    frontTxt=`Et markert trykkfall (~${Math.abs(Math.round(worst))} hPa på 12 t) rundt ${day} varsler en front — ofte et godt vindu rett før og under. `; }
  const dNext6=pts[Math.min(N-1,split+6)].v-nowV;
  const cat=pressCat(nowV,dNext6), sub=sPress[cat];
  cap.innerHTML=`Lufttrykk nå <b>${Math.round(nowV)} hPa</b>, <b>${pressTrendWord(d24back)}</b> siste døgn. `+
    `Neste 24 t: ${pressTrendWord(d24)}; mot slutten av uka ${pressTrendWord(d72)}. `+frontTxt+
    `<span class="muted">Gir nå kategori «${PRESS_LABEL[cat]}» → delskår ${sub.toFixed(2)} (vekt 0,16) i Fiskeindeksen. Kilde: Open-Meteo MSL-trykk.</span>`;
}

/* ---------- fiskelogg ---------- */
const round1=x=>(x==null||isNaN(x))?"":Math.round(x*10)/10;
function secondaryWater(){
  const sts=STATE.cfg.stations||[];
  return (sts[1] && STATE.water) ? STATE.water[sts[1].id] : null;
}
/* lufttemp + vind for de lokale værpunktene -> Excel-kolonner */
function wptCols(){
  const find=n=>(STATE.wpts||[]).find(p=>p.label&&p.label.toLowerCase().startsWith(n));
  const dir=p=>(p&&p.windDir!=null)?`${degToCompass(p.windDir)} (${Math.round(p.windDir)}°)`:"";
  const bru=find("brustugu"), lei=find("leirmo");
  return {
    lufttemp_brustugu: bru?round1(bru.air):"", vind_brustugu: bru?round1(bru.wind):"", vindretn_brustugu: dir(bru),
    lufttemp_leirmo: lei?round1(lei.air):"", vind_leirmo: lei?round1(lei.wind):"", vindretn_leirmo: dir(lei)
  };
}
/* faktisk målt (Frost, Lora) -> Excel-kolonner */
function obsCols(){
  const o=STATE.obsStn;
  const dir=(o&&o.windDir!=null)?`${degToCompass(o.windDir)} (${Math.round(o.windDir)}°)`:"";
  return {
    lufttemp_lora_malt: o&&o.air!=null?round1(o.air):"",
    vind_lora_malt: o&&o.wind!=null?round1(o.wind):"",
    vindretn_lora_malt: dir
  };
}
async function logForecast(){
  if(!STATE.now) return;
  const now=STATE.now, w=now.now;
  const prim=STATE.water[STATE.primary]||{}, sec=secondaryWater();
  const [vt]=verdict(now.idx.score);
  const row={
    dato: osloDateKey(new Date()),
    logget: new Date().toLocaleString("no-NO",{timeZone:"Europe/Oslo"}),
    indeks: now.idx.score, vurdering: vt,
    vanntemp_lesja: prim.temp?round1(prim.temp.latest):round1(now.wtNow),
    vannf_lesja: prim.discharge?round1(prim.discharge.latest):"",
    vannfkat_lesja: FLOW_LABEL[now.fcat]||"",
    vanntemp_dombas: (sec&&sec.temp)?round1(sec.temp.latest):"",
    vannf_dombas: (sec&&sec.discharge)?round1(sec.discharge.latest):"",
    lufttemp: round1(w.air), sky: w.cloud!=null?Math.round(w.cloud):"",
    vind: round1(w.wind),
    vindretning: now.windDir!=null?`${degToCompass(now.windDir)} (${Math.round(now.windDir)}°)`:"",
    ...wptCols(),
    ...obsCols(),
    lufttrykk: w.press!=null?Math.round(w.press):"", nedbor: round1(w.precip),
    klarhet: CLAR_LABEL[now.clarity]||"", klekking: HATCH_LABEL[now.state.hatch]||"",
    begrensende: PART_LABELS[now.idx.limiting.key]||""
  };
  try{
    const r=await fetch("/api/log/forecast",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(row)});
    const j=await r.json(); if(j&&j.rows!=null) STATE.progCount=j.rows;
    updateLogCount();
  }catch(e){}
}
function updateLogCount(){
  const o=STATE.obs?STATE.obs.length:0, p=STATE.progCount!=null?STATE.progCount:"–";
  $("logCount").textContent=`· ${p} prognosedager · ${o} observasjoner`;
}
async function loadObsList(){
  try{
    const j=await getJSON("/api/observations");
    STATE.obs=(j&&j.rows)?j.rows:[];
  }catch(e){ STATE.obs=[]; }
  renderObsList(); updateLogCount();
}
function renderObsList(){
  const el=$("obsList"), rows=STATE.obs||[];
  if(!rows.length){ el.innerHTML=`<div class="empty">Ingen observasjoner ennå — registrer din første tur over.</div>`; return; }
  el.innerHTML=rows.slice().reverse().map(o=>{
    const bits=[];
    if(o.strekning) bits.push(o.strekning);
    if(o.antall!=null&&o.antall!=="") bits.push(`<b>${o.antall}</b> fisk`);
    if(o.storste_cm) bits.push(`største <b>${o.storste_cm} cm</b>`);
    if(o.art) bits.push(o.art);
    if(o.flue) bits.push(`flue: <b>${o.flue}</b>`);
    if(o.klekking_obs) bits.push(`klekking: ${o.klekking_obs}`);
    if(o.egen_vanntemp!=null&&o.egen_vanntemp!=="") bits.push(`vann ${o.egen_vanntemp}°`);
    if(o.sikt_obs) bits.push(`sikt: ${o.sikt_obs}`);
    if(o.vind_obs) bits.push(`vind: ${o.vind_obs}`);
    if(o.notat) bits.push(`«${o.notat}»`);
    return `<div class="obsrow"><span class="od">${o.dato||"?"}</span><span class="om">${bits.join(" · ")}</span></div>`;
  }).join("");
}
async function saveObs(){
  const num=id=>{ const v=$(id).value; return v===""?"":parseFloat(v); };
  const row={
    dato: $("ob_dato").value || osloDateKey(new Date()),
    strekning: $("ob_strekning").value, timer: num("ob_timer"), antall: num("ob_antall"),
    storste_cm: num("ob_storste"), art: $("ob_art").value, flue: $("ob_flue").value.trim(),
    klekking_obs: $("ob_klekking").value.trim(), egen_vanntemp: num("ob_vanntemp"),
    sikt_obs: $("ob_sikt").value, vind_obs: $("ob_vind").value.trim(),
    notat: $("ob_notat").value.trim(),
    logget: new Date().toLocaleString("no-NO",{timeZone:"Europe/Oslo"})
  };
  $("logMsg").textContent="Lagrer …";
  try{
    await fetch("/api/log/observation",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(row)});
    $("logMsg").textContent="Lagret ✓";
    ["ob_timer","ob_antall","ob_storste","ob_flue","ob_klekking","ob_vanntemp","ob_vind","ob_notat"].forEach(id=>$(id).value="");
    await loadObsList();
    setTimeout(()=>{$("logMsg").textContent="";},2500);
  }catch(e){ $("logMsg").textContent="Feil ved lagring"; }
}

$("refreshBtn").onclick=refresh;
$("settingsBtn").onclick=openModal;
$("saveObs").onclick=saveObs;
$("ob_dato").value=osloDateKey(new Date());
loadObsList();

/* kartopplasting */
function pickMap(){ $("mapFileInput").click(); }
$("mapUploadBtn").onclick=pickMap;
$("mapUploadBtn2").onclick=pickMap;
$("mapFileInput").onchange=e=>{
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  const reader=new FileReader();
  reader.onload=async()=>{
    try{
      const r=await fetch("/api/mapupload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataUrl:reader.result})});
      const j=await r.json();
      if(j.error){ alert("Kunne ikke lagre kart: "+j.error); return; }
      await loadConfig();
      $("mapImg").dataset.src=""; // tving ny innlasting
      renderMap();
    }catch(err){ alert("Opplasting feilet: "+err); }
  };
  reader.readAsDataURL(f);
};
$("modalCancel").onclick=closeModal;
$("modalSave").onclick=saveModal;
$("modalBg").onclick=e=>{ if(e.target===$("modalBg")) closeModal(); };
refresh();
setInterval(refresh, 15*60*1000); // auto-oppdater hvert 15. min

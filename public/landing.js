/* Forside-status: regner NÅ-fiskeindeks per elv med SAMME modell som dashbordet
   (scoring.js), og viser score + merkelapp + farge på hvert elvekort.
   Speiler nå-tilstanden i app.js buildDays slik at tallet er identisk med dashbordet. */
async function getJSON(u){ const r=await fetch(u); return r.json(); }
const isoDate=d=>d.toISOString().slice(0,10);
function osloHour(d){ return parseInt(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',hour12:false}).format(d),10); }
function timeWindowNow(){ const h=osloHour(new Date()); if(h<6||h>=21) return "lowlight"; if(h<10||h>=18) return "mid"; return "midday"; }
function pctRank(dist,v){ if(!dist||!dist.length) return 0.5; return dist.filter(x=>x<=v).length/dist.length; }

async function riverStatus(cfg){
  if(cfg.lat==null) return null;
  const wx=await getJSON(`/api/met?lat=${cfg.lat}&lon=${cfg.lon}&altitude=${cfg.altitude||0}`);
  const ts=wx&&wx.properties&&wx.properties.timeseries;
  if(!ts||!ts.length) return null;
  const n0=ts[0], det=n0.data.instant.details, t0=new Date(n0.time).getTime();
  let p3=det.air_pressure_at_sea_level;
  for(const e of ts){ if(new Date(e.time).getTime()-t0>=3*36e5){ p3=e.data.instant.details.air_pressure_at_sea_level; break; } }
  const air=det.air_temperature, cloud=det.cloud_area_fraction, wind=det.wind_speed,
        hum=det.relative_humidity, press=det.air_pressure_at_sea_level;

  // vann: temp + vannføring fra FØRSTE ferske stasjon (samme logikk som app.js loadWater)
  const stations=(cfg.stations&&cfg.stations.length)?cfg.stations:(cfg.station?[{id:cfg.station}]:[]);
  let wt=null, dis=null, disDist=null, disTrend=0, disStation=null;
  if(cfg.hasKey){
    const to=new Date(), from=new Date(to.getTime()-60*864e5), ref=isoDate(from)+'/'+isoDate(to);
    for(const st of stations){
      const r=await getJSON(`/api/nve/Observations?StationId=${st.id}&Parameter=1001,1003&ResolutionTime=1440&ReferenceTime=${ref}`);
      if(!r||!r.data) continue;
      for(const d of r.data){
        const obs=(d.observations||[]).filter(o=>o.value!=null);
        if(!obs.length) continue;
        const last=obs[obs.length-1];
        if(Date.now()-new Date(last.time).getTime()>=5*864e5) continue;   // utdatert serie
        if(d.parameter===1003 && wt==null) wt=last.value;
        if(d.parameter===1001 && dis==null){
          dis=last.value; disStation=st.id; disDist=obs.map(o=>o.value);
          const tl=new Date(last.time).getTime(); let prev=null;
          for(let i=obs.length-1;i>=0;i--){ if(tl-new Date(obs[i].time).getTime()>=22*36e5){prev=obs[i];break;} }
          disTrend=prev?last.value-prev.value:0;
        }
      }
    }
  }
  // vannføring i % av normal (sesongnormal p50, median-fallback)
  let flowPct=null, flowTrend=0, flowLevel=0.55;
  if(cfg.flowFixed!=null){ flowPct=cfg.flowFixed; }      // fast (stillevann)
  else if(dis!=null){
    flowLevel=pctRank(disDist,dis);
    flowTrend=dis?disTrend/dis:0;
    const nrm=await getJSON('/api/normals?station='+disStation);
    const p50=nrm&&nrm.discharge&&nrm.discharge.p50, doy=dayOfYear(new Date());
    if(p50&&p50[doy]>0) flowPct=dis/p50[doy]*100;
    else { const a=[...disDist].sort((x,y)=>x-y), m=a[Math.floor(a.length/2)]; if(m) flowPct=dis/m*100; }
  }
  // modellert temp hvis ingen måling (samme anker som app.js: nå-luft + smeltevannsgulv)
  if(wt==null){ const fl=flowLevel>0.6?6:(flowLevel>0.42?4.5:-99); wt=Math.max(0,Math.min(19,Math.max(air-1.0,fl))); }

  const state={temp:wt, windAvg:wind, flowPct, flowTrend, cloud:cloudCat(cloud), time:timeWindowNow(),
               season:seasonFromTemp(wt), airTemp:air, humidity:hum, pressTrend:(p3-press)};
  const idx=computeIndex(state);
  const [label,color]=verdict(idx.score, wind);
  return {score:idx.score, label, color};
}

(async function(){
  // dato under overskriften – understreker at dataene er ferske i dag
  const dEl=document.getElementById('lpDate');
  if(dEl){
    const d=new Date().toLocaleDateString('nb-NO',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    dEl.innerHTML=`<span class="livedot ok"></span> Live i dag · <span class="d">${d.charAt(0).toUpperCase()+d.slice(1)}</span>`;
  }
  const grid=document.getElementById('riverGrid');
  let data;
  try{ data=await getJSON('/api/rivers'); }catch(e){ grid.innerHTML='<div class="lp-empty">Kunne ikke laste elveliste.</div>'; return; }
  const rivers=(data&&data.rivers)||[];
  if(!rivers.length){ grid.innerHTML='<div class="lp-empty">Ingen elver konfigurert ennå.</div>'; return; }
  rivers.sort((a,b)=>(a.kind==='stillevann'?1:0)-(b.kind==='stillevann'?1:0));   // stillevann-områder nederst
  grid.innerHTML=rivers.map(r=>{
    const live=r.draft?"":`<span class="lp-live"><span class="livedot ok"></span>live</span>`;
    const kind=(r.kind==='stillevann')?`<span class="lp-kind">(stillevann)</span>`:"";
    const head=`<div class="lp-namerow"><div class="lp-name">${r.shortName||r.name||r.id}${kind}</div>${live}</div>`+(r.region?`<div class="lp-region">${r.region}</div>`:"");
    if(r.draft) return `<div class="lp-card lp-draft" aria-disabled="true" title="Under arbeid – kommer snart">${head}<div class="lp-badge">Under arbeid</div></div>`;
    return `<a class="lp-card" href="/${r.id}">${head}
      <div class="lp-status" id="st-${r.id}"><span class="lp-load">Laster forhold …</span></div>
      <div class="lp-go">Åpne dashbord →</div></a>`;
  }).join("");
  // fyll inn live-status per elv (parallelt)
  rivers.filter(r=>!r.draft).forEach(async r=>{
    const el=document.getElementById('st-'+r.id);
    try{
      const cfg=await getJSON('/api/config?river='+r.id);
      const s=await riverStatus(cfg);
      if(el&&s) el.innerHTML=`<span class="lp-score" style="color:${s.color}">${s.score}</span><span class="lp-sep">/100</span><span class="lp-verdict" style="color:${s.color}">${s.label}</span>`;
      else if(el) el.innerHTML=`<span class="lp-load">Forhold utilgjengelig nå</span>`;
    }catch(e){ if(el) el.innerHTML=`<span class="lp-load">Forhold utilgjengelig nå</span>`; }
  });
})();

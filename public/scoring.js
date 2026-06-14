/* ============================================================
   Fiskeindeks – scoringsmodell for ørret/harr i elv.
   Speiler vektene og delskår-funksjonene fra fiskeindeks_1.html
   eksakt, og legger på kartlegging fra live-data -> kategorier
   samt en klekke-/flueråd-modul bygd på researchdokumentet.
   ============================================================ */

const W = {temp:0.24, light:0.18, press:0.16, flow:0.15, clarity:0.10, hatch:0.09, wind:0.05, stab:0.03};

/* ---- delskår-funksjoner (0..1) – identiske med originalen ---- */
function sTemp(t){
  if(t<2)return 0.10; if(t<4)return 0.25; if(t<7)return 0.45; if(t<10)return 0.70;
  if(t<=14)return 1.00; if(t<=16)return 0.95; if(t<=18)return 0.70; if(t<20)return 0.40; return 0.10;
}
function sLight(cloud,time,season){
  const m={
    overcast:{lowlight:1.00,mid:0.90,midday:0.82},
    partly:  {lowlight:0.88,mid:0.72,midday:0.55},
    clear:   {lowlight:0.72,mid:0.55,midday:0.32}
  };
  let v=m[cloud][time];
  if(season==="cold" && cloud==="clear" && time==="midday") v=Math.min(1,v+0.28);
  if(season==="cold" && cloud==="clear" && time==="mid")    v=Math.min(1,v+0.15);
  return v;
}
const sPress={falling:1.00,stable:0.78,slowrise:0.55,bluebird:0.25,lowflat:0.40};
const sFlow ={optimal:1.00,risingfromlow:0.92,high:0.70,lowclear:0.55,flood:0.30,drought:0.30};
const sClar ={tinge:1.00,gin:0.70,stained:0.48,muddy:0.20};
const sHatch={active:1.00,likely:0.75,sparse:0.45,none:0.30};
const sWind ={breeze:1.00,calm:0.80,fresh:0.55,strong:0.30};
const sStab ={stable:1.00,moderate:0.65,abrupt:0.35};

function gates(s){
  let g=1, msg="", cls="";
  if(s.temp>=20){ g*=0.15; msg="Vannet er ≥ 20 °C — ørreten er oksygenstresset. Indeksen er sterkt nedjustert, og du bør la fisken være."; cls="warn"; }
  else if(s.temp>=18){ g*=0.6; if(!msg){msg="Vannet nærmer seg stressgrensen (18–20 °C). Fisk tidlig/sent og land raskt."; cls="note";} }
  if(s.flow==="flood" || s.clarity==="muddy"){ g*=0.45; if(!msg){msg="Flom eller sjokoladebrunt vann overstyrer det meste — søk klarere vann langs bredden eller vent på at silten klarner."; cls="note";} }
  return {g,msg,cls};
}

const PART_LABELS = {
  temp:"Vanntemperatur", light:"Lys / sky / tid", press:"Lufttrykk-trend", flow:"Vannføring",
  clarity:"Vannklarhet", hatch:"Klekking / næring", wind:"Vind", stab:"Stabilitet"
};

/* state = {temp, cloud, time, press, flow, clarity, hatch, wind, stab, season} */
function computeIndex(state){
  const light=sLight(state.cloud,state.time,state.season);
  const parts=[
    {key:"temp",   w:W.temp,   s:sTemp(state.temp)},
    {key:"light",  w:W.light,  s:light},
    {key:"press",  w:W.press,  s:sPress[state.press]},
    {key:"flow",   w:W.flow,   s:sFlow[state.flow]},
    {key:"clarity",w:W.clarity,s:sClar[state.clarity]},
    {key:"hatch",  w:W.hatch,  s:sHatch[state.hatch]},
    {key:"wind",   w:W.wind,   s:sWind[state.wind]},
    {key:"stab",   w:W.stab,   s:sStab[state.stab]},
  ];
  const raw=parts.reduce((a,p)=>a+p.w*p.s,0);
  const {g,msg,cls}=gates(state);
  const score=Math.round(100*g*raw);
  // begrensende faktor = leddet som "stjeler" mest poeng: (1 - delskår) × vekt
  let limiting=parts[0], worst=-1;
  parts.forEach(p=>{ const room=(1-p.s)*p.w; if(room>worst){worst=room;limiting=p;} });
  return {score,parts,g,msg,cls,limiting};
}

function verdict(v){
  if(v>=78)return ["Utmerket","#4fb6a8"];
  if(v>=64)return ["Veldig bra","#6fc27a"];
  if(v>=50)return ["Lovende","#c9b85a"];
  if(v>=36)return ["Variabelt","#e0935a"];
  return ["Tøft","#d8624a"];
}

/* ============================================================
   KARTLEGGING: rå live-data -> modellkategorier
   ============================================================ */

function cloudCat(frac){            // cloud_area_fraction 0..100
  if(frac==null) return "partly";
  if(frac>=70) return "overcast";
  if(frac>=30) return "partly";
  return "clear";
}
function windCat(ms){
  if(ms==null) return "breeze";
  if(ms<2) return "calm";
  if(ms<6) return "breeze";
  if(ms<9) return "fresh";
  return "strong";
}
/* lufttrykk: nivå (hPa) + trend (dP over perioden, hPa) */
function pressCat(level, dP){
  if(dP<=-2.5) return "falling";          // tydelig fallende, ofte før front -> best
  if(dP<=-0.8) return "falling";
  if(dP>=2.5)  return (level>=1018?"bluebird":"slowrise");
  if(dP>=0.8)  return "slowrise";
  if(level<1002) return "lowflat";        // lavt og flatt
  return "stable";
}
/* flow-nivå 0..1 (0=tørke … 1=flom) -> kategori.
   `rising` = kortidstrend (m³/s endring siste døgn, fortegn) */
function flowCat(level, rising, warm){
  if(level>=0.85) return "flood";
  if(level>=0.62) return (rising>0.05?"flood":"high");
  if(level<=0.18) return (warm? "drought":"lowclear");
  if(level<=0.34) return (rising>0.04?"risingfromlow":"lowclear");
  return "optimal";
}
/* klarhet utledet av flow-kategori + nedbør siste døgn (mm) */
function clarityFromFlow(fcat, recentRainMm){
  if(fcat==="flood") return "muddy";
  if(fcat==="high")  return recentRainMm>12 ? "stained" : "tinge";
  if(fcat==="risingfromlow") return recentRainMm>15 ? "stained" : "tinge";
  if(fcat==="lowclear"||fcat==="drought") return "gin";
  return recentRainMm>20 ? "stained" : "tinge";   // optimal
}
function seasonFromTemp(t){ return t==null ? "warm" : (t<7 ? "cold":"warm"); }
function timeWindow(){ return "lowlight"; } // dagsrangering: anta at du fisker primtid

/* stabilitet ut fra endring i sky/trykk mot forrige dag */
function stabCat(dCloud, dPress){
  const a=Math.abs(dCloud||0), b=Math.abs(dPress||0);
  if(a>55 || b>9) return "abrupt";
  if(a>25 || b>4) return "moderate";
  return "stable";
}

/* ============================================================
   KLEKKING & FLUERÅD  (researchdokument: aurivillii, baetis …)
   dato + vanntemp + sky + nedbør -> kategori + tekstråd
   ============================================================ */
function dayOfYear(d){
  const start=new Date(Date.UTC(d.getUTCFullYear(),0,0));
  return Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-start)/86400000);
}

function hatchState(date, waterTemp, cloudFrac, rainMm){
  // grunnpotensial fra årstid (Lesja, høyt & nordlig -> klekking komprimert rundt St.Hans+)
  const doy=dayOfYear(date);
  let seasonPot;
  if(doy<152) seasonPot=0.45;             // før 1. juni
  else if(doy<=200) seasonPot=1.00;       // ~1.jun–19.jul: aurivillii/baetis-vinduet
  else if(doy<=243) seasonPot=0.85;       // ut august: vårflue/baetis
  else if(doy<=260) seasonPot=0.65;       // tidlig sept
  else seasonPot=0.40;

  // temperaturvindu for insektaktivitet
  let tPot=0.4;
  if(waterTemp!=null){
    if(waterTemp<5) tPot=0.30;
    else if(waterTemp<8) tPot=0.65;
    else if(waterTemp<=15) tPot=1.00;     // aurivillii/baetis trives
    else if(waterTemp<=18) tPot=0.70;
    else tPot=0.35;
  }
  // vær: overskyet + lett regn + fukt = klassisk baetis/aurivillii-vindu
  let wPot=0.6;
  const cl=cloudFrac==null?60:cloudFrac;
  if(cl>=70 && rainMm>0.1 && rainMm<4) wPot=1.00;     // drittværsflua elsker dette
  else if(cl>=70) wPot=0.85;
  else if(cl>=30) wPot=0.7;
  else wPot=0.45;                                      // klart & tørt = dårligere klekk
  if(rainMm>=6) wPot=Math.min(wPot,0.75);             // kraftig regn demper

  const score=seasonPot*0.45 + tPot*0.35 + wPot*0.20;
  let cat;
  if(score>=0.82) cat="active";
  else if(score>=0.62) cat="likely";
  else if(score>=0.42) cat="sparse";
  else cat="none";
  return {cat, score, seasonPot, tPot, wPot};
}

/* full tekstråd for et gitt døgn */
function hatchAdvice(date, waterTemp, cloudFrac, rainMm){
  const hs=hatchState(date, waterTemp, cloudFrac, rainMm);
  const doy=dayOfYear(date);
  const cl=cloudFrac==null?60:cloudFrac;
  const wet=rainMm>0.1, overcast=cl>=70;

  let primary, flies=[], tactic;

  if(doy>=160 && doy<=196){          // ~9.jun–15.jul: kjerneperioden
    primary="Stor elvedøgnflue (Ephemerella aurivillii/aroni) er primærflua rundt St. Hans og 3–4 uker fram — «den viktigste døgnflua i rennende vann i Norge». Baetis rhodani («drittværsflua») går parallelt, særlig i regn.";
    flies=[
      ["Aurivillii-klekker / -dun","#12–#14 — nøkkelflue, henger lenge i filmen"],
      ["Klinkhåmer, mørk brun","#12–#16 — klekker i strøm"],
      ["Parachute Adams","#14–#16 — allround døgnflue"],
      ["CDC Comparadun / F-fly","#14–#18 — baetis & små klekkere"],
      ["Pheasant Tail nymfe","#14–#16 — under klekking / blindfiske"],
      ["Superpuppan","#10–#14 — vårflue i skumringen"],
    ];
    tactic = overcast
      ? "Fullt skydekke gir lavlys-fordel hele dagen — du kan fiske midt på dagen like gjerne som i gryningen. Fisk klekker/dun i filmen når du ser vak."
      : "Klart vær: konsentrer innsatsen formiddag ved klekking og skumring. Hold lav silhuett i det klare vannet.";
  } else if(doy>=197 && doy<=243){    // sensommer
    primary="Vårfluer dominerer nå (Rhyacophila, Hydropsyche), med fortsatt baetis og Heptagenia (gul flatdøgnflue). Klekking ofte mot kveld/mørke.";
    flies=[
      ["Superpuppan, flere farger","#10–#14 — svømmepuppe mot land, stripefritt"],
      ["CDC & Elk / March Brown","#12–#16 — voksen vårflue"],
      ["Heptagenia-imitasjon, gul","#12–#14"],
      ["Spent spinner","#14–#18 — spinnerfall i skumring"],
      ["Goddard/Streaking Caddis","#12–#16"],
    ];
    tactic="Sett av skumringen til puppefiske og spinnerfall. Stor aure trekker nær land for å beite når lyset svinner.";
  } else if(doy>=152 && doy<=159){    // tidlig juni
    primary="Forsommer: baetis og fjærmygg er i gang, aurivillii på trappene. Avhenger sterkt av at snøsmeltingsflommen avtar og elva klarner.";
    flies=[
      ["Pheasant Tail / Hare's Ear nymfe","#12–#16 — tungt ved høy/farget vann"],
      ["Woolly Bugger","#8–#10 — streamer i grumset/høyt vann"],
      ["Baetis-klekker / CDC","#14–#16 når elva klarner"],
      ["Griffiths Gnat","#16–#20 — fjærmygg morgen/kveld"],
    ];
    tactic="Ved høyt/farget vann: tunge nymfer og streamer langs kantene. Vent på klarvann for tørrflue.";
  } else {
    primary="Utenfor kjerneperioden. Fjærmygg klekker hele sesongen (morgen/kveld); baetis-høstgenerasjon små utover september.";
    flies=[
      ["Griffiths Gnat / myggklekker","#16–#20"],
      ["Liten baetis CDC","#18–#20"],
      ["Pheasant Tail nymfe","#14–#18"],
    ];
    tactic="Fisk fint og smått på stille partier morgen og kveld.";
  }

  // værbetinget tilleggsnotat
  let note="";
  if(overcast && wet) note="Lærebok-forhold for baetis/aurivillii: fullt skydekke + lett regn + høy fukt. Forvent vak.";
  else if(!overcast && !wet) note="Klart og tørt demper klekkingen — fisken blir sky i det krystallklare vannet. Lange, tynne fortommer (0,12–0,15 mm).";
  else if(rainMm>=6) note="Kraftig regn kan grumse og heve vannet — følg med på vannføringen; bytt til tunge nymfer/streamer hvis det stiger.";

  return {state:hs, primary, flies, tactic, note};
}

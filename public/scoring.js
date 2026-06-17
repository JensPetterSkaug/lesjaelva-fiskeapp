/* ============================================================
   Fiskeindeks – scoringsmodell for ørret/harr i elv.
   Speiler vektene og delskår-funksjonene fra fiskeindeks_1.html
   eksakt, og legger på kartlegging fra live-data -> kategorier
   samt en klekke-/flueråd-modul bygd på researchdokumentet.
   ============================================================ */

/* Vekter (sum = 1,00). Kalibrert for ørret/harr i elv.
   yr.no: lufttemp, fukt, trykk-tendens, sky+tid (lys), snittvind.
   NVE Sildre: vanntemp, vannføring (% av normal + trend). */
const W = {temp:0.25, wind:0.25, flow:0.20, light:0.15, airtemp:0.05, humidity:0.05, press:0.05};

/* ---- delskår-funksjoner (0..1) ---- */
function sTemp(t){
  if(t==null) return 0.5;
  if(t<2)return 0.10; if(t<4)return 0.25; if(t<7)return 0.45; if(t<10)return 0.70;
  if(t<=14)return 1.00; if(t<=16)return 0.95; if(t<=18)return 0.70; if(t<20)return 0.40; return 0.10;
}
/* snittvind (m/s) – yr sitt første tall, ikke kast */
function sWindAvg(ms){
  if(ms==null) return 0.85;
  if(ms<1)return 1.00; if(ms<2)return 0.95; if(ms<3)return 0.85; if(ms<4)return 0.60;
  if(ms<6)return 0.35; if(ms<8)return 0.25; if(ms<10)return 0.18; return 0.12;
}
function sLight(cloud,time,season){
  const m={
    overcast:{lowlight:1.00,mid:0.90,midday:0.82},
    partly:  {lowlight:0.88,mid:0.72,midday:0.55},
    clear:   {lowlight:0.72,mid:0.55,midday:0.32}
  };
  let v=m[cloud][time];
  if(season==="cold" && cloud==="clear" && time==="midday") v=Math.min(1,v+0.28);  // sol varmer vannet, fjærmygg
  return v;
}
/* lufttemperatur (°C) fra yr */
function sAirTemp(t){
  if(t==null) return 0.85;
  if(t<0)return 0.30; if(t<5)return 0.45; if(t<10)return 0.65; if(t<15)return 0.85;
  if(t<=22)return 1.00; if(t<=26)return 0.80; return 0.60;
}
/* luftfuktighet (%) fra yr */
function sHumidity(h){
  if(h==null) return 0.75;
  if(h<40)return 0.45; if(h<55)return 0.60; if(h<70)return 0.75; if(h<=85)return 0.90; return 1.00;
}
/* lineær interpolasjon over kontrollpunkter [[x,y],…] (x stigende) */
function interp(pts, x){
  if(x<=pts[0][0]) return pts[0][1];
  if(x>=pts[pts.length-1][0]) return pts[pts.length-1][1];
  for(let i=0;i<pts.length-1;i++){ const [x0,y0]=pts[i],[x1,y1]=pts[i+1];
    if(x>=x0 && x<=x1) return y0+(y1-y0)*(x-x0)/(x1-x0); }
  return pts[pts.length-1][1];
}
/* lufttrykk-TENDENS (ΔhPa over 3 t) fra yr */
function sPressTrend(dP){
  if(dP==null) return 0.80;
  if(dP<=-5) return 0.70;                                    // svært bratt fall (storm)
  return interp([[-5,0.70],[-4,1.00],[-2,1.00],[-1,0.90],[0,0.80],[1,0.62],[4,0.30],[5,0.24]], dP);
}
/* vannføring: nivå-kurve (% av normal), topp 90–115 % */
function sFlowLevel(pct){
  if(pct==null) return 0.85;
  return interp([[20,0.35],[50,0.58],[75,0.82],[90,1.00],[115,1.00],[140,0.82],[175,0.58],[220,0.36],[300,0.24],[400,0.15]], pct);
}
/* trend-multiplikator (hysterese), avhengig av nivå% og relativ 24t-trend */
function flowTrendMult(pct, relTrend){
  if(pct==null||relTrend==null) return 1.00;
  if(relTrend>0.20) return pct>150?0.40:(pct>110?0.70:0.95);  // sterkt stigende
  if(relTrend>0.05){                                          // stigende
    if(pct<110) return 1.08;                                  // fra lav
    if(pct>150) return 0.68;                                  // ved høy
    return 1.00;
  }
  if(relTrend<-0.05) return pct>120?1.10:1.00;                // fallende fra høy -> klarner
  return 1.00;                                                // stabil
}
function sFlow(pct, relTrend){
  return Math.max(0, Math.min(1, sFlowLevel(pct)*flowTrendMult(pct,relTrend)));
}

/* kategori-baserte delskår – brukes av time-for-time-rapporten og trykk-grafen (ikke hovedindeksen) */
const sPress={falling:1.00,stable:0.78,slowrise:0.55,bluebird:0.25,lowflat:0.40};
const sClar ={tinge:1.00,gin:0.70,stained:0.48,muddy:0.20};
const sHatch={active:1.00,likely:0.75,sparse:0.45,none:0.30};
const sWind ={breeze:1.00,calm:0.80,fresh:0.55,strong:0.30};

/* multiplikative porter; G = produkt (hver ≤ 1). Setter også varsel-melding. */
function gates(s){
  let g=1, msg="", cls="";
  // flom-port (sikkerhet) – høyest prioritet på melding
  if(s.flowPct!=null && s.flowPct>=175){
    const falling=(s.flowTrend!=null && s.flowTrend<-0.05);
    let fg = s.flowPct>=250?0.10 : s.flowPct>=200?0.20 : (1.00-0.55*(s.flowPct-175)/25);
    if(falling) fg=Math.min(1.0, fg*1.4);
    g*=fg;
    if(s.flowPct>=200 && !falling){
      msg=`Svært høy vannføring (~${Math.round(s.flowPct)} % av normal) — elva er i praksis ikke fiskbar, og høy/stigende vannføring er farlig å vade. Vent til den faller og klarner.`; cls="warn";
    } else {
      msg=`Høy vannføring (~${Math.round(s.flowPct)} % av normal)${falling?", men fallende — klarner":""}. Søk roligere kanter og vær forsiktig med vading.`; cls="note";
    }
  }
  // temp-port
  if(s.temp>=20){ g*=0.15; if(!msg){ msg="Vannet er ≥ 20 °C — ørreten er oksygenstresset. Indeksen er sterkt nedjustert, og du bør la fisken være."; cls="warn"; } }
  else if(s.temp>=18){ g*=0.6; if(!msg){ msg="Vannet nærmer seg stressgrensen (18–20 °C). Fisk tidlig/sent og land raskt."; cls="note"; } }
  // vind-port: tørrfluepresentasjon kollapser over ~6 m/s snittvind
  if(s.windAvg!=null && s.windAvg>6){
    const wg = s.windAvg>=10 ? 0.15 : interp([[6,1.00],[7,0.55],[8,0.38],[10,0.20]], s.windAvg);
    g*=wg;
    if(!msg){ msg=`Sterk snittvind (${Math.round(s.windAvg)} m/s) gjør tørrfluefiske vanskelig — fisk tyngre nymfe/streamer eller søk le.`; cls="note"; }
  }
  // bakoverkompatibel flom/grums-port for time-for-time-modellen (kategori-felt)
  if(s.flow==="flood" || s.clarity==="muddy"){ g*=0.45; if(!msg){ msg="Flom eller svært grumset vann — søk klarere vann langs bredden eller vent."; cls="note"; } }
  return {g,msg,cls};
}

const PART_LABELS = {
  temp:"Vanntemperatur", wind:"Vind (snitt)", flow:"Vannføring", light:"Lysforhold",
  airtemp:"Lufttemperatur", humidity:"Luftfuktighet", press:"Lufttrykk-tendens"
};

/* state = {temp, windAvg, flowPct, flowTrend, cloud, time, season, airTemp, humidity, pressTrend} */
function computeIndex(state){
  const light=sLight(state.cloud,state.time,state.season);
  const parts=[
    {key:"temp",    w:W.temp,    s:sTemp(state.temp)},
    {key:"wind",    w:W.wind,    s:sWindAvg(state.windAvg)},
    {key:"flow",    w:W.flow,    s:sFlow(state.flowPct,state.flowTrend)},
    {key:"light",   w:W.light,   s:light},
    {key:"airtemp", w:W.airtemp, s:sAirTemp(state.airTemp)},
    {key:"humidity",w:W.humidity,s:sHumidity(state.humidity)},
    {key:"press",   w:W.press,   s:sPressTrend(state.pressTrend)},
  ];
  const raw=parts.reduce((a,p)=>a+p.w*p.s,0);
  const {g,msg,cls}=gates(state);
  const score=Math.round(100*g*raw);
  // begrensende faktor = leddet som "stjeler" mest poeng: (1 - delskår) × vekt
  let limiting=parts[0], worst=-1;
  parts.forEach(p=>{ const room=(1-p.s)*p.w; if(room>worst){worst=room;limiting=p;} });
  return {score,parts,g,msg,cls,limiting};
}

/* merkelapp + farge etter indeks (0–100) OG snittvind (m/s).
   Vind ≤ 3,0 m/s = rolig (tørrflue-vennlig); > 3,0 m/s = søk le.
   Returnerer [full label (vind-avhengig), farge, kort label (til trange visninger)]. */
function verdict(v, windAvg){
  const windy = (windAvg!=null && windAvg>3.0);
  let color, calm, gust, short;
  if(v>=90){      color="#4fb6a8"; calm="Perfekt tørrfluefiske";     gust="Bra, men søk LE-plasser";          short="Perfekt"; }
  else if(v>=80){ color="#6fc27a"; calm="Veldig bra tørrfluefiske";  gust="Muligheter, men søk LE-plasser";   short="Veldig bra"; }
  else if(v>=70){ color="#c9b85a"; calm="Gode muligheter";           gust="Ok muligheter, men mye vind";      short="Gode forhold"; }
  else if(v>=50){ color="#e0935a"; calm="Ok muligheter";             gust="Utfordrende";                      short="Ok"; }
  else {          color="#d8624a"; calm="Finn et annet sted å fiske"; gust="Finn et annet sted å fiske";       short="Lite lovende"; }
  return [windy?gust:calm, color, short];
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

/* ------------------------------------------------------------
   LESJA SONE 7 – sesongbasert, forhold-styrt fluevalg
   (syntese fra «Sesongbasert flueguide for Lesjaelva i sone 7»)
   ------------------------------------------------------------ */
/* sesongperiode for sone 7 ut fra dag-på-året */
function lesjaPeriod(doy){
  if(doy>=152 && doy<=165) return "tidlig";      // ~1.–14. jun: kaldt, snøsmelting
  if(doy>=166 && doy<=181) return "forsommer";   // 15. jun–30. jun: lesbar tørrflueelv
  if(doy>=182 && doy<=212) return "hoysommer";   // jul: vårfluer dominerer
  if(doy>=213 && doy<=243) return "sensommer";   // aug: landinsekter, små mønstre
  if(doy>=244 && doy<=271) return "host";         // 1.–20. sep: små olivener, mygg
  return "utenfor";
}
const LESJA_PERIOD_TXT={
  tidlig:"Tidlig sesong: kaldt til kjølig vann (ofte 7–11 °C), gjerne preget av snøsmelting. Tenk nymfer, pupper og små olivener — start ofte under overflaten med PT eller en oliven emerger.",
  forsommer:"Forsommer: elva blir mer lesbar som tørrflueelv. Små oliven døgnfluer (Baetis) først, deretter mellomstore (Aurivillii). På grå/regnfulle dager slår klekkeren ofte dunen.",
  hoysommer:"Høysommer: vårfluene blir stadig viktigere. CDC Caddis er sterk i blankt, stilleflytende vann; Brun's Caddis når eggleggere gir plaskvak. Klart, rolig vann — fisk gjerne på synlig fisk.",
  sensommer:"Sensommer: landinsekter og små, diskrete mønstre teller mest — maur, små CDC-vårfluer, ignita/spinner og mygg. Lavt og klart vann: gå ned i størrelse, ikke opp.",
  host:"Tidlig høst: kort, men god periode for små olivener, mygg og nymfer (Baetis-høstgenerasjon, Ignita). Fisk gjerne subsurface mellom vakene og bytt raskt til emerger når det vaker.",
  utenfor:"Utenfor kjernesesongen. Sjekk lokale fiskeregler/åpningstider. Hvis du fisker: små olivener, mygg og slanke nymfer på stille partier."
};
/* flueboks – prio fra «må-ha»-rangeringen i guiden (arketype: kald høyfjellselv).
   seasons: perioder fluen er aktuell ('all' = hele sesongen).
   tags: forhold den løftes av (clearLow=lav&klar, overcastRain=grått/regn,
   highWater=høy/farget, evening=kveldsvak). allRound=basisføde hele tiden. */
const LESJA_FLIES=[
  {name:"CDC Caddis",type:"Tørrflue",size:"#12–16",im:"Voksen vårflue",lat:"Trichoptera",prio:1,seasons:["forsommer","hoysommer","sensommer","host"],tags:["clearLow","evening"],tip:"Sterk i blankt, stilleflytende vann; fiskes dødt eller med bittesmå twitch."},
  {name:"CDC Comparadun Olive",type:"Tørrflue",size:"#14–18",im:"Liten døgnflue (baetis)",lat:"Baetis rhodani",prio:2,seasons:["tidlig","forsommer","hoysommer","sensommer","host"],tags:["clearLow"],allRound:true,tip:"Allround oliven dun — perfekt i klart, lavt vann; fiskes helt dødt."},
  {name:"Pheasant Tail Nymph",type:"Nymfe",size:"#14–18",im:"Døgnflue-nymfe",lat:"Baetis / Ephemerella",prio:3,seasons:["all"],tags:["highWater"],allRound:true,tip:"Allround hovednymfe; kort, kontrollert drift mot synlig fisk."},
  {name:"Klinkhammer Olive",type:"Emerger",size:"#14–16",im:"Klekkende døgnflue",lat:"Baetis / E. aurivillii",prio:4,seasons:["tidlig","forsommer","hoysommer","sensommer","host"],tags:["overcastRain","clearLow"],tip:"Perfekt når fisken bare viser snute; fiskes lavt og dødt i filmen."},
  {name:"Aurivillii-emerger",type:"Emerger",size:"#12–14",im:"Stor elvedøgnflue (klekker)",lat:"Ephemerella aurivillii",prio:5,seasons:["forsommer","hoysommer"],tags:["overcastRain"],tip:"Nøkkelvalg når aurivillii henger i filmen — fiskes rolig og presist."},
  {name:"Aurivillii-dun",type:"Tørrflue",size:"#12–14",im:"Stor elvedøgnflue",lat:"Ephemerella aurivillii",prio:6,seasons:["forsommer","hoysommer"],tags:[],tip:"Når fisken vil ha litt større døgnfluer; fisk dødt i glid og flats."},
  {name:"Sparkle Pupa / Superpuppan",type:"Caddis-puppe",size:"#12–16",im:"Vårfluepuppe",lat:"Trichoptera",prio:7,seasons:["forsommer","hoysommer","sensommer","host"],tags:["evening","highWater"],tip:"Når du ser urolig vårflueaktivitet; drift eller korte løft mot slutten av drift."},
  {name:"Svart / rød maur",type:"Terrestrial",size:"#12–16",im:"Maur",lat:"Formicidae",prio:8,seasons:["hoysommer","sensommer"],tags:["clearLow"],tip:"Særlig god i lav, klar elv; fiskes dødt eller svært rolig."},
  {name:"Ignita-dun / spinner",type:"Tørrflue",size:"#14–18",im:"Liten døgnflue",lat:"Ephemerella ignita",prio:9,seasons:["hoysommer","sensommer","host"],tags:["clearLow","evening"],tip:"Når fisken går smått og fint; dødt eller som spent spinner i varme kvelder."},
  {name:"Shuttlecock / Baetis-emerger",type:"Emerger",size:"#14–18",im:"Liten døgnflue (klekker)",lat:"Baetis rhodani",prio:10,seasons:["tidlig","forsommer","host"],tags:["overcastRain","clearLow"],tip:"Når rene duns blir refusert; fiskes helt dødt."},
  {name:"Zebra Midge / svart myggnymfe",type:"Nymfe",size:"#16–18",im:"Fjærmygg-puppe",lat:"Chironomidae",prio:11,seasons:["all"],tags:["clearLow"],allRound:true,tip:"Sterk på harr og treg fisk i roligere vann; fiskes sakte og kontrollert."},
  {name:"Lys hareøre-/olivennymfe",type:"Nymfe",size:"#12–16",im:"Døgnflue-/vårflue-nymfe",lat:"Ephemeroptera",prio:12,seasons:["all"],tags:["highWater"],allRound:true,tip:"Generell døgnflue-/caddisprofil; fiskes dødt."},
  {name:"Brun's Caddis",type:"Tørrflue",size:"#12–14",im:"Eggleggende vårflue",lat:"Trichoptera",prio:13,seasons:["hoysommer","sensommer"],tags:["evening"],tip:"Når plaskvak avslører eggleggere; fiskes med lite dirr eller kort skate."},
  {name:"Steinfluenymfe / Montana",type:"Nymfe",size:"#10–12",im:"Steinflue-nymfe",lat:"Plecoptera",prio:14,seasons:["tidlig"],tags:["highWater"],tip:"Viktigst tidlig og ved høy vannføring; fiskes som søkeflue."},
  {name:"Mygg (klekker/voksen)",type:"Tørrflue",size:"#18–20",im:"Fjærmygg",lat:"Chironomidae",prio:15,seasons:["tidlig","sensommer","host"],tags:["clearLow"],tip:"Smått og fint på stille partier morgen og kveld."},
  {name:"Olive jig-nymfe",type:"Nymfe",size:"#14–16",im:"Døgnflue-nymfe",lat:"Baetis",prio:16,seasons:["forsommer","hoysommer","sensommer","host"],tags:["highWater"],tip:"Sight-nymphing i litt mer trykk; slank profil tett på bunn."},
  {name:"Bibio",type:"Terrestrial",size:"#10–12",im:"Bibio / hårmygg",lat:"Bibio",prio:17,seasons:["sensommer"],tags:["clearLow"],tip:"Sensommer/fjelldager med riktig insektbilde; dødt eller lett drivende."},
  {name:"Black Woolly Bugger",type:"Streamer",size:"#8–10",im:"Byttefisk / stor larve",lat:"—",prio:18,seasons:["tidlig"],tags:["highWater"],tip:"Større silhuett ved høy vannføring eller skumring; fiskes rolig, ikke aggressivt."},
];
/* --- Hemsil (Hemsedal): teknisk, sky ørret i klart fjellvann; Aurivillii-event i juni.
   Deler Lesja-flueboksen (samme baetis/aurivillii/vårflue-DNA), egen ørret-tekst. --- */
const HEMSIL_PERIOD_TXT={
  tidlig:"Tidlig sesong i Hemsil: kaldt, klart fjellvann. Start under overflaten med nymfe/emerger — den ville Hemsil-ørreten er sky, så bruk lang, fin fortom og hold lav profil.",
  forsommer:"Forsommer: Baetis er i gang, og i siste halvdel av juni starter Aurivillii-klekkingen som henter den store ørreten opp fra dype høler — gullperioden for tørrflue. Let etter vakende fisk.",
  hoysommer:"Høysommer: Aurivillii og vårfluer. Klart, teknisk vann — finn vakende fisk og presenter lavt og dødt med lang fortom (0,12–0,15 mm).",
  sensommer:"Sensommer: små døgnfluer, vårfluer og landinsekter. Gå ned i størrelse på lavt, klart vann — storørreten er kresen.",
  host:"Tidlig høst: små olivener, mygg og nymfer. Fisk fint og presist mellom vakene; bytt raskt til emerger når det vaker.",
  utenfor:"Utenfor sesong. Sjekk lokale regler (Hemsedal Fiskeforening). Smått og fint hvis du fisker."
};
/* --- Sel / Selsvollene (sone 5): stor, rolig, glassklar Lågen; storharr (>40 cm) + ørret.
   Harr-vektet boks: smått teller mest (mygg, små døgnfluer, maur). --- */
const SEL_PERIOD_TXT={
  tidlig:"Tidlig sesong på Sel (Selsvollene): klart, stilleflytende Lågen-vann. Nymfer og små olivener — storharren tar smått. (Fang-og-slipp på ørret til 21. mai.)",
  forsommer:"Forsommer: Baetis og fjærmygg, Aurivillii fra siste halvdel av juni. Stor harr og ørret tar små tørrfluer og klekkere i det glassklare, rolige vannet.",
  hoysommer:"Høysommer: vårfluer, små døgnfluer og landinsekter. Storharren (>40 cm) er kresen — tenk smått: mygg, små CDC, maur og spinner.",
  sensommer:"Sensommer: maur, mygg og små olivener er gull for harr på lavt, klart vann. Gå langt ned i størrelse (#16–20).",
  host:"Tidlig høst: små olivener, mygg og nymfer. Fint og smått på de rolige glidene.",
  utenfor:"Utenfor sesong (sone 5 Selsvollene). Sjekk regler hos Lågen Fiskeelv. Smått og fint hvis du fisker."
};
const SEL_FLIES=[
  {name:"CDC Comparadun Olive",type:"Tørrflue",size:"#16–18",im:"Liten døgnflue (baetis)",lat:"Baetis rhodani",prio:1,seasons:["tidlig","forsommer","hoysommer","sensommer","host"],tags:["clearLow"],allRound:true,tip:"Liten oliven dun — storharrens favoritt i glassklart, rolig vann; fiskes helt dødt."},
  {name:"Griffiths Gnat / myggklynge",type:"Tørrflue",size:"#16–20",im:"Fjærmygg (klynge)",lat:"Chironomidae",prio:2,seasons:["all"],tags:["clearLow"],allRound:true,tip:"Mygg og klynger — dødelig på kresen harr; fiskes dødt på stille glid."},
  {name:"Pheasant Tail Nymph",type:"Nymfe",size:"#14–18",im:"Døgnflue-nymfe",lat:"Baetis / Ephemerella",prio:3,seasons:["all"],tags:["highWater"],allRound:true,tip:"Allround nymfe for harr og ørret; rolig, kontrollert drift."},
  {name:"Svart / rød maur",type:"Terrestrial",size:"#14–18",im:"Maur",lat:"Formicidae",prio:4,seasons:["hoysommer","sensommer"],tags:["clearLow"],tip:"Landinsekt — gull for harr på lavt, klart vann; fiskes dødt eller svært rolig."},
  {name:"Zebra Midge / svart myggnymfe",type:"Nymfe",size:"#16–20",im:"Fjærmygg-puppe",lat:"Chironomidae",prio:5,seasons:["all"],tags:["clearLow"],allRound:true,tip:"Smått og sakte — sterk på storharr i roligere vann."},
  {name:"CDC Caddis",type:"Tørrflue",size:"#14–16",im:"Voksen vårflue",lat:"Trichoptera",prio:6,seasons:["forsommer","hoysommer","sensommer","host"],tags:["clearLow","evening"],tip:"Blankt, stilleflytende vann; fiskes dødt eller med bittesmå twitch."},
  {name:"Klinkhammer Olive",type:"Emerger",size:"#14–16",im:"Klekkende døgnflue",lat:"Baetis / E. aurivillii",prio:7,seasons:["tidlig","forsommer","hoysommer","sensommer","host"],tags:["overcastRain","clearLow"],tip:"Når fisken bare viser snute; fiskes lavt og dødt i filmen."},
  {name:"Ignita-dun / spinner",type:"Tørrflue",size:"#16–18",im:"Liten døgnflue",lat:"Ephemerella ignita",prio:8,seasons:["hoysommer","sensommer","host"],tags:["clearLow","evening"],tip:"Smått og fint; dødt eller som spent spinner i varme kvelder."},
  {name:"Aurivillii-emerger / -dun",type:"Tørrflue",size:"#12–14",im:"Stor elvedøgnflue",lat:"Ephemerella aurivillii",prio:9,seasons:["forsommer","hoysommer"],tags:["overcastRain"],tip:"Fra siste halvdel av juni — henter opp stor fisk; fiskes presist."},
  {name:"Rusty Spinner",type:"Tørrflue",size:"#16–18",im:"Døgnflue (utgytt)",lat:"Ephemeroptera",prio:10,seasons:["hoysommer","sensommer"],tags:["evening"],tip:"Spinnerfall i stille kveldsluft; fiskes helt dødt."},
  {name:"Lys hareøre-/olivennymfe",type:"Nymfe",size:"#14–16",im:"Døgnflue-/vårflue-nymfe",lat:"Ephemeroptera",prio:11,seasons:["all"],tags:["highWater"],allRound:true,tip:"Generell nymfeprofil; fiskes dødt."},
  {name:"Soft Hackle PT",type:"Våtflue",size:"#14–16",im:"Klekkende døgnflue",lat:"Baetis",prio:12,seasons:["all"],tags:["overcastRain"],tip:"Når fisken tar rett under filmen; liten skrå-/nedstrømsdrift."},
  {name:"Sparkle Pupa / Superpuppan",type:"Caddis-puppe",size:"#14–16",im:"Vårfluepuppe",lat:"Trichoptera",prio:13,seasons:["forsommer","hoysommer","sensommer"],tags:["evening","highWater"],tip:"Urolig vårflueaktivitet; drift med korte løft mot slutten."},
  {name:"Steinfluenymfe / Montana",type:"Nymfe",size:"#10–12",im:"Steinflue-nymfe",lat:"Plecoptera",prio:14,seasons:["tidlig"],tags:["highWater"],tip:"Tidlig sesong/høy vannføring; fiskes som søkeflue."},
];
/* --- Skogstjern / lavlands-stillevann (Østfold): små ørret + abbor i klare tjern.
   Fjærmygg-dominert (palmermygg/klekker), småe døgnfluer, vårflue, maur; abbor på liten streamer.
   Sesong fra isløsning (april) — fangstrapportene viser topp i mai på mygg #18–20. --- */
const SKOGSTJERN_PERIOD_TXT={
  tidlig:"Tidlig vår på tjerna: like etter isløsning. Fjærmygg klekker først (ofte midt på dagen når vannet varmes), og de første døgnfluene kommer. Klekker og pupper i overflatefilmen.",
  forsommer:"Forsommer er gull på skogstjerna: tett fjærmygg-klekking morgen og kveld, døgnfluer og første vårfluer. Vak i stille viker — fisk klekker/palmermygg lavt i filmen.",
  hoysommer:"Høysommer: fjærmygg fortsatt sentralt, vårfluer mot kveld, og landinsekter (maur, biller) på varme dager. Klart, stille vann — gå smått og fint.",
  sensommer:"Sensommer: maur og landinsekter, fjærmygg morgen/kveld, små døgnfluer. Lavt og blankt — diskrete mønstre og lange fortommer.",
  host:"Tidlig høst: fjærmygg og små døgnfluer, ofte god vak på milde dager. Abbor tar mindre streamer/nymfe langs kanter.",
  utenfor:"Utenom kjernesesongen. Fjærmygg klekker så lenge det er åpent vann — smått og fint, gjerne på ettermiddagen."
};
const SKOGSTJERN_FLIES=[
  {name:"Palmermygg / myggklekker",type:"Tørrflue/klekker",size:"#16–20",im:"Fjærmygg",lat:"Chironomidae",prio:1,seasons:["all"],tags:["clearLow","overcastRain"],allRound:true,tip:"Nøkkelflua i tjerna (jf. fangstrapport) — fiskes dødt i filmen, særlig grått og stille."},
  {name:"Griffiths Gnat / myggklynge",type:"Tørrflue",size:"#16–20",im:"Fjærmygg (klynge)",lat:"Chironomidae",prio:2,seasons:["all"],tags:["clearLow"],allRound:true,tip:"Klynger av fjærmygg — dødelig på kresen ørret i blankt vann; fiskes helt dødt."},
  {name:"CDC myggklekker / Shuttlecock",type:"Emerger",size:"#16–18",im:"Klekkende fjærmygg",lat:"Chironomidae",prio:3,seasons:["all"],tags:["overcastRain","clearLow"],tip:"Når fisken viser snute uten å ta voksen — sitter lavt i overflaten."},
  {name:"CDC Comparadun / døgnflue",type:"Tørrflue",size:"#14–16",im:"Døgnflue (stillevann)",lat:"Leptophlebia / Baetis",prio:4,seasons:["tidlig","forsommer","hoysommer","sensommer","host"],tags:["clearLow"],tip:"Mørk vårdøgnflue (Leptophlebia) tidlig, baetis utover — fiskes dødt i vaksoner."},
  {name:"CDC Caddis",type:"Tørrflue",size:"#14–16",im:"Voksen vårflue",lat:"Trichoptera",prio:5,seasons:["forsommer","hoysommer","sensommer"],tags:["evening","clearLow"],tip:"Mot kveld når vårfluen er aktiv; dødt eller bittesmå napp."},
  {name:"Pheasant Tail / myggnymfe",type:"Nymfe",size:"#14–18",im:"Døgnflue-/fjærmyggnymfe",lat:"Baetis / Chironomidae",prio:6,seasons:["all"],allRound:true,tags:[],tip:"Under filmen mellom vakene; sakte, kontrollert i tjerna."},
  {name:"Buzzer (fjærmyggpuppe)",type:"Nymfe/puppe",size:"#12–16",im:"Fjærmyggpuppe",lat:"Chironomidae",prio:7,seasons:["forsommer","hoysommer","sensommer"],tags:["overcastRain"],tip:"Stillevanns-klassiker — hengende puppe like under overflaten; svært sakte."},
  {name:"Svart/rød maur",type:"Terrestrial",size:"#14–16",im:"Maur",lat:"Formicidae",prio:8,seasons:["hoysommer","sensommer"],tags:["clearLow"],tip:"Varme dager med maurnedfall; fiskes dødt nær land."},
  {name:"Spent spinner",type:"Tørrflue",size:"#16–18",im:"Døgnflue (utgytt)",lat:"Ephemeroptera",prio:9,seasons:["forsommer","hoysommer","sensommer"],tags:["evening"],tip:"Spinnerfall i stille kveldsluft; ligger flatt i overflatehinnen."},
  {name:"Liten Woolly Bugger / streamer",type:"Streamer",size:"#10–12",im:"Byttefisk / virvelløs",lat:"—",prio:10,seasons:["all"],tags:[],tip:"For abbor og søkefiske langs kanter og dropp; sakte inntak."},
  {name:"Bibio / Black Gnat",type:"Terrestrial",size:"#14–16",im:"Hårmygg / landinsekt",lat:"Bibionidae",prio:11,seasons:["forsommer","sensommer"],tags:["clearLow"],tip:"Svart landinsekt på blankt vann; god når det svermer."},
];
/* flue-arketyper: elve-profilen velger arketype (flyArchetype). */
const FLY_ARCHETYPES={
  "kald-hoyfjellselv": { flies: LESJA_FLIES,      periodTxt: LESJA_PERIOD_TXT },
  "hemsil":            { flies: LESJA_FLIES,      periodTxt: HEMSIL_PERIOD_TXT },
  "sel-grayling":      { flies: SEL_FLIES,        periodTxt: SEL_PERIOD_TXT },
  "skogstjern":        { flies: SKOGSTJERN_FLIES, periodTxt: SKOGSTJERN_PERIOD_TXT },
};
function flyArchetype(id){ return FLY_ARCHETYPES[id] || FLY_ARCHETYPES["kald-hoyfjellselv"]; }
/* gjeldende forhold -> sett av aktive «tags» */
function lesjaTags(cloud, precip, wt, fcat, clarity, sunEl){
  const t=new Set();
  const cl=cloud==null?60:cloud, rain=precip||0;
  const highWater = ["high","flood","risingfromlow"].includes(fcat) || ["stained","muddy"].includes(clarity);
  if(highWater) t.add("highWater");
  if((cl>=65 && rain>=0.1) || cl>=85) t.add("overcastRain");
  if(!highWater && cl<75 && ["gin","tinge"].includes(clarity)) t.add("clearLow");
  if(sunEl!=null && sunEl<8) t.add("evening");
  if(wt!=null && wt>=14) t.add("warm");
  return t;
}
/* ranger hele flueboksen etter sesong + forhold */
function rankLesjaFlies(period, tags, flies){
  return (flies||LESJA_FLIES).map(f=>{
    let s=(20-f.prio)*2;                                   // grunnprioritet fra guiden
    s += (f.seasons.includes("all")||f.seasons.includes(period)) ? 30 : -38;
    if(f.tags) f.tags.forEach(tag=>{ if(tags.has(tag)) s+=22; });
    if(f.allRound) s+=10;                                  // basisføde hele sesongen
    return {f,s};
  }).sort((a,b)=>b.s-a.s).map(x=>x.f);
}

/* full tekstråd + rangert fluevalg for et gitt døgn / nå.
   opts: {fcat, clarity, sunEl} (klarhet/vannføring/sollys hvis kjent) */
function hatchAdvice(date, waterTemp, cloudFrac, rainMm, opts){
  opts=opts||{};
  const hs=hatchState(date, waterTemp, cloudFrac, rainMm);
  const period=lesjaPeriod(dayOfYear(date));
  const tags=lesjaTags(cloudFrac, rainMm, waterTemp, opts.fcat, opts.clarity, opts.sunEl);
  const arch=flyArchetype(opts.archetype);
  const flies=rankLesjaFlies(period, tags, arch.flies);
  const primary=arch.periodTxt[period];

  let tactic;
  if(tags.has("highWater"))         tactic="Høyere/litt farget vann: øk til større nymfe (PT, hareøre, steinflue) eller mørk streamer — ikke prøv å «blende» fisken med flashy mønstre.";
  else if(tags.has("overcastRain")) tactic="Grått, kjølig eller lett regn: tenk Baetis/Aurivillii-emerger. Får du refusjon på dun, bytt til klekker — ikke til en annen art.";
  else if(tags.has("clearLow"))     tactic="Lav og glassklar elv: gå ned i størrelse, tynne CDC-fluer og maur, lange fine fortommer (0,12–0,15 mm). Hold lav silhuett — fisken ser deg.";
  else if(tags.has("evening"))      tactic="Plaskvak i kveldsluft: bytt raskt til eggleggende vårflue eller puppe nær land.";
  else                              tactic="Klart, rolig vann og god tid for fisken — presenter slankt og dødt med fin fortom.";

  let note="";
  if(tags.has("warm")&&tags.has("clearLow")) note="Varmt og lavt: let etter aktiv fisk i litt kaldere, oksygenrike strømtunger og overganger.";
  else if(tags.has("overcastRain")&&(period==="forsommer"||period==="host")) note="Lærebok-forhold for Baetis/Aurivillii: grått og fuktig. Forvent vak — vær klar med emergeren.";

  return {state:hs, period, primary, flies, tactic, note};
}

/* ============================================================
   DAGSRAPPORT – time-for-time-modell per elvepunkt
   Rangerer punktene i terrain.json time for time ut fra
   solhøyde/lys, terrengskygge, le for vinden, vindstyrke,
   trykkfall, vanntemp, klekking og klarhet — og gir flueråd
   tilpasset lyset den timen.
   ============================================================ */

/* --- solposisjon (NOAA lavpresisjon, ~0,01°) -> {elevation, azimuth} grader --- */
function solarPosition(date, lat, lon){
  const rad=Math.PI/180, deg=180/Math.PI;
  const jd = date.getTime()/86400000 + 2440587.5;     // Julian Day
  const n  = jd - 2451545.0;                            // dager siden J2000.0
  let L = (280.460 + 0.9856474*n) % 360; if(L<0) L+=360;       // midlere lengde
  const g = ((357.528 + 0.9856003*n) % 360)*rad;               // midlere anomali
  const lambda = (L + 1.915*Math.sin(g) + 0.020*Math.sin(2*g))*rad;  // ekliptisk lengde
  const eps = (23.439 - 0.0000004*n)*rad;                      // jordaksens helning
  const decl = Math.asin(Math.sin(eps)*Math.sin(lambda));      // deklinasjon
  const ra = Math.atan2(Math.cos(eps)*Math.sin(lambda), Math.cos(lambda));
  let GMST = (18.697374558 + 24.06570982441908*n) % 24; if(GMST<0) GMST+=24;
  const LST = (GMST*15 + lon)*rad;                             // lokal stjernetid (rad)
  const H = LST - ra;                                          // timevinkel
  const latR = lat*rad;
  const el = Math.asin(Math.sin(latR)*Math.sin(decl)+Math.cos(latR)*Math.cos(decl)*Math.cos(H));
  let az = Math.atan2(-Math.sin(H), Math.tan(decl)*Math.cos(latR)-Math.sin(latR)*Math.cos(H));
  az = (az*deg+360)%360;
  return {elevation: el*deg, azimuth: az};
}

/* terrenghorisont (grader over horisontalen) interpolert til vilkårlig asimut */
function horizonAt(horizon, az){
  if(!horizon) return 0;
  az=((az%360)+360)%360;
  const lo=Math.floor(az/45)*45, hi=(lo+45)%360, t=(az-lo)/45;
  const a=+horizon[String(lo)]||0, b=+horizon[String(hi)]||0;
  return a+(b-a)*t;
}
/* terrenghorisont oppstrøms vinden (±30°) = skjermingsgrad i grader (le) */
function terrainShelter(horizon, windFrom){
  if(windFrom==null||!horizon) return null;
  let best=0;
  for(const k in horizon){
    const dd=parseInt(k,10), diff=Math.abs(((dd-windFrom+180)%360)-180);
    if(diff<=30) best=Math.max(best, +horizon[k]||0);
  }
  return best;
}

/* --- omgivelseslys-proxy 0..1 fra solhøyde + skydekke --- */
function sunBrightness(el, cloud){
  let b;
  if(el<=-6)      b=0.04;                       // mørke / dyp tussmørke
  else if(el<0)   b=0.04+(el+6)/6*0.16;         // tussmørke -6..0°
  else if(el<6)   b=0.20+el/6*0.30;             // gyllen, lav sol
  else if(el<15)  b=0.50+(el-6)/9*0.25;
  else if(el<30)  b=0.75+(el-15)/15*0.18;
  else            b=Math.min(1,0.93+(el-30)/30*0.07);
  const c=cloud==null?50:cloud;
  return b*(1-0.55*c/100);                       // skyer demper opplevd lysstyrke
}
/* fiskelys-delskår: lavt lys best, glohardt midt-på-dagen-lys verst, stummende mørke litt hemmet */
function sLightH(bright){
  if(bright<=0.12) return 0.78;
  if(bright<=0.32) return 1.00;                  // primtid: gryning/skumring/overskyet
  if(bright<=0.50) return 0.86;
  if(bright<=0.68) return 0.66;
  if(bright<=0.82) return 0.50;
  return 0.38;                                   // hard sol, blank elv
}
/* sol/skygge på selve standplassen */
function sShade(shaded, el, cloud){
  if(el<=0) return 1.00;                          // ingen direkte sol uansett
  if(shaded) return 1.00;                         // punktet ligger i terrengskygge
  const c=cloud==null?50:cloud;
  if(c>=70) return 0.88;                          // overskyet diffuserer — skygge betyr lite
  if(c>=30) return 0.70;
  if(el<10) return 0.74;                          // lav sol, lange skygger på vannet
  if(el<25) return 0.52;
  return 0.40;                                    // høy sol rett på blankt vann
}
/* le-delskår: skjerming betyr mest når det blåser */
function sShelterH(deg, wcat){
  const calm=(wcat==="calm"||wcat==="breeze");
  if(deg==null) return calm?0.85:0.60;
  let base = deg>=10?1.0 : deg>=5?0.82 : deg>=2?0.62 : 0.42;
  if(calm) base=0.70+0.30*base;                   // rolig vær: løft de vindutsatte punktene
  return base;
}

/* WH = vekting for time-for-time-rangeringen (summerer til 1,00) */
const WH = {light:0.20, shade:0.13, shelter:0.16, wind:0.12, press:0.13, temp:0.12, hatch:0.09, clarity:0.05};
const WH_LABELS = {
  light:"Lysstyrke (sol + sky)", shade:"Sol / skygge på plassen", shelter:"Le for vinden",
  wind:"Vindstyrke", press:"Trykk / trykkfall", temp:"Vanntemperatur", hatch:"Klekking", clarity:"Vannklarhet"
};

/* env = {temp,cloud,wind,windFrom,press,flow,clarity,hatch,sunEl,sunAz,bright}
   point = terrain.json-punkt med .horizon  ->  delskår + samlet score for plassen den timen */
function spotHourScore(env, point){
  const shaded  = env.sunEl>0 && env.sunEl < horizonAt(point.horizon, env.sunAz);
  const shelter = terrainShelter(point.horizon, env.windFrom);
  const wcat    = windCat(env.wind);
  const parts=[
    {key:"light",  w:WH.light,  s:sLightH(env.bright)},
    {key:"shade",  w:WH.shade,  s:sShade(shaded, env.sunEl, env.cloud)},
    {key:"shelter",w:WH.shelter,s:sShelterH(shelter, wcat)},
    {key:"wind",   w:WH.wind,   s:sWind[wcat]},
    {key:"press",  w:WH.press,  s:sPress[env.press]},
    {key:"temp",   w:WH.temp,   s:sTemp(env.temp)},
    {key:"hatch",  w:WH.hatch,  s:sHatch[env.hatch]},
    {key:"clarity",w:WH.clarity,s:sClar[env.clarity]},
  ];
  const raw=parts.reduce((a,p)=>a+p.w*p.s,0);
  const {g}=gates({temp:env.temp, flow:env.flow, clarity:env.clarity});
  let best=parts[0], room=-1;
  parts.forEach(p=>{ const r=(1-p.s)*p.w; if(r>room){room=r;best=p;} });
  return {score:Math.round(100*g*raw), parts, shaded, shelter, wcat, g, limiting:best};
}

/* kort flueråd tilpasset lyset/årstiden den timen */
function hourFlyTip(date, waterTemp, cloud, precip, sunEl, bright){
  const hs=hatchState(date, waterTemp, cloud, precip);
  const cl=cloud==null?50:cloud, doy=dayOfYear(date);
  const dusk = sunEl<3, glare = bright>=0.62, overcast = cl>=65;
  const caddis = doy>=190;            // sensommer: vårflue mot kvelden
  const core   = doy>=160 && doy<=196; // aurivillii-kjernen
  let fly, size, tip;
  if(dusk){
    if(caddis){ fly="Superpuppa / voksen vårflue"; size="#10–#14"; tip="Skumring: svøm puppe mot land, vær klar for vak ved bredden."; }
    else      { fly="Klinkhåmer / spent spinner";  size="#12–#16"; tip="Lavt lys: stor aure vaker — klekker/spinner i overflatefilmen."; }
  } else if(glare){
    fly="CDC baetis / F-fly"; size="#16–#20"; tip="Hardt lys: fin, lang fortom (0,12–0,14 mm) — fisk skyggesoner og strykkanter.";
  } else if(overcast){
    fly = core ? "Aurivillii-klekker / Klinkhåmer" : "Parachute Adams / CDC-klekker";
    size="#12–#16"; tip="Overskyet — lavlysfordel hele timen; klekker i strøm og bakevjer.";
  } else {
    fly="Parachute Adams / Pheasant Tail"; size="#14–#16"; tip="Vekslende lys: tørrflue ved vak, ellers nymfe gjennom strykene.";
  }
  return {fly, size, tip, hatch:hs.cat};
}

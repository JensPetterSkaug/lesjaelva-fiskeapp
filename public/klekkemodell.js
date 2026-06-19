/**
 * klekkemodell.js
 * ------------------------------------------------------------
 * Ren, rammeverk-uavhengig klekke- og fiskbarhetsmodell.
 * Bygget på modellspesifikasjonen "Klekkeindeks & Tørrflueindeks
 * for Elvepuls". KAL = krever lokal kalibrering (startgjetning).
 *
 * NB: identisk med originalen bortsett fra TO ting som kun gjør at fila
 * kjører i nettleser — verdiene er uendret:
 *  1) ES-modul `export`-nøkkelordene er fjernet (lastes som vanlig <script>).
 *  2) `Math.exp(-(...)**2)` → `Math.exp(-((...)**2))` i bell()/gauss():
 *     unær minus rett før `**` er en SyntaxError i JS; parentesene
 *     disambiguerer uten å endre uttrykket (exp(−(d/σ)²)).
 * Matematikk, vekter, ddCenter/ddWidth/topt og diel er URØRT.
 *
 * KALIBRERING (2026-06): artenes `gates` (sesongvinduer, dag-i-året) er
 * strammet til å treffe spesifikasjonens tabell «Sesongvindu (Sør-Norge)»
 * (Leveranse 4) eksakt — f.eks. Baetis «slutten apr–jun» = [115,181].
 * Dette styrer både Sesongkalenderen og sesong-porten i klekkescore.
 * ------------------------------------------------------------
 */

/* ---------- Artsparametere (Leveranse 4) ---------- */
const ARTER = [
  { id:"baetis_rhodani", navn:"Baetis rhodani", vanlig:"Large Dark Olive · str. 16",
    gates:[[115,181],[244,304]], ddCenter:230, ddWidth:170, toptLo:8, toptHi:14,
    diel:"dag_skumring", ddKonf:"middels",
    note:"Univoltin i kaldt/høyt; bivoltin sør. Full larveutvikling ~950 DD (Sand & Brittain 2009). Basetemp antatt 0 °C; klekking ned til 3 °C (Elliott 1972)." },
  { id:"sma_baetis", navn:"Små Baetis spp.", vanlig:"B. muticus/fuscatus, Centroptilum m.fl.",
    gates:[[152,304]], ddCenter:620, ddWidth:260, toptLo:10, toptHi:16,
    diel:"dag", ddKonf:"lav", note:"Jevnt tilfang, ofte bivoltin. KAL." },
  { id:"serratella_ignita", navn:"Serratella ignita", vanlig:"Blue-Winged Olive (BWO)",
    gates:[[182,243]], ddCenter:860, ddWidth:240, toptLo:13, toptHi:18,
    diel:"sen_kveld", ddKonf:"lav", note:"Høysommer, univoltin med eggdiapause. KAL." },
  { id:"ephemerella_aurivillii", navn:"Ephemerella aurivillii", vanlig:"«aurivilli» — trekker storfisk",
    gates:[[166,212]], ddCenter:720, ddWidth:210, toptLo:11, toptHi:16,
    diel:"dag_kveld", ddKonf:"lav", note:"Midt/sent juni–juli. Univoltin. KAL." },
  { id:"ephemera_danica", navn:"Ephemera danica", vanlig:"Norges største døgnflue",
    gates:[[121,196]], ddCenter:760, ddWidth:230, toptLo:12, toptHi:18,
    diel:"tidlig_ettermiddag", ddKonf:"lav",
    note:"GDD-styrt, semivoltin/2-årig (Everall 2015). Rett art for klare elver — IKKE E. vulgata. KAL." },
  { id:"siphlonurus", navn:"Siphlonurus spp.", vanlig:"Stor svømmedøgnflue",
    gates:[[121,212]], ddCenter:560, ddWidth:220, toptLo:10, toptHi:15,
    diel:"dag", ddKonf:"lav", note:"Forsommer. Skydekke dokumentert relevant (Sættem & Brittain 1985). KAL." },
  { id:"heptageniidae", navn:"Heptageniidae", vanlig:"Flathodede — stryk",
    gates:[[121,288]], ddCenter:600, ddWidth:300, toptLo:11, toptHi:17,
    diel:"dag_kveld", ddKonf:"lav", note:"Heptagenia/Rhithrogena/Ecdyonurus. Mest univoltin. KAL." },
  { id:"varfluer", navn:"Vårfluer (Trichoptera)", vanlig:"Limnephilidae / Hydropsychidae",
    gates:[[121,273]], ddCenter:650, ddWidth:320, toptLo:10, toptHi:18,
    diel:"skumring_natt", ddKonf:"lav", note:"Dominerer i Rena. Pupping trigget av vår-temp/oksygen (Tszydel & Błońska 2022). KAL." }
];

/* ---------- Vekter (eksponert for kalibrering) ---------- */
const KLEKKE_VEKTER = { s_DD:0.30, s_Tnow:0.22, gate:0.10, s_hydro:0.12, s_trend:0.08, s_sky:0.10, luft:0.03, fukt:0.02 };
const FISK_VEKTER   = { klekke:0.45, vind:0.20, lys:0.12, vann:0.10, nedbor:0.08, trykk:0.03, lufttemp:0.02 };
const TBASE = 0; // °C, KAL — bytt ut når lokal basetemp er funnet

/* ---------- matematikk ---------- */
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sigmoid=(x,c,w)=>1/(1+Math.exp(-(x-c)/w));
function bell(x,lo,hi){ if(x<lo) return Math.exp(-(((x-lo)/3)**2)); if(x>hi) return Math.exp(-(((x-hi)/3.5)**2)); return 1; }
function softGate(day,start,end,r=12){ return clamp(Math.min(clamp((day-(start-r))/r,0,1), clamp(((end+r)-day)/r,0,1)),0,1); }
function gateOf(art,day){ let g=0; for(const [s,e] of art.gates) g=Math.max(g,softGate(day,s,e)); return g; }
function gauss(h,peak,sd){ const dh=Math.min(Math.abs(h-peak),24-Math.abs(h-peak)); return Math.exp(-((dh/sd)**2)); }

/** Døgngrader fra daglige temperaturer (anbefalt — krever temperaturlogg). */
function akkDDfraDaglig(daglige){ return daglige.reduce((s,t)=>s+Math.max(0,t-TBASE),0); }
/** Døgngrader fra snitt × dager (forenkling når du ikke har full logg). */
function akkDDfraSnitt(snittTemp,dager){ return Math.max(0,snittTemp-TBASE)*dager; }
/** Dag-i-året fra Date. */
function dagIAaret(d){ return Math.floor((d-new Date(d.getFullYear(),0,0))/864e5); }

function dielRaw(type,h){
  switch(type){
    case "dag": return gauss(h,13,4.2);
    case "dag_skumring": return Math.max(gauss(h,12,4.6),0.92*gauss(h,20.5,1.7));
    case "sen_kveld": return gauss(h,19.2,2.7);
    case "dag_kveld": return Math.max(0.8*gauss(h,12,3.5),gauss(h,19,2.3));
    case "tidlig_ettermiddag": return gauss(h,15,2.9);
    case "skumring_natt": return Math.max(gauss(h,22,2.3),0.8*gauss(h,1,2.2));
    default: return 0.7;
  }
}
function dielMult(art,h,day){
  let v=dielRaw(art.diel,h);
  const highSummer=clamp((day-182)/15,0,1)*clamp((227-day)/15,0,1);
  if(highSummer>0){ v=v*(1-0.18*highSummer*gauss(h,13,3))+0.12*highSummer*gauss(h,20.5,2.5); }
  else { const early=Math.max(clamp((120-day)/30,0,1),clamp((day-260)/30,0,1)); v+=0.10*early*gauss(h,13,3.5); }
  return clamp(0.5+0.5*clamp(v,0,1),0.5,1.0);
}

/* fiskbarhets-kurver */
function windCurve(v){ if(v<2)return 0.6; if(v<5)return 1.0; if(v<7)return 0.7; if(v<10)return 0.3; return 0.1; }
function lightCurve(h,sky){ const low=Math.max(gauss(h,5.5,2.5),gauss(h,21,2.5)), mid=gauss(h,13,3.5), f=sky/100;
  return clamp(0.55+0.45*low + f*0.35*mid - (1-f)*0.3*mid,0.2,1); }
function waterCurve(flow,nedbor){ return clamp(1-clamp(Math.max(0,flow)/50,0,1)-clamp(nedbor/5,0,1)*0.5,0.1,1); }
function precipCurve(p){ if(p<0.6)return 1.0; if(p<2)return 0.85; if(p<4)return 0.55; return 0.3; }
function spatePenalty(flow){ return clamp(Math.max(0,flow)/60,0,1); }

/**
 * Hovedberegning.
 * @param {Object} f  forecast/forhold for ett punkt og ett tidspunkt:
 *   day, hour, akkDD, vanntemp, trend, flow, sky, vind, nedbor, lufttemp, fukt
 * @returns {{arter, klekkeindeks, dom, fisk, comps}}
 */
function beregn(f){
  const { day, hour, akkDD, vanntemp, trend=0, flow=0, sky=50, vind=0, nedbor=0, lufttemp=12, fukt=70 } = f;
  const W=KLEKKE_VEKTER;
  const s_sky = sky>=50?1.0:0.7;
  const s_hydro = 1-spatePenalty(flow);
  const s_trend = clamp(0.5+0.10*trend,0,1);
  const nLuft = clamp(lufttemp/20,0,1);
  const nFukt = clamp((fukt-40)/60,0,1);

  const arter = ARTER.map(a=>{
    const gate=gateOf(a,day);
    const s_DD=sigmoid(akkDD,a.ddCenter,a.ddWidth);
    const s_Tnow=bell(vanntemp,a.toptLo,a.toptHi);
    const base = W.s_DD*s_DD + W.s_Tnow*s_Tnow + W.gate*gate
               + W.s_hydro*s_hydro + W.s_trend*s_trend + W.s_sky*s_sky
               + W.luft*nLuft + W.fukt*nFukt;
    const klekkescore = 100*base*gate;
    const diel = dielMult(a,hour,day);
    return { art:a, gate, s_DD, s_Tnow, diel, klekkescore, final: klekkescore*diel };
  }).sort((x,y)=>y.final-x.final);

  const dom = arter[0];
  const klekkeindeks = dom.final; // maks over aktive arter

  const V=FISK_VEKTER;
  const comps = [
    { key:"Klekkeindeks", w:V.klekke,   v:klekkeindeks/100 },
    { key:"Vind",         w:V.vind,     v:windCurve(vind) },
    { key:"Lys / tid",    w:V.lys,      v:lightCurve(hour,sky) },
    { key:"Vannføring",   w:V.vann,     v:waterCurve(flow,nedbor) },
    { key:"Nedbør",       w:V.nedbor,   v:precipCurve(nedbor) },
    { key:"Lufttrykk",    w:V.trykk,    v:0.7 },
    { key:"Lufttemp",     w:V.lufttemp, v:clamp((lufttemp+2)/14,0,1) },
  ];
  const fisk = 100*comps.reduce((acc,c)=>acc+c.w*c.v,0);

  return { arter, klekkeindeks, dom, fisk, comps };
}

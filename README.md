# Lesjaelva fiskedashboard

Live dashboard for fluefiske i **Lesjaelva / øvre Gudbrandsdalslågen, sone 7** (Lesjaverk, NVE-stasjon `2.346.0`).
Henter sanntidsdata fra **NVE Sildre / HydAPI** (vanntemperatur, vannføring, vannstand) og **MET Norway**
(værprognose), regner ut **Fiskeindeksen** for nå-tilstanden, og gir en **14-dagers prognose** for fiskeforholdene.

## Kom i gang

Krever bare Python 3 (ingen pakker å installere).

```bash
python3 server.py
```

Åpne så **http://localhost:8765** i nettleseren.

Annen port: `PORT=9000 python3 server.py`

### NVE API-nøkkel (for vanntemp + vannføring)

Værdelen virker uten nøkkel. For å hente vanndata fra NVE trenger du en gratis nøkkel:

1. Lag en nøkkel på **https://hydapi.nve.no/Users**
2. Enten:
   - lim den inn i dashboardets **⚙ Innstillinger**, eller
   - start med miljøvariabel: `NVE_API_KEY=din_nøkkel python3 server.py`

Nøkkelen lagres lokalt i `config.json` og sendes aldri ut til nettleseren igjen.

## Hva dashbordet viser

- **Nå-status**: vanntemperatur, vannføring (+ trend vs siste 60 dager), utledet vannklarhet, lufttemp,
  nedbør, vind, lufttrykk-trend, klekkevurdering — og samlet **Fiskeindeks 0–100**.
- **Bidrag til indeksen**: hvilke faktorer som løfter/holder igjen dagen, og den begrensende faktoren.
- **Klekking & flueråd**: hvilke insekter som er aktuelle (aurivillii rundt St. Hans, Baetis i regn, vårfluer
  utover sommeren …) og konkrete flueforslag — fra researchnotatet om sone 7.
- **14-dagers prognose**: én indeks per døgn (dag 1–9 fra MET, dag 10–14 klimatologi). Klikk en dag for detaljer.
- **Dagsrapport – time for time**: for valgt dag rangeres alle elvepunktene fra Le-kartet time for time, og du får
  **beste fiskeplass** hver time + et **flueråd (mønster + krokstørrelse)** tilpasset lyset. Modellen veier åtte
  påvirkninger per time og punkt: lysstyrke (beregnet solhøyde × skydekke), sol/skygge på selve plassen
  (terrengskygge når sola står bak horisonten), le for vinden, vindstyrke, trykkfall (6 t fram), vanntemp,
  klekking og vannklarhet. Sammendraget peker ut dagens beste vindu og den plassen som oftest topper lista.
  Krever MET-timesprognose (de nærmeste ~2–3 døgnene).

## Fiskelogg → Excel

Nederst i dashbordet ligger **Min fiskelogg**, som samler alt på ett sted:

- **Prognose (auto):** hver gang dashbordet kjører lagres dagens forhold som én rad — én rad per dato (nyeste vinner). Inkluderer Fiskeindeks, vanntemp + vannføring for begge stasjoner (Lesjavatnet + Dombås), vær, vindretning, klarhet, klekking og begrensende faktor.
- **Observasjoner (manuelt):** registrer det du faktisk ser ved elva (strekning, timer, antall fisk, største, art, flue som funket, observert klekking/sikt/vind, egen vanntemp, notat).
- **«Last ned Excel (.xlsx)»** bygger et regneark med to faner — *Prognose* og *Observasjoner* — koblet på dato, så du kan sammenligne hva modellen sa mot hva som faktisk skjedde.

Loggen lagres lokalt i `data/` (`prognose.jsonl`, `observasjoner.jsonl`, *gitignored*). Excel-fila genereres på nytt ved hver nedlasting.

## Modellen

Fiskeindeksen (kalibrert for ørret/harr i elv) vekter sju faktorer (vanntemp 0,25 · vind 0,25 · vannføring 0,20
· lys 0,15 · lufttemp 0,05 · luftfuktighet 0,05 · lufttrykk-tendens 0,05) og legger på multiplikative porter ved
≥18–20 °C vanntemp, sterk snittvind (>6 m/s, tørrfluepresentasjon) og flom (~≥175 % av normal, med vade-advarsel).
Vind = snittvind fra yr (ikke kast); vannføring = nivå i % av normal × trend-multiplikator (hysterese). Se `public/scoring.js`.

**Datakilder:** yr.no (lufttemp, luftfuktighet, lufttrykk-tendens, skydekke+tid, snittvind) og NVE Sildre (vanntemp,
vannføring i % av normal + trend).

**Forbehold:** «% av normal» bruker median av siste ~60 dagers vannføring som referanse (proxy, ikke 15-års
sesongnormal). Vanntemperatur for kommende dager *modelleres* fra lufttemperatur (demping + smeltevannsgulv), ikke målt.
Luftfuktighet og 3-timers trykk-tendens finnes per time for de nærmeste døgnene; lenger ut blir prognose-faktorene
grovere. Dette er angler-heuristikk, ikke en validert biologisk ligning.

**Time-for-time-rapporten** bruker en egen vekting (lysstyrke 0,20 · le 0,16 · trykk 0,13 · sol/skygge 0,13 ·
vindstyrke 0,12 · vanntemp 0,12 · klekking 0,09 · klarhet 0,05). Solhøyde og -asimut beregnes astronomisk
(NOAA-lavpresisjon) per time, og terrengskygge/le avledes av høydehorisonten i hvert elvepunkt (`terrain.json`).
Vindretning og -styrke gjelder hele sona (ett MET-punkt), så finskala-forskjeller mellom punktene kommer kun fra
terrenget — modell på dalskala, ikke en standplass-garanti.

## Deployment

> **GitHub Pages fungerer _ikke_ for denne appen.** Pages serverer bare statiske filer og kan ikke kjøre
> `server.py`. Uten backend feiler alle `/api/*`-kall: NVE-proxyen (CORS + API-nøkkel), MET-proxyen,
> sesongnormalene, fiskeloggen og Excel-eksporten. En Pages-versjon ville bare vist et tomt skall.

For en **live, delbar** versjon (URL du kan sende til venner) trengs en vert som kjører Python.
Repoet er klargjort med `Procfile` og `render.yaml`.

### Render (anbefalt, gratis, gir delbar URL)
1. Push repoet til GitHub (se under).
2. Gå til [render.com](https://render.com) → **New → Blueprint** → koble GitHub-repoet (Render leser `render.yaml`).
3. Når den spør: lim inn **`NVE_API_KEY`** (fra hydapi.nve.no/Users). `HOST=0.0.0.0` og `PORT` settes automatisk.
4. Du får en URL som `https://lesjaelva-fiskeapp.onrender.com` — det er lenken du deler.

Tilsvarende fungerer **Railway** / **Fly.io** (`Procfile` + `NVE_API_KEY`-miljøvariabel), eller egen VPS bak en reverse proxy.

**Verdt å vite ved en delt deploy:**
- NVE-nøkkelen ligger trygt server-side (eksponeres aldri i nettleseren), men **alle med lenken** kan se data,
  legge inn observasjoner. Greit for venner — ikke en offentlig tjeneste.
- Render free-tier har **flyktig filsystem**: fiskeloggen (`data/`) nullstilles ved redeploy/dvale. Vil du ta vare
  på loggen over tid, kjør lokalt eller legg på et persistent volum.

Enklest og mest privat er å kjøre **lokalt** (se «Kom i gang»).

## Filer

- `server.py` — lokal server + proxy (NVE + MET), config-lagring
- `public/index.html` · `public/styles.css` — UI
- `public/scoring.js` — Fiskeindeks-modellen + klekke-/flueråd
- `public/app.js` — datahenting, 14-dagers modellering, rendering
- `config.json` — lokal config (NVE-nøkkel, koordinater) — *gitignored*

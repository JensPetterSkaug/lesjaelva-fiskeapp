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

## Fiskelogg → Excel

Nederst i dashbordet ligger **Min fiskelogg**, som samler alt på ett sted:

- **Prognose (auto):** hver gang dashbordet kjører lagres dagens forhold som én rad — én rad per dato (nyeste vinner). Inkluderer Fiskeindeks, vanntemp + vannføring for begge stasjoner (Lesjavatnet + Dombås), vær, vindretning, klarhet, klekking og begrensende faktor.
- **Observasjoner (manuelt):** registrer det du faktisk ser ved elva (strekning, timer, antall fisk, største, art, flue som funket, observert klekking/sikt/vind, egen vanntemp, notat).
- **«Last ned Excel (.xlsx)»** bygger et regneark med to faner — *Prognose* og *Observasjoner* — koblet på dato, så du kan sammenligne hva modellen sa mot hva som faktisk skjedde.

Loggen lagres lokalt i `data/` (`prognose.jsonl`, `observasjoner.jsonl`, *gitignored*). Excel-fila genereres på nytt ved hver nedlasting.

## Modellen

Fiskeindeksen vekter åtte faktorer (vanntemp 0,24 · lys/sky 0,18 · trykk 0,16 · vannføring 0,15 · klarhet 0,10
· klekking 0,09 · vind 0,05 · stabilitet 0,03) og legger på harde portvoktere ved ≥18–20 °C vann og flom/grumset
vann. Se `public/scoring.js` — formelen er identisk med din `fiskeindeks_1.html`.

**Forbehold:** Vannklarhet og vannføringskategori *utledes* fra vannføringsnivå + nedbør (stasjonen har ingen
turbiditetssensor) — kan overstyres i innstillinger. Vanntemperatur for kommende dager *modelleres* fra
lufttemperatur (demping + smeltevannsgulv), ikke målt. Dette er angler-heuristikk, ikke en validert biologisk ligning.

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
  legge inn observasjoner og bytte kartbilde. Greit for venner — ikke en offentlig tjeneste.
- Render free-tier har **flyktig filsystem**: fiskeloggen (`data/`) nullstilles ved redeploy/dvale. Vil du ta vare
  på loggen over tid, kjør lokalt eller legg på et persistent volum.

Enklest og mest privat er å kjøre **lokalt** (se «Kom i gang»).

## Filer

- `server.py` — lokal server + proxy (NVE + MET), config-lagring
- `public/index.html` · `public/styles.css` — UI
- `public/scoring.js` — Fiskeindeks-modellen + klekke-/flueråd
- `public/app.js` — datahenting, 14-dagers modellering, rendering
- `config.json` — lokal config (NVE-nøkkel, koordinater) — *gitignored*

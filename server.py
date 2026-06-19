#!/usr/bin/env python3
"""
Lesjaelva fiskedashboard – lokal server.

Serverer dashboardet (public/) og proxyer to API-er slik at nettleseren
slipper CORS-problemer og NVE-nøkkelen aldri eksponeres til klienten:

  GET  /api/met?lat=&lon=&altitude=     -> MET Norway locationforecast 2.0 (compact)
  GET  /api/nve/<endpoint>?<query>      -> NVE HydAPI v1 (Stations|Series|Observations|Parameters|Percentiles)
  GET  /api/config                      -> { hasKey, station, lat, lon, altitude }
  POST /api/config  { nveApiKey, ... }  -> lagrer config.json

Kjør:  python3 server.py            (port 8765)
       PORT=9000 python3 server.py  (annen port)

NVE-nøkkel:
  - hent gratis på https://hydapi.nve.no/Users
  - sett env-variabel  NVE_API_KEY=...   ELLER lim den inn i dashboardets innstillinger.
"""

import base64
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
CONFIG_PATH = os.path.join(ROOT, "config.json")
DATA_DIR = os.path.join(ROOT, "data")
PROG_PATH = os.path.join(DATA_DIR, "prognose.jsonl")
OBS_PATH = os.path.join(DATA_DIR, "observasjoner.jsonl")
FAKTISK_PATH = os.path.join(DATA_DIR, "faktisk.jsonl")

# kolonner i Excel-eksporten (nøkkel i lagret rad -> overskrift)
PROG_COLS = [
    ("dato", "Dato"), ("logget", "Logget"), ("indeks", "Fiskeindeks"), ("vurdering", "Vurdering"),
    ("vanntemp_lesja", "Vanntemp Lesjavatnet (°C)"), ("vannf_lesja", "Vannføring Lesjavatnet (m³/s)"),
    ("vannfkat_lesja", "Vannføring-kategori"),
    ("vanntemp_dombas", "Vanntemp Dombås (°C)"), ("vannf_dombas", "Vannføring Dombås (m³/s)"),
    ("lufttemp", "Lufttemp sentrum (°C)"), ("sky", "Skydekke (%)"), ("vind", "Vind sentrum (m/s)"), ("vindretning", "Vindretning sentrum"),
    ("lufttemp_brustugu", "Lufttemp Brustugubrue (°C)"), ("vind_brustugu", "Vind Brustugubrue (m/s)"), ("vindretn_brustugu", "Vindretning Brustugubrue"),
    ("lufttemp_leirmo", "Lufttemp Leirmo (°C)"), ("vind_leirmo", "Vind Leirmo (m/s)"), ("vindretn_leirmo", "Vindretning Leirmo"),
    ("lufttemp_lora_malt", "Lufttemp Lora MÅLT (°C)"), ("vind_lora_malt", "Vind Lora MÅLT (m/s)"), ("vindretn_lora_malt", "Vindretning Lora MÅLT"),
    ("lufttrykk", "Lufttrykk (hPa)"), ("nedbor", "Nedbør (mm)"), ("klarhet", "Vannklarhet (utledet)"),
    ("klekking", "Klekking"), ("begrensende", "Begrensende faktor"),
]
FAKTISK_COLS = [
    ("dato", "Dato"), ("logget", "Logget (UTC)"),
    ("vanntemp_lesja", "Vanntemp Lesjavatnet MÅLT (°C)"), ("vannf_lesja", "Vannføring Lesjavatnet MÅLT (m³/s)"),
    ("vannstand_lesja", "Vannstand Lesjavatnet MÅLT (m)"),
    ("vanntemp_dombas", "Vanntemp Dombås MÅLT (°C)"), ("vannf_dombas", "Vannføring Dombås MÅLT (m³/s)"),
    ("vannstand_dombas", "Vannstand Dombås MÅLT (m)"),
    ("lufttemp_lora_malt", "Lufttemp Lora MÅLT (°C)"), ("vind_lora_malt", "Vind Lora MÅLT (m/s)"),
    ("vindretn_lora_malt", "Vindretning Lora MÅLT (°)"), ("lufttrykk_malt", "Lufttrykk Dovre MÅLT (hPa)"),
]
OBS_COLS = [
    ("dato", "Dato"), ("strekning", "Strekning"), ("timer", "Timer fisket"), ("antall", "Antall fisk"),
    ("storste_cm", "Største (cm)"), ("art", "Art"), ("flue", "Flue som funket"),
    ("klekking_obs", "Observert klekking"), ("egen_vanntemp", "Egen vanntemp (°C)"),
    ("sikt_obs", "Observert sikt"), ("vind_obs", "Observert vind"), ("notat", "Notat"), ("logget", "Logget"),
]

PORT = int(os.environ.get("PORT", "8765"))
# 127.0.0.1 lokalt (trygt), 0.0.0.0 i skyen (sett HOST=0.0.0.0 ved deploy)
HOST = os.environ.get("HOST", "127.0.0.1")
CONTACT = os.environ.get("MET_CONTACT", "jens-petter.skaug@knowit.no")
USER_AGENT = "LesjaelvaFiskedashboard/1.0 (kontakt: %s)" % CONTACT

NVE_BASE = "https://hydapi.nve.no/api/v1/"
MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
NVE_ALLOWED = {"Stations", "Series", "Observations", "Parameters", "Percentiles"}

# Standardverdier for Lesjaelva / øvre Lågen, sone 7 (Lesjaverk-stasjonen 2.346.0).
DEFAULTS = {
    "station": "2.346.0",
    "stations": [
        {"id": "2.346.0", "label": "Lesjavatnet"},
        {"id": "2.303.0", "label": "Dombås"},
    ],
    # værpunkt: Lesja sentrum (sone 7). NB: modellvinden er svært stedsfølsom i dalen.
    "lat": 62.1235,
    "lon": 8.8678,
    "altitude": 560,
    # lokale MET-værpunkt for lufttemp + vind (koordinater fra Kartverket)
    "weatherPoints": [
        {"label": "Brustugubrue", "lat": 62.0850, "lon": 9.0302, "altitude": 540},
        {"label": "Leirmo", "lat": 62.1650, "lon": 8.6489, "altitude": 600},
    ],
}

# Enkel in-memory cache: { url: (timestamp, status, headers, body_bytes) }
_CACHE = {}
CACHE_TTL = 600  # sekunder


# ---------- elve-profiler (multi-tenant) ----------
RIVERS_DIR = os.path.join(ROOT, "rivers")
SINGLE_RIVER = os.environ.get("RIVER")          # satt => single-river-deploy
DEFAULT_RIVER = SINGLE_RIVER or "lesja"
# hemmelige felt som leses fra config.json (resten kommer fra elve-profilen)
SECRET_KEYS = ("nveApiKey", "frostClientId", "frostClientSecret",
               "supabaseUrl", "supabaseKey", "clarityOverride", "tempOverride")


def river_exists(rid):
    return bool(rid) and rid.isalnum() and os.path.isfile(os.path.join(RIVERS_DIR, rid + ".json"))


def load_river(rid):
    with open(os.path.join(RIVERS_DIR, rid + ".json"), "r", encoding="utf-8") as f:
        return json.load(f)


def list_rivers():
    out = []
    if os.path.isdir(RIVERS_DIR):
        for fn in sorted(os.listdir(RIVERS_DIR)):
            if fn.endswith(".json"):
                try:
                    p = load_river(fn[:-5])
                    out.append({"id": fn[:-5], "name": p.get("name"),
                                "shortName": p.get("shortName"), "region": p.get("region"),
                                "draft": bool(p.get("draft")),
                                "kind": "stillevann" if p.get("flowFixed") is not None else "elv"})
                except Exception:
                    pass
    return out


def load_config(river=None):
    rid = SINGLE_RIVER or river or DEFAULT_RIVER
    if not river_exists(rid):
        rid = DEFAULT_RIVER if river_exists(DEFAULT_RIVER) else rid
    cfg = dict(DEFAULTS)                          # fallback-struktur
    if river_exists(rid):
        try:
            cfg.update(load_river(rid))
        except Exception as e:
            print("[advarsel] kunne ikke lese elve-profil:", rid, e, file=sys.stderr)
    cfg["id"] = rid
    # hemmeligheter/overrides fra config.json (gitignorert)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                local = json.load(f)
            for k in SECRET_KEYS:
                if k in local:
                    cfg[k] = local[k]
        except Exception as e:
            print("[advarsel] kunne ikke lese config.json:", e, file=sys.stderr)
    # env-nøkkel vinner hvis satt
    env_key = os.environ.get("NVE_API_KEY")
    if env_key:
        cfg["nveApiKey"] = env_key
    return cfg


def save_config(updates):
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    cfg.update(updates)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    return cfg


# ---------- fiskelogg: JSONL-lagring ----------
def read_jsonl(path):
    rows = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        pass
    return rows


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def upsert_forecast(row):
    """Én rad per dato — nyeste prognose for dagen vinner."""
    rows = [r for r in read_jsonl(PROG_PATH) if r.get("dato") != row.get("dato")]
    rows.append(row)
    rows.sort(key=lambda r: r.get("dato", ""))
    write_jsonl(PROG_PATH, rows)
    return len(rows)


# ---------- Supabase (varig lagring via REST, kun stdlib) ----------
def _sb_creds():
    cfg = load_config()
    url = (os.environ.get("SUPABASE_URL") or cfg.get("supabaseUrl") or "").rstrip("/")
    key = os.environ.get("SUPABASE_KEY") or cfg.get("supabaseKey") or ""
    return url, key


def sb_enabled():
    u, k = _sb_creds()
    return bool(u and k)


def sb_write(table, row, upsert=False):
    """Skriv én rad til Supabase. Feiler stille (lokal logg er uansett kilden)."""
    u, k = _sb_creds()
    if not (u and k):
        return False
    body = json.dumps(row).encode("utf-8")
    prefer = "resolution=merge-duplicates,return=minimal" if upsert else "return=minimal"
    headers = {"apikey": k, "Authorization": "Bearer " + k,
               "Content-Type": "application/json", "Prefer": prefer}
    req = urllib.request.Request(u + "/rest/v1/" + table, data=body, headers=headers, method="POST")
    try:
        urllib.request.urlopen(req, timeout=15)
        return True
    except Exception as e:
        print("[supabase] skriving til %s feilet: %s" % (table, e), file=sys.stderr)
        return False


def sb_read(table):
    """Les alle data-objekter fra en tabell, sortert kronologisk. None ved feil."""
    u, k = _sb_creds()
    if not (u and k):
        return None
    headers = {"apikey": k, "Authorization": "Bearer " + k, "Accept": "application/json"}
    url = u + "/rest/v1/" + table + "?select=data&order=logget.asc"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read().decode("utf-8"))
        return [x.get("data") for x in rows if isinstance(x, dict) and x.get("data") is not None]
    except Exception as e:
        print("[supabase] lesing fra %s feilet: %s" % (table, e), file=sys.stderr)
        return None


# ---------- daglig snapshot av FAKTISKE målte data (NVE + Frost) ----------
def _nve_latest(station, key):
    import datetime as _dt
    to = _dt.date.today()
    fr = to - _dt.timedelta(days=7)
    ref = "%s/%s" % (fr.isoformat(), to.isoformat())
    url = (NVE_BASE + "Observations?StationId=%s&Parameter=1003,1001,1000&ResolutionTime=1440&ReferenceTime=%s"
           % (station, ref))
    status, ct, body = fetch(url, {"X-API-Key": key, "Accept": "application/json"}, ttl=300)
    out = {}
    try:
        for s in json.loads(body).get("data", []):
            obs = [o for o in s.get("observations", []) if o.get("value") is not None]
            if obs:
                out[s.get("parameter")] = round(obs[-1]["value"], 3)
    except Exception:
        pass
    return out


def _frost_latest(source, elements, cid):
    import datetime as _dt
    now = _dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    fr = now - _dt.timedelta(hours=3)
    rt = fr.strftime("%Y-%m-%dT%H:%M:%SZ") + "/" + now.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = ("https://frost.met.no/observations/v0.jsonld?sources=%s&referencetime=%s&elements=%s"
           % (urllib.parse.quote(source), urllib.parse.quote(rt), urllib.parse.quote(elements)))
    auth = base64.b64encode((cid + ":").encode()).decode()
    status, ct, body = fetch(url, {"Authorization": "Basic " + auth, "Accept": "application/json"}, ttl=300)
    vals = {}
    try:
        for entry in json.loads(body).get("data", []):
            for o in entry.get("observations", []):
                vals[o["elementId"]] = o["value"]
    except Exception:
        pass
    return vals


def gather_actuals():
    import datetime as _dt
    cfg = load_config()
    now = _dt.datetime.utcnow()
    out = {"dato": now.strftime("%Y-%m-%d"), "logget": now.strftime("%Y-%m-%d %H:%M UTC")}
    key = os.environ.get("NVE_API_KEY") or cfg.get("nveApiKey")
    if key:
        for station, tag in (("2.346.0", "lesja"), ("2.303.0", "dombas")):
            v = _nve_latest(station, key)
            if 1003 in v:
                out["vanntemp_" + tag] = v[1003]
            if 1001 in v:
                out["vannf_" + tag] = v[1001]
            if 1000 in v:
                out["vannstand_" + tag] = v[1000]
    cid = os.environ.get("FROST_CLIENT_ID") or cfg.get("frostClientId")
    if cid:
        w = _frost_latest("SN16845", "air_temperature,wind_speed,wind_from_direction", cid)
        if "air_temperature" in w:
            out["lufttemp_lora_malt"] = round(w["air_temperature"], 1)
        if "wind_speed" in w:
            out["vind_lora_malt"] = round(w["wind_speed"], 1)
        if "wind_from_direction" in w:
            out["vindretn_lora_malt"] = round(w["wind_from_direction"])
        p = _frost_latest("SN16400", "air_pressure_at_sea_level", cid)
        if "air_pressure_at_sea_level" in p:
            out["lufttrykk_malt"] = round(p["air_pressure_at_sea_level"], 1)
    return out


def save_actuals():
    """Hent + lagre dagens faktiske data (lokal mirror + Supabase, upsert per dato)."""
    row = gather_actuals()
    rows = [r for r in read_jsonl(FAKTISK_PATH) if r.get("dato") != row.get("dato")]
    rows.append(row)
    rows.sort(key=lambda r: r.get("dato", ""))
    write_jsonl(FAKTISK_PATH, rows)
    sb_ok = sb_write("faktisk", {"dato": row.get("dato"), "data": row}, upsert=True)
    return row, sb_ok


# ---------- minimal .xlsx-skriver (kun stdlib) ----------
def _col_letter(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _xml_escape(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _cell_xml(col, rownum, val):
    ref = _col_letter(col) + str(rownum)
    if isinstance(val, bool):
        val = str(val)
    if isinstance(val, (int, float)):
        return '<c r="%s"><v>%s</v></c>' % (ref, val)
    if val is None or val == "":
        return '<c r="%s"/>' % ref
    return ('<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
            % (ref, _xml_escape(val)))


def _sheet_xml(rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
    for i, row in enumerate(rows, 1):
        cells = "".join(_cell_xml(j, i, v) for j, v in enumerate(row))
        out.append('<row r="%d">%s</row>' % (i, cells))
    out.append('</sheetData></worksheet>')
    return "".join(out)


def build_xlsx(sheets):
    """sheets = [(navn, rows)], rows = liste av liste med str/tall."""
    ns_ct = "http://schemas.openxmlformats.org/package/2006/content-types"
    ns_rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns_doc = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    overrides = "".join(
        '<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1)
        for i in range(len(sheets)))
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="%s"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '%s</Types>') % (ns_ct, overrides)
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>'
                 % (ns_rel, ns_doc))
    sheet_tags = "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>'
                         % (_xml_escape(nm[:31]), i + 1, i + 1) for i, (nm, _) in enumerate(sheets))
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="%s">'
                '<sheets>%s</sheets></workbook>') % (ns_doc, sheet_tags)
    wb_rels_items = "".join('<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>'
                            % (i + 1, ns_doc, i + 1) for i in range(len(sheets)))
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="%s">%s</Relationships>') % (ns_rel, wb_rels_items)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        for i, (_, rows) in enumerate(sheets):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), _sheet_xml(rows))
    return buf.getvalue()


def export_xlsx_bytes():
    def mk(cols, data):
        rows = [[h for _, h in cols]]
        for d in data:
            rows.append([d.get(k, "") for k, _ in cols])
        return rows
    prog = sb_read("prognose")
    if prog is None:
        prog = read_jsonl(PROG_PATH)
    obs = sb_read("observasjoner")
    if obs is None:
        obs = read_jsonl(OBS_PATH)
    fak = sb_read("faktisk")
    if fak is None:
        fak = read_jsonl(FAKTISK_PATH)
    return build_xlsx([
        ("Prognose", mk(PROG_COLS, prog)),
        ("Faktisk", mk(FAKTISK_COLS, fak)),
        ("Observasjoner", mk(OBS_COLS, obs)),
    ])


# ---------- flerårige sesongnormaler (dag-for-dag percentiler) ----------
NORMALS_CACHE = {}      # station -> (timestamp, result)
NORMALS_TTL = 24 * 3600


def _percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = p * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _doy(datestr):
    import datetime as _dt
    y, m, d = map(int, datestr[:10].split("-"))
    return _dt.date(y, m, d).timetuple().tm_yday


def compute_normals(station, key, years=15):
    import datetime as _dt
    now = time.time()
    cached = NORMALS_CACHE.get(station)
    if cached and (now - cached[0]) < NORMALS_TTL:
        return cached[1]
    to = _dt.date.today()
    fr = to.replace(year=to.year - years)
    ref = "%s/%s" % (fr.isoformat(), to.isoformat())
    url = (NVE_BASE + "Observations?StationId=%s&Parameter=1000,1001&ResolutionTime=1440&ReferenceTime=%s"
           % (station, ref))
    req = urllib.request.Request(url, headers={"X-API-Key": key, "Accept": "application/json"})
    data = json.load(urllib.request.urlopen(req, timeout=60))
    out = {"station": station}
    yrs = set()
    pmap = {1000: "stage", 1001: "discharge"}
    for s in data.get("data", []):
        pk = pmap.get(s.get("parameter"))
        if not pk:
            continue
        byd = {}
        for o in s.get("observations", []):
            if o.get("value") is None:
                continue
            byd.setdefault(_doy(o["time"]), []).append(o["value"])
            yrs.add(o["time"][:4])
        res = {k: [None] * 367 for k in ("p10", "p25", "p50", "p75", "p90")}
        for doy in range(1, 367):
            pool = []
            for w in range(-7, 8):                    # ±7 dagers vindu
                pool += byd.get(((doy - 1 + w) % 366) + 1, [])
            if not pool:
                continue
            pool.sort()
            for nm, p in (("p10", .10), ("p25", .25), ("p50", .50), ("p75", .75), ("p90", .90)):
                res[nm][doy] = round(_percentile(pool, p), 3)
        out[pk] = res
    out["years"] = [min(yrs), max(yrs)] if yrs else [None, None]
    NORMALS_CACHE[station] = (now, out)
    return out


def fetch(url, headers, ttl=CACHE_TTL):
    """Hent en URL med caching. Returnerer (status, content_type, body_bytes)."""
    now = time.time()
    cached = _CACHE.get(url)
    if cached and (now - cached[0]) < ttl:
        return cached[1], cached[2], cached[3]
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read()
            ct = resp.headers.get("Content-Type", "application/json")
            status = resp.status
    except urllib.error.HTTPError as e:
        body = e.read()
        ct = e.headers.get("Content-Type", "application/json") if e.headers else "application/json"
        status = e.code
    except Exception as e:
        body = json.dumps({"error": "fetch_failed", "detail": str(e)}).encode("utf-8")
        ct = "application/json"
        status = 502
    if status == 200:
        _CACHE[url] = (now, status, ct, body)
    return status, ct, body


class Handler(BaseHTTPRequestHandler):
    server_version = "LesjaelvaDash/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_raw(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- routing ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/config":
            return self.handle_get_config((qs.get("river") or [None])[0])
        if path == "/api/rivers":
            return self.send_json({"rivers": list_rivers(), "default": DEFAULT_RIVER,
                                   "multiTenant": SINGLE_RIVER is None})
        if path == "/api/met":
            return self.handle_met(qs)
        if path == "/api/pressure":
            return self.handle_pressure(qs)
        if path == "/api/obs":
            return self.handle_obs(qs)
        if path == "/api/obsseries":
            return self.handle_obs_series(qs)
        if path.startswith("/api/nve/"):
            return self.handle_nve(path[len("/api/nve/"):], parsed.query)
        if path == "/api/normals":
            cfg = load_config()
            key = cfg.get("nveApiKey")
            if not key:
                return self.send_json({"error": "no_key"}, 200)
            station = (qs.get("station") or ["2.303.0"])[0]
            try:
                return self.send_json(compute_normals(station, key))
            except Exception as e:
                return self.send_json({"error": "normals_failed", "detail": str(e)}, 200)
        if path == "/api/snapshot":
            row, sb_ok = save_actuals()
            fields = [k for k in row if k not in ("dato", "logget")]
            return self.send_json({"ok": True, "dato": row["dato"], "felt": len(fields),
                                   "supabase": sb_ok, "row": row})
        if path == "/api/observations":
            obs = sb_read("observasjoner")
            if obs is None:
                obs = read_jsonl(OBS_PATH)
            return self.send_json({"rows": obs})
        if path == "/api/logstatus":
            prog = sb_read("prognose"); obs = sb_read("observasjoner")
            if prog is None:
                prog = read_jsonl(PROG_PATH)
            if obs is None:
                obs = read_jsonl(OBS_PATH)
            fak = sb_read("faktisk")
            if fak is None:
                fak = read_jsonl(FAKTISK_PATH)
            return self.send_json({"prognose": len(prog), "faktisk": len(fak), "observasjoner": len(obs),
                                   "lagring": "supabase" if sb_enabled() else "lokal"})
        if path == "/api/export.xlsx":
            body = export_xlsx_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="fiskelogg-lesjaelva.xlsx"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)

        # ---- multi-tenant ruting ----
        seg = path.strip("/")
        if path == "/" or path == "":
            return self.serve_static("/index.html" if SINGLE_RIVER else "/landing.html")
        # /<id> (uten punktum/skråstrek) som matcher en elve-profil -> appen.
        # Utkast (draft) skjules på multi-tenant-deploy uten ?preview=1 -> til forsiden.
        if "/" not in seg and "." not in seg and river_exists(seg):
            try:
                is_draft = bool(load_river(seg).get("draft"))
            except Exception:
                is_draft = False
            preview = (qs.get("preview") or ["0"])[0] == "1"
            if SINGLE_RIVER is None and is_draft and not preview:
                self.send_response(302)
                self.send_header("Location", "/")
                self.end_headers()
                return
            return self.serve_static("/index.html")

        return self.serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            return self.handle_post_config()
        if parsed.path == "/api/log/forecast":
            return self.handle_log_forecast()
        if parsed.path == "/api/log/observation":
            return self.handle_log_observation()
        self.send_json({"error": "not_found"}, 404)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def handle_log_forecast(self):
        data = self._read_json_body()
        if not isinstance(data, dict) or not data.get("dato"):
            return self.send_json({"error": "bad_data"}, 400)
        allowed = {k for k, _ in PROG_COLS}
        row = {k: v for k, v in data.items() if k in allowed}
        n = upsert_forecast(row)
        sb_write("prognose", {"dato": row.get("dato"), "data": row}, upsert=True)
        self.send_json({"ok": True, "rows": n})

    def handle_log_observation(self):
        data = self._read_json_body()
        if not isinstance(data, dict) or not data.get("dato"):
            return self.send_json({"error": "bad_data"}, 400)
        allowed = {k for k, _ in OBS_COLS}
        row = {k: v for k, v in data.items() if k in allowed}
        append_jsonl(OBS_PATH, row)
        sb_write("observasjoner", {"dato": row.get("dato"), "data": row})
        self.send_json({"ok": True})

    # ---- config ----
    def handle_get_config(self, river=None):
        cfg = load_config(river)
        self.send_json({
            "hasKey": bool(cfg.get("nveApiKey")),
            "hasFrost": bool(cfg.get("frostClientId") or os.environ.get("FROST_CLIENT_ID")),
            "hasSupabase": sb_enabled(),
            "id": cfg.get("id"),
            "name": cfg.get("name"),
            "shortName": cfg.get("shortName"),
            "fishonTitle": cfg.get("fishonTitle"),
            "eyebrow": cfg.get("eyebrow"),
            "region": cfg.get("region"),
            "station": cfg.get("station"),
            "stations": cfg.get("stations"),
            "lat": cfg.get("lat"),
            "lon": cfg.get("lon"),
            "altitude": cfg.get("altitude"),
            "clarityOverride": cfg.get("clarityOverride"),
            "tempOverride": cfg.get("tempOverride"),
            "weatherPoints": cfg.get("weatherPoints"),
            "secondary": cfg.get("secondary"),
            "leeZones": cfg.get("leeZones"),
            "terrainFile": cfg.get("terrainFile"),
            "flyArchetype": cfg.get("flyArchetype"),
            "flowFixed": cfg.get("flowFixed"),
            "frostStation": cfg.get("frostStation"),
            "frostLabel": cfg.get("frostLabel"),
            "fishingCardUrl": cfg.get("fishingCardUrl"),
            "tempBaseline": cfg.get("tempBaseline"),
            "multiTenant": SINGLE_RIVER is None,
            "contact": CONTACT,
        })

    def handle_post_config(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return self.send_json({"error": "bad_json"}, 400)
        updates = {}
        for k in ("nveApiKey", "station", "lat", "lon", "altitude"):
            if k in data and data[k] not in (None, ""):
                updates[k] = data[k]
        # overstyringer kan settes ELLER nullstilles (null sletter)
        for k in ("clarityOverride", "tempOverride"):
            if k in data:
                updates[k] = data[k] if data[k] not in (None, "") else None
        cfg = save_config(updates)
        self.send_json({"ok": True, "hasKey": bool(cfg.get("nveApiKey"))})

    # ---- MET proxy ----
    def handle_met(self, qs):
        cfg = load_config()
        lat = (qs.get("lat") or [cfg["lat"]])[0]
        lon = (qs.get("lon") or [cfg["lon"]])[0]
        alt = (qs.get("altitude") or [cfg["altitude"]])[0]
        try:
            lat = round(float(lat), 4)
            lon = round(float(lon), 4)
            alt = int(float(alt))
        except Exception:
            return self.send_json({"error": "bad_coords"}, 400)
        url = "%s?lat=%s&lon=%s&altitude=%s" % (MET_URL, lat, lon, alt)
        status, ct, body = fetch(url, {"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.send_raw(status, "application/json; charset=utf-8", body)

    # ---- Frost: faktiske observasjoner (vind/temp/trykk) ----
    def handle_obs(self, qs):
        import datetime as _dt
        cfg = load_config()
        cid = cfg.get("frostClientId") or os.environ.get("FROST_CLIENT_ID")
        if not cid:
            return self.send_json({"error": "no_frost",
                                   "message": "Frost client-id mangler. Sett frostClientId i config "
                                              "eller FROST_CLIENT_ID. Hent gratis på frost.met.no/auth/requestCredentials.html"}, 200)
        source = (qs.get("source") or ["SN16845"])[0]
        elements = (qs.get("elements") or ["air_temperature,wind_speed,wind_from_direction"])[0]
        # floor til hel time -> stabil URL -> cache treffer (obs oppdateres ~hver time)
        now = _dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        fr = now - _dt.timedelta(hours=3)
        rt = fr.strftime("%Y-%m-%dT%H:%M:%SZ") + "/" + now.strftime("%Y-%m-%dT%H:%M:%SZ")
        url = ("https://frost.met.no/observations/v0.jsonld?sources=%s&referencetime=%s&elements=%s"
               % (urllib.parse.quote(source), urllib.parse.quote(rt), urllib.parse.quote(elements)))
        auth = base64.b64encode((cid + ":").encode()).decode()
        status, ct, body = fetch(url, {"Authorization": "Basic " + auth, "Accept": "application/json"})
        try:
            d = json.loads(body)
            values, units, tlast = {}, {}, None
            for entry in d.get("data", []):           # tidssortert -> siste vinner
                tlast = entry.get("referenceTime")
                for o in entry.get("observations", []):
                    values[o["elementId"]] = o["value"]
                    units[o["elementId"]] = o.get("unit")
            self.send_json({"source": source, "time": tlast, "values": values, "units": units})
        except Exception as e:
            self.send_json({"error": "frost_parse", "detail": str(e)}, 200)

    # ---- Frost: tidsserie (f.eks. målt lufttrykk siste N dager) ----
    def handle_obs_series(self, qs):
        import datetime as _dt
        cfg = load_config()
        cid = cfg.get("frostClientId") or os.environ.get("FROST_CLIENT_ID")
        if not cid:
            return self.send_json({"error": "no_frost"}, 200)
        source = (qs.get("source") or ["SN16400"])[0]
        element = (qs.get("element") or ["air_pressure_at_sea_level"])[0]
        try:
            days = max(1, min(60, int((qs.get("days") or ["14"])[0])))
        except Exception:
            days = 14
        now = _dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        fr = now - _dt.timedelta(days=days)
        rt = fr.strftime("%Y-%m-%dT%H:%M:%SZ") + "/" + now.strftime("%Y-%m-%dT%H:%M:%SZ")
        url = ("https://frost.met.no/observations/v0.jsonld?sources=%s&referencetime=%s&elements=%s"
               % (urllib.parse.quote(source), urllib.parse.quote(rt), urllib.parse.quote(element)))
        auth = base64.b64encode((cid + ":").encode()).decode()
        status, ct, body = fetch(url, {"Authorization": "Basic " + auth, "Accept": "application/json"})
        try:
            d = json.loads(body)
            pts = []
            for entry in d.get("data", []):
                obs = entry.get("observations", [])
                if obs and obs[0].get("value") is not None:
                    pts.append({"t": entry.get("referenceTime"), "v": obs[0]["value"]})
            self.send_json({"source": source, "element": element, "points": pts})
        except Exception as e:
            self.send_json({"error": "frost_parse", "detail": str(e)}, 200)

    # ---- lufttrykk (Open-Meteo: historikk + prognose, ingen nøkkel) ----
    def handle_pressure(self, qs):
        cfg = load_config()
        lat = (qs.get("lat") or [cfg["lat"]])[0]
        lon = (qs.get("lon") or [cfg["lon"]])[0]
        try:
            lat = round(float(lat), 4)
            lon = round(float(lon), 4)
        except Exception:
            return self.send_json({"error": "bad_coords"}, 400)
        url = ("https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
               "&hourly=pressure_msl&past_days=14&forecast_days=7&timezone=Europe%%2FOslo" % (lat, lon))
        status, ct, body = fetch(url, {"Accept": "application/json"})
        self.send_raw(status, "application/json; charset=utf-8", body)

    # ---- NVE proxy ----
    def handle_nve(self, endpoint, query):
        endpoint = endpoint.strip("/")
        if endpoint not in NVE_ALLOWED:
            return self.send_json({"error": "endpoint_not_allowed", "endpoint": endpoint}, 400)
        cfg = load_config()
        key = cfg.get("nveApiKey")
        if not key:
            return self.send_json({"error": "no_key",
                                   "message": "NVE API-nøkkel mangler. Lim den inn i innstillinger, "
                                              "eller sett NVE_API_KEY. Hent gratis på "
                                              "https://hydapi.nve.no/Users"}, 200)
        url = NVE_BASE + endpoint
        if query:
            url += "?" + query
        status, ct, body = fetch(url, {"X-API-Key": key, "Accept": "application/json"})
        self.send_raw(status, "application/json; charset=utf-8", body)

    # ---- static files ----
    def serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        path = urllib.parse.unquote(path)  # tål filnavn med mellomrom/æøå
        # hindre path traversal
        safe = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(PUBLIC, safe)
        if not full.startswith(PUBLIC) or not os.path.isfile(full):
            return self.send_json({"error": "not_found", "path": path}, 404)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_raw(200, ctype, body)


def main():
    if not os.path.isdir(PUBLIC):
        print("Fant ikke public/ – kjør fra prosjektmappa.", file=sys.stderr)
        sys.exit(1)
    cfg = load_config()
    print("=" * 60)
    print(" Lesjaelva fiskedashboard")
    print(" Åpne:        http://localhost:%d" % PORT)
    print(" Stasjon:     %s   (%.4f, %.4f, %d moh)" %
          (cfg["station"], cfg["lat"], cfg["lon"], cfg["altitude"]))
    print(" NVE-nøkkel:  %s" % ("satt ✓" if cfg.get("nveApiKey") else "MANGLER – legg inn i innstillinger"))
    print(" MET-kontakt: %s" % CONTACT)
    print(" Binder til:  %s:%d" % (HOST, PORT))
    print("=" * 60)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopper.")
        httpd.shutdown()


if __name__ == "__main__":
    main()

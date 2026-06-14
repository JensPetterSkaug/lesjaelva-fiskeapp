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
import re
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

# kolonner i Excel-eksporten (nøkkel i lagret rad -> overskrift)
PROG_COLS = [
    ("dato", "Dato"), ("logget", "Logget"), ("indeks", "Fiskeindeks"), ("vurdering", "Vurdering"),
    ("vanntemp_lesja", "Vanntemp Lesjavatnet (°C)"), ("vannf_lesja", "Vannføring Lesjavatnet (m³/s)"),
    ("vannfkat_lesja", "Vannføring-kategori"),
    ("vanntemp_dombas", "Vanntemp Dombås (°C)"), ("vannf_dombas", "Vannføring Dombås (m³/s)"),
    ("lufttemp", "Lufttemp (°C)"), ("sky", "Skydekke (%)"), ("vind", "Vind (m/s)"), ("vindretning", "Vindretning"),
    ("lufttrykk", "Lufttrykk (hPa)"), ("nedbor", "Nedbør (mm)"), ("klarhet", "Vannklarhet (utledet)"),
    ("klekking", "Klekking"), ("begrensende", "Begrensende faktor"),
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
    "mapFile": "Lesjaelva sone 7.png",   # ligger i public/, vises by default ved deploy
}

# Enkel in-memory cache: { url: (timestamp, status, headers, body_bytes) }
_CACHE = {}
CACHE_TTL = 600  # sekunder


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
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
    return build_xlsx([
        ("Prognose", mk(PROG_COLS, read_jsonl(PROG_PATH))),
        ("Observasjoner", mk(OBS_COLS, read_jsonl(OBS_PATH))),
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
            return self.handle_get_config()
        if path == "/api/met":
            return self.handle_met(qs)
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
        if path == "/api/observations":
            return self.send_json({"rows": read_jsonl(OBS_PATH)})
        if path == "/api/logstatus":
            return self.send_json({"prognose": len(read_jsonl(PROG_PATH)),
                                   "observasjoner": len(read_jsonl(OBS_PATH))})
        if path == "/api/export.xlsx":
            body = export_xlsx_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="fiskelogg-lesjaelva.xlsx"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)

        return self.serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            return self.handle_post_config()
        if parsed.path == "/api/mapupload":
            return self.handle_map_upload()
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
        self.send_json({"ok": True, "rows": n})

    def handle_log_observation(self):
        data = self._read_json_body()
        if not isinstance(data, dict) or not data.get("dato"):
            return self.send_json({"error": "bad_data"}, 400)
        allowed = {k for k, _ in OBS_COLS}
        row = {k: v for k, v in data.items() if k in allowed}
        append_jsonl(OBS_PATH, row)
        self.send_json({"ok": True})

    def handle_map_upload(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return self.send_json({"error": "bad_json"}, 400)
        m = re.match(r"data:image/(png|jpeg|jpg|webp);base64,(.*)$", data.get("dataUrl", ""), re.S)
        if not m:
            return self.send_json({"error": "bad_image"}, 400)
        ext = {"jpeg": "jpg"}.get(m.group(1), m.group(1))
        try:
            blob = base64.b64decode(m.group(2))
        except Exception:
            return self.send_json({"error": "bad_b64"}, 400)
        if len(blob) > 12 * 1024 * 1024:
            return self.send_json({"error": "too_large"}, 400)
        fname = "kart." + ext
        with open(os.path.join(PUBLIC, fname), "wb") as f:
            f.write(blob)
        save_config({"mapFile": fname})
        self.send_json({"ok": True, "mapFile": fname})

    # ---- config ----
    def handle_get_config(self):
        cfg = load_config()
        self.send_json({
            "hasKey": bool(cfg.get("nveApiKey")),
            "station": cfg.get("station"),
            "stations": cfg.get("stations"),
            "lat": cfg.get("lat"),
            "lon": cfg.get("lon"),
            "altitude": cfg.get("altitude"),
            "clarityOverride": cfg.get("clarityOverride"),
            "tempOverride": cfg.get("tempOverride"),
            "mapFile": cfg.get("mapFile"),
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

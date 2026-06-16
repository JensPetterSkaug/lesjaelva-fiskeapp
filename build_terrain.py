#!/usr/bin/env python3
"""Bygg terrain/<river>.json med terrenghorisont fra Kartverket DTM.
Engangsskript (ikke del av runtime). Kjør: python3 build_terrain.py"""
import json, math, urllib.request, urllib.parse, time, sys

ELEV_URL = "https://ws.geonorge.no/hoydedata/v1/punkt"
DIRS = [0, 45, 90, 135, 180, 225, 270, 315]      # N, NØ, Ø, … (grader fra nord)
DISTS = [250, 500, 900, 1500]                     # meter utover per retning
CACHE = {}

def elev(lat, lon):
    key = (round(lat, 5), round(lon, 5))
    if key in CACHE:
        return CACHE[key]
    q = urllib.parse.urlencode({"koordsys": 4258, "nord": f"{lat:.6f}", "ost": f"{lon:.6f}", "geojson": "false"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"{ELEV_URL}?{q}", timeout=20) as r:
                d = json.load(r)
            z = d["punkter"][0]["z"]
            CACHE[key] = z
            return z
        except Exception as e:
            if attempt == 2:
                print("  ! elev-feil", lat, lon, e, file=sys.stderr)
                return None
            time.sleep(0.5)

def offset(lat, lon, bearing_deg, dist_m):
    b = math.radians(bearing_deg)
    dlat = dist_m * math.cos(b) / 111320.0
    dlon = dist_m * math.sin(b) / (111320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon

def snap_to_river(lat, lon, radius_m=700, step_m=175):
    """Snapp til lokal dalbunn (elva ligger i lavpunktet). Returnerer (lat,lon,elev)."""
    best = (lat, lon, elev(lat, lon))
    n = int(radius_m / step_m)
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            la = lat + (i * step_m) / 111320.0
            lo = lon + (j * step_m) / (111320.0 * math.cos(math.radians(lat)))
            z = elev(la, lo)
            if z is not None and (best[2] is None or z < best[2]):
                best = (la, lo, z)
    return best

def horizon(lat, lon, base):
    h = {}
    for d in DIRS:
        best = 0.0
        for dist in DISTS:
            la, lo = offset(lat, lon, d, dist)
            z = elev(la, lo)
            if z is None:
                continue
            ang = math.degrees(math.atan2(z - base, dist))   # terrenghøyde-vinkel
            best = max(best, ang)
        h[str(d)] = round(best, 1)
    return h

def build(points):
    out = []
    for i, p in enumerate(points):
        lat0, lon0, navn, anchor = p[0], p[1], p[2], (len(p) > 3 and p[3])
        if anchor:                                  # ekte stasjonskoord -> ligger på elva
            lat, lon, base = lat0, lon0, elev(lat0, lon0)
        else:
            lat, lon, base = snap_to_river(lat0, lon0)
        if base is None:
            print("  hopper over (ingen høyde):", navn); continue
        hz = horizon(lat, lon, base)
        out.append({"lat": round(lat, 5), "lon": round(lon, 5), "elev": round(base, 1),
                    "horizon": hz, "navn": navn})
        print(f"  [{i+1}/{len(points)}] {navn}: {round(base,1)} moh"
              + ("" if anchor else f" (snappet fra {lat0:.4f},{lon0:.4f})"))
    return out

# --- elvepunkter. anchor=True: ekte NVE-stasjonskoord (på elva). ellers snappes til dalbunn ---
SEL = [
    (61.8415, 9.4106, "Lågen v/Sel", True),
    (61.8120, 9.4700, "Lågen – Selsverket", False),
    (61.7970, 9.5100, "Lågen – Bjølstad", False),
    (61.7819, 9.5464, "Lågen ovf. Otta", True),
    (61.7696, 9.5452, "Otta sentrum", True),
    (61.7450, 9.5400, "Lågen ndf. Otta", False),
    (61.7150, 9.5320, "Lågen – Nedre Sel", False),
    (61.6804, 9.5351, "Lågen ovf. Sjoa", True),
]
HEMSIL = [
    (60.8850, 8.4700, "Hemsil – øvre", False),
    (60.8720, 8.4950, "Hemsil – vest for sentrum", False),
    (60.8653, 8.5206, "Hemsil v/Hemsedal sentrum", True),
    (60.8500, 8.5600, "Hemsil – Trøim", False),
    (60.8300, 8.6000, "Hemsil – ndf. Trøim", False),
    (60.8050, 8.6500, "Hemsil – mot Gol", False),
    (60.7750, 8.7100, "Hemsil – nedre", False),
]

if __name__ == "__main__":
    for name, pts in [("sel", SEL), ("hemsil", HEMSIL)]:
        print(f"== {name} ==")
        data = build(pts)
        with open(f"public/terrain/{name}.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(f"  -> public/terrain/{name}.json ({len(data)} punkt)\n")

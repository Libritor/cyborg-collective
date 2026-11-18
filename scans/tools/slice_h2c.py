#!/usr/bin/env python3
"""Slice an STL for the lab's Bambu Lab H2C with Bambu Studio's command line and
report print time and filament. Flattens the installed system profiles (the CLI
rejects profiles that still say `inherits`) and applies the overrides given.

    python slice_h2c.py model.stl [--out DIR] [--set key=value ...] [--spiral]
"""
import argparse
import glob
import json
import os
import subprocess
import sys

STUDIO = r"C:\Program Files\Bambu Studio\bambu-studio.exe"
BBL = os.path.join(os.environ.get("APPDATA", ""), "BambuStudio", "system", "BBL")
MACHINE = "Bambu Lab H2C 0.4 nozzle"
PROCESS = "0.20mm Standard @BBL H2C"
FILAMENT = "Bambu PLA Basic @BBL H2C"


def flat(folder, name):
    chain = []
    while name:
        d = json.load(open(os.path.join(BBL, folder, name + ".json"), encoding="utf-8"))
        chain.append(d)
        name = d.get("inherits")
    out = {}
    for d in reversed(chain):
        out.update(d)
    out.pop("inherits", None)
    out["name"] = chain[0]["name"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stl")
    ap.add_argument("--out", default=None)
    ap.add_argument("--set", action="append", default=[], help="process setting key=value")
    ap.add_argument("--spiral", action="store_true", help="spiral vase mode")
    ap.add_argument("--process", default=PROCESS)
    ap.add_argument("--filament", default=FILAMENT)
    a = ap.parse_args()
    out = os.path.abspath(a.out) if a.out else os.path.join(os.path.dirname(os.path.abspath(a.stl)), "h2c_slice")   # Bambu resolves --outputdir against its own cwd
    os.makedirs(out, exist_ok=True)
    m = flat("machine", MACHINE)
    p = flat("process", a.process)
    p.update({"name": a.process + " (cli)", "compatible_printers": [MACHINE], "instantiation": "true"})
    if a.spiral:
        p.update({"spiral_mode": "1", "wall_loops": "1", "sparse_infill_density": "0%", "enable_support": "0", "brim_type": "no_brim"})
    for kv in a.set:
        k, v = kv.split("=", 1)
        p[k] = v
    f = flat("filament", a.filament)
    f["compatible_printers"] = [MACHINE]
    paths = {}
    for n, d in (("machine", m), ("process", p), ("filament", f)):
        paths[n] = os.path.join(out, n + "_flat.json")
        json.dump(d, open(paths[n], "w", encoding="utf-8"), indent=1)
    for old in glob.glob(os.path.join(out, "result.json")) + glob.glob(os.path.join(out, "plate_*.gcode")):
        os.remove(old)
    cmd = [STUDIO, "--load-settings", paths["machine"] + ";" + paths["process"], "--load-filaments", paths["filament"],
           "--slice", "0", "--export-3mf", "sliced.3mf", "--outputdir", out, os.path.abspath(a.stl)]
    subprocess.run(cmd, cwd=out, capture_output=True, text=True, timeout=2400)
    rp = os.path.join(out, "result.json")
    if not os.path.exists(rp):
        raise SystemExit("Bambu Studio wrote no result.json")
    r = json.load(open(rp))
    if r.get("return_code") != 0:
        raise SystemExit("slice failed: " + str(r.get("error_string")))
    g = glob.glob(os.path.join(out, "plate_*.gcode"))
    info = {}
    if g:
        for line in open(g[0], encoding="utf-8", errors="replace"):
            if line.startswith("; total estimated time:") or line.startswith("; model printing time:"):
                info["time"] = line.split("total estimated time:")[-1].strip() if "total estimated" in line else info.get("time")
            elif line.startswith("; total filament weight [g]"):
                info["grams"] = line.split(":")[-1].strip()
            elif line.startswith("; total layer number:"):
                info["layers"] = line.split(":")[-1].strip()
            if len(info) == 3:
                break
    print(f"sliced {os.path.basename(a.stl)} for the H2C: {info.get('time', '?')} print time, {info.get('grams', '?')} g PLA, {info.get('layers', '?')} layers")
    print(f"3mf: {os.path.join(out, 'sliced.3mf')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

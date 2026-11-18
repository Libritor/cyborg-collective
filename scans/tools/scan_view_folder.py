#!/usr/bin/env python3
"""Everything a sitting photographed, as one folder a splat can be trained from.

    python scan_view_folder.py <object folder pulled from the headset> [--out <folder>]

Print What I See keeps two kinds of pictures: the scan's (scan/k0000.jpg ... with depth and a row in scan/frames.csv)
and one per trigger pull (capture_<n>.jpg with capture_<n>.json: the camera pose at that moment). This writes
<object folder>/view/ with all of them under one frames.csv and the scan's camera.json, so quest_scan.py --scan
<...>/view trains one splat of everything that was looked at. There is no scan.json in it: it is a view of the
surroundings, not one object.
"""
import argparse
import csv
import json
import os
import shutil


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--out")
    a = ap.parse_args()
    src = os.path.normpath(a.folder)
    scan = os.path.join(src, "scan")
    out = os.path.normpath(a.out) if a.out else os.path.join(src, "view")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    cam = os.path.join(scan, "camera.json")
    if not os.path.exists(cam):
        raise SystemExit(f"no scan/camera.json in {src}: this sitting has no scan pictures to take the camera from")
    shutil.copyfile(cam, os.path.join(out, "camera.json"))
    rows = []
    for r in csv.DictReader(open(os.path.join(scan, "frames.csv"))):
        p = os.path.join(scan, r["file"])
        if not os.path.exists(p):
            continue
        shutil.copyfile(p, os.path.join(out, r["file"]))
        d = os.path.splitext(p)[0] + ".depth"
        if os.path.exists(d):
            shutil.copyfile(d, os.path.join(out, os.path.basename(d)))
        rows.append({k: r[k] for k in ("file", "t_unix_ms", "t_app_s", "cam_px", "cam_py", "cam_pz", "cam_qx", "cam_qy", "cam_qz", "cam_qw")})
    n_scan = len(rows)
    anchors = {}
    caps = sorted((f for f in os.listdir(src) if f.startswith("capture_") and f.endswith(".json")), key=lambda s: int(s[8:-5]))
    for c in caps:
        j = json.load(open(os.path.join(src, c)))
        jpg = os.path.join(src, c[:-5] + ".jpg")
        if not os.path.exists(jpg):
            continue
        name = "p%04d.jpg" % int(c[8:-5])
        shutil.copyfile(jpg, os.path.join(out, name))
        p, q = j["cam_pos"], j["cam_rot"]
        rows.append({"file": name, "t_unix_ms": j.get("t_unix_ms", 0), "t_app_s": 0, "cam_px": p[0], "cam_py": p[1], "cam_pz": p[2],
                     "cam_qx": q[0], "cam_qy": q[1], "cam_qz": q[2], "cam_qw": q[3]})
        if j.get("seed"):
            anchors[name] = j["seed"]             # where the trigger pointed: the one spot of this picture with a measured depth
    json.dump({"coordinates": "Unity world, left-handed, y up, metres", "points": anchors}, open(os.path.join(out, "anchors.json"), "w"), indent=1)
    with open(os.path.join(out, "frames.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["frame", "file", "t_unix_ms", "t_app_s", "cam_px", "cam_py", "cam_pz", "cam_qx", "cam_qy", "cam_qz", "cam_qw"])
        w.writeheader()
        for i, r in enumerate(rows):
            w.writerow(dict(r, frame=i))
    print(f"{out}: {n_scan} scan pictures + {len(rows) - n_scan} trigger pictures")


if __name__ == "__main__":
    main()

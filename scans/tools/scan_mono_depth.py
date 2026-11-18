#!/usr/bin/env python3
"""Depth for pictures the headset recorded no depth behind: estimated from each picture alone, then pinned to
what was measured.

    python scan_mono_depth.py <scan or view folder> [--stride 4] [--max-m 6]

A depth-estimation network (Depth Anything V2, the indoor metric model, on the CPU) gives every picture a depth map.
A network's metres are only roughly metres, so each map is scaled to the headset's own measurements in that
picture: the depth rays, where the picture has them (k0000.depth ...), or the one spot the trigger pointed at
(anchors.json, written by scan_view_folder.py). A picture with neither takes the median scale of the others.

Writes <folder>/mono/<picture>.npy (metres along the optical axis, 640 x 480, float16), mono_points.ply (every
picture's depth as coloured points in the scan's right-handed world: the starting cloud for quest_scan.py --points)
and mono_report.json (per picture: the scale used and, where there is a depth grid, how well the shape fits it).

This is a guess at the shape of the room, good to perhaps a tenth of the distance. It is no measurement: where the
headset recorded its own depth (every picture, with the app from 17 Nov 2026 16:30 on) that is used instead.
"""
import argparse
import json
import os
import sys

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")     # this Anaconda's numpy and torch each bring an OpenMP runtime

import numpy as np                                                      # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan_lib as L                                                    # noqa: E402

MODEL ="depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"
W, H = 640, 480


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--stride", type=int, default=4, help="every Nth pixel of the 640 x 480 map becomes a point")
    ap.add_argument("--max-m", type=float, default=6.0)
    a = ap.parse_args()
    import torch
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    folder = os.path.normpath(a.folder)
    frames, intr, _ = L.load_scan(folder)
    anchors = {}
    ap_ = os.path.join(folder, "anchors.json")
    if os.path.exists(ap_):
        anchors = {k: L.S @ np.array(v, float) for k, v in json.load(open(ap_))["points"].items()}
    proc = AutoImageProcessor.from_pretrained(a.model)
    net = AutoModelForDepthEstimation.from_pretrained(a.model).eval()
    out = os.path.join(folder, "mono")
    os.makedirs(out, exist_ok=True)
    sx, sy = W / intr["w"], H / intr["h"]
    maps, report = {}, {}
    for f in frames:
        im = Image.open(os.path.join(folder, f.name)).convert("RGB")
        with torch.no_grad():
            pred = net(**proc(images=im, return_tensors="pt")).predicted_depth
        d = torch.nn.functional.interpolate(pred[None] if pred.dim() == 3 else pred, size=(H, W), mode="bilinear", align_corners=False)[0, 0].numpy().astype(np.float64)
        maps[f.name] = d
        rep = {"network_median_m": round(float(np.median(d)), 2)}
        if f.depth_file:
            _, pts, _n = L.load_depth(f)
            x, y, z = L.project(f, intr, pts)
            xi, yi = (x * sx).astype(int), (y * sy).astype(int)
            ok = (z > 0.1) & (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
            if ok.sum() > 50:
                ratio = z[ok] / np.maximum(d[yi[ok], xi[ok]], 1e-3)
                s = float(np.median(ratio))
                e = np.abs(s * d[yi[ok], xi[ok]] - z[ok])
                rep.update({"scale": round(s, 3), "pinned_to": f"{int(ok.sum())} depth rays", "fit_median_cm": round(float(np.median(e)) * 100, 1),
                            "fit_p90_cm": round(float(np.percentile(e, 90)) * 100, 1)})
        elif f.name in anchors:
            x, y, z = L.project(f, intr, anchors[f.name][None])
            xi, yi = int(x[0] * sx), int(y[0] * sy)
            if z[0] > 0.1 and 0 <= xi < W and 0 <= yi < H:
                win = d[max(0, yi - 3):yi + 4, max(0, xi - 3):xi + 4]
                rep.update({"scale": round(float(z[0] / np.median(win)), 3), "pinned_to": "the trigger point", "true_m": round(float(z[0]), 2)})
        report[f.name] = rep
        print(f"  {f.name}: {rep}", flush=True)
    known = [r["scale"] for r in report.values() if "scale" in r]
    fallback = float(np.median(known)) if known else 1.0
    P, C = [], []
    from PIL import Image as _I
    ys, xs = np.mgrid[0:H:a.stride, 0:W:a.stride]
    for f in frames:
        rep = report[f.name]
        s = rep.get("scale")
        if s is None:
            s = fallback; rep.update({"scale": round(s, 3), "pinned_to": "nothing (the others' median)"})
        d = maps[f.name] * s
        np.save(os.path.join(out, os.path.splitext(f.name)[0] + ".npy"), d.astype(np.float16))
        # leave out the jumps between a near thing and what is behind it: there the map smears one into the other
        gy, gx = np.gradient(d)
        edge = np.hypot(gx, gy) > 0.04 * d
        z = d[ys, xs]
        ok = (z > 0.15) & (z < a.max_m) & ~edge[ys, xs]
        u, v = (xs[ok] + 0.5) / sx, (ys[ok] + 0.5) / sy
        ray = np.stack([(u - intr["cx"]) / intr["fx"], (v - intr["cy"]) / intr["fy"], np.ones(ok.sum())], 1) * z[ok][:, None]
        P.append(f.C + ray @ f.R_cw())
        im = np.asarray(_I.open(os.path.join(folder, f.name)).convert("RGB").resize((W, H)))
        C.append(im[ys[ok], xs[ok]])
    P, C = np.vstack(P), np.vstack(C)
    L.write_points_ply(os.path.join(folder, "mono_points.ply"), P, C)
    json.dump({"model": a.model, "pictures": report}, open(os.path.join(folder, "mono_report.json"), "w"), indent=1)
    sc = np.array([r["scale"] for r in report.values()])
    print(f"{len(P)} points -> {os.path.join(folder, 'mono_points.ply')}; scales {sc.min():.2f} to {sc.max():.2f} (median {np.median(sc):.2f})")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""How close is the solid quest_scan.py made to the model the synthetic scan was drawn from?

    python scan_gate.py <run folder made from a scan_synth.py scan> [--limit-mm 3.0]

Compares <run>/object/object_world.ply with <run>/truth/gt_world.ply (both in the scan's world, metres):
distances from points on the solid to the true surface (accuracy) and from the true surface to the solid
(completeness), the three sizes, the volume. PASS when the solid is closed, the median distance both ways is
under --limit-mm and every size is within 6 %. Also the printed STL is read back and checked (closed, size,
flat on the bed). Writes <run>/gate.json and a picture gate.jpg (the two side by side from four sides).
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def volume(mesh):
    v = np.asarray(mesh.vertices); t = np.asarray(mesh.triangles)
    return float(np.einsum("ij,ij->i", v[t[:, 0]], np.cross(v[t[:, 1]], v[t[:, 2]])).sum() / 6.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--limit-mm", type=float, default=3.0)
    a = ap.parse_args()
    import open3d as o3d
    from scipy.spatial import cKDTree
    import scan_solid as SO
    from splat_render import Camera
    run = os.path.normpath(a.run)
    rec = o3d.io.read_triangle_mesh(os.path.join(run, "object", "object_world.ply"))
    gt = o3d.io.read_triangle_mesh(os.path.join(run, "truth", "gt_world.ply"))
    truth = json.load(open(os.path.join(run, "truth", "truth.json")))
    summ = json.load(open(os.path.join(run, "summary.json")))
    pr = np.asarray(rec.sample_points_uniformly(120000, use_triangle_normal=True).points)
    pg = np.asarray(gt.sample_points_uniformly(120000, use_triangle_normal=True).points)
    d_acc, _ = cKDTree(pg).query(pr)
    d_com, _ = cKDTree(pr).query(pg)
    # the base of the solid is a flat face the model does not have (it stands on its feet): leave it out of accuracy
    base = summ["object"]["base_y"]
    off_base = pr[:, 1] > base + 0.002
    # which side of the true surface the solid's surface lies on: negative = inside the model (the solid is too small)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(gt))
    occ = scene.compute_occupancy(o3d.core.Tensor(pr.astype(np.float32))).numpy() > 0.5
    signed = np.where(occ, -d_acc, d_acc)
    er, eg = np.asarray(rec.get_axis_aligned_bounding_box().get_extent()), np.asarray(gt.get_axis_aligned_bounding_box().get_extent())
    out = {"offset_mm": round(float(np.median(signed[off_base])) * 1000, 2), "accuracy_mm": {k: round(float(f(d_acc[off_base])) * 1000, 2) for k, f in (("median", np.median), ("mean", np.mean), ("p95", lambda x: np.percentile(x, 95)))},
           "completeness_mm": {k: round(float(f(d_com)) * 1000, 2) for k, f in (("median", np.median), ("mean", np.mean), ("p95", lambda x: np.percentile(x, 95)))},
           "size_cm": [round(float(x) * 100, 2) for x in er], "true_size_cm": [round(float(x) * 100, 2) for x in eg],
           "size_error_pct": [round(float((x - y) / y * 100), 1) for x, y in zip(er, eg)],
           "volume_cm3": round(volume(rec) * 1e6, 1), "true_volume_cm3": round(abs(volume(gt)) * 1e6, 1),
           "support_y_error_mm": round((base - truth["table_y"]) * 1000, 2), "closed": SO.is_closed(rec),
           "held_out_psnr_db": summ.get("train", {}).get("held_out_psnr_db")}
    # the STL that goes to the slicer
    stl = (summ.get("print") or {}).get("stl")
    if stl and os.path.exists(stl):
        m = o3d.io.read_triangle_mesh(stl); m.remove_duplicated_vertices()
        v = np.asarray(m.vertices)
        out["stl"] = {"closed": SO.is_closed(m), "size_mm": [round(float(x), 1) for x in v.max(0) - v.min(0)], "on_bed": bool(abs(v[:, 2].min()) < 1e-3),
                      "volume_cm3": round(volume(m) / 1000, 1), "triangles": int(len(m.triangles))}
    ok = (out["closed"] and out["accuracy_mm"]["median"] < a.limit_mm and out["completeness_mm"]["median"] < a.limit_mm
          and all(abs(e) < 6 for e in out["size_error_pct"]) and ("stl" not in out or (out["stl"]["closed"] and out["stl"]["on_bed"])))
    out["pass"] = bool(ok)
    json.dump(out, open(os.path.join(run, "gate.json"), "w"), indent=1)
    # the two from four sides
    from PIL import Image
    c = (np.asarray(gt.get_max_bound()) + np.asarray(gt.get_min_bound())) / 2
    R = float(np.linalg.norm(eg) / 2)
    size = 360
    sheet = Image.new("RGB", (4 * size, 2 * size), "white")
    rec.compute_vertex_normals(); gt.compute_vertex_normals()
    for k in range(4):
        az = np.pi / 4 + k * np.pi / 2
        eye = c + 3.2 * R * np.array([np.cos(az) * np.cos(0.4), np.sin(0.4), np.sin(az) * np.cos(0.4)])
        f = 0.44 * size * 3.2
        cam = Camera.look_at(eye, c, (0, 1, 0), f, f, size / 2, size / 2, size, size)
        for row, m in enumerate((gt, rec)):
            img = SO.shade_mesh(m, cam, colour=(0.62, 0.78, 0.62) if row == 0 else None)
            sheet.paste(Image.fromarray((img * 255).astype(np.uint8)), (k * size, row * size))
    sheet.save(os.path.join(run, "gate.jpg"), quality=88)
    print(json.dumps(out, indent=1))
    print("GATE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

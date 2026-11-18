#!/usr/bin/env python3
"""A 3-D model of the surroundings from a view scan: every picture's depth map fused into one coloured surface, and
a printable diorama of it.

    python scan_room_model.py <run folder> [--voxel 0.02] [--wall 0.06] [--scale 30] [--cut 2.25] [--no-slice]

Needs the depth maps scan_mono_depth.py wrote next to the pictures (<scan>/mono/*.npy, metres, pinned to the
headset's measurements). They are voted into a voxel grid the way a depth camera's would be: free in front of
what a picture sees, solid for `--wall` metres behind it, unknown elsewhere. The surface of the solid part is the
model: the walls, floor, ceiling and the fronts of the furniture as a shell `--wall` thick, seen from where the
pictures were taken. What no picture saw is simply missing; nothing is invented.

Writes <run>/room/:
  room_model.glb / .ply   the shell, coloured from the pictures; metres, y up, the origin on the floor under the
                          spot the pictures were taken from (as the viewer's view.ply)
  room_diorama.stl        for the printer: the same at 1:<scale>, the ceiling and everything above --cut metres
                          left off so one can look in, on a base plate; millimetres, standing on the bed
  room_diorama_h2c.3mf    sliced for the Bambu H2C (nothing is sent to the printer)
  room_model.jpg          the shell from four sides and from above
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan_lib as L                                                    # noqa: E402
import scan_solid as SO                                                 # noqa: E402
from splat_render import Camera                                         # noqa: E402


def fuse(frames, intr, mono_dir, voxel, wall, max_m, log=print):
    """-> (field [nx, ny, nz] negative inside the shell, origin, picture count per voxel)."""
    from scipy.ndimage import maximum_filter, minimum_filter
    maps = []
    P = []
    for f in frames:
        p = os.path.join(mono_dir, os.path.splitext(f.name)[0] + ".npy")
        if not os.path.exists(p):
            continue
        d = np.load(p).astype(np.float64)
        gy, gx = np.gradient(d)
        d[(np.hypot(gx, gy) > 0.04 * d) | (d > max_m) | (d < 0.15)] = 0.0       # jumps between near and far smear: left out
        h, w = d.shape
        cam = Camera.of_frame(f, intr).scaled(w / intr["w"])
        maps.append((cam, d))
        ys, xs = np.mgrid[0:h:6, 0:w:6]
        z = d[ys, xs]; ok = z > 0
        ray = np.stack([(xs[ok] + 0.5 - cam.cx) / cam.fx, (ys[ok] + 0.5 - cam.cy) / cam.fy, np.ones(ok.sum())], 1) * z[ok][:, None]
        P.append(cam.C + ray @ cam.R)
    if len(maps) < 3:
        raise SystemExit(f"only {len(maps)} depth maps in {mono_dir}: run scan_mono_depth.py on the scan folder first")
    P = np.vstack(P)
    lo, hi = np.percentile(P, 0.3, 0) - 0.15, np.percentile(P, 99.7, 0) + 0.15
    shape = np.ceil((hi - lo) / voxel).astype(int) + 1
    log(f"{len(maps)} depth maps, room box {np.round(hi - lo, 2).tolist()} m, grid {shape.tolist()} at {voxel * 100:.1f} cm")
    n_free = np.zeros(shape, np.uint16); n_near = np.zeros(shape, np.uint16); s_sdf = np.zeros(shape, np.float32)
    for cam, d in maps:
        dmin = minimum_filter(np.where(d > 0, d, 1e9), size=3, mode="nearest")
        amax = np.ones_like(d)                                      # a pixel with no depth says nothing (not "empty")
        SO._vote(lo[0], lo[1], lo[2], voxel, cam.R, cam.C, cam.fx, cam.fy, cam.cx, cam.cy, d, dmin, amax, wall, wall, n_free, n_near, s_sdf)
    W = n_free.astype(np.float32) + n_near
    # solid = behind a seen surface by up to `wall`, by the pictures' majority; free or never seen = not solid
    field = np.where(n_near >= 1, (n_free + s_sdf) / np.maximum(W, 1), 1.0).astype(np.float32)
    return field, lo, W


def to_mesh(field, origin, voxel, keep_share=0.02):
    import open3d as o3d
    from scipy.ndimage import gaussian_filter, label
    from skimage.measure import marching_cubes
    f = gaussian_filter(field, 0.7)
    solid = f < 0
    lab, n = label(solid)
    if n == 0:
        raise SystemExit("nothing solid came out of the depth maps")
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    small = np.flatnonzero(sizes < keep_share * sizes.max())
    f[np.isin(lab, small) & solid] = 0.5                              # specks and loose flakes
    f = np.where(np.abs(f) < 0.03, np.where(f < 0, -0.03, 0.03), f).astype(np.float32)
    g = np.pad(f, 1, constant_values=1.0)
    verts, faces, _, _ = marching_cubes(g, level=0.0, spacing=(voxel,) * 3)
    verts = verts + origin - 0.5 * voxel
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(verts), o3d.utility.Vector3iVector(faces.astype(np.int32)))
    m.remove_duplicated_vertices(); m.remove_degenerate_triangles(); m.remove_unreferenced_vertices()
    if SO.signed_volume(m) < 0:
        m.triangles = o3d.utility.Vector3iVector(np.asarray(m.triangles)[:, ::-1].copy())
    m.compute_vertex_normals()
    return m, int(n - len(small))


def colour(mesh, pts, cols):
    import open3d as o3d
    from scipy.spatial import cKDTree
    _, nn = cKDTree(pts).query(np.asarray(mesh.vertices), k=3)
    mesh.vertex_colors = o3d.utility.Vector3dVector(cols[nn].mean(1) / 255.0)


def shade(mesh, cam):
    """A picture of the coloured mesh from a camera (ray casting on the CPU, the pictures' colours with a little shading)."""
    import open3d as o3d
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
    ys, xs = np.mgrid[0:cam.h, 0:cam.w]
    d = np.stack([(xs + 0.5 - cam.cx) / cam.fx, (ys + 0.5 - cam.cy) / cam.fy, np.ones_like(xs, float)], -1) @ cam.R
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    hit = scene.cast_rays(o3d.core.Tensor(np.concatenate([np.broadcast_to(cam.C, d.shape), d], -1).astype(np.float32)))
    t = hit["t_hit"].numpy(); nrm = hit["primitive_normals"].numpy(); tri = hit["primitive_ids"].numpy()
    ok = np.isfinite(t)
    vc = np.asarray(mesh.vertex_colors); T = np.asarray(mesh.triangles)
    img = np.ones((cam.h, cam.w, 3))
    base = vc[T[tri[ok]]].mean(1) if len(vc) else np.full((ok.sum(), 3), 0.8)
    lam = 0.55 + 0.45 * np.abs((nrm[ok] * -d[ok]).sum(-1))
    img[ok] = np.clip(base * lam[:, None] * 1.5, 0, 1)
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run")
    ap.add_argument("--voxel", type=float, default=0.02)
    ap.add_argument("--wall", type=float, default=0.06, help="how thick the shell behind every seen surface is, metres")
    ap.add_argument("--max-m", type=float, default=6.0)
    ap.add_argument("--scale", type=float, default=30.0, help="the print is 1:<scale>")
    ap.add_argument("--cut", type=float, default=2.25, help="the print leaves off everything above this height (metres above the floor)")
    ap.add_argument("--no-slice", action="store_true")
    a = ap.parse_args()
    import open3d as o3d
    from PIL import Image
    run = os.path.normpath(a.run)
    summ = json.load(open(os.path.join(run, "summary.json")))
    scan = summ["scan"]
    frames, intr, _ = L.load_scan(scan)
    out = os.path.join(run, "room")
    os.makedirs(out, exist_ok=True)
    field, origin, W = fuse(frames, intr, os.path.join(scan, "mono"), a.voxel, a.wall, a.max_m)
    mesh, pieces = to_mesh(field, origin, a.voxel)
    pts, cols = L.read_points_ply(os.path.join(scan, "mono_points.ply"))
    colour(mesh, pts, cols)
    # the same frame as the viewer's view.ply: sideways origin under the spot the pictures were taken from
    eye = np.median(np.array([f.C for f in frames]), 0)
    floor = float(np.percentile(pts[:, 1], 1.0))
    shift = np.array([eye[0], 0.0, eye[2]])
    v = np.asarray(mesh.vertices) - shift
    shown = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v), mesh.triangles)
    shown.vertex_colors = mesh.vertex_colors; shown.compute_vertex_normals()
    o3d.io.write_triangle_mesh(os.path.join(out, "room_model.glb"), shown)
    o3d.io.write_triangle_mesh(os.path.join(out, "room_model.ply"), shown)
    ext = v.max(0) - v.min(0)
    info = {"triangles": int(len(mesh.triangles)), "pieces": pieces, "size_m": [round(float(x), 2) for x in ext], "size_axes": "x, y (up), z",
            "floor_y_m": round(floor, 3), "voxel_cm": a.voxel * 100, "shell_cm": a.wall * 100, "depth_maps": len(frames)}
    # pictures: from above (the ceiling left off) and from the four corners
    mid = (v.max(0) + v.min(0)) / 2
    R = float(np.linalg.norm(ext[[0, 2]]) / 2)
    cutm = o3d.geometry.TriangleMesh(shown)
    keep = np.asarray(cutm.vertices)[:, 1] < floor + a.cut
    cutm.remove_vertices_by_mask(~keep)
    size = 520
    sheet = Image.new("RGB", (3 * size, 2 * size), "white")
    views = [(mid + np.array([0.02, 3.4 * R, 0.01]), (0, 0, -1))]
    for k in range(4):
        az = np.pi / 4 + k * np.pi / 2
        views.append((mid + 2.6 * R * np.array([np.cos(az) * 0.75, 0.75, np.sin(az) * 0.75]), (0, 1, 0)))
    views.append((np.array([0.0, eye[1], 0.0]), (0, 1, 0)))
    for i, (e, up) in enumerate(views):
        fpx = 0.95 * size * (np.linalg.norm(e - mid) / (2 * R)) if i < 5 else 0.5 * size
        target = mid if i < 5 else np.array([0.0, eye[1], 0.0]) + np.median(np.array([f.fwd for f in frames]), 0)
        cam = Camera.look_at(e, target, up, fpx, fpx, size / 2, size / 2, size, size)
        img = shade(cutm if i < 5 else shown, cam)
        sheet.paste(Image.fromarray((img * 255).astype(np.uint8)), ((i % 3) * size, (i // 3) * size))
    sheet.save(os.path.join(out, "room_model.jpg"), quality=88)
    # the print: 1:scale, z up, ceiling left off, on a base plate
    s = 1000.0 / a.scale
    vox_mm = a.voxel * s
    f2 = field.copy()
    j_cut = int((floor + a.cut - origin[1]) / a.voxel)
    j_floor = max(0, int((floor - origin[1]) / a.voxel) - 1)
    f2[:, j_cut:, :] = 1.0
    f2[:, :j_floor, :] = 1.0
    # Everything stands on the floor: under the lowest solid voxel of every column, solid down to the floor. The
    # pictures seldom saw the foot of a wall or a cupboard, and what was seen from above (a bed, a desk) becomes
    # a block, which is what it is at this scale.
    sol = f2 < 0
    first = np.argmax(sol, axis=1)
    jj = np.arange(f2.shape[1])[None, :, None]
    f2[sol.any(1)[:, None, :] & (jj >= j_floor) & (jj < first[:, None, :])] = -0.5
    # the base plate: the whole floor inside the outline of what was seen (its convex hull), 1.2 mm thick at least
    from skimage.morphology import convex_hull_image
    foot = convex_hull_image((f2 < 0).any(1))
    plate = max(2, int(np.ceil(1.2 / vox_mm)))
    f2[:, j_floor:j_floor + plate, :] = np.where(foot[:, None, :], -0.5, f2[:, j_floor:j_floor + plate, :])
    dm, _ = to_mesh(f2, origin, a.voxel, keep_share=0.01)
    dv = np.asarray(dm.vertices) - shift
    pv = np.stack([dv[:, 0], -dv[:, 2], dv[:, 1]], 1) * s
    pv[:, 2] -= pv[:, 2].min(); pv[:, 0] -= pv[:, 0].min(); pv[:, 1] -= pv[:, 1].min()
    pm = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(pv), dm.triangles)
    pm.compute_triangle_normals(); pm.compute_vertex_normals()
    stl = os.path.join(out, "room_diorama.stl")
    o3d.io.write_triangle_mesh(stl, pm)
    # what the print looks like, from two sides
    pm_y = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.stack([pv[:, 0], pv[:, 2], -pv[:, 1]], 1)), dm.triangles)   # back to y up for the camera
    pm_y.compute_vertex_normals()
    pmid = (np.asarray(pm_y.vertices).max(0) + np.asarray(pm_y.vertices).min(0)) / 2
    pR = float(np.linalg.norm(np.asarray(pm_y.vertices).max(0) - np.asarray(pm_y.vertices).min(0)) / 2)
    two = Image.new("RGB", (2 * 640, 520), "white")
    for i, az in enumerate((np.pi * 0.25, np.pi * 1.25)):
        e = pmid + 2.4 * pR * np.array([np.cos(az) * 0.72, 0.7, np.sin(az) * 0.72])
        cam = Camera.look_at(e, pmid, (0, 1, 0), 0.95 * 520 * 2.4 / 2, 0.95 * 520 * 2.4 / 2, 320, 260, 640, 520)
        two.paste(Image.fromarray((SO.shade_mesh(pm_y, cam) * 255).astype(np.uint8)), (i * 640, 0))
    two.save(os.path.join(out, "room_diorama.jpg"), quality=88)
    back = o3d.io.read_triangle_mesh(stl); back.remove_duplicated_vertices()
    info["print"] = {"scale": f"1:{a.scale:g}", "size_mm": [round(float(x), 1) for x in pv.max(0) - pv.min(0)], "closed": SO.is_closed(back),
                     "triangles": int(len(pm.triangles)), "stl": stl}
    if not a.no_slice:
        hd = os.path.join(out, "h2c")
        shutil.rmtree(hd, ignore_errors=True)
        p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "slice_h2c.py"), stl, "--out", hd, "--set", "enable_support=1",
                            "--set", "support_type=tree(auto)"], capture_output=True, text=True)
        line = [l for l in p.stdout.splitlines() if l.startswith("sliced ")]
        tmf = os.path.join(hd, "sliced.3mf")
        if p.returncode == 0 and os.path.exists(tmf):
            shutil.copy(tmf, os.path.join(out, "room_diorama_h2c.3mf"))
            info["print"]["h2c_3mf"] = os.path.join(out, "room_diorama_h2c.3mf")
            info["print"]["slice"] = line[0] if line else "sliced"
        else:
            info["print"]["slice"] = "FAILED: " + (p.stdout.strip().splitlines() or p.stderr.strip().splitlines() or ["no output"])[-1]
    summ["room_model"] = info
    json.dump(summ, open(os.path.join(run, "summary.json"), "w"), indent=1)
    print(json.dumps(info, indent=1))


if __name__ == "__main__":
    main()

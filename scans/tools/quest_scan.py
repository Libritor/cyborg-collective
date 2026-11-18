#!/usr/bin/env python3
"""Quest 3S object scan -> Gaussian splat -> printable solid.

    python quest_scan.py                         # pull the newest scan from the headset and do everything
    python quest_scan.py --scan <folder>         # a scan (or Room Walk) folder already on this computer
    python quest_scan.py --run <run folder> --from object     # redo from a stage: check dataset train object print render web

The Print What I See app (scan mode) leaves, per object, pictures with the camera pose of each and a grid of the
headset's depth behind each picture. This script:
  check    reads the scan, checks the depth rays against the camera model, counts the sides covered
  dataset  writes what the splat trainer reads: the pictures, the headset's poses as they are, and the depth points
           as the starting cloud (so the splat starts from measured geometry, in metres)
  train    trains the Gaussian splat on the laptop's graphics card (Brush), keeps some pictures back and compares
           the splat's renders of those with the photographs
  object   finds the surface the object stands on and the object on it, renders the splat's depth from every
           camera position and carves one closed solid out of that (scan_solid.py)
  print    real-size STL, an STL scaled to --print-mm, sliced for the Bambu H2C (3MF + G-code); nothing is sent
           to the printer
  render   pictures: photograph / splat / solid from the same positions, and a turntable of the splat
  web      the files the headset viewer shows (scan_view.py)

Results: Downloads\\quest_scans\\<name>\\ (summary.json lists every number).
Python: the Anaconda one (numpy, scipy, numba, open3d, scikit-image, Pillow). Trainer: Brush, brush\\brush_app.exe in the home folder.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan_lib as L                                                    # noqa: E402

PKG = "com.mersivity.printsee"
REMOTE = f"/sdcard/Android/data/{PKG}/files/objects"
BRUSH = os.path.join(os.path.expanduser("~"), "brush", "brush_app.exe")
OUT_ROOT = os.path.join(os.path.expanduser("~"), "Downloads", "quest_scans")
STAGES = ["check", "dataset", "train", "object", "print", "render", "web"]


def log(*a):
    print("[scan]", time.strftime("%H:%M:%S"), *a, flush=True)


def adb(args, device=None, check=True):
    cmd = ["adb"] + (["-s", device] if device else []) + args
    r = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, MSYS_NO_PATHCONV="1"))
    if check and r.returncode != 0:
        raise SystemExit(f"adb {' '.join(args)} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def pull_latest(device, out_root, name=None):
    """The newest object on the headset that has a scan -> <out_root>/<name>; returns that folder."""
    names = sorted(n.strip() for n in adb(["shell", "ls", REMOTE], device).split() if n.strip())
    if name:
        names = [n for n in names if n == name]
    for n in reversed(names):
        if "frames.csv" in adb(["shell", "ls", f"{REMOTE}/{n}/scan"], device, check=False):
            dst = os.path.join(out_root, n)
            os.makedirs(out_root, exist_ok=True)
            if os.path.isdir(os.path.join(dst, "scan")):
                shutil.rmtree(os.path.join(dst, "scan"))
            log(f"pulling {n} from the headset ...")
            adb(["pull", f"{REMOTE}/{n}", out_root], device)
            return dst
    raise SystemExit("no object with a scan on the headset: pick an object, walk round it, press B")


class Run:
    def __init__(self, a):
        self.a = a
        if a.run:
            self.dir = os.path.normpath(a.run)
        elif a.scan:
            scan = os.path.normpath(a.scan)
            self.dir = os.path.join(OUT_ROOT, a.name or (os.path.basename(os.path.dirname(scan)) if os.path.basename(scan) == "scan" else os.path.basename(scan)))
        else:
            self.dir = pull_latest(a.device, OUT_ROOT, a.object)
        os.makedirs(self.dir, exist_ok=True)
        self.sum_path = os.path.join(self.dir, "summary.json")
        self.sum = json.load(open(self.sum_path)) if os.path.exists(self.sum_path) else {}
        scan = a.scan or self.sum.get("scan") or os.path.join(self.dir, "scan")
        self.scan = os.path.normpath(scan)
        if not os.path.exists(os.path.join(self.scan, "frames.csv")):
            raise SystemExit(f"no frames.csv in {self.scan}")
        self.sum["scan"] = self.scan
        for k in ("first", "last", "stride"):
            if getattr(a, k) is not None:
                self.sum[k] = getattr(a, k)
        self.frames, self.intr, self.obj = L.load_scan(self.scan, self.sum.get("first"), self.sum.get("last"), self.sum.get("stride") or 1)
        # Which object? The scan lists everything that was picked; the one to make solid is the one that was walked
        # round. If none was (pictures from one spot, or nothing picked), this is a view of the surroundings.
        cands = list((self.obj or {}).get("picks") or [])
        if not cands and self.obj and self.obj.get("seed") is not None:
            cands = [self.obj]
        self.choice = {"picked": len(cands)}
        best = None
        for i, c in enumerate(cands):
            n, deg = L.seen_from(self.frames, self.intr, c["centre"])
            if best is None or (deg, n) > (best[1], best[2]):
                best = (i, deg, n)
        if best:
            self.choice.update({"best": best[0] + 1, "seen_from_deg": best[1], "in_pictures": best[2]})
        if a.view or a.solid:
            self.sum["forced"] = "view" if a.view else "solid"      # remembered for later stages of the same run
        forced = self.sum.get("forced")
        if forced == "view" or not best or ((best[1] < 140 or best[2] < 20) and forced != "solid"):
            self.obj = None
            self.choice["mode"] = "view"
        else:
            c = cands[best[0]]
            self.obj = dict(self.obj, seed=c["seed"], centre=c["centre"], radius=c.get("radius", 0.15))
            self.choice["mode"] = "object"
        if a.centre:
            c = [float(x) for x in a.centre.split(",")]
            self.obj = dict(self.obj or {}, seed=c, centre=c, radius=(self.obj or {}).get("radius", 0.15))
            self.sum["centre_given"] = c
        elif self.sum.get("centre_given") and not self.obj:
            c = self.sum["centre_given"]
            self.obj = {"seed": c, "centre": c, "radius": 0.15}
        if a.radius:
            self.sum["radius_given"] = a.radius
        self.gs = os.path.join(self.dir, "gs")
        self.odir = os.path.join(self.dir, "object")
        self.name = os.path.basename(self.dir)

    def save(self):
        json.dump(self.sum, open(self.sum_path, "w"), indent=1)

    def splat_path(self):
        p = self.sum.get("train", {}).get("splat")
        if not p or not os.path.exists(p):
            raise SystemExit("no trained splat yet: run the train stage")
        return p

    def cameras(self):
        from splat_render import Camera
        return [Camera.of_frame(f, self.intr) for f in self.frames]


# ---------------------------------------------------------------- check
def stage_check(r):
    fr, intr = r.frames, r.intr
    if len(fr) < 12:
        raise SystemExit(f"only {len(fr)} pictures in the scan: walk all the way round the object before saving")
    C = np.array([f.C for f in fr])
    info = {"pictures": len(fr), "camera_path_m": round(float(np.linalg.norm(np.diff(C, axis=0), axis=1).sum()), 2),
            "image": [intr["w"], intr["h"]], "focal_px": round(intr["fx"], 1)}
    # the depth rays against the camera model: a ray's world point must project back to the spot it was cast through
    res, hits = [], 0
    for f in fr:
        if not f.depth_file:
            continue
        uv, pts, _ = L.load_depth(f)
        hits += len(pts)
        if len(pts) < 20:
            continue
        px, py = L.viewport_to_pixel(uv, intr)
        x, y, z = L.project(f, intr, pts)
        ok = z > 0.05
        res.append([np.median(x[ok] - px[ok]), np.median(y[ok] - py[ok]), np.median(np.hypot(x[ok] - px[ok], y[ok] - py[ok]))])
    info["depth_points"] = int(hits)
    if res:
        res = np.array(res)
        info["depth_ray_offset_px"] = [round(float(np.median(res[:, 0])), 2), round(float(np.median(res[:, 1])), 2)]
        info["depth_ray_error_px"] = round(float(np.median(res[:, 2])), 2)
        if info["depth_ray_error_px"] > 12:
            raise SystemExit(f"the depth rays land {info['depth_ray_error_px']} px from where they were cast: the camera model or the pose "
                             "convention does not fit this scan (expected under 6 px)")
    if r.obj:
        c = np.array(r.obj["centre"])
        az = np.degrees(np.arctan2(C[:, 2] - c[2], C[:, 0] - c[0]))
        seen = np.zeros(36, bool); seen[((az + 180) // 10).astype(int) % 36] = True
        el = np.degrees(np.arcsin(np.clip((C[:, 1] - c[1]) / np.maximum(np.linalg.norm(C - c, axis=1), 1e-6), -1, 1)))
        info.update({"around_deg": int(seen.sum() * 10), "distance_m": [round(float(x), 2) for x in np.percentile(np.linalg.norm(C - c, axis=1), [5, 50, 95])],
                     "elevation_deg": [round(float(x)) for x in np.percentile(el, [5, 50, 95])]})
    info["mode"] = r.choice
    r.sum["check"] = info
    log("check:", info)
    ch = r.choice
    if r.obj:
        log(f"mode: OBJECT: picked thing {ch.get('best', 1)} of {max(ch['picked'], 1)}, photographed from {ch.get('seen_from_deg', '?')} degrees round it "
            f"in {ch.get('in_pictures', '?')} pictures -> splat and solid")
    elif ch["picked"]:
        log(f"mode: VIEW: none of the {ch['picked']} picked things was walked round (the best: {ch['seen_from_deg']} degrees in {ch['in_pictures']} pictures; "
            "a solid needs 140 degrees and 20 pictures) -> a splat of the surroundings from where they were photographed, no solid")
    else:
        log("mode: VIEW: nothing was picked -> a splat of the surroundings from where they were photographed, no solid")


# ---------------------------------------------------------------- dataset
def depth_cloud(r):
    """All depth points of the scan with the colour of the picture there and the surface normal: (P, colours, N)."""
    from PIL import Image
    P, Cc, N = [], [], []
    intr = r.intr
    for f in r.frames:
        if not f.depth_file:
            continue
        _, pts, nrm = L.load_depth(f)
        if not len(pts):
            continue
        im = Image.open(os.path.join(r.scan, f.name)); im.draft("RGB", (intr["w"] // 2, intr["h"] // 2))
        im = np.asarray(im.convert("RGB"))
        sx, sy = im.shape[1] / intr["w"], im.shape[0] / intr["h"]
        x, y, z = L.project(f, intr, pts)
        ok = (z > 0.05) & (x >= 0) & (x < intr["w"]) & (y >= 0) & (y < intr["h"])
        xi = np.clip((x[ok] * sx).astype(int), 0, im.shape[1] - 1); yi = np.clip((y[ok] * sy).astype(int), 0, im.shape[0] - 1)
        P.append(pts[ok]); Cc.append(im[yi, xi]); N.append(nrm[ok])
    if not P:
        return None, None, None
    return np.vstack(P), np.vstack(Cc), np.vstack(N)


def thin(P, cell):
    """Indices of one point per cell."""
    _, first = np.unique(np.floor(P / cell).astype(np.int64), axis=0, return_index=True)
    return first


def object_region(r, P, N):
    """Where the object is and how far it reaches, before any training, from the headset's depth: the clump of
    depth points standing on the level surface at the picked spot. -> (centre, radius, how it was found)."""
    import scan_solid as SO
    seed, centre = np.array(r.obj["seed"], float), np.array(r.obj["centre"], float)
    hint = float(r.obj.get("radius", 0.15))
    given = r.sum.get("radius_given")
    reach = float(given) if given else float(np.clip(3 * hint + 0.15, 0.3, 0.9))
    if given:
        return centre, float(given), "given"
    if P is None or len(P) < 300:
        return centre, max(hint, 0.1), "the pick (no depth)"
    y0 = SO.plane_from_depth(P, N, centre, reach + 0.25)
    # how rough the depth is, from the level surface itself: the object is what stands clear of that roughness
    lift = 0.02
    if y0 is not None:
        d = np.hypot(P[:, 0] - centre[0], P[:, 2] - centre[2])
        flat = (d < reach + 0.25) & (N[:, 1] > 0.9) & (np.abs(P[:, 1] - y0) < 0.05)
        if flat.sum() > 100:
            lift = float(np.clip(3 * 1.4826 * np.median(np.abs(P[flat, 1] - y0)), 0.02, 0.06))
    limit = float(np.clip(2.5 * hint + 0.05, 0.15, 0.6))          # further than this from the pick is not the object
    k = thin(P, 0.006)
    fake = {"xyz": P[k], "opacity": np.ones(len(k)), "scale": np.zeros((len(k), 3))}
    m = SO.object_component(fake, seed, y0, reach, cell=max(0.012, 0.6 * lift), lift=lift)
    how = "the headset's depth"
    q = P[k][m]
    if m.sum() >= 30:
        lo, hi = np.percentile(q, 1, 0), np.percentile(q, 99, 0)
    if m.sum() < 30 or np.linalg.norm(hi - lo) / 2 > limit:
        # no clear clump (rough depth joins the object to the table): what stands above the surface near the pick
        q = P[k]
        near = (np.hypot(q[:, 0] - centre[0], q[:, 2] - centre[2]) < limit) & (np.abs(q[:, 1] - centre[1]) < limit + 0.1)
        if y0 is not None:
            near &= q[:, 1] > y0 + lift
        if near.sum() < 30:
            return centre, max(hint, 0.1), "the pick (no clump in the depth)"
        lo, hi = np.percentile(q[near], 2, 0), np.percentile(q[near], 98, 0)
        how = "the headset's depth near the pick"
    if y0 is not None:
        lo[1] = y0
    return (lo + hi) / 2, float(min(np.linalg.norm(hi - lo) / 2, limit)), how


def crop_cameras(r, centre, reach):
    """For every picture that has the object in it: the window of the picture round the object. The splat is trained
    on those windows, so all its detail goes to the object rather than to the room."""
    intr = r.intr
    out = []
    for i, f in enumerate(r.frames):
        x, y, z = L.project(f, intr, centre[None])
        x, y, z = float(x[0]), float(y[0]), float(z[0])
        if z < 0.12 or not (0 <= x < intr["w"] and 0 <= y < intr["h"]):
            continue
        hs = min(intr["fx"] * reach / z + 6, 0.5 * min(intr["w"], intr["h"]))
        x0, x1 = int(max(0, np.floor(x - hs))), int(min(intr["w"], np.ceil(x + hs)))
        y0, y1 = int(max(0, np.floor(y - hs))), int(min(intr["h"], np.ceil(y + hs)))
        if (x1 - x0) * (y1 - y0) < 0.55 * (2 * hs) ** 2 or x1 - x0 < 96 or y1 - y0 < 96:
            continue
        out.append({"index": i, "name": os.path.splitext(f.name)[0] + ".png", "x0": x0, "y0": y0, "w": x1 - x0, "h": y1 - y0})
    return out


def stage_dataset(r):
    from PIL import Image
    P, Cc, N = depth_cloud(r)
    info = {"depth_points": 0 if P is None else int(len(P))}
    if P is not None:
        k = thin(P, 0.004)
        np.save(os.path.join(r.dir, "depth_points.npy"), np.hstack([P[k], N[k]]).astype(np.float32))
        L.write_points_ply(os.path.join(r.dir, "depth_points.ply"), P[k], Cc[k])
    shutil.rmtree(r.gs, ignore_errors=True)
    img_dir = os.path.join(r.gs, "images")
    os.makedirs(img_dir)
    if r.obj:
        centre, radius, how = object_region(r, P, N)
        reach = 1.5 * radius + 0.06
        crops = crop_cameras(r, centre, reach)
        if len(crops) < 12:
            raise SystemExit(f"the object is in only {len(crops)} of the {len(r.frames)} pictures: scan it again keeping it in the middle of the view")
        frames, intrs = [], []
        for c in crops:
            f = r.frames[c["index"]]
            im = Image.open(os.path.join(r.scan, f.name)).convert("RGB").crop((c["x0"], c["y0"], c["x0"] + c["w"], c["y0"] + c["h"]))
            im.save(os.path.join(img_dir, c["name"]), compress_level=3)
            frames.append(f)
            intrs.append({"w": c["w"], "h": c["h"], "fx": r.intr["fx"], "fy": r.intr["fy"], "cx": r.intr["cx"] - c["x0"], "cy": r.intr["cy"] - c["y0"]})
        names = [c["name"] for c in crops]
        json.dump(crops, open(os.path.join(r.gs, "crops.json"), "w"))
        info.update({"object_centre": np.round(centre, 4).tolist(), "object_radius_m": round(radius, 3), "object_found_by": how,
                     "crop_reach_m": round(reach, 3), "pictures": len(crops), "crop_px": [int(np.median([c["w"] for c in crops])), int(np.median([c["h"] for c in crops]))]})
    else:
        centre, reach = None, None
        L.link_images(r.gs, r.scan, r.frames)
        frames, intrs, names = r.frames, r.intr, None
        info["pictures"] = len(frames)
    # the starting cloud: the headset's depth, fine round the object and coarse beyond (in metres, where things are)
    src = "the headset's depth"
    if P is not None:
        d = np.linalg.norm(P - centre, axis=1) if centre is not None else np.full(len(P), 1e9)
        near = d < (1.3 * reach if reach else 0)
        keep = np.concatenate([np.flatnonzero(near)[thin(P[near], 0.003)] if near.any() else np.zeros(0, int),
                               np.flatnonzero(~near)[thin(P[~near], 0.02)] if (~near).any() else np.zeros(0, int)])
        pts, cols = P[keep], Cc[keep]
    elif r.a.points:
        pts, cols = L.read_points_ply(r.a.points)
        seen = np.zeros(len(pts), bool)
        for f in frames:
            x, y, z = L.project(f, r.intr, pts)
            seen |= (z > 0.1) & (z < 8) & (x > 0) & (x < r.intr["w"]) & (y > 0) & (y < r.intr["h"])
        pts, cols = pts[seen], (cols[seen] if cols is not None else None)
        src = os.path.basename(r.a.points)
    else:
        pts = cols = None
        src = "none"
    extra = r.a.points or r.sum.get("points_given")
    if extra and P is not None:
        # points given on top of the headset's depth (e.g. scan_mono_depth.py's cloud for the pictures without any)
        r.sum["points_given"] = extra
        ep, ec = L.read_points_ply(extra)
        k = thin(ep, 0.02)
        pts = np.vstack([pts, ep[k]])
        cols = np.vstack([cols, ec[k] if ec is not None else np.full((len(k), 3), 128, np.uint8)])
        src += " + " + os.path.basename(extra)
    bare = [f for f in frames if not f.depth_file] if not extra else []
    if bare:
        # pictures with no depth behind them: a loose cloud along their own rays, each point the colour of its
        # pixel, for the trainer to pull into place
        rng = np.random.default_rng(0)
        per = max(600, min(3000, 60000 // len(bare)))
        LP, LC = [], []
        for f in bare:
            im = Image.open(os.path.join(r.scan, f.name)); im.draft("RGB", (r.intr["w"] // 4, r.intr["h"] // 4))
            im = np.asarray(im.convert("RGB"))
            u, v = rng.uniform(0, r.intr["w"], per), rng.uniform(0, r.intr["h"], per)
            dirs = np.stack([(u - r.intr["cx"]) / r.intr["fx"], (v - r.intr["cy"]) / r.intr["fy"], np.ones(per)], 1) @ f.R_cw()
            LP.append(f.C + dirs * rng.uniform(0.5, 3.5, (per, 1)))
            LC.append(im[np.clip((v * im.shape[0] / r.intr["h"]).astype(int), 0, im.shape[0] - 1), np.clip((u * im.shape[1] / r.intr["w"]).astype(int), 0, im.shape[1] - 1)])
        LP, LC = np.vstack(LP), np.vstack(LC)
        pts = LP if pts is None else np.vstack([pts, LP])
        cols = LC if cols is None else np.vstack([cols, LC])
        src = ("a loose cloud along the pictures' rays" if src == "none" else src + f" + a loose cloud for the {len(bare)} pictures without it")
    L.write_colmap(r.gs, frames, intrs, pts, cols, names)
    info.update({"start_points": int(len(pts)), "start_points_from": src})
    r.sum["dataset"] = info
    log("dataset:", info)


# ---------------------------------------------------------------- train
def run_brush(dataset, out, steps, max_res, sh_degree, eval_every, extra=()):
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    if not os.path.exists(BRUSH):
        raise SystemExit(f"the splat trainer is missing: {BRUSH}")
    cmd = [BRUSH, dataset, "--total-steps", str(steps), "--export-every", str(steps), "--eval-every", str(steps), "--export-path", out,
           "--export-name", "splat_{iter}.ply", "--max-resolution", str(max_res), "--sh-degree", str(sh_degree), "--seed", "42"]
    if eval_every:
        cmd += ["--eval-split-every", str(eval_every), "--eval-save-to-disk"]
    cmd += list(extra)
    t0 = time.time()
    with open(os.path.join(out, "brush.log"), "w") as fh:
        p = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT)
    plys = sorted((f for f in os.listdir(out) if f.endswith(".ply")), key=lambda f: os.path.getmtime(os.path.join(out, f)))
    if p.returncode != 0 or not plys:
        raise SystemExit(f"the trainer failed (exit {p.returncode}); see {os.path.join(out, 'brush.log')}")
    return os.path.join(out, plys[-1]), round(time.time() - t0)


def stage_train(r):
    from PIL import Image
    a = r.a
    out = os.path.join(r.gs, "out")
    n = (r.sum.get("dataset") or {}).get("pictures", len(r.frames))
    log(f"training the object's splat: {a.steps} steps on {n} pictures ...")
    extra = ["--max-splats", str(a.max_splats)] if a.max_splats else []
    if a.growth:
        extra += ["--growth-grad-threshold", str(a.growth)]
    splat, secs = run_brush(r.gs, out, a.steps, max(r.intr["w"], r.intr["h"]), a.sh_degree, a.eval_every, extra)
    info = {"steps": a.steps, "seconds": secs, "splat": splat, "splat_mb": round(os.path.getsize(splat) / 1e6, 1)}
    # the pictures kept back from training, against the splat's renders of them
    ev = [d for d in os.listdir(out) if d.startswith("eval_")]
    ps = []
    if ev:
        ed = os.path.join(out, sorted(ev)[-1])
        imgs = os.path.join(r.gs, "images")
        for nm in sorted(os.listdir(ed)):
            stem = os.path.splitext(nm)[0]
            ph = next((os.path.join(imgs, stem + e) for e in (".png", ".jpg") if os.path.exists(os.path.join(imgs, stem + e))), None)
            if not ph:
                continue
            x = Image.open(os.path.join(ed, nm)).convert("RGB")
            y = Image.open(ph).convert("RGB").resize(x.size)
            mse = np.mean((np.asarray(x, float) - np.asarray(y, float)) ** 2)
            ps.append(10 * np.log10(255 ** 2 / max(mse, 1e-9)))
        info["held_out_pictures"] = len(ps)
        if ps:
            info["held_out_psnr_db"] = round(float(np.mean(ps)), 2)
            info["held_out_psnr_min_db"] = round(float(np.min(ps)), 2)
    info["gaussians"] = int(len(L.read_splat_ply(splat)["xyz"]))
    r.sum["train"] = info
    log("train:", info)
    # the room round the object, quickly and at half size: only for looking at
    if a.scene_steps > 0 and r.obj:
        sd = os.path.join(r.dir, "gs_scene")
        shutil.rmtree(sd, ignore_errors=True)
        L.link_images(sd, r.scan, r.frames)
        dp = os.path.join(r.dir, "depth_points.npy")
        pts = cols = None
        if os.path.exists(dp):
            D = np.load(dp)[:, :3].astype(float)
            pts = D[thin(D, 0.015)]
        L.write_colmap(sd, r.frames, r.intr, pts, cols)
        log(f"training the room's splat: {a.scene_steps} steps at half size ...")
        try:
            scene, secs = run_brush(sd, os.path.join(sd, "out"), a.scene_steps, max(r.intr["w"], r.intr["h"]) // 2, 1, 0)
            r.sum["scene"] = {"steps": a.scene_steps, "seconds": secs, "splat": scene, "gaussians": int(len(L.read_splat_ply(scene)["xyz"]))}
            log("scene:", r.sum["scene"])
        except SystemExit as e:
            log("the room's splat failed (the object's is unaffected):", e)


# ---------------------------------------------------------------- object
def stage_object(r):
    import open3d as o3d
    import scan_solid as SO
    a = r.a
    if not r.obj:
        raise SystemExit("this scan does not say where the object is: give --centre x,y,z (metres, the scan's right-handed frame)")
    os.makedirs(r.odir, exist_ok=True)
    sp = L.read_splat_ply(r.splat_path())
    seed, centre = np.array(r.obj["seed"], float), np.array(r.obj["centre"], float)
    hint = float(r.obj.get("radius", 0.15))
    given = r.sum.get("radius_given")
    max_radius = float(given) if given else float(np.clip(3 * hint + 0.15, 0.3, 0.9))
    info = {"seed": seed.round(4).tolist(), "search_radius_m": round(max_radius, 3)}
    # the surface it stands on
    y0, share = SO.support_plane(sp, centre, max_radius + 0.25)
    dp = os.path.join(r.dir, "depth_points.npy")
    y0_depth = None
    if os.path.exists(dp):
        D = np.load(dp)
        if D.shape[1] >= 6:
            y0_depth = SO.plane_from_depth(D[:, :3].astype(float), D[:, 3:6].astype(float), centre, max_radius + 0.25)
    info["support_y_splat"] = None if y0 is None else round(y0, 4)
    info["support_y_depth"] = None if y0_depth is None else round(y0_depth, 4)
    if a.no_plane:
        y0 = None
    elif y0 is None or share < 0.08:
        y0 = y0_depth
    info["support_y"] = None if y0 is None else round(y0, 4)
    # the object on it: the clump at the picked spot, clear of the surface's own roughness, and no further out than
    # one and a half times what the headset's depth said the object reaches
    ds = r.sum.get("dataset") or {}
    around = seed
    if not given and ds.get("object_found_by", "").startswith("the headset's depth") and ds.get("object_radius_m"):
        max_radius = min(max_radius, 1.5 * float(ds["object_radius_m"]) + 0.04)
        around = np.array(ds["object_centre"], float)
    lift = 0.012
    if y0 is not None:
        d = np.hypot(sp["xyz"][:, 0] - centre[0], sp["xyz"][:, 2] - centre[2])
        flat = (sp["opacity"] > 0.3) & (d < max_radius + 0.25) & (np.abs(sp["xyz"][:, 1] - y0) < 0.04)
        if flat.sum() > 200:
            lift = float(np.clip(4 * 1.4826 * np.median(np.abs(sp["xyz"][flat, 1] - np.median(sp["xyz"][flat, 1]))), 0.012, 0.04))
    info.update({"search_radius_m": round(max_radius, 3), "clear_of_surface_mm": round(lift * 1000, 1)})
    mask = SO.object_component(sp, seed, y0, max_radius, lift=lift, around=around)
    if mask.sum() < 200:
        raise SystemExit(f"only {int(mask.sum())} Gaussians at the picked spot: the splat did not form there (too few pictures of the object, "
                         "or it moved); scan again")
    p = sp["xyz"][mask]
    info["object_gaussians"] = int(mask.sum())
    cams = r.cameras()
    c = SO.carve(sp, mask, cams, y0, log=log, cells=a.cells, inset_px=a.inset_px)
    mesh, minfo = SO.field_to_mesh(c, seed=seed)
    SO.colour_mesh(mesh, sp, mask)
    closed = SO.is_closed(mesh)
    bb = mesh.get_axis_aligned_bounding_box()
    ext = np.asarray(bb.get_extent())
    info.update(minfo)
    info.update({"views_used": c["views"], "voxel_mm": round(c["voxel"] * 1000, 2), "closed": closed, "triangles": int(len(mesh.triangles)),
                 "size_cm": [round(float(ext[0]) * 100, 1), round(float(ext[1]) * 100, 1), round(float(ext[2]) * 100, 1)], "size_axes": "x, y (up), z",
                 "base_y": round(float(c["base"]), 4)})
    o3d.io.write_triangle_mesh(os.path.join(r.odir, "object_world.ply"), mesh)
    # the object's Gaussians for viewing: everything inside the solid's box above the surface, moved so the middle of
    # its base is the origin (y up)
    lo, hi = np.asarray(bb.get_min_bound()), np.asarray(bb.get_max_bound())
    pad = 0.01
    xyz = sp["xyz"]
    inbox = np.all(xyz > lo - pad, 1) & np.all(xyz < hi + pad, 1) & (xyz[:, 1] > c["base"] + 0.002) & (sp["scale"].max(1) < 0.5 * max(ext.max(), 0.05))
    # ... and of those only the ones on the solid (within a few millimetres of it): not the table's haze round its feet
    from scipy.ndimage import distance_transform_edt
    far = distance_transform_edt(~c["solid"]) * c["voxel"]
    idx = np.flatnonzero(inbox)
    ijk = np.floor((xyz[idx] - c["origin"]) / c["voxel"]).astype(int)
    ok = np.all(ijk >= 0, 1) & np.all(ijk < np.array(far.shape), 1)
    near_solid = np.zeros(len(idx), bool)
    near_solid[ok] = far[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]] < max(0.003, 2.5 * c["voxel"])
    inbox = np.zeros(len(xyz), bool); inbox[idx[near_solid]] = True
    origin = np.array([(lo[0] + hi[0]) / 2, c["base"], (lo[2] + hi[2]) / 2])
    raw = sp["raw"][inbox].copy()
    raw["x"] -= origin[0]; raw["y"] -= origin[1]; raw["z"] -= origin[2]
    L.write_splat_ply(os.path.join(r.odir, "object_splat.ply"), raw)
    info["object_splat_gaussians"] = int(inbox.sum())
    info["origin_world"] = origin.round(4).tolist()
    # how far the splat's surface is from the headset's own depth, at the depth points on the object
    if os.path.exists(dp):
        from scipy.spatial import cKDTree
        D = np.load(dp)[:, :3].astype(float)
        on = np.all(D > lo - 0.01, 1) & np.all(D < hi + 0.01, 1) & (D[:, 1] > c["base"] + 0.01)
        if on.sum() > 30:
            s = mesh.sample_points_uniformly(60000)
            dist, _ = cKDTree(np.asarray(s.points)).query(D[on])
            info["headset_depth_vs_solid_mm"] = {"points": int(on.sum()), "median": round(float(np.median(dist)) * 1000, 1), "p90": round(float(np.percentile(dist, 90)) * 1000, 1)}
    np.save(os.path.join(r.odir, "object_mask.npy"), mask)
    r.sum["object"] = info
    log("object:", info)
    if not closed:
        log("WARNING: the solid is not a closed surface; the slicer may refuse it")


# ---------------------------------------------------------------- print
def stage_print(r):
    import open3d as o3d
    a = r.a
    info_o = r.sum.get("object") or {}
    wp = os.path.join(r.odir, "object_world.ply")
    if not os.path.exists(wp):
        raise SystemExit("no solid yet: run the object stage")
    mesh = o3d.io.read_triangle_mesh(wp)
    v = np.asarray(mesh.vertices)
    origin = np.array(info_o["origin_world"])
    v = v - origin
    # the printer's frame: z up, standing on the bed; a turn, not a mirror
    vp = np.stack([v[:, 0], -v[:, 2], v[:, 1]], 1) * 1000.0
    vp[:, 2] -= vp[:, 2].min()
    ext = vp.max(0) - vp.min(0)
    out = {}

    def write(name, scale):
        m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(vp * scale), mesh.triangles)
        m.compute_triangle_normals(); m.compute_vertex_normals()
        path = os.path.join(r.odir, name)
        o3d.io.write_triangle_mesh(path, m)
        return path

    real = write(f"{r.name}_real_size.stl", 1.0)
    out["real_size_mm"] = [round(float(x), 1) for x in ext]
    scale = float(a.scale) if a.scale else (min(1.0, a.print_mm / float(ext.max())) if a.print_mm > 0 else 1.0)
    if a.print_mm > 0 and not a.scale and ext.max() < a.print_mm and a.enlarge:
        scale = a.print_mm / float(ext.max())
    stl = write(f"{r.name}_print.stl", scale) if abs(scale - 1.0) > 1e-6 else real
    out.update({"scale": round(scale, 4), "print_size_mm": [round(float(x) * scale, 1) for x in ext], "stl": stl, "real_size_stl": real})
    mesh.compute_vertex_normals()
    o3d.io.write_triangle_mesh(os.path.join(r.odir, f"{r.name}.glb"), o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v), mesh.triangles).paint_uniform_color([0.8, 0.8, 0.8])
                               if not mesh.has_vertex_colors() else _moved(mesh, v))
    if not a.no_slice:
        hd = os.path.join(r.odir, "h2c")
        shutil.rmtree(hd, ignore_errors=True)
        p = subprocess.run([sys.executable, "-I", os.path.join(HERE, "slice_h2c.py"), stl, "--out", hd, "--set", "enable_support=1",
                            "--set", "support_type=tree(auto)", "--set", "brim_type=auto_brim"], capture_output=True, text=True)
        line = [l for l in p.stdout.splitlines() if l.startswith("sliced ")]
        tmf = os.path.join(hd, "sliced.3mf")
        if p.returncode == 0 and os.path.exists(tmf):
            dst = os.path.join(r.odir, f"{r.name}_h2c.3mf")
            shutil.copy(tmf, dst)
            out["h2c_3mf"] = dst
            out["slice"] = line[0] if line else "sliced"
            with zipfile.ZipFile(tmf) as z:
                g = [n for n in z.namelist() if n.endswith(".gcode")]
                if g:
                    gp = os.path.join(r.odir, f"{r.name}.gcode")
                    open(gp, "wb").write(z.read(g[0]))
                    out["gcode"] = gp
        else:
            out["slice"] = "FAILED: " + (p.stdout.strip().splitlines() or p.stderr.strip().splitlines() or ["no output"])[-1]
    r.sum["print"] = out
    log("print:", out)


def _moved(mesh, v):
    import open3d as o3d
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v), mesh.triangles)
    m.vertex_colors = mesh.vertex_colors
    m.compute_vertex_normals()
    return m


# ---------------------------------------------------------------- render
def stage_render(r):
    import open3d as o3d
    from PIL import Image, ImageDraw
    import scan_solid as SO
    from splat_render import Camera, render, to_image
    rd = os.path.join(r.dir, "renders")
    os.makedirs(rd, exist_ok=True)
    sp = L.read_splat_ply(r.splat_path())
    info = {}
    mesh = None
    wp = os.path.join(r.odir, "object_world.ply")
    if os.path.exists(wp):
        mesh = o3d.io.read_triangle_mesh(wp); mesh.compute_vertex_normals()
    # four of the scan's own positions: photograph, splat, solid (the window of each picture the splat was trained on)
    cp = os.path.join(r.gs, "crops.json")
    if os.path.exists(cp):
        crops = json.load(open(cp))
        views = [(Camera(r.frames[c["index"]].R_cw(), r.frames[c["index"]].C, r.intr["fx"], r.intr["fy"], r.intr["cx"] - c["x0"], r.intr["cy"] - c["y0"], c["w"], c["h"]),
                  os.path.join(r.gs, "images", c["name"])) for c in crops]
    else:
        views = [(c, os.path.join(r.scan, f.name)) for c, f in zip(r.cameras(), r.frames)]
    pick = [int(i) for i in np.linspace(0, len(views) - 1, 6).round()[1:5]]
    tw = th = 400
    sheet = Image.new("RGB", (4 * tw, (3 if mesh is not None else 2) * th), "white")
    ps = []
    for k, i in enumerate(pick):
        cam0, path = views[i]
        s = min(tw / cam0.w, th / cam0.h)
        cam = cam0.scaled(s)
        img, _, _ = render(sp, cam, background=(0, 0, 0))
        photo = Image.open(path).convert("RGB").resize((cam.w, cam.h))
        ps.append(10 * np.log10(1.0 / max(np.mean((img - np.asarray(photo, float) / 255) ** 2), 1e-9)))
        ox, oy = k * tw + (tw - cam.w) // 2, (th - cam.h) // 2
        sheet.paste(photo, (ox, oy)); sheet.paste(to_image(img), (ox, th + oy))
        if mesh is not None:
            sheet.paste(to_image(SO.shade_mesh(mesh, cam)), (ox, 2 * th + oy))
    d = ImageDraw.Draw(sheet)
    for row, text in enumerate(["photograph (Quest camera)", "Gaussian splat, same position", "printable solid, same position"][:sheet.height // th]):
        d.rectangle([0, row * th, 250, row * th + 18], fill="black"); d.text((6, row * th + 3), text, fill="white")
    sheet.save(os.path.join(rd, "photo_splat_solid.jpg"), quality=88)
    info["sheet"] = os.path.join(rd, "photo_splat_solid.jpg")
    info["splat_vs_photo_psnr_db"] = round(float(np.mean(ps)), 2)
    # a turntable of the object's own Gaussians
    op = os.path.join(r.odir, "object_splat.ply")
    if os.path.exists(op):
        so = L.read_splat_ply(op)
        ext = so["xyz"].max(0) - so["xyz"].min(0)
        mid = (so["xyz"].max(0) + so["xyz"].min(0)) / 2
        R = float(np.linalg.norm(ext) / 2)
        size, n = 420, 24
        dist = 3.2 * R
        f = 0.44 * size * dist / R
        frames = []
        o_mesh = None
        if mesh is not None:
            o_mesh = _moved(mesh, np.asarray(mesh.vertices) - np.array(r.sum["object"]["origin_world"]))
        for k in range(n):
            az = 2 * np.pi * k / n
            eye = mid + dist * np.array([np.cos(az) * np.cos(0.42), np.sin(0.42), np.sin(az) * np.cos(0.42)])
            cam = Camera.look_at(eye, mid, (0, 1, 0), f, f, size / 2, size / 2, size, size)
            img, _, _ = render(so, cam, background=(1, 1, 1))
            if o_mesh is not None:
                img = np.concatenate([img, SO.shade_mesh(o_mesh, cam)], 1)
            frames.append(to_image(img))
        frames[0].save(os.path.join(rd, "turntable.gif"), save_all=True, append_images=frames[1:], duration=120, loop=0)
        strip = Image.new("RGB", (6 * frames[0].width // (2 if o_mesh is not None else 1), frames[0].height * (1 if o_mesh is None else 2)), "white")
        w1 = size
        for j, k in enumerate(range(0, n, n // 6)):
            if o_mesh is None:
                strip.paste(frames[k], (j * w1, 0))
            else:
                strip.paste(frames[k].crop((0, 0, w1, size)), (j * w1, 0)); strip.paste(frames[k].crop((w1, 0, 2 * w1, size)), (j * w1, size))
        strip.save(os.path.join(rd, "turntable.jpg"), quality=88)
        info["turntable"] = os.path.join(rd, "turntable.jpg")
        info["turntable_gif"] = os.path.join(rd, "turntable.gif")
    if not r.obj:
        # a view of the surroundings: look round from where the pictures were taken, in directions between theirs
        eye, yaw, pitch = view_point(r)
        w, h = 560, 420
        f = 0.5 * w / np.tan(np.radians(40))                    # 80 degrees across
        frames = []
        for a in np.linspace(yaw[0], yaw[1], 36):
            fwd = np.array([np.sin(a) * np.cos(pitch), np.sin(pitch), -np.cos(a) * np.cos(pitch)])
            cam = Camera.look_at(eye, eye + fwd, (0, 1, 0), f, f, w / 2, h / 2, w, h)
            img, _, _ = render(sp, cam, background=(0, 0, 0))
            frames.append(to_image(img))
        frames[0].save(os.path.join(rd, "look_around.gif"), save_all=True, append_images=frames[1:] + frames[-2:0:-1], duration=110, loop=0)
        strip = Image.new("RGB", (4 * w, 2 * h), "black")
        for j, k in enumerate(np.linspace(0, len(frames) - 1, 8).round().astype(int)):
            strip.paste(frames[k], ((j % 4) * w, (j // 4) * h))
        strip.save(os.path.join(rd, "look_around.jpg"), quality=88)
        info["look_around"] = os.path.join(rd, "look_around.jpg")
        info["look_around_gif"] = os.path.join(rd, "look_around.gif")
    r.sum["render"] = info
    log("render:", info)


def view_point(r):
    """For a view of the surroundings: where the pictures were taken from (the middle of the camera positions), the
    span of directions they looked in (yaw from, to; radians, 0 = towards -z, growing to the right) and their
    usual tilt."""
    C = np.array([f.C for f in r.frames]); F = np.array([f.fwd for f in r.frames])
    eye = np.median(C, 0)
    yaw = np.arctan2(F[:, 0], -F[:, 2])
    # the span: the smallest arc that holds every direction (cut the circle at its widest gap)
    s = np.sort(yaw)
    gaps = np.diff(np.concatenate([s, [s[0] + 2 * np.pi]]))
    k = int(np.argmax(gaps))
    lo = s[(k + 1) % len(s)]
    hi = lo + (2 * np.pi - gaps[k])
    return eye, (float(lo), float(hi)), float(np.median(np.arcsin(np.clip(F[:, 1], -1, 1))))


# ---------------------------------------------------------------- web
def stage_web(r):
    """The files the viewer loads (scan_view.py serves this folder as /data/)."""
    wd = os.path.join(r.dir, "web")
    os.makedirs(wd, exist_ok=True)
    o, pr = r.sum.get("object") or {}, r.sum.get("print") or {}
    files = {}
    for src, name in ((os.path.join(r.odir, "object_splat.ply"), "object.ply"), (os.path.join(r.odir, f"{r.name}.glb"), "object.glb"),
                      (pr.get("real_size_stl"), "object_real_size.stl"), (pr.get("stl"), "object_print.stl"), (pr.get("h2c_3mf"), "object_h2c.3mf"),
                      (os.path.join(r.dir, "renders", "photo_splat_solid.jpg"), "photo_splat_solid.jpg")):
        if src and os.path.exists(src):
            shutil.copyfile(src, os.path.join(wd, name)); files[name] = os.path.getsize(src)
    # the room round the object: the scene's Gaussians within reach, the most solid ones first
    scene = (r.sum.get("scene") or {}).get("splat")
    if scene and os.path.exists(scene):
        sp = L.read_splat_ply(scene)
        origin = np.array(o.get("origin_world", np.median(sp["xyz"], 0)))
        d = np.linalg.norm(sp["xyz"] - origin, axis=1)
        m = np.flatnonzero((d < 3.0) & (sp["opacity"] > 0.05))
        if len(m) > 300000:
            m = m[np.argsort(-sp["opacity"][m])[:300000]]
        raw = sp["raw"][m].copy()
        raw["x"] -= origin[0]; raw["y"] -= origin[1]; raw["z"] -= origin[2]
        L.write_splat_ply(os.path.join(wd, "scene.ply"), raw)
        files["scene.ply"] = os.path.getsize(os.path.join(wd, "scene.ply"))
    elif os.path.exists(os.path.join(wd, "scene.ply")):
        os.remove(os.path.join(wd, "scene.ply"))
    meta = {"name": r.name, "size_cm": o.get("size_cm"), "print": {k: pr.get(k) for k in ("scale", "print_size_mm", "real_size_mm", "slice")},
            "pictures": len(r.frames), "train": {k: (r.sum.get("train") or {}).get(k) for k in ("steps", "seconds", "gaussians", "held_out_psnr_db")},
            "files": files, "made": time.strftime("%Y-%m-%d %H:%M")}
    if not r.obj:
        # no single object: the splat of everything that was looked at, to be seen from where it was photographed.
        # Moved sideways so that spot is the origin; heights stay as the headset had them (0 = its floor).
        sp = L.read_splat_ply(r.splat_path())
        eye, yaw, pitch = view_point(r)
        m = np.flatnonzero(sp["opacity"] > 0.03)
        if len(m) > 400000:
            m = m[np.argsort(-sp["opacity"][m])[:400000]]
        raw = sp["raw"][m].copy()
        raw["x"] -= eye[0]; raw["z"] -= eye[2]
        L.write_splat_ply(os.path.join(wd, "view.ply"), raw)
        files["view.ply"] = os.path.getsize(os.path.join(wd, "view.ply"))
        mid = 0.5 * (yaw[0] + yaw[1])
        # the surface model and the diorama made from it, when scan_room_model.py has run
        rm = r.sum.get("room_model") or {}
        for src, name in ((os.path.join(r.dir, "room", "room_model.glb"), "room.glb"), (os.path.join(r.dir, "room", "room_diorama.stl"), "room_diorama.stl"),
                          (os.path.join(r.dir, "room", "room_diorama_h2c.3mf"), "room_diorama_h2c.3mf")):
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(wd, name)); files[name] = os.path.getsize(src)
        meta.update({"mode": "view", "eye_height_m": round(float(eye[1]), 3), "look_yaw_rad": round(mid, 4), "look_pitch_rad": round(pitch, 4),
                     "yaw_span_rad": [round(yaw[0], 4), round(yaw[1], 4)], "files": files,
                     "room": {"size_m": rm.get("size_m"), "open_above_m": round(float(rm.get("floor_y_m", 0.0)) + 2.25, 3),
                              "print": {k: (rm.get("print") or {}).get(k) for k in ("scale", "size_mm", "slice")}} if rm else None})
        for stale in ("object.ply", "object.glb"):
            if os.path.exists(os.path.join(wd, stale)):
                os.remove(os.path.join(wd, stale))
    json.dump(meta, open(os.path.join(wd, "meta.json"), "w"), indent=1)
    r.sum["web"] = {"folder": wd, "files": files}
    log("web:", files)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scan", help="a scan folder on this computer (frames.csv, camera.json, pictures)")
    ap.add_argument("--run", help="an existing run folder under Downloads\\quest_scans (to redo stages)")
    ap.add_argument("--name", help="name of the run folder for --scan")
    ap.add_argument("--object", help="which object on the headset (default: the newest with a scan)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--from", dest="start", choices=STAGES, default="check")
    ap.add_argument("--only", choices=STAGES)
    ap.add_argument("--steps", type=int, default=8000)
    ap.add_argument("--sh-degree", type=int, default=2)
    ap.add_argument("--eval-every", type=int, default=10, help="every Nth picture is kept back from training to test the splat")
    ap.add_argument("--max-splats", type=int, default=0)
    ap.add_argument("--growth", type=float, default=None, help="the trainer's growth threshold (lower = more Gaussians; its default is 0.00004)")
    ap.add_argument("--scene-steps", type=int, default=2000, help="steps for the quick splat of the room round the object (0 = none)")
    ap.add_argument("--first", type=int); ap.add_argument("--last", type=int); ap.add_argument("--stride", type=int)
    ap.add_argument("--points", help="starting points (.ply) for a scan without depth")
    ap.add_argument("--centre", help="x,y,z of the object in the scan's right-handed frame, when the scan does not say")
    ap.add_argument("--radius", type=float, help="how far from the centre the object may reach, metres")
    ap.add_argument("--view", action="store_true", help="a view of the surroundings, even if an object was walked round")
    ap.add_argument("--solid", action="store_true", help="make the solid of the picked object even if it was not walked round")
    ap.add_argument("--no-plane", action="store_true", help="the object does not stand on a level surface")
    ap.add_argument("--cells", type=int, default=176, help="voxels along the object's longest side")
    ap.add_argument("--inset-px", type=float, default=2.0, help="how many picture pixels the splat's surface sits inside the real one (see scan_solid.carve)")
    ap.add_argument("--print-mm", type=float, default=120.0, help="longest side of the print; 0 = real size. Objects smaller than this print at real size")
    ap.add_argument("--enlarge", action="store_true", help="scale small objects up to --print-mm as well")
    ap.add_argument("--scale", type=float, help="print scale, overriding --print-mm")
    ap.add_argument("--no-slice", action="store_true")
    a = ap.parse_args()
    r = Run(a)
    todo = [a.only] if a.only else STAGES[STAGES.index(a.start):]
    t0 = time.time()
    for st in todo:
        if st in ("object", "print") and not r.obj and not a.only:
            continue                        # a view of the surroundings: there is no one object to make solid
        globals()["stage_" + st](r)
        r.save()
    log(f"done in {time.time() - t0:.0f} s: {r.dir}")


if __name__ == "__main__":
    main()

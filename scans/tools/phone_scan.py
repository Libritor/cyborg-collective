#!/usr/bin/env python3
"""A phone's scan (a ROS 2 bag from MuseLog's "Scan in 3-D") -> a Gaussian splat the site's viewer opens.

The phone sends pictures, its own motion and, if a headband was on, brain waves, as one .mcap. It
does not know where it was when each picture was taken (no depth sensor, no tracking), so that is
worked out here from the pictures themselves:

  1 pictures   taken out of the bag, turned upright as the phone meant them
  2 placing    structure from motion (COLMAP, through pycolmap): where each picture was taken from
  3 frame      "up" from how the phone was held; for a head, the point the pictures all look at
               becomes the middle; for a place, one picture's spot becomes where the viewer stands.
               SIZE IS A GUESS: pictures alone carry no scale (see ARM_M and STEP_M below)
  4 training   Brush, the same trainer the headset scans use
  5 web        the files the viewer loads (web\\), and the pictures of the splat shown with it (renders\\)

  python phone_scan.py <bag folder or .mcap> [--kind head|world] [--name NAME] [--steps 7000]
  python phone_scan.py --pictures <folder of .jpg> --kind head --name NAME       (pictures from anywhere)

Results: Downloads\\phone_scans\\<name>\\. Publish with scan_publish.py <run> --kind phone.
Needs the anaconda python (pycolmap, rosbags, mcap, numba, Pillow) and Brush.
"""
import argparse
import json
import math
import os
import shutil
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan_lib as L                                                    # noqa: E402

OUT_ROOT = os.path.join(os.path.expanduser("~"), "Downloads", "phone_scans")
IMAGE_TOPIC = "/phone/camera/image/compressed"
ARM_M = 0.6      # a head scan: how far from the head the phone is taken to have been (an arm's length)
STEP_M = 0.3     # a place: how far apart two pictures in a row are taken to be (a slow walk)
EYE_M = 1.5      # a place: the height the viewer stands at
HEAD_REACH = 0.30  # a head scan: what lies within this of the middle (after ARM_M) is "the head"
MIN_PLACED = 10


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


class Unusable(Exception):
    """The scan cannot be made into a splat; the message is for the person who sent it."""


# ------------------------------------------------------------------ 1 pictures

def read_bag(bag, images):
    """Write the bag's pictures to `images` as frame_00000.jpg ..., upright. -> what the bag held."""
    from io import BytesIO
    from mcap.reader import make_reader
    from PIL import Image, ImageOps
    from rosbags.typesys import Stores, get_typestore
    path = bag
    if os.path.isdir(bag):
        files = sorted(f for f in os.listdir(bag) if f.endswith(".mcap"))
        if not files:
            raise Unusable("the recording holds no .mcap file")
        path = os.path.join(bag, files[0])
    store = get_typestore(Stores.ROS2_HUMBLE)
    os.makedirs(images, exist_ok=True)
    held = {"pictures": 0, "imu": 0, "eeg": 0, "info": {}, "sizes": {}, "turned": 0}
    t0 = t1 = None
    with open(path, "rb") as fh:
        for schema, channel, message in make_reader(fh).iter_messages():
            t0 = message.log_time if t0 is None else min(t0, message.log_time)
            t1 = message.log_time if t1 is None else max(t1, message.log_time)
            if channel.topic == IMAGE_TOPIC:
                msg = store.deserialize_cdr(message.data, "sensor_msgs/msg/CompressedImage")
                raw = bytes(msg.data)
                try:
                    im = Image.open(BytesIO(raw))
                    im.load()
                except Exception:  # noqa: BLE001  a picture that does not open is left out
                    continue
                up = ImageOps.exif_transpose(im)
                out = os.path.join(images, f"frame_{held['pictures']:05d}.jpg")
                if up is im or up.size == im.size and im.getexif().get(0x0112, 1) in (1, None):
                    with open(out, "wb") as o:
                        o.write(raw)                      # already upright: the phone's own bytes
                else:
                    up.convert("RGB").save(out, "JPEG", quality=95)
                    held["turned"] += 1
                key = f"{up.size[0]}x{up.size[1]}"
                held["sizes"][key] = held["sizes"].get(key, 0) + 1
                held["pictures"] += 1
            elif channel.topic == "/phone/imu":
                held["imu"] += 1
            elif channel.topic == "/muse/eeg":
                held["eeg"] += 1
            elif channel.topic == "/scan/info":
                try:
                    held["info"] = json.loads(store.deserialize_cdr(message.data, "std_msgs/msg/String").data)
                except Exception:  # noqa: BLE001
                    pass
    held["seconds"] = round((t1 - t0) / 1e9, 1) if t0 is not None else 0
    return held


def copy_pictures(folder, images):
    from PIL import Image, ImageOps
    os.makedirs(images, exist_ok=True)
    names = sorted(f for f in os.listdir(folder) if f.lower().endswith((".jpg", ".jpeg")))
    sizes = {}
    for i, n in enumerate(names):
        im = ImageOps.exif_transpose(Image.open(os.path.join(folder, n)))
        im.convert("RGB").save(os.path.join(images, f"frame_{i:05d}.jpg"), "JPEG", quality=95)
        key = f"{im.size[0]}x{im.size[1]}"
        sizes[key] = sizes.get(key, 0) + 1
    return {"pictures": len(names), "imu": 0, "eeg": 0, "info": {}, "sizes": sizes, "turned": 0, "seconds": 0}


# ------------------------------------------------------------------ 2 placing

def place(images, work, n, one_size):
    """Structure from motion. -> the largest model (pycolmap.Reconstruction)."""
    import pycolmap
    db = os.path.join(work, "database.db")
    sparse = os.path.join(work, "sparse_raw")
    for p in (db,):
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(sparse, ignore_errors=True)
    os.makedirs(sparse)
    t = time.time()
    ro = pycolmap.ImageReaderOptions()
    # a phone's JPEG has had its lens distortion taken out by the phone: a plain pinhole fits it,
    # and a plain pinhole is what the trainer wants
    ro.camera_model = "PINHOLE"
    eo = pycolmap.FeatureExtractionOptions()
    eo.max_image_size = 1600
    eo.use_gpu = False
    eo.num_threads = 8
    eo.sift.max_num_features = 5000
    pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.SINGLE if one_size else pycolmap.CameraMode.PER_IMAGE,
                              reader_options=ro, extraction_options=eo, device=pycolmap.Device.cpu)
    mo = pycolmap.FeatureMatchingOptions()
    mo.use_gpu = False
    mo.num_threads = 8
    if n <= 100:
        # few enough to compare every picture with every other: the last pictures of a walk round a
        # head show what the first ones did, and only this finds that
        pycolmap.match_exhaustive(db, matching_options=mo, device=pycolmap.Device.cpu)
        how = "every pair"
    else:
        po = pycolmap.SequentialPairingOptions()
        po.overlap = 15
        po.quadratic_overlap = True
        po.loop_detection = False
        pycolmap.match_sequential(db, matching_options=mo, pairing_options=po, device=pycolmap.Device.cpu)
        how = "neighbours in time"
    log(f"features and matches ({how}) in {time.time() - t:.0f} s")
    t = time.time()
    opts = pycolmap.IncrementalPipelineOptions()
    opts.min_model_size = MIN_PLACED
    maps = pycolmap.incremental_mapping(db, images, sparse, options=opts)
    if not maps:
        raise Unusable("the pictures could not be placed: they share too little (too few, too blurred, or of something that moved)")
    rec = max(maps.values(), key=lambda r: r.num_reg_images())
    log(f"placed {rec.num_reg_images()} of {n} pictures, {rec.num_points3D()} points, "
        f"{rec.compute_mean_reprojection_error():.2f} px, in {time.time() - t:.0f} s ({len(maps)} model(s))")
    return rec


def poses(rec):
    """-> names, centres [n,3], forward [n,3], up [n,3] of the placed pictures, in the order of their names."""
    rows = []
    for im in rec.images.values():
        if not im.has_pose:
            continue
        cfw = im.cam_from_world()
        R = np.asarray(cfw.rotation.matrix())
        C = -R.T @ np.asarray(cfw.translation)
        rows.append((im.name, C, R.T @ np.array([0.0, 0.0, 1.0]), -(R.T @ np.array([0.0, 1.0, 0.0]))))
    rows.sort(key=lambda r: r[0])
    return [r[0] for r in rows], np.array([r[1] for r in rows]), np.array([r[2] for r in rows]), np.array([r[3] for r in rows])


# ------------------------------------------------------------------ 3 frame

def looked_at(C, D):
    """The point nearest to every picture's line of sight (least squares)."""
    A = np.zeros((3, 3))
    b = np.zeros(3)
    for c, d in zip(C, D):
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ c
    return np.linalg.solve(A + 1e-9 * np.eye(3), b)


def frame_for(kind, C, D, U):
    """The similarity (scale s, rotation R, shift t: x' = s R x + t) into the viewer's frame
    (metres, y up), and what the viewer needs to know about it."""
    up = U.mean(0)
    up /= np.linalg.norm(up)
    if kind == "head":
        p = looked_at(C, D)
        dist = np.linalg.norm(C - p, axis=1)
        radius = float(np.median(dist))
        s = ARM_M / radius
        z = C[0] - p
        z -= up * (z @ up)
        z /= np.linalg.norm(z)
        x = np.cross(up, z)
        R = np.stack([x, up, z], 0)
        middle = np.array([0.0, HEAD_REACH, 0.0])          # the middle sits one reach above the turntable
        t = middle - s * R @ p
        # how far round the pictures go, seen from above
        ang = np.unwrap(np.arctan2((C - p) @ x, (C - p) @ z))
        info = {"round_deg": round(float(np.degrees(ang.max() - ang.min())), 0),
                "distance_spread": round(float(np.std(dist) / radius), 3),
                "assumed": f"the phone was taken to be {ARM_M} m from the head"}
        return s, R, t, info
    centroid = C.mean(0)
    eye = int(np.argmin(np.linalg.norm(C - centroid, axis=1)))
    steps = np.linalg.norm(np.diff(C, axis=0), axis=1)
    s = STEP_M / max(float(np.median(steps)), 1e-9)
    f = D[eye] - up * (D[eye] @ up)
    f /= np.linalg.norm(f)
    z = -f                                                  # the viewer looks along -z
    x = np.cross(up, z)
    R = np.stack([x, up, z], 0)
    t = np.array([0.0, EYE_M, 0.0]) - s * R @ C[eye]
    fwd = R @ D[eye]
    yaws = np.arctan2((D @ R.T)[:, 0], -(D @ R.T)[:, 2])
    info = {"eye_picture": eye, "look_yaw_rad": round(float(math.atan2(fwd[0], -fwd[2])), 4),
            "look_pitch_rad": round(float(math.asin(max(-1.0, min(1.0, fwd[1])))), 4),
            "yaw_span_rad": [round(float(yaws.min()), 4), round(float(yaws.max()), 4)],
            "path_m": round(float(steps.sum() * s), 1),
            "assumed": f"two pictures in a row were taken to be {STEP_M} m apart, and the viewer to stand {EYE_M} m high"}
    return s, R, t, info


# ------------------------------------------------------------------ 5 web and pictures of the splat

def row_of(pictures, cols, gap=6, back=(255, 255, 255)):
    from PIL import Image
    w, h = pictures[0].size
    rows = (len(pictures) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap), back)
    for i, p in enumerate(pictures):
        sheet.paste(p, ((i % cols) * (w + gap), (i // cols) * (h + gap)))
    return sheet


def pictures_of(splat, kind, info, out):
    import splat_render as SR
    os.makedirs(os.path.dirname(out), exist_ok=True)
    shots = []
    if kind == "head":
        mid = np.array([0.0, info.get("middle_height_m", HEAD_REACH), 0.0])
        w = h = 420
        f = 1.15 * w
        for k in range(6):
            a = 2 * math.pi * k / 6
            eye = mid + 2.6 * HEAD_REACH * np.array([math.sin(a) * math.cos(0.2), math.sin(0.2), math.cos(a) * math.cos(0.2)])
            cam = SR.Camera.look_at(eye, mid, (0, 1, 0), f, f, w / 2, h / 2, w, h)
            img, _, _ = SR.render(splat, cam, background=(1.0, 1.0, 1.0))
            shots.append(SR.to_image(img))
        row_of(shots, 6).save(out, quality=90)
    else:
        eye = np.array([0.0, EYE_M, 0.0])
        w, h = 400, 300
        f = 0.5 * w / math.tan(math.radians(35))
        for k in range(8):
            a = info["look_yaw_rad"] + 2 * math.pi * k / 8
            fwd = np.array([math.sin(a), 0.0, -math.cos(a)])
            cam = SR.Camera.look_at(eye, eye + fwd, (0, 1, 0), f, f, w / 2, h / 2, w, h)
            img, _, _ = SR.render(splat, cam, background=(0.07, 0.08, 0.1))
            shots.append(SR.to_image(img))
        row_of(shots, 4, back=(18, 20, 26)).save(out, quality=90)
    return out


def run(source, kind=None, name=None, steps=7000, pictures=None, title=None, keep_pictures=True):
    """The whole chain. -> the run folder. Raises Unusable with a sentence for the sender."""
    import quest_scan as QS
    name = name or os.path.splitext(os.path.basename(os.path.normpath(source or pictures)))[0]
    run_dir = os.path.join(OUT_ROOT, name)
    work = os.path.join(run_dir, "work")
    data = os.path.join(run_dir, "gs")
    images = os.path.join(data, "images")
    for d in (work, data, os.path.join(run_dir, "web"), os.path.join(run_dir, "renders")):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(work)
    summary = {"name": name, "source": "phone", "started": time.strftime("%Y-%m-%d %H:%M")}

    held = copy_pictures(pictures, images) if pictures else read_bag(source, images)
    kind = kind or held["info"].get("kind") or "world"
    if kind not in ("head", "world"):
        kind = "world"
    title = title or held["info"].get("title")
    n = held["pictures"]
    log(f"{name}: {kind}, {n} pictures {held['sizes']}, {held['imu']} motion and {held['eeg']} EEG messages, {held['seconds']} s")
    summary.update({"kind": kind, "bag": {k: held[k] for k in ("pictures", "imu", "eeg", "seconds", "sizes", "turned")},
                    "said": held["info"]})
    if n < 12:
        raise Unusable(f"{n} pictures are too few to make a model of")

    rec = place(images, work, n, len(held["sizes"]) == 1)
    placed = rec.num_reg_images()
    if placed < MIN_PLACED:
        raise Unusable(f"only {placed} of {n} pictures could be placed")
    names, C, D, U = poses(rec)
    s, R, t, info = frame_for(kind, C, D, U)
    import pycolmap
    rec.transform(pycolmap.Sim3d(float(s), pycolmap.Rotation3d(R), t))
    sparse = os.path.join(data, "sparse", "0")
    os.makedirs(sparse)
    rec.write(sparse)
    # pictures that were not placed take no part in the training
    for f in os.listdir(images):
        if f not in set(names):
            os.remove(os.path.join(images, f))
    cam = next(iter(rec.cameras.values()))
    summary["placing"] = {"pictures": n, "placed": placed, "points": rec.num_points3D(),
                          "reprojection_px": round(float(rec.compute_mean_reprojection_error()), 2),
                          "camera": {"model": str(cam.model).split(".")[-1], "w": cam.width, "h": cam.height,
                                     "params": [round(float(v), 2) for v in cam.params]}}
    summary["frame"] = info
    log("frame:", info)

    out = os.path.join(data, "out")
    log(f"training: {steps} steps on {placed} pictures ...")
    ply, secs = QS.run_brush(data, out, steps, max(cam.width, cam.height), 2, 10)
    sp = L.read_splat_ply(ply)
    train = {"steps": steps, "seconds": secs, "gaussians": int(len(sp["xyz"])), "splat_mb": round(os.path.getsize(ply) / 1e6, 1)}
    psnr = held_out(out, images)
    if psnr:
        train.update(psnr)
    summary["train"] = train
    log("train:", train)

    web = os.path.join(run_dir, "web")
    os.makedirs(web)
    files = {}
    meta = {"name": name, "source": "phone", "made": time.strftime("%Y-%m-%d %H:%M"), "pictures": placed,
            "train": {k: train.get(k) for k in ("steps", "seconds", "gaussians", "held_out_psnr_db")},
            "placing": summary["placing"], "bag": summary["bag"], "assumed": info["assumed"]}
    if title:
        meta["title_given"] = str(title)[:60]
    if kind == "head":
        mid = np.array([0.0, HEAD_REACH, 0.0])
        d = np.linalg.norm(sp["xyz"] - mid, axis=1)
        big = sp["scale"].max(1)
        inside = (d < HEAD_REACH) & (sp["opacity"] > 0.05) & (big < 0.5 * HEAD_REACH)
        if inside.sum() < 500:
            raise Unusable("the splat holds almost nothing where the pictures were looking")
        # stand what was cut out on the viewer's turntable: moving Gaussians straight down changes nothing else of them
        drop = float(np.percentile(sp["xyz"][inside, 1], 1))
        raw = sp["raw"].copy()
        raw["y"] -= drop
        info["middle_height_m"] = round(HEAD_REACH - drop, 3)
        L.write_splat_ply(os.path.join(web, "object.ply"), raw[inside])
        rest = np.flatnonzero(~inside & (d < 3.0) & (sp["opacity"] > 0.05))
        if len(rest) > 300000:
            rest = rest[np.argsort(-sp["opacity"][rest])[:300000]]
        if len(rest):
            L.write_splat_ply(os.path.join(web, "scene.ply"), raw[rest])
        size = round(2 * HEAD_REACH * 100, 1)
        meta.update({"size_cm": [size, size, size], "size_note": "the size shown is a guess: pictures alone carry no scale",
                     "round_deg": info["round_deg"]})
        shown = L.read_splat_ply(os.path.join(web, "object.ply"))
        pictures_of(shown, "head", info, os.path.join(run_dir, "renders", "turntable.jpg"))
        meta["train"]["gaussians"] = int(inside.sum())
    else:
        keep = np.flatnonzero(sp["opacity"] > 0.03)
        if len(keep) > 400000:
            keep = keep[np.argsort(-sp["opacity"][keep])[:400000]]
        L.write_splat_ply(os.path.join(web, "view.ply"), sp["raw"][keep])
        meta.update({"mode": "view", "eye_height_m": EYE_M, "look_yaw_rad": info["look_yaw_rad"],
                     "look_pitch_rad": info["look_pitch_rad"], "yaw_span_rad": info["yaw_span_rad"]})
        shown = L.read_splat_ply(os.path.join(web, "view.ply"))
        pictures_of(shown, "world", info, os.path.join(run_dir, "renders", "look_around.jpg"))
        meta["train"]["gaussians"] = int(len(keep))
    for f in os.listdir(web):
        files[f] = os.path.getsize(os.path.join(web, f))
    meta["files"] = files
    with open(os.path.join(web, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    summary["web"] = files
    summary["shown_gaussians"] = meta["train"]["gaussians"]
    summary["finished"] = time.strftime("%Y-%m-%d %H:%M")
    with open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)
    shutil.rmtree(work, ignore_errors=True)
    if not keep_pictures:
        # the splat is made: the camera's own pictures are not kept (nor the trainer's copies of them)
        shutil.rmtree(images, ignore_errors=True)
        for d in os.listdir(out):
            if d.startswith("eval_"):
                shutil.rmtree(os.path.join(out, d), ignore_errors=True)
    log(f"done: {run_dir}")
    return run_dir, summary


def held_out(out, images):
    """How well the splat reproduces the pictures kept back from training."""
    from PIL import Image
    ev = sorted(d for d in os.listdir(out) if d.startswith("eval_"))
    if not ev:
        return None
    ps = []
    ed = os.path.join(out, ev[-1])
    for nm in sorted(os.listdir(ed)):
        stem = os.path.splitext(nm)[0]
        ph = next((os.path.join(images, stem + e) for e in (".png", ".jpg") if os.path.exists(os.path.join(images, stem + e))), None)
        if not ph:
            continue
        x = Image.open(os.path.join(ed, nm)).convert("RGB")
        y = Image.open(ph).convert("RGB").resize(x.size)
        mse = np.mean((np.asarray(x, float) - np.asarray(y, float)) ** 2)
        ps.append(10 * np.log10(255 ** 2 / max(mse, 1e-9)))
    if not ps:
        return None
    return {"held_out_pictures": len(ps), "held_out_psnr_db": round(float(np.mean(ps)), 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bag", nargs="?", help="a bag folder, or its .mcap file")
    ap.add_argument("--pictures", help="a folder of .jpg pictures instead of a bag")
    ap.add_argument("--kind", choices=("head", "world"), help="default: what the bag says")
    ap.add_argument("--name")
    ap.add_argument("--title")
    ap.add_argument("--steps", type=int, default=7000)
    ap.add_argument("--drop-pictures", action="store_true", help="delete the camera's pictures once the splat is made")
    a = ap.parse_args()
    if not a.bag and not a.pictures:
        ap.error("a bag or --pictures is needed")
    try:
        run(a.bag, a.kind, a.name, a.steps, a.pictures, a.title, keep_pictures=not a.drop_pictures)
    except Unusable as e:
        raise SystemExit(f"no splat: {e}")


if __name__ == "__main__":
    main()

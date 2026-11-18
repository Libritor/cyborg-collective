#!/usr/bin/env python3
"""Shared pieces of the Quest object scan (quest_scan.py): reading a scan folder, the camera model, the
COLMAP dataset a splat trainer reads, and Gaussian-splat .ply files.

A scan folder is what the Print What I See app writes in scan mode (and, without depth, what Room Walk writes):
  camera.json     the passthrough camera: image size, Meta's sensor intrinsics, lens offset
  frames.csv      one row per picture: file, cam_px..cam_qw = the camera pose in Unity world (left-handed, y up)
  k0000.jpg ...   the pictures (Room Walk: f000000.jpg ...)
  k0000.depth ... float32 rows of 8: u, v (viewport, v up), x, y, z (Unity world, metres), nx, ny, nz: where a ray
                  through that spot of the picture met the headset's depth
  scan.json       the object: seed point, centre, radius (Unity world)

Everything here works in a right-handed world: Unity's with z negated (y still up, metres).
"""
import csv
import json
import os
import struct

import numpy as np

S = np.diag([1.0, 1.0, -1.0])            # Unity (left-handed) -> right-handed: negate z
SH_C0 = 0.28209479177387814              # the constant spherical harmonic: colour = 0.5 + SH_C0 * f_dc


def quat_to_mat(x, y, z, w):
    n = np.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_to_quat_wxyz(R):
    """Rotation matrix -> unit quaternion (w, x, y, z), w >= 0."""
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = np.array([0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s])
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q = np.array([(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s])
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q = np.array([(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s])
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q = np.array([(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s])
    q /= np.linalg.norm(q)
    return q if q[0] >= 0 else -q


def pca_intrinsics(cam):
    """Meta's sensor intrinsics mapped to the delivered picture, the way PassthroughCameraAccess does it: the sensor
    is scaled by the larger axis ratio and cropped centrally to the picture's aspect. Pixel (0, 0) = top left."""
    sw, sh = cam["sensorResolution"]["x"], cam["sensorResolution"]["y"]
    w, h = cam["width"], cam["height"]
    sx, sy = w / sw, h / sh
    m = max(sx, sy)
    crop_x, crop_y = sw * (1 - sx / m) / 2, sh * (1 - sy / m) / 2
    return {"w": int(w), "h": int(h), "fx": cam["focalLength"]["x"] * m, "fy": cam["focalLength"]["y"] * m,
            "cx": (cam["principalPoint"]["x"] - crop_x) * m, "cy": (cam["principalPoint"]["y"] - crop_y) * m}


class Frame:
    """One picture: where the camera was (C) and its axes in the world (right, up, fwd), all right-handed."""
    __slots__ = ("name", "index", "t", "C", "right", "up", "fwd", "depth_file")

    def R_cw(self):
        """World -> camera rotation in COLMAP's camera frame (x right, y down, z forward)."""
        return np.stack([self.right, -self.up, self.fwd], 0)

    def t_cw(self):
        return -self.R_cw() @ self.C


def load_scan(folder, first=None, last=None, stride=1):
    """-> (frames, intrinsics, object dict or None). Frames whose picture is missing are left out."""
    folder = os.path.normpath(folder)
    cam = json.load(open(os.path.join(folder, "camera.json")))
    frames = []
    for i, r in enumerate(csv.DictReader(open(os.path.join(folder, "frames.csv")))):
        if not os.path.exists(os.path.join(folder, r["file"])):
            continue
        if (first is not None and i < first) or (last is not None and i >= last):
            continue
        R_u = quat_to_mat(float(r["cam_qx"]), float(r["cam_qy"]), float(r["cam_qz"]), float(r["cam_qw"]))
        f = Frame()
        f.name, f.index, f.t = r["file"], i, float(r.get("t_app_s") or 0)
        f.C = S @ np.array([float(r["cam_px"]), float(r["cam_py"]), float(r["cam_pz"])])
        f.right, f.up, f.fwd = S @ R_u[:, 0], S @ R_u[:, 1], S @ R_u[:, 2]
        d = os.path.join(folder, os.path.splitext(r["file"])[0] + ".depth")
        f.depth_file = d if os.path.exists(d) else None
        frames.append(f)
    frames = frames[::max(1, stride)]
    obj = None
    p = os.path.join(folder, "scan.json")
    if os.path.exists(p):
        obj = json.load(open(p))
        for o in [obj] + list(obj.get("picks") or []):
            for k in ("seed", "centre"):
                if o.get(k) is not None:
                    o[k] = (S @ np.array(o[k], float)).tolist()
    return frames, pca_intrinsics(cam), obj


def seen_from(frames, intr, centre, reach=2.5):
    """How a point was photographed: (number of pictures that have it in view from within `reach` metres, how many
    degrees of the circle round it those pictures were taken from, counted in 10-degree steps)."""
    centre = np.asarray(centre, float)
    n, bins = 0, set()
    for f in frames:
        x, y, z = project(f, intr, centre[None])
        if z[0] > 0.15 and 0 <= x[0] < intr["w"] and 0 <= y[0] < intr["h"] and np.linalg.norm(f.C - centre) < reach:
            n += 1
            bins.add(int((np.degrees(np.arctan2(f.C[2] - centre[2], f.C[0] - centre[0])) + 180) // 10) % 36)
    return n, 10 * len(bins)


def load_depth(frame):
    """The frame's depth rays -> (uv [n, 2] in pixels of the picture, top-left origin, needs the picture size
    applied by the caller: here still viewport 0..1 with v up), points [n, 3] right-handed, normals [n, 3])."""
    if not frame.depth_file:
        return np.zeros((0, 2)), np.zeros((0, 3)), np.zeros((0, 3))
    a = np.fromfile(frame.depth_file, dtype="<f4")
    a = a[:len(a) // 8 * 8].reshape(-1, 8).astype(np.float64)
    return a[:, 0:2], a[:, 2:5] @ S.T, a[:, 5:8] @ S.T


def project(frame, intr, pts):
    """World points -> (pixel x, pixel y, depth along the optical axis)."""
    pc = (pts - frame.C) @ frame.R_cw().T
    z = pc[:, 2]
    zs = np.where(np.abs(z) < 1e-9, 1e-9, z)
    return intr["fx"] * pc[:, 0] / zs + intr["cx"], intr["fy"] * pc[:, 1] / zs + intr["cy"], z


def viewport_to_pixel(uv, intr):
    """Unity viewport (u right, v up, 0..1) -> pixel (x right, y down) in the upright picture."""
    return uv[:, 0] * intr["w"], (1.0 - uv[:, 1]) * intr["h"]


# ---------------------------------------------------------------- COLMAP dataset (binary model + pictures)
def link_images(dataset, folder, frames):
    """<dataset>/images/* = the scan's pictures: hard links (no disk used) when the drive allows it, copies otherwise."""
    import shutil
    img_dir = os.path.join(dataset, "images")
    os.makedirs(img_dir, exist_ok=True)
    keep = {f.name for f in frames}
    for n in os.listdir(img_dir):
        if n not in keep:
            os.remove(os.path.join(img_dir, n))
    for f in frames:
        dst = os.path.join(img_dir, f.name)
        if os.path.exists(dst):
            continue
        try:
            os.link(os.path.join(folder, f.name), dst)
        except OSError:
            shutil.copyfile(os.path.join(folder, f.name), dst)


def write_colmap(dataset, frames, intrs, points=None, colors=None, names=None):
    """<dataset>/sparse/0/{cameras,images,points3D}.bin with the headset's poses as they are. intrs: one camera
    model for all pictures (a dict) or one per picture (a list, e.g. for crops); names: the picture files under
    <dataset>/images (default: each frame's own name)."""
    sp = os.path.join(dataset, "sparse", "0")
    os.makedirs(sp, exist_ok=True)
    per = isinstance(intrs, (list, tuple))
    cams = list(intrs) if per else [intrs]
    with open(os.path.join(sp, "cameras.bin"), "wb") as fh:
        fh.write(struct.pack("<Q", len(cams)))
        for i, c in enumerate(cams, 1):
            fh.write(struct.pack("<IiQQ", i, 1, int(c["w"]), int(c["h"])))                # model 1 = PINHOLE
            fh.write(struct.pack("<4d", c["fx"], c["fy"], c["cx"], c["cy"]))
    with open(os.path.join(sp, "images.bin"), "wb") as fh:
        fh.write(struct.pack("<Q", len(frames)))
        for i, f in enumerate(frames, 1):
            q = mat_to_quat_wxyz(f.R_cw())
            t = f.t_cw()
            fh.write(struct.pack("<I", i))
            fh.write(struct.pack("<7d", q[0], q[1], q[2], q[3], t[0], t[1], t[2]))
            fh.write(struct.pack("<I", i if per else 1))
            fh.write((names[i - 1] if names else f.name).encode("utf-8") + b"\x00")
            fh.write(struct.pack("<Q", 0))
    n = 0 if points is None else len(points)
    with open(os.path.join(sp, "points3D.bin"), "wb") as fh:
        fh.write(struct.pack("<Q", n))
        if n:
            rec = np.zeros(n, dtype=[("id", "<u8"), ("xyz", "<f8", 3), ("rgb", "u1", 3), ("err", "<f8"), ("track", "<u8")])
            rec["id"] = np.arange(1, n + 1)
            rec["xyz"] = points
            rec["rgb"] = np.clip(colors, 0, 255).astype(np.uint8) if colors is not None else 128
            rec["err"] = 1.0
            fh.write(rec.tobytes())
    return sp


# ---------------------------------------------------------------- Gaussian splat .ply (the 3DGS layout)
def read_splat_ply(path):
    """-> dict: xyz [n,3], scale [n,3] (metres, already exp'd), quat [n,4] (w,x,y,z, unit), opacity [n] (0..1),
    rgb [n,3] (0..1 from the constant harmonic), sh_rest [n, k] raw, plus the raw structured array."""
    with open(path, "rb") as fh:
        head = b""
        while not head.endswith(b"end_header\n"):
            c = fh.read(1)
            if not c:
                raise ValueError("no ply header in " + path)
            head += c
        lines = head.decode("ascii", "replace").splitlines()
        if not any(l.startswith("format binary_little_endian") for l in lines):
            raise ValueError("only binary little-endian ply is read: " + path)
        n, props, in_vertex = 0, [], False
        types = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1", "uint8": "u1", "int": "<i4", "uint": "<u4",
                 "short": "<i2", "ushort": "<u2", "char": "i1"}
        for l in lines:
            p = l.split()
            if p[:2] == ["element", "vertex"]:
                n, in_vertex = int(p[2]), True
            elif p[:1] == ["element"]:
                in_vertex = False
            elif p[:1] == ["property"] and in_vertex:
                props.append((p[2], types[p[1]]))
        raw = np.frombuffer(fh.read(n * np.dtype(props).itemsize), dtype=props, count=n)
    names = raw.dtype.names
    xyz = np.stack([raw["x"], raw["y"], raw["z"]], 1).astype(np.float64)
    scale = np.exp(np.stack([raw["scale_0"], raw["scale_1"], raw["scale_2"]], 1).astype(np.float64))
    quat = np.stack([raw["rot_0"], raw["rot_1"], raw["rot_2"], raw["rot_3"]], 1).astype(np.float64)
    quat /= np.maximum(np.linalg.norm(quat, axis=1, keepdims=True), 1e-12)
    opacity = 1.0 / (1.0 + np.exp(-raw["opacity"].astype(np.float64)))
    rgb = np.clip(0.5 + SH_C0 * np.stack([raw["f_dc_0"], raw["f_dc_1"], raw["f_dc_2"]], 1).astype(np.float64), 0, 1)
    rest = sorted((nm for nm in names if nm.startswith("f_rest_")), key=lambda s: int(s.split("_")[-1]))
    sh_rest = np.stack([raw[nm] for nm in rest], 1).astype(np.float32) if rest else np.zeros((n, 0), np.float32)
    return {"xyz": xyz, "scale": scale, "quat": quat, "opacity": opacity, "rgb": rgb, "sh_rest": sh_rest, "raw": raw}


def write_splat_ply(path, raw):
    """A subset (or all) of a splat read with read_splat_ply, unchanged in layout."""
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {len(raw)}"]
    back = {"<f4": "float", "<f8": "double", "|u1": "uchar", "<i4": "int", "<u4": "uint"}
    for nm in raw.dtype.names:
        head.append(f"property {back[raw.dtype[nm].str]} {nm}")
    head.append("end_header")
    with open(path, "wb") as fh:
        fh.write(("\n".join(head) + "\n").encode("ascii"))
        fh.write(np.ascontiguousarray(raw).tobytes())


def write_points_ply(path, pts, rgb=None):
    n = len(pts)
    rec = np.zeros(n, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")])
    rec["x"], rec["y"], rec["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
    if rgb is not None:
        rec["red"], rec["green"], rec["blue"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    else:
        rec["red"] = rec["green"] = rec["blue"] = 160
    with open(path, "wb") as fh:
        fh.write((f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\nproperty float x\nproperty float y\nproperty float z\n"
                  "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n").encode("ascii"))
        fh.write(rec.tobytes())


def read_points_ply(path):
    """Positions (and colours when present) of a binary point .ply written by Open3D, COLMAP or write_points_ply."""
    import open3d as o3d
    pc = o3d.io.read_point_cloud(path)
    pts = np.asarray(pc.points)
    cols = (np.asarray(pc.colors) * 255).astype(np.uint8) if pc.has_colors() else None
    return pts, cols

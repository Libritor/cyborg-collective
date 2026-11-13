"""What head/ shows of Steve Mann's CT scan, made from the scan itself.

    python head/make_head.py "PATH/Dr. Mann - MRI/DICOM"

The scan (a head CT: 63 axial slices, 3 mm apart, 0.47 mm pixels) stays on the computer that has it. This
writes, next to this file, only what the page draws, shown with Prof. Mann's agreement:

    skin.bin      the skin as the scanner found it: one closed surface, positions as 16-bit steps of its box, triangles
    slices.jpg    the 63 slices, each 256 x 256, eight to a row: grey levels for the eye, not the scanner's numbers
    masks.png     for the same cells: red = inside the head, green = inside the skull (the brain's room)
    head.json     the box, the slice spacing, where a Muse headband's four electrodes rest on this head (approximate)

No file here holds a name, a date, an identifier or anything else from the scan's headers: only shape and grey. Frame of everything written: millimetres, x to the wearer's left, y up, z to the front, origin on the axis of
the head at the lowest slice.
(system python: pydicom, numpy, scipy, scikit-image, Pillow)
"""
import collections
import glob
import json
import os
import sys

import numpy as np
import pydicom
from PIL import Image
from scipy import ndimage as ndi
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
CELL = 256                      # pixels across one slice in the atlas
COLS = 8
SKIN_HU = -350.0                # between air and skin
BONE_HU = 250.0
GRID_MM = 1.875                 # the surface's grid in the slice plane (4 scanner pixels)
Z_UP = 1.5                      # surface rows per slice spacing (the scan has a slice every 3 mm): a row every 2 mm
# Where a Muse rests, as an angle round the head from the front (towards the wearer's left) and millimetres above the
# bridge of the nose (the nasion, found on the scan as the deepest point of the midline between nose and forehead).
# The forehead pair sits on the forehead, clear above the eyebrows (the brow ridge of this head is about 10 mm above
# the nasion); the ear pair rests behind the ears, a little below it. Approximate: a script cannot feel for landmarks.
SITES = (("AF7", 30.0, 34.0), ("AF8", -30.0, 34.0), ("TP9", 112.0, -12.0), ("TP10", -112.0, -12.0))


def load_axial(src):
    """The axial soft-tissue series as Hounsfield units [slice, row, column], bottom slice first, and its spacing."""
    series = collections.defaultdict(list)
    for p in glob.glob(os.path.join(src, "**", "*"), recursive=True):
        if not os.path.isfile(p):
            continue
        try:
            d = pydicom.dcmread(p, stop_before_pixels=True)
        except Exception:  # noqa: BLE001
            continue
        o = getattr(d, "ImageOrientationPatient", None)
        if o is None or abs(np.cross(np.array(o[:3], float), np.array(o[3:], float))[2]) < 0.9:
            continue
        kernel = getattr(d, "ConvolutionKernel", "")
        kernel = kernel if isinstance(kernel, str) else "".join(kernel)
        series[(d.SeriesInstanceUID, kernel)].append(p)
    soft = [(k, v) for k, v in series.items() if "J37" in k[1]] or list(series.items())
    files = max(soft, key=lambda kv: len(kv[1]))[1]
    ds = sorted((pydicom.dcmread(p) for p in files), key=lambda d: float(d.ImagePositionPatient[2]))
    o = [round(float(v)) for v in ds[0].ImageOrientationPatient]
    if o != [1, 0, 0, 0, 1, 0]:
        raise SystemExit("the slices are not laid out left-to-right, front-to-back as this script assumes: %s" % o)
    vol = np.stack([d.pixel_array.astype(np.float32) * float(d.RescaleSlope) + float(d.RescaleIntercept) for d in ds])
    dz = float(np.median(np.diff([float(d.ImagePositionPatient[2]) for d in ds])))
    return vol, (dz, float(ds[0].PixelSpacing[0]), float(ds[0].PixelSpacing[1]))


def body_mask(vol):
    """Inside the skin: denser than air, holes filled slice by slice, the one biggest piece (the head, not the headrest)."""
    m = vol > SKIN_HU
    m = ndi.binary_opening(m, structure=np.ones((1, 5, 5), bool))
    lab, n = ndi.label(m)
    if n > 1:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    return np.stack([ndi.binary_fill_holes(s) for s in m])


def brain_mask(vol, body):
    """Inside the skull, at half the scan's resolution [slice, row / 2, column / 2]: what bone encloses in each slice.
    The skull base has gaps (foramina, sinuses, ear canals), so a slice is closed gently or, where that fills
    little, hard; a slice whose outline is open takes its inside from the slices above and below it."""
    v = vol[:, ::2, ::2]
    skull = v > 200
    st = ndi.generate_binary_structure(2, 1)
    filled = np.zeros_like(skull)
    for i in range(len(v)):
        gentle = ndi.binary_fill_holes(ndi.binary_closing(skull[i], structure=st, iterations=7))
        strong = ndi.binary_fill_holes(ndi.binary_closing(skull[i], structure=st, iterations=18))
        filled[i] = gentle if gentle.sum() >= 0.6 * strong.sum() else strong
    area = filled.sum(axis=(1, 2)).astype(float)
    for i in range(1, len(v) - 1):
        if area[i] < 0.5 * min(area[i - 1], area[i + 1]):
            filled[i] = filled[i - 1] & filled[i + 1]
    inside = np.zeros_like(skull)
    for i in range(len(v)):
        inside[i] = filled[i] & ~ndi.binary_dilation(skull[i], iterations=1) & (v[i] > -30) & (v[i] < 120)
    inside[:8] = False                                             # below the brainstem
    inside &= body[:, ::2, ::2]

    def biggest(m):
        lab, n = ndi.label(m)
        if n < 2:
            return m
        return lab == (1 + int(np.argmax(ndi.sum(m, lab, range(1, n + 1)))))

    room = biggest(ndi.binary_opening(biggest(inside), structure=np.ones((1, 5, 5), bool)))   # thin links to orbits and sinuses cut
    room = ndi.binary_closing(room, structure=np.ones((3, 5, 5), bool))
    return np.stack([ndi.binary_fill_holes(sl) for sl in room])


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    vol, (dz, dy, dx) = load_axial(sys.argv[1])
    n, rows, cols = vol.shape
    body = body_mask(vol)
    brain = brain_mask(vol, body)
    print("slices %d of %dx%d, %.3f mm pixels, %.1f mm apart; inside the head %.0f cm3, inside the skull %.0f cm3"
          % (n, rows, cols, dx, dz, body.sum() * dx * dy * dz / 1000, brain.sum() * 4 * dx * dy * dz / 1000))

    # the head's axis: the middle of its outline, taken where the head is widest
    rr, cc = np.nonzero(body.any(0))
    r0, r1, c0, c1 = rr.min(), rr.max(), cc.min(), cc.max()
    axis_r, axis_c = (r0 + r1) / 2.0, (c0 + c1) / 2.0
    top = int(np.nonzero(body.any((1, 2)))[0].max())                       # the highest slice with head in it
    # scanner pixel (slice k, row r, column c) -> page millimetres
    X = lambda c: (c - axis_c) * dx           # noqa: E731   to the wearer's left
    Y = lambda k: k * dz                      # noqa: E731   up
    Z = lambda r: -(r - axis_r) * dy          # noqa: E731   to the front (rows run front to back)

    # ---- the skin: the outline blurred a little, sampled on a coarser grid, closed top and bottom
    soft = ndi.gaussian_filter(body.astype(np.float32), (0.45, 2.2, 2.2))
    step = GRID_MM / dx
    grid = ndi.zoom(soft, (Z_UP, 1 / step, 1 / step), order=1)
    grid = np.pad(grid, 1, constant_values=0.0)
    verts, faces, _, _ = measure.marching_cubes(grid, 0.5)
    k = (verts[:, 0] - 1) * (n - 1) / (grid.shape[0] - 3)                   # back to slices, rows and columns of the scan
    r = (verts[:, 1] - 1) * (rows - 1) / (grid.shape[1] - 3)
    c = (verts[:, 2] - 1) * (cols - 1) / (grid.shape[2] - 3)
    P = np.stack([X(c), Y(k), Z(r)], 1).astype(np.float32)
    # triangles wound so that their fronts face out of the head (x, y, z here is a mirror of slice, row, column order)
    v0, v1, v2 = P[faces[:, 0]], P[faces[:, 1]], P[faces[:, 2]]
    out = (np.cross(v1 - v0, v2 - v0) * ((v0 + v1 + v2) / 3 - P.mean(0))).sum()
    if out < 0:
        faces = faces[:, ::-1]
    lo, size = P.min(0), P.max(0) - P.min(0)
    q = np.round((P - lo) / size * 65535).astype("<u2")
    wide = len(P) > 65535
    with open(os.path.join(HERE, "skin.bin.tmp"), "wb") as f:
        f.write(np.array([len(P), len(faces)], "<u4").tobytes())
        f.write(q.tobytes())
        f.write(np.ascontiguousarray(faces).astype("<u4" if wide else "<u2").tobytes())
    os.replace(os.path.join(HERE, "skin.bin.tmp"), os.path.join(HERE, "skin.bin"))

    # ---- the slices, for the cut: a square of the scan round the head's axis, grey levels chosen for the eye
    side_mm = float(np.ceil(max((r1 - r0) * dy, (c1 - c0) * dx) / 10.0) * 10 + 10)
    half = side_mm / 2.0
    rows_at = axis_r - np.linspace(half, -half, CELL) / dy                   # top of a cell = the front of the head
    cols_at = axis_c + np.linspace(-half, half, CELL) / dx                   # left of a cell = the wearer's right
    gr, gc = np.meshgrid(rows_at, cols_at, indexing="ij")
    cells_y = (n + COLS - 1) // COLS
    grey = np.zeros((cells_y * CELL, COLS * CELL), np.uint8)
    masks = np.zeros((cells_y * CELL, COLS * CELL, 3), np.uint8)
    for s in range(n):
        hu = ndi.map_coordinates(vol[s], [gr, gc], order=1, mode="constant", cval=-1000.0)
        inb = ndi.map_coordinates(body[s].astype(np.float32), [gr, gc], order=1, mode="constant") > 0.5
        inr = ndi.map_coordinates(brain[s].astype(np.float32), [gr / 2.0, gc / 2.0], order=1, mode="constant") > 0.5
        wide_w = np.clip((hu + 160.0) / 400.0, 0, 1) * 150.0                 # fat .. soft tissue
        bone = np.clip((hu - 240.0) / 900.0, 0, 1) * 105.0                   # bone on top of that, to white
        img = wide_w + bone
        brainy = 70.0 + np.clip((ndi.gaussian_filter(hu, 0.8) - 2.0) / 60.0, 0, 1) * 110.0   # inside the skull: fluid dark, brain light
        img = np.where(inr, brainy, img)
        img[~inb] = 0
        y0, x0 = (s // COLS) * CELL, (s % COLS) * CELL
        grey[y0:y0 + CELL, x0:x0 + CELL] = np.clip(img, 0, 255).astype(np.uint8)
        masks[y0:y0 + CELL, x0:x0 + CELL, 0] = inb * 255
        masks[y0:y0 + CELL, x0:x0 + CELL, 1] = inr * 255
    Image.fromarray(grey).save(os.path.join(HERE, "slices.jpg"), quality=86, optimize=True)
    Image.fromarray(masks).save(os.path.join(HERE, "masks.png"), optimize=True)

    # ---- the bridge of the nose: on the midline, the front of the face slice by slice; the nose tip is furthest
    # forward, and the nasion is the deepest point in the 50 mm above it
    cmid = int(round(axis_c))
    front = np.full(n, -1e9)
    for k_ in range(n):
        rows_in = np.nonzero(body[k_, :, cmid - 6:cmid + 7].any(1))[0]
        if len(rows_in):
            front[k_] = (axis_r - rows_in.min()) * dy
    tip = int(np.argmax(front[:n * 2 // 3]))
    reach_k = int(round(50.0 / dz))
    nasion_k = tip + 3 + int(np.argmin(front[tip + 3:tip + 3 + reach_k]))
    print("nose tip at slice %d, nasion at slice %d (%.0f mm below the top)" % (tip, nasion_k, (top - nasion_k) * dz))

    # ---- where a Muse's electrodes rest: out from the axis at an angle and a height, to the last point inside the skin
    def skin_point(angle_deg, above_nasion_mm):
        ks = nasion_k + above_nasion_mm / dz
        k0 = int(np.clip(round(ks), 0, n - 1))
        a = np.radians(angle_deg)
        d = np.array([np.sin(a), np.cos(a)])                                 # (to the left, to the front) in millimetres
        reach = 0.0
        for mm in np.arange(20.0, 140.0, 0.5):                               # out to where the ray first leaves the head:
            rr_ = axis_r - d[1] * mm / dy                                    # the scalp behind the ear, not the ear beyond it
            cc_ = axis_c + d[0] * mm / dx
            if not (0 <= rr_ < rows - 1 and 0 <= cc_ < cols - 1 and body[k0, int(round(rr_)), int(round(cc_))]):
                break
            reach = mm
        return [round(float(d[0] * reach), 1), round(float(Y(ks)), 1), round(float(d[1] * reach), 1)], [round(float(d[0]), 3), 0.0, round(float(d[1]), 3)]

    sites = []
    for name, angle, above in SITES:
        pos, normal = skin_point(angle, above)
        sites.append({"name": name, "pos": pos, "out": normal})

    info = {
        "what": "Steve Mann's head from his own CT scan, shown with his agreement. Shape and grey only: nothing from the scan's headers.",
        "scan": {"kind": "CT", "slices": int(n), "slice_mm": round(dz, 3), "pixel_mm": round(dx, 4)},
        "frame": "millimetres; x to the wearer's left, y up, z to the front; origin on the head's axis at the lowest slice",
        "skin": {"file": "skin.bin", "vertices": int(len(P)), "triangles": int(len(faces)), "index_bytes": 4 if wide else 2,
                 "box_min": [round(float(v), 3) for v in lo], "box_size": [round(float(v), 3) for v in size]},
        "slices": {"file": "slices.jpg", "masks": "masks.png", "count": int(n), "cols": COLS, "rows": int(cells_y), "cell": CELL,
                   "side_mm": side_mm, "first_y_mm": 0.0, "step_mm": round(dz, 3)},
        "top_y_mm": round(float(Y(top)), 1),
        "electrodes": sites,
        "nasion_y_mm": round(float(Y(nasion_k)), 1),
        "electrodes_note": "about where a Muse headband's four electrodes rest: the forehead pair on the forehead above the eyebrows, the ear pair behind the ears; placed by angle round the head and height above the bridge of the nose as found on the scan",
    }
    with open(os.path.join(HERE, "head.json.tmp"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(info, f, indent=1)
        f.write("\n")
    os.replace(os.path.join(HERE, "head.json.tmp"), os.path.join(HERE, "head.json"))
    for name in ("skin.bin", "slices.jpg", "masks.png", "head.json"):
        print("  %-10s %7.0f KB" % (name, os.path.getsize(os.path.join(HERE, name)) / 1024))
    print("skin: %d vertices, %d triangles; box %s mm; electrodes %s" % (len(P), len(faces), np.round(size).tolist(), [(s["name"], s["pos"]) for s in sites]))


if __name__ == "__main__":
    main()

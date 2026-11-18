#!/usr/bin/env python3
"""From a trained Gaussian splat to one closed solid of the scanned object (used by quest_scan.py).

  support_plane     the level surface the object stands on (world y is up)
  object_component  the Gaussians that belong to the object: the connected clump above that surface at the seed
  carve             depth maps of the splat from the scan's own camera positions, voted into a voxel grid:
                    a voxel is outside once enough cameras see past it, the surface sits where they see it,
                    and what no camera could see stays solid (so the body is closed), limited to the convex
                    hull of the object's Gaussians and cut flat on the support surface
  field_to_mesh     marching cubes -> a closed triangle mesh in world metres, coloured from the splat

Right-handed world, y up, metres (scan_lib's frame).
"""
import numpy as np
from numba import njit, prange

from splat_render import Camera, quat_to_rot, render


def support_plane(sp, centre, reach, below=0.6):
    """Height (y) of the level surface under the object, from the splat itself: flat, level Gaussians near the
    object pile up at one height. -> (y0 or None, share of the level area found at that height)."""
    xyz, op, sc = sp["xyz"], sp["opacity"], sp["scale"]
    d = np.hypot(xyz[:, 0] - centre[0], xyz[:, 2] - centre[2])
    m = (op > 0.3) & (d < reach) & (xyz[:, 1] > centre[1] - below) & (xyz[:, 1] < centre[1] - 0.003)
    if m.sum() < 50:
        return None, 0.0
    s = np.sort(sc[m], 1)
    R = quat_to_rot(sp["quat"][m])
    thin = np.argmin(sc[m], 1)
    axis = R[np.arange(len(thin)), :, thin]                       # the direction each Gaussian is thinnest in
    level = (np.abs(axis[:, 1]) > 0.9) & (s[:, 0] < 0.5 * s[:, 1])
    w = op[m] * s[:, 1] * s[:, 2]
    y = xyz[m, 1]
    if level.sum() >= 30:
        y, w = y[level], w[level]
    bins = np.arange(y.min() - 0.004, y.max() + 0.008, 0.004)
    if len(bins) < 3:
        return None, 0.0
    h, e = np.histogram(y, bins=bins, weights=w)
    h = np.convolve(h, [0.25, 0.5, 0.25], mode="same")
    strong = np.flatnonzero(h >= 0.4 * h.max())
    k = strong[-1]                                                # the highest strong level: the one right under the object
    lo, hi = e[max(k - 2, 0)], e[min(k + 3, len(e) - 1)]
    sel = (y >= lo) & (y <= hi)
    y0 = float(np.average(y[sel], weights=w[sel]))
    return y0, float(w[sel].sum() / max(w.sum(), 1e-12))


def plane_from_depth(pts, nrm, centre, reach, below=0.6):
    """The same from the headset's depth points (those whose surface faces up)."""
    if pts is None or len(pts) < 50:
        return None
    d = np.hypot(pts[:, 0] - centre[0], pts[:, 2] - centre[2])
    m = (d < reach) & (nrm[:, 1] > 0.9) & (pts[:, 1] > centre[1] - below) & (pts[:, 1] < centre[1] - 0.003)
    if m.sum() < 50:
        return None
    y = pts[m, 1]
    h, e = np.histogram(y, bins=np.arange(y.min() - 0.005, y.max() + 0.01, 0.005))
    h = np.convolve(h, [0.25, 0.5, 0.25], mode="same")
    k = np.flatnonzero(h >= 0.4 * h.max())[-1]
    sel = (y >= e[max(k - 1, 0)]) & (y <= e[min(k + 2, len(e) - 1)])
    return float(np.median(y[sel]))


def object_component(sp, seed, y0, max_radius, max_height=1.2, cell=0.008, lift=0.012, around=None):
    """Boolean mask over the Gaussians: the clump above the support surface that the seed point belongs to, no
    further than max_radius (sideways) from `around` (default: the seed)."""
    from scipy.ndimage import binary_dilation, generate_binary_structure, label
    xyz, op, sc = sp["xyz"], sp["opacity"], sp["scale"]
    mid = seed if around is None else around
    d = np.hypot(xyz[:, 0] - mid[0], xyz[:, 2] - mid[2])
    floor = (y0 + lift) if y0 is not None else seed[1] - max_radius
    top = (y0 if y0 is not None else seed[1] - max_radius) + max_height
    cand = (op > 0.2) & (d < max_radius) & (xyz[:, 1] > floor) & (xyz[:, 1] < top) & (sc.max(1) < 0.06)
    idx = np.flatnonzero(cand)
    if len(idx) < 20:
        return np.zeros(len(xyz), bool)
    p = xyz[idx]
    lo = p.min(0) - 2 * cell
    ijk = np.floor((p - lo) / cell).astype(int)
    shape = ijk.max(0) + 3
    occ = np.zeros(shape, bool)
    occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    st = generate_binary_structure(3, 3)
    lab, n = label(binary_dilation(occ, st), structure=st)
    labs = lab[ijk[:, 0], ijk[:, 1], ijk[:, 2]]
    near = np.argmin(np.linalg.norm(p - np.asarray(seed), axis=1))
    mask = np.zeros(len(xyz), bool)
    mask[idx[labs == labs[near]]] = True
    return mask


@njit(parallel=True, cache=True, nogil=True)
def _vote(ox, oy, oz, v, R, C, fx, fy, cx, cy, depth, dmin, amax, trunc, back, n_free, n_near, s_sdf):
    nx, ny, nz = n_free.shape
    h, w = depth.shape
    for i in prange(nx):
        X = ox + (i + 0.5) * v
        for j in range(ny):
            Y = oy + (j + 0.5) * v
            for k in range(nz):
                Z = oz + (k + 0.5) * v
                dx, dy, dz = X - C[0], Y - C[1], Z - C[2]
                zc = R[2, 0] * dx + R[2, 1] * dy + R[2, 2] * dz
                if zc <= 0.03:
                    continue
                iu = int(np.floor(fx * (R[0, 0] * dx + R[0, 1] * dy + R[0, 2] * dz) / zc + cx))
                iv = int(np.floor(fy * (R[1, 0] * dx + R[1, 1] * dy + R[1, 2] * dz) / zc + cy))
                if iu < 0 or iu >= w or iv < 0 or iv >= h:
                    continue
                # free only if this pixel and all eight round it agree (dmin = the nearest surface among them, a huge
                # number where none has one): a camera looking along a surface must not shave it
                if dmin[iv, iu] - zc > trunc:
                    if dmin[iv, iu] < 1e8 or amax[iv, iu] < 0.15:
                        n_free[i, j, k] += 1
                    continue
                d = depth[iv, iu]
                if d <= 0:
                    continue
                sdf = d - zc
                if sdf > trunc:
                    continue
                if sdf >= -trunc:
                    # just behind the surface this camera sees: counts as inside, but never by more than `back`,
                    # so a thin wall seen from both sides is not thickened by the cameras behind it
                    n_near[i, j, k] += 1
                    s_sdf[i, j, k] += (sdf if sdf > -back else -back) / trunc


@njit(parallel=True, cache=True, nogil=True)
def _outside_hull(ox, oy, oz, v, eq, tol, out):
    nx, ny, nz = out.shape
    for i in prange(nx):
        X = ox + (i + 0.5) * v
        for j in range(ny):
            Y = oy + (j + 0.5) * v
            for k in range(nz):
                Z = oz + (k + 0.5) * v
                for f in range(eq.shape[0]):
                    if eq[f, 0] * X + eq[f, 1] * Y + eq[f, 2] * Z + eq[f, 3] > tol:
                        out[i, j, k] = True
                        break


def crop_camera(cam, corners, pad=6):
    """The camera restricted to the rectangle of its picture that the box corners fall in (None if out of view)."""
    pc = (corners - cam.C) @ cam.R.T
    if np.all(pc[:, 2] < 0.05):
        return None
    z = np.maximum(pc[:, 2], 0.05)
    x = cam.fx * pc[:, 0] / z + cam.cx
    y = cam.fy * pc[:, 1] / z + cam.cy
    x0, x1 = int(max(0, np.floor(x.min()) - pad)), int(min(cam.w, np.ceil(x.max()) + pad))
    y0, y1 = int(max(0, np.floor(y.min()) - pad)), int(min(cam.h, np.ceil(y.max()) + pad))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return Camera(cam.R, cam.C, cam.fx, cam.fy, cam.cx - x0, cam.cy - y0, x1 - x0, y1 - y0)


def carve(sp, obj_mask, cams, y0, log=print, cells=176, max_views=90, min_voxel=0.0008, max_voxel=0.004, inset_px=2.0):
    """-> dict(field [nx, ny, nz] float32 (negative inside), origin [3], voxel, views, plane_layer).
    cams: the scan's cameras (splat_render.Camera at full picture size)."""
    from scipy.ndimage import maximum_filter, minimum_filter
    from scipy.spatial import ConvexHull
    xyz = sp["xyz"]
    p = xyz[obj_mask]
    lo, hi = np.percentile(p, 0.5, 0), np.percentile(p, 99.5, 0)
    base = y0 if y0 is not None else float(lo[1])
    lo[1] = base
    centre = (lo + hi) / 2
    radius = float(np.linalg.norm(hi - lo) / 2)
    # the Gaussians that can come between a camera and the object: those near it
    near = (sp["opacity"] > 0.05) & (np.linalg.norm(xyz - centre, axis=1) < radius + 1.5)

    def depth_of(cc, fx_full, inset):
        _, depth, alpha = render(sp, cc, keep=near, min_alpha=0.02)
        # A small object's surface in a splat lies inside the real one: its Gaussians are drawn a little wider than
        # they are, so the trainer pulls them in. Measured against known models at two distances (scan_gate.py): the
        # rendered depth of the object is about two pixels of the training pictures too far, while a large flat
        # surface (the table) comes out where it is. So the object's depths are brought that much nearer the camera
        # and the table's are not.
        if inset:
            depth = np.where(depth > 0, depth * (1.0 - inset / fx_full), 0.0)
        return depth, alpha

    views = []
    for c in cams:
        pc = c.R @ (centre - c.C)
        dist = float(np.linalg.norm(centre - c.C))
        if pc[2] < 0.1 or dist > 4.0 or dist < 0.6 * radius:
            continue
        u, w_ = c.fx * pc[0] / pc[2] + c.cx, c.fy * pc[1] / pc[2] + c.cy
        if not (0 <= u < c.w and 0 <= w_ < c.h):
            continue
        views.append((c, dist))
    if len(views) > max_views:
        views = [views[i] for i in np.linspace(0, len(views) - 1, max_views).round().astype(int)]
    if len(views) < 3:
        raise SystemExit(f"only {len(views)} pictures look at the object: scan it again from more sides")
    # The support surface again, from the splat's rendered depth rather than from where its Gaussians' middles are:
    # the ring of surface round the object as a dozen of the cameras see it.
    base_first = base
    if y0 is not None:
        r_in = float(np.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2) + 0.012
        r_out = r_in + 0.07
        ring = np.array([[centre[0] + sx * r_out, y0 + sy, centre[2] + sz * r_out] for sx in (-1, 1) for sy in (-0.02, 0.02) for sz in (-1, 1)])
        ys = []
        for c, dist in views[::max(1, len(views) // 12)]:
            cc = crop_camera(c.scaled(0.5), ring)
            if cc is None:
                continue
            depth, _ = depth_of(cc, c.fx, 0.0)
            vv, uu = np.nonzero(depth > 0)
            d = depth[vv, uu]
            pw = cc.C + np.stack([(uu + 0.5 - cc.cx) / cc.fx * d, (vv + 0.5 - cc.cy) / cc.fy * d, d], 1) @ cc.R
            rr = np.hypot(pw[:, 0] - centre[0], pw[:, 2] - centre[2])
            ok = (rr > r_in) & (rr < r_out) & (np.abs(pw[:, 1] - y0) < 0.012)
            ys.append(pw[ok, 1])
        ys = np.concatenate(ys) if ys else np.zeros(0)
        if len(ys) > 800:
            base = float(np.median(ys))
            lo[1] = base
    ext = hi - lo
    v = float(np.clip(ext.max() / cells, min_voxel, max_voxel))
    margin = max(0.008, 4 * v)
    # a voxel boundary lies exactly on the support surface, three layers of margin under it
    plane_layer = 3
    origin = np.array([lo[0] - margin, base - plane_layer * v, lo[2] - margin])
    shape = np.ceil((hi + margin - origin) / v).astype(int) + 1
    log(f"object box {np.round(ext * 100, 1).tolist()} cm, voxel {v * 1000:.2f} mm, grid {shape.tolist()}, support surface moved {1000 * (base - base_first):+.1f} mm")
    corners = np.array([[x, y, z] for x in (lo[0] - margin, hi[0] + margin) for y in (base, hi[1] + margin) for z in (lo[2] - margin, hi[2] + margin)])
    n_free = np.zeros(shape, np.uint16); n_near = np.zeros(shape, np.uint16); s_sdf = np.zeros(shape, np.float32)
    trunc, back = 3.0 * v, 1.2 * v
    for n, (c, dist) in enumerate(views):
        s = float(np.clip(1.3 * dist / (c.fx * v), 0.25, 1.0))     # a voxel covers a little over a pixel
        cc = crop_camera(c.scaled(s), corners)
        if cc is None:
            continue
        depth, alpha = depth_of(cc, c.fx, inset_px)
        dmin = minimum_filter(np.where(depth > 0, depth, 1e9), size=3, mode="nearest")
        amax = maximum_filter(alpha, size=3, mode="nearest")
        _vote(origin[0], origin[1], origin[2], v, cc.R, cc.C, cc.fx, cc.fy, cc.cx, cc.cy, depth, dmin, amax, trunc, back, n_free, n_near, s_sdf)
        if n % 20 == 0:
            log(f"  depth view {n + 1} of {len(views)} ({cc.w} x {cc.h})")
    W = n_free.astype(np.float32) + n_near
    w_min = max(2, int(round(0.04 * len(views))))
    field = np.where(W >= w_min, (n_free + s_sdf) / np.maximum(W, 1), -1.0).astype(np.float32)
    # nothing outside the convex hull of the object's Gaussians (and of their feet on the support surface)
    hp = p[sp["opacity"][obj_mask] > 0.4] if (sp["opacity"][obj_mask] > 0.4).sum() > 50 else p
    hp = np.unique(np.round(hp / 0.004).astype(np.int64), axis=0) * 0.004
    feet = hp.copy(); feet[:, 1] = base
    hull = ConvexHull(np.vstack([hp, feet]))
    out = np.zeros(shape, np.bool_)
    _outside_hull(origin[0], origin[1], origin[2], v, np.ascontiguousarray(hull.equations), 2.0 * v + 0.002, out)
    field[out] = 1.0
    return {"field": field, "origin": origin, "voxel": v, "views": len(views), "plane_layer": plane_layer, "seen": W, "w_min": w_min,
            "has_plane": y0 is not None, "base": base}


def field_to_mesh(c, seed=None, skirt=0.004, smooth=0.6, polish=6):
    """The solid as a closed mesh (world metres). The part within `skirt` of the support surface is replaced by the
    cross-section just above it carried straight down, so the base is flat and the surface's own noise is left out."""
    import open3d as o3d
    from scipy.ndimage import gaussian_filter, label
    from skimage.measure import marching_cubes
    f, v, m = c["field"].copy(), c["voxel"], c["plane_layer"]
    cut = m + (int(np.ceil(skirt / v)) if c["has_plane"] else 0)
    cut = min(cut, f.shape[1] - 2)
    if smooth:
        f = gaussian_filter(f, smooth)
    f[:, m:cut, :] = f[:, cut:cut + 1, :]                 # carry the section above the skirt down to the surface
    f[:, :m, :] = 1.0
    solid = f < 0
    lab, n = label(solid)
    if n == 0:
        raise SystemExit("the carving left nothing solid: the splat is too thin here, scan again with more pictures")
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    keep = int(np.argmax(sizes))
    if seed is not None and n > 1:
        # prefer the piece the seed touches when it is a real piece (a tenth of the biggest at least)
        ijk = np.floor((np.asarray(seed) - c["origin"]) / v).astype(int)
        ii = [slice(max(0, a - 3), a + 4) for a in ijk]
        if all(0 <= a < s for a, s in zip(ijk, f.shape)):
            near = np.unique(lab[ii[0], ii[1], ii[2]]); near = near[near > 0]
            near = [k for k in near if sizes[k] >= 0.1 * sizes.max()]
            if near:
                keep = int(max(near, key=lambda k: sizes[k]))
    f[solid & (lab != keep)] = 0.5
    f[:, m - 1, :] = np.where(f[:, m, :] < 0, -f[:, m, :], 1.0)   # the base lies on the voxel boundary = the surface
    c["solid"] = f < 0
    # keep the surface from passing through a voxel's centre: there marching cubes makes triangles too small to
    # survive smoothing and a file's rounding, and the surface would no longer read back closed
    f = np.where(np.abs(f) < 0.03, np.where(f < 0, -0.03, 0.03), f).astype(np.float32)
    g = np.pad(f, 1, constant_values=1.0)
    verts, faces, _, _ = marching_cubes(g, level=0.0, spacing=(v, v, v))
    verts = verts + c["origin"] - 0.5 * v                        # padded index i <-> voxel centre (i - 1 + 0.5) v
    mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(verts), o3d.utility.Vector3iVector(faces.astype(np.int32)))
    mesh.remove_duplicated_vertices(); mesh.remove_degenerate_triangles(); mesh.remove_unreferenced_vertices()
    if signed_volume(mesh) < 0:
        mesh.triangles = o3d.utility.Vector3iVector(np.asarray(mesh.triangles)[:, ::-1].copy())
    if polish:
        # take the splat's grain off the surface without shrinking it (Taubin), and put the base back flat
        y_base = c["base"]
        on_base = np.abs(np.asarray(mesh.vertices)[:, 1] - y_base) < 0.05 * v
        sm = mesh.filter_smooth_taubin(number_of_iterations=polish)
        vs = np.asarray(sm.vertices).copy()
        vs[on_base, 1] = y_base
        vs[~on_base, 1] = np.maximum(vs[~on_base, 1], y_base)
        mesh.vertices = o3d.utility.Vector3dVector(vs)
    mesh.compute_vertex_normals()
    return mesh, {"solid_voxels": int(sizes[keep]), "pieces": int(n), "volume_cm3": round(signed_volume(mesh) * 1e6, 2)}


def signed_volume(mesh):
    v = np.asarray(mesh.vertices); t = np.asarray(mesh.triangles)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def is_closed(mesh):
    return bool(mesh.is_edge_manifold(allow_boundary_edges=False)) and bool(mesh.is_vertex_manifold())


def colour_mesh(mesh, sp, obj_mask):
    """Vertex colours from the nearest Gaussians of the object."""
    import open3d as o3d
    from scipy.spatial import cKDTree
    m = obj_mask & (sp["opacity"] > 0.3)
    if m.sum() < 10:
        m = obj_mask
    tree = cKDTree(sp["xyz"][m])
    _, nn = tree.query(np.asarray(mesh.vertices), k=min(4, int(m.sum())))
    nn = nn.reshape(len(mesh.vertices), -1)
    mesh.vertex_colors = o3d.utility.Vector3dVector(sp["rgb"][m][nn].mean(1))
    return mesh


def shade_mesh(mesh, cam, light=(0.4, -0.8, 0.45), colour=None):
    """A shaded picture of a mesh from a camera, by ray casting on the CPU (no graphics card needed)."""
    import open3d as o3d
    t = o3d.t.geometry.TriangleMesh.from_legacy(mesh)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(t)
    ys, xs = np.mgrid[0:cam.h, 0:cam.w]
    d = np.stack([(xs + 0.5 - cam.cx) / cam.fx, (ys + 0.5 - cam.cy) / cam.fy, np.ones_like(xs, float)], -1) @ cam.R
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    rays = np.concatenate([np.broadcast_to(cam.C, d.shape), d], -1).astype(np.float32)
    hit = scene.cast_rays(o3d.core.Tensor(rays))
    tt = hit["t_hit"].numpy(); nrm = hit["primitive_normals"].numpy()
    ok = np.isfinite(tt)
    nrm = np.where((nrm * d).sum(-1, keepdims=True) > 0, -nrm, nrm)
    L = np.asarray(light, float); L = -L / np.linalg.norm(L)
    to_cam = -d
    shade = 0.25 + 0.55 * np.clip((nrm * L).sum(-1), 0, 1) + 0.3 * np.clip((nrm * to_cam).sum(-1), 0, 1)
    base = np.array([0.78, 0.80, 0.84]) if colour is None else np.asarray(colour, float)
    img = np.ones((cam.h, cam.w, 3))
    img[ok] = np.clip(shade[ok, None] * base, 0, 1)
    return img

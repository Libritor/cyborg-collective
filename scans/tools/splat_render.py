#!/usr/bin/env python3
"""A software Gaussian-splat renderer (numba, on the CPU): colour, depth and coverage of a trained splat from any
camera. Used by quest_scan.py to turn a splat into depth maps for the solid, to draw the turntable pictures and to
check the splat against the photographs, without a GPU library.

    from splat_render import Camera, render
    img, depth, alpha = render(splat, Camera(R_cw, C, fx, fy, cx, cy, w, h))

splat = scan_lib.read_splat_ply(...) (or a dict with xyz, scale, quat, opacity, rgb). The colour is the constant
term of each Gaussian (no view-dependent shading); depth is the distance along the optical axis at which the ray
has lost half its light (the median depth), 0 where it never does; alpha is how much of the ray was stopped.
"""
import math

import numpy as np
from numba import njit


class Camera:
    """COLMAP convention: x_cam = R_cw (x_world - C); x right, y down, z forward; pixel (0, 0) top left."""

    def __init__(self, R_cw, C, fx, fy, cx, cy, w, h):
        self.R, self.C = np.asarray(R_cw, float), np.asarray(C, float)
        self.fx, self.fy, self.cx, self.cy, self.w, self.h = float(fx), float(fy), float(cx), float(cy), int(w), int(h)

    def scaled(self, s):
        """The same view at s times the resolution."""
        return Camera(self.R, self.C, self.fx * s, self.fy * s, self.cx * s, self.cy * s, max(1, round(self.w * s)), max(1, round(self.h * s)))

    @staticmethod
    def of_frame(frame, intr):
        return Camera(frame.R_cw(), frame.C, intr["fx"], intr["fy"], intr["cx"], intr["cy"], intr["w"], intr["h"])

    @staticmethod
    def look_at(eye, target, up, fx, fy, cx, cy, w, h):
        eye, target, up = np.asarray(eye, float), np.asarray(target, float), np.asarray(up, float)
        f = target - eye; f /= np.linalg.norm(f)
        r = np.cross(f, up); r /= np.linalg.norm(r)
        d = np.cross(f, r)                       # image "down"
        return Camera(np.stack([r, d, f], 0), eye, fx, fy, cx, cy, w, h)


def quat_to_rot(q):
    """[n, 4] (w, x, y, z) unit quaternions -> [n, 3, 3]."""
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    R = np.empty((len(q), 3, 3))
    R[:, 0, 0] = 1 - 2 * (y * y + z * z); R[:, 0, 1] = 2 * (x * y - z * w); R[:, 0, 2] = 2 * (x * z + y * w)
    R[:, 1, 0] = 2 * (x * y + z * w); R[:, 1, 1] = 1 - 2 * (x * x + z * z); R[:, 1, 2] = 2 * (y * z - x * w)
    R[:, 2, 0] = 2 * (x * z - y * w); R[:, 2, 1] = 2 * (y * z + x * w); R[:, 2, 2] = 1 - 2 * (x * x + y * y)
    return R


def covariances(splat):
    """World-space 3x3 covariance of every Gaussian, cached on the dict."""
    if "cov" not in splat:
        R = quat_to_rot(splat["quat"])
        M = R * splat["scale"][:, None, :]
        splat["cov"] = M @ np.transpose(M, (0, 2, 1))
    return splat["cov"]


@njit(cache=True, nogil=True)
def _composite(order, mx, my, mz, ca, cb, cc, rad, op, col, w, h, img, depth, alpha, min_alpha):
    T = np.ones((h, w))
    for k in range(order.shape[0]):
        i = order[k]
        r = rad[i]
        x0 = max(0, int(math.floor(mx[i] - r))); x1 = min(w - 1, int(math.ceil(mx[i] + r)))
        y0 = max(0, int(math.floor(my[i] - r))); y1 = min(h - 1, int(math.ceil(my[i] + r)))
        if x1 < x0 or y1 < y0:
            continue
        a, b, c, o, z = ca[i], cb[i], cc[i], op[i], mz[i]
        r0, g0, b0 = col[i, 0], col[i, 1], col[i, 2]
        for y in range(y0, y1 + 1):
            dy = y + 0.5 - my[i]
            for x in range(x0, x1 + 1):
                t = T[y, x]
                if t < 1e-3:
                    continue
                dx = x + 0.5 - mx[i]
                p = -0.5 * (a * dx * dx + c * dy * dy) - b * dx * dy
                if p > 0 or p < -12:
                    continue
                al = o * math.exp(p)
                if al < min_alpha:
                    continue
                if al > 0.99:
                    al = 0.99
                wgt = t * al
                img[y, x, 0] += wgt * r0; img[y, x, 1] += wgt * g0; img[y, x, 2] += wgt * b0
                tn = t * (1 - al)
                if t > 0.5 and tn <= 0.5:
                    depth[y, x] = z
                T[y, x] = tn
    for y in range(h):
        for x in range(w):
            alpha[y, x] = 1 - T[y, x]


def render(splat, cam, background=(1.0, 1.0, 1.0), near=0.05, far=1e9, min_alpha=1.0 / 255, keep=None):
    """-> (img [h, w, 3] float 0..1 over the background, depth [h, w] metres (0 = none), alpha [h, w]).
    keep: optional boolean mask or index array choosing which Gaussians to draw."""
    xyz, op, col = splat["xyz"], splat["opacity"], splat["rgb"]
    cov = covariances(splat)
    idx = np.arange(len(xyz)) if keep is None else (np.flatnonzero(keep) if np.asarray(keep).dtype == bool else np.asarray(keep))
    pc = (xyz[idx] - cam.C) @ cam.R.T
    z = pc[:, 2]
    ok = (z > near) & (z < far)
    # leave out what cannot reach the picture (a generous margin: big Gaussians at the edge still count)
    px = cam.fx * pc[:, 0] / np.where(ok, z, 1) + cam.cx
    py = cam.fy * pc[:, 1] / np.where(ok, z, 1) + cam.cy
    m = 0.5 * max(cam.w, cam.h)
    ok &= (px > -m) & (px < cam.w + m) & (py > -m) & (py < cam.h + m)
    idx, pc, z, px, py = idx[ok], pc[ok], z[ok], px[ok], py[ok]
    n = len(idx)
    img = np.zeros((cam.h, cam.w, 3)); depth = np.zeros((cam.h, cam.w)); alpha = np.zeros((cam.h, cam.w))
    if n:
        # the 2-D footprint: J W cov W^T J^T, with a small blur so nothing is thinner than a pixel
        J = np.zeros((n, 2, 3))
        J[:, 0, 0] = cam.fx / z; J[:, 0, 2] = -cam.fx * pc[:, 0] / (z * z)
        J[:, 1, 1] = cam.fy / z; J[:, 1, 2] = -cam.fy * pc[:, 1] / (z * z)
        JW = J @ cam.R
        c2 = JW @ cov[idx] @ np.transpose(JW, (0, 2, 1))
        sa, sb, sc = c2[:, 0, 0] + 0.3, c2[:, 0, 1], c2[:, 1, 1] + 0.3
        det = sa * sc - sb * sb
        good = det > 1e-12
        det = np.where(good, det, 1.0)
        ca, cb, cc = sc / det, -sb / det, sa / det
        mid = 0.5 * (sa + sc)
        rad = 3.0 * np.sqrt(mid + np.sqrt(np.maximum(mid * mid - det, 0.0)))
        rad = np.where(good, np.minimum(rad, 2.0 * max(cam.w, cam.h)), 0.0)
        order = np.argsort(z, kind="stable").astype(np.int64)
        _composite(order, np.ascontiguousarray(px), np.ascontiguousarray(py), np.ascontiguousarray(z), np.ascontiguousarray(ca),
                   np.ascontiguousarray(cb), np.ascontiguousarray(cc), np.ascontiguousarray(rad), np.ascontiguousarray(op[idx]),
                   np.ascontiguousarray(col[idx]), cam.w, cam.h, img, depth, alpha, float(min_alpha))
    bg = np.asarray(background, float)
    img += (1 - alpha)[:, :, None] * bg
    return np.clip(img, 0, 1), depth, alpha


def to_image(img):
    from PIL import Image
    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))

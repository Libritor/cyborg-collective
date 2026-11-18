#!/usr/bin/env python3
"""A made-up scan with a known answer, in exactly the files the headset writes, to test quest_scan.py end to end.

    python scan_synth.py <out folder> [--model ~/DinoPrint/prints/trex.stl] [--length 0.22]
                         [--pictures 110] [--arc 360] [--depth-noise-mm 4] [--pose-noise-mm 0]

A model (default: the Dino Print T. rex, 22 cm long) stands on a textured table in a small room with a few other
things near it. A browser draws it with three.js from a walk round the table at the Quest camera's own geometry
(1280 x 960, Meta's intrinsics): each picture as a JPEG, and behind each an 80 x 60 grid of "depth" with noise
like a stereo depth sensor's. Written to <out>/scan/ in the headset's conventions (Unity's left-handed world,
viewport v up): camera.json, frames.csv, k0000.jpg, k0000.depth, scan.json. The truth goes to <out>/truth/:
gt_world.ply (the model where it stood, metres, the pipeline's right-handed frame) and truth.json.
"""
import argparse
import base64
import functools
import http.server
import json
import os
import shutil
import threading

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
THREE = os.path.join(os.path.expanduser("~"), "DinoPrint", "web", "vendor", "three.module.min.js")
W, H = 1280, 960
CAMERA_JSON = {"app": "scan_synth", "width": W, "height": H, "focalLength": {"x": 1155.1234130859375, "y": 1155.1234130859375},
               "principalPoint": {"x": 864.9209594726563, "y": 866.6670532226563}, "sensorResolution": {"x": 1728, "y": 1728}}

PAGE = r"""<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports": {"three": "./three.module.min.js"}}</script>
<script type="module">
import * as THREE from 'three';
const W = 1280, H = 960, GX = 80, GY = 60;
const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x30343a);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function texture(w, h, base, blobs, lines) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < blobs; i++) {
    g.fillStyle = `hsla(${Math.floor(rnd() * 360)}, ${30 + rnd() * 50}%, ${25 + rnd() * 50}%, ${0.25 + rnd() * 0.5})`;
    const x = rnd() * w, y = rnd() * h, r = 4 + rnd() * 40;
    if (rnd() < 0.5) g.fillRect(x, y, r * 2, r); else { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < lines; i++) { g.lineWidth = 1 + rnd() * 3; g.beginPath(); g.moveTo(rnd() * w, rnd() * h); g.lineTo(rnd() * w, rnd() * h); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const M = (tex) => new THREE.MeshLambertMaterial({map: tex});
const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); scene.add(m); return m; };
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.5));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6); sun.position.set(1.5, 3, 1); scene.add(sun);
const fill = new THREE.DirectionalLight(0xdde8ff, 0.7); fill.position.set(-2, 1.5, -1.5); scene.add(fill);
window.build = (model) => {
  const T = model.table;                                    // top of the table
  add(new THREE.BoxGeometry(1.3, 0.04, 0.9), M(texture(1024, 720, '#9a7b55', 260, 60)), model.at[0], T - 0.02, model.at[2]);
  for (const [dx, dz] of [[-0.6, -0.4], [0.6, -0.4], [-0.6, 0.4], [0.6, 0.4]])
    add(new THREE.BoxGeometry(0.05, T - 0.04, 0.05), new THREE.MeshLambertMaterial({color: 0x333333}), model.at[0] + dx, (T - 0.04) / 2, model.at[2] + dz);
  const floor = add(new THREE.PlaneGeometry(6, 6), M(texture(1024, 1024, '#6d6f73', 500, 120)), model.at[0], 0, model.at[2]); floor.rotation.x = -Math.PI / 2;
  const wallTex = [texture(1024, 512, '#c9c4b8', 160, 40), texture(1024, 512, '#b8c4c9', 160, 40), texture(1024, 512, '#c4b8c9', 160, 40), texture(1024, 512, '#bfc9b8', 160, 40)];
  for (let i = 0; i < 4; i++) {
    const w = add(new THREE.PlaneGeometry(6, 2.8), M(wallTex[i]), model.at[0] + [0, 3, 0, -3][i], 1.4, model.at[2] + [-3, 0, 3, 0][i]);
    w.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][i];
  }
  // other things on the table, well clear of the model
  add(new THREE.BoxGeometry(0.12, 0.09, 0.16), M(texture(256, 256, '#3b6ea5', 60, 10)), model.at[0] - 0.42, T + 0.045, model.at[2] - 0.2);
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.11, 32), M(texture(256, 256, '#b5483c', 60, 10)), model.at[0] + 0.45, T + 0.055, model.at[2] + 0.22);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(model.v), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(model.c), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(model.f), 1));
  g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({vertexColors: true})));
  return scene.children.length;
};
const camera = new THREE.PerspectiveCamera();
const posMat = new THREE.ShaderMaterial({side: THREE.DoubleSide,
  vertexShader: 'varying vec3 p; varying vec3 n; void main(){ vec4 w = modelMatrix * vec4(position,1.0); p = w.xyz; n = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: 'varying vec3 p; varying vec3 n; uniform float which; void main(){ gl_FragColor = which < 0.5 ? vec4(p, 1.0) : vec4(normalize(n), 1.0); }',
  uniforms: {which: {value: 0}}});
const rt = new THREE.WebGLRenderTarget(GX, GY, {type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter});
window.shot = (c) => {
  // c: eye [3], right/up/fwd [3 each] in this world, fx fy cx cy
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...c.right), new THREE.Vector3(...c.up), new THREE.Vector3(...c.fwd).negate());
  camera.position.set(...c.eye); camera.quaternion.setFromRotationMatrix(m); camera.updateMatrixWorld(true);
  const n = 0.03, f = 30;
  camera.projectionMatrix.set(2 * c.fx / W, 0, 1 - 2 * c.cx / W, 0,   0, 2 * c.fy / H, 2 * c.cy / H - 1, 0,   0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),   0, 0, -1, 0);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  renderer.setRenderTarget(null); scene.overrideMaterial = null;
  renderer.render(scene, camera);
  const jpg = renderer.domElement.toDataURL('image/jpeg', 0.92);
  const out = [];
  const bg = scene.background; scene.background = null;
  for (const which of [0, 1]) {
    posMat.uniforms.which.value = which; scene.overrideMaterial = posMat;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.render(scene, camera);
    const buf = new Float32Array(GX * GY * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, GX, GY, buf);
    out.push(Array.from(buf));
  }
  scene.overrideMaterial = null; scene.background = bg; renderer.setRenderTarget(null);
  return {jpg, pos: out[0], nrm: out[1]};
};
window.ready = true;
</script></body></html>"""


def model_arrays(path, length, at, yaw_deg, table):
    """The model at real size, y up, standing on the table: vertices, faces, colours (three.js world = the
    pipeline's right-handed frame)."""
    import open3d as o3d
    m = o3d.io.read_triangle_mesh(path)
    m.remove_duplicated_vertices(); m.remove_degenerate_triangles()
    if len(m.triangles) > 60000:
        m = m.simplify_quadric_decimation(60000)
        m.remove_degenerate_triangles(); m.remove_unreferenced_vertices()
    v = np.asarray(m.vertices, float)
    v = v - np.array([(v[:, 0].min() + v[:, 0].max()) / 2, (v[:, 1].min() + v[:, 1].max()) / 2, v[:, 2].min()])
    v *= length / (v.max(0) - v.min(0)).max()
    v = np.stack([v[:, 0], v[:, 2], -v[:, 1]], 1)                # z up -> y up (a turn, not a mirror)
    a = np.radians(yaw_deg)
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    v = v @ Ry.T + np.array([at[0], table, at[2]])
    # paint: stripes and blotches, so the pictures have something to match on
    rng = np.random.default_rng(3)
    k = rng.normal(size=(6, 3)) * 90
    ph = rng.uniform(0, 6.28, 6)
    s = sum(np.sin(v @ k[i] + ph[i]) for i in range(6)) / 6
    t = np.sin(v[:, 0] * 160 + v[:, 1] * 60) * 0.5 + 0.5
    base = np.array([0.36, 0.52, 0.24]); alt = np.array([0.78, 0.62, 0.30]); dark = np.array([0.16, 0.12, 0.10])
    c = base[None] * (1 - t[:, None]) + alt[None] * t[:, None]
    c = np.where((s > 0.18)[:, None], dark[None], c) * (0.85 + 0.3 * rng.random((len(v), 1)))
    m.vertices = o3d.utility.Vector3dVector(v)
    return m, v, np.asarray(m.triangles), np.clip(c, 0, 1)


def walk(centre, table, n, arc_deg, rng, near=1.0):
    """Camera positions and axes of someone walking round the table looking at the object."""
    cams = []
    # radius, height above the table, share of the pictures
    rings = [(0.55 * near, 0.30 * near, 0.55), (0.43 * near, 0.55 * near, 0.45)]
    start = rng.uniform(0, 360)
    for radius, height, share in rings:
        k = max(4, int(round(n * share)))
        for i in range(k):
            az = np.radians(start + arc_deg * i / (k if arc_deg >= 360 else max(k - 1, 1)))
            eye = np.array([centre[0] + radius * np.cos(az), table + height, centre[2] + radius * np.sin(az)]) + rng.normal(0, 0.015, 3)
            target = centre + rng.normal(0, 0.025, 3)
            fwd = target - eye; fwd /= np.linalg.norm(fwd)
            roll = np.radians(rng.normal(0, 3))
            right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
            up = np.cross(right, fwd)
            right, up = right * np.cos(roll) + up * np.sin(roll), up * np.cos(roll) - right * np.sin(roll)
            cams.append((eye, right, up, fwd))
    return cams


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--model", default=os.path.join(os.path.expanduser("~"), "DinoPrint", "prints", "trex.stl"))
    ap.add_argument("--length", type=float, default=0.22)
    ap.add_argument("--pictures", type=int, default=110)
    ap.add_argument("--arc", type=float, default=360.0, help="how much of the circle is walked, degrees")
    ap.add_argument("--depth-noise-mm", type=float, default=4.0, help="depth noise at half a metre (grows with distance squared)")
    ap.add_argument("--pose-noise-mm", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--near", type=float, default=1.0, help="how close the walk is: 1 = 55 cm from the object, 0.6 = 33 cm")
    ap.add_argument("--yaw", type=float, default=35.0, help="how the model is turned on the table, degrees")
    a = ap.parse_args()
    import sys
    sys.path.insert(0, HERE)
    import scan_lib as L
    from playwright.sync_api import sync_playwright
    rng = np.random.default_rng(a.seed)
    out = os.path.normpath(a.out)
    scan, truth, site = os.path.join(out, "scan"), os.path.join(out, "truth"), os.path.join(out, "_site")
    for d in (scan, truth, site):
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    table, at = 0.74, np.array([0.30, 0.0, -0.50])
    mesh, v, f, c = model_arrays(a.model, a.length, at, a.yaw, table)
    import open3d as o3d
    o3d.io.write_triangle_mesh(os.path.join(truth, "gt_world.ply"), mesh)
    centre = (v.min(0) + v.max(0)) / 2
    intr = L.pca_intrinsics(CAMERA_JSON)
    shutil.copyfile(THREE, os.path.join(site, "three.module.min.js"))
    open(os.path.join(site, "index.html"), "w", encoding="utf-8").write(PAGE)
    json.dump({"v": v.ravel().round(5).tolist(), "f": f.ravel().tolist(), "c": c.ravel().round(3).tolist(), "table": table, "at": at.tolist()},
              open(os.path.join(site, "model.json"), "w"))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site)
    handler.log_message = lambda *args, **kw: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    cams = walk(centre, table, a.pictures, a.arc, rng, a.near)
    Sm = np.diag([1.0, 1.0, -1.0])
    rows = ["frame,file,t_unix_ms,t_app_s,cam_px,cam_py,cam_pz,cam_qx,cam_qy,cam_qz,cam_qw,depth_hits"]
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": W, "height": H})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
        pg.wait_for_function("window.ready === true", timeout=60000)
        pg.evaluate("async () => { const m = await (await fetch('model.json')).json(); return window.build(m); }")
        for i, (eye, right, up, fwd) in enumerate(cams):
            r = pg.evaluate("c => window.shot(c)", {"eye": eye.tolist(), "right": right.tolist(), "up": up.tolist(), "fwd": fwd.tolist(),
                                                    "fx": intr["fx"], "fy": intr["fy"], "cx": intr["cx"], "cy": intr["cy"]})
            if errs:
                raise SystemExit("page error: " + errs[0])
            name = f"k{i:04d}"
            open(os.path.join(scan, name + ".jpg"), "wb").write(base64.b64decode(r["jpg"].split(",", 1)[1]))
            pos = np.array(r["pos"], np.float64).reshape(60, 80, 4); nrm = np.array(r["nrm"], np.float64).reshape(60, 80, 4)
            iy, ix = np.mgrid[0:60, 0:80]
            hit = pos[..., 3] > 0.5
            P = pos[..., :3][hit]; N = nrm[..., :3][hit]
            uv = np.stack([(ix[hit] + 0.5) / 80, (iy[hit] + 0.5) / 60], 1)
            # depth like a stereo sensor's: noise along the ray growing with distance squared, some rays lost, none past 4 m
            ray = P - eye; dist = np.linalg.norm(ray, axis=1)
            keep = (dist < 4.0) & (rng.random(len(P)) > 0.08)
            sigma = a.depth_noise_mm / 1000 * (dist / 0.5) ** 2
            P = P + ray / dist[:, None] * rng.normal(0, 1, len(P))[:, None] * sigma[:, None]
            P, N, uv = P[keep], N[keep], uv[keep]
            rec = np.hstack([uv, P @ Sm.T, N @ Sm.T]).astype("<f4")
            rec.tofile(os.path.join(scan, name + ".depth"))
            eye_n = eye + rng.normal(0, a.pose_noise_mm / 1000, 3) if a.pose_noise_mm else eye
            R_u = np.stack([Sm @ right, Sm @ up, Sm @ fwd], 1)       # Unity's camera axes as columns
            q = L.mat_to_quat_wxyz(R_u)                               # w, x, y, z
            e_u = Sm @ eye_n
            rows.append(f"{i},{name}.jpg,{1794000000000 + i * 400},{i * 0.4:.4f},{e_u[0]:.5f},{e_u[1]:.5f},{e_u[2]:.5f},{q[1]:.6f},{q[2]:.6f},{q[3]:.6f},{q[0]:.6f},{len(P)}")
            if i % 20 == 0:
                print(f"  picture {i + 1} of {len(cams)}: {len(P)} depth rays", flush=True)
        gpu = pg.evaluate("() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }")
        b.close()
    srv.shutdown()
    shutil.rmtree(site, ignore_errors=True)
    open(os.path.join(scan, "frames.csv"), "w").write("\n".join(rows) + "\n")
    json.dump(CAMERA_JSON, open(os.path.join(scan, "camera.json"), "w"), indent=1)
    # the pick: the spot of the model nearest the first camera; the middle and size the app would have guessed
    seed = v[np.argmin(np.linalg.norm(v - cams[0][0], axis=1))]
    radius = float(np.clip(np.linalg.norm(v.max(0) - v.min(0)) / 2, 0.06, 0.4))
    json.dump({"name": os.path.basename(out), "seed": (Sm @ seed).round(4).tolist(), "centre": (Sm @ centre).round(4).tolist(), "radius": round(radius, 3),
               "pictures": len(cams), "saved": True, "coordinates": "Unity world, left-handed, y up, metres"}, open(os.path.join(scan, "scan.json"), "w"))
    json.dump({"model": a.model, "length_m": a.length, "table_y": table, "size_m": (v.max(0) - v.min(0)).round(4).tolist(), "centre": centre.round(4).tolist(),
               "pictures": len(cams), "arc_deg": a.arc, "depth_noise_mm": a.depth_noise_mm, "pose_noise_mm": a.pose_noise_mm, "renderer": gpu},
              open(os.path.join(truth, "truth.json"), "w"), indent=1)
    print(f"synthetic scan: {len(cams)} pictures in {scan} (drawn by {gpu})")


if __name__ == "__main__":
    main()

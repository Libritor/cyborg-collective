#!/usr/bin/env python3
"""Put a finished scan on the website (6ense.com/scans/), or take one off again.

    python scan_publish.py <run folder> [--id trex] [--title "..."] [--note "..."]     one scan
    python scan_publish.py --remove <id>                                               take it off
    python scan_publish.py --rebuild                                                   only rewrite the list, the viewer and its libraries
    python scan_publish.py --list                                                      what is on the site (in the clone)
    add --no-push to write into the clone of the site without committing or pushing

A run is a folder quest_scan.py has finished (it has web\\meta.json). The id, title and note it is published
under are kept in the run's publish.json, so publishing it again needs no arguments. What goes up, into
scans/runs/<id>/ of the clone of the site's repository:

    the splat, compressed        Open3D reads the trained .ply and writes .spz, about a tenth of the size; the
                                 file is read back and its Gaussians counted before it is kept
    the solid or the room model  .glb, repacked with its data in binary (a quarter smaller than as made)
    a picture                    the splat's own render. Not a camera picture: those stay on this computer
    files to print               an object's STL and its sliced 3MF; a room's diorama STL, zipped
    meta.json                    the numbers, the words, and which files the viewer loads

and beside them scans/scans.json (the list), scans/index.html (the list as a plain page: no script), scans/view.html
(the viewer, which is web/splat/index.html), scans/vendor/ (three.js and Spark: the site keeps its libraries beside
its pages) and scans/test_scans_page.py.

Then it commits scans/ in the clone under the clone's own git identity and pushes it: GitHub Pages serves it a minute
or two later. A push here does not touch the relay. Publishing is public: a scan of a room shows the room.
(anaconda python: open3d, Pillow)
"""
import argparse
import base64
import datetime
import html
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(HERE, "web", "splat")                 # index.html (the viewer) and vendor/
EXTRA = os.path.join(HERE, "web", "scans")                  # files that go to scans/ as they are (the page's test)
CLONE = os.path.join(os.path.expanduser("~"), "cyborg-collective-site")      # the local clone of the site's repository
OUT_ROOT = os.path.join(os.path.expanduser("~"), "Downloads", "quest_scans")
# a browser offers AR and VR only at a secure address; the relay serves a copy of the whole site at one
SECURE_COPY = "https://cyborg-collective-relay.onrender.com/scans/"
LIMIT = 95 * 1024 * 1024                                    # GitHub refuses a file of 100 MB
MONTHS = "January February March April May June July August September October November December".split()


# The tools themselves, published beside the scans as plain files (scans/tools/), with what each is for. Paths are
# from this folder; the last three are the headset app's, in the Unity project.
UNITY = os.path.join(os.path.expanduser("~"), "Mersivity", "MersivityQuest", "Assets", "PrintSee")
TOOLS = [
    ("On the headset", [
        (os.path.join(UNITY, "PrintWhatISee.cs"), "The headset app (Unity, Meta's passthrough camera and depth): keeps a picture, the camera's position and a grid of depth rays every 5 cm of head movement; the trigger names the object; the splat sensor sends one reading per depth ray for the live view."),
        (os.path.join(UNITY, "Editor", "PrintSeeBuild.cs"), "Builds the app's scene and its Android package."),
        (os.path.join(UNITY, "Editor", "compile_check.py"), "Compiles the app's scripts in seconds, without a build."),
        ("printsee_build.ps1", "Runs the Unity build without a window, watching the disk."),
    ]),
    ("One sitting", [
        (os.path.join("..", "start_quest_scan.ps1"), "The one command: scan, splat, solid, print file; -Live and -Publish send to this site."),
        ("scan_session.py", "Waits for the headset to be worn, starts the app, follows its log, then runs the steps below."),
        ("quest_scan.py", "The laptop's part: checks the scan, writes the training set, trains the splat (Brush), cuts out the object, makes the solid, slices it, draws the pictures."),
    ]),
    ("The parts of the laptop's work", [
        ("scan_lib.py", "Reads a scan folder; the headset camera's model; writes the training set in COLMAP's layout; reads and writes splat files."),
        ("splat_render.py", "Draws a Gaussian splat on the processor: colour, depth and coverage from any camera position."),
        ("scan_solid.py", "From splat to solid: the surface the object stands on, the object's own Gaussians, depth from every side voted into a closed body with a flat base."),
        ("slice_h2c.py", "Slices an STL for a Bambu H2C with the slicer's own command line; reports time and grams."),
        ("scan_view.py", "Serves the viewer (view.html on this site) on the laptop and to the headset through the USB cable."),
        (os.path.join("web", "splat", "fetch_vendor.py"), "Fetches the two libraries the viewer runs on, checked against recorded hashes."),
    ]),
    ("A room seen from one spot", [
        ("scan_view_folder.py", "Gathers an early sitting's pictures into one folder."),
        ("scan_mono_depth.py", "Depth for pictures that have none: a depth network's map per picture, pinned to the headset's own measurements."),
        ("scan_room_model.py", "Fuses those depth maps into a coloured shell of the room and a diorama to print."),
    ]),
    ("Checking the method", [
        ("scan_synth.py", "Draws a made-up scan of a known model, at the headset camera's geometry and with noisy depth."),
        ("scan_gate.py", "Measures the result against the known model and says pass or fail."),
    ]),
    ("To this site", [
        ("scan_publish.py", "Puts a finished scan here (the splat compressed by Open3D), takes one off, and writes these pages."),
        ("quest_splat.py", "The live view's sender: takes the app's depth readings over the USB cable, keeps one per 2 cm, records them, passes them to the relay."),
        (os.path.join("..", "start_quest_splat.ps1"), "The live sender on its own, without a scan."),
        ("splat_live_check.py", "Sends a labelled test pattern through the public relay and checks that the home page draws it and lets it go."),
        ("SCAN_README.md", "The notes kept with the tools: how to run them, every file, the method, what was checked and what was not."),
    ]),
]


def log(*a):
    print("[publish]", *a, flush=True)


def day(made):
    """'2026-11-17 16:47' -> '17 November 2026'."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", made or "")
    return f"{int(m.group(3))} {MONTHS[int(m.group(2)) - 1]} {m.group(1)}" if m else ""


def to_spz(src, dst):
    """The trained splat, compressed by Open3D; -> how many Gaussians the written file holds."""
    import open3d as o3d
    pc = o3d.t.io.read_point_cloud(src)
    n = int(pc.point.positions.shape[0])
    need = {"f_dc", "opacity", "scale", "rot"}
    if n == 0 or not need.issubset(set(pc.point)):
        raise SystemExit(f"{src} is not a Gaussian splat Open3D can read ({n} points, has {sorted(pc.point)})")
    if not o3d.t.io.write_point_cloud(dst, pc):
        raise SystemExit(f"Open3D could not write {dst}")
    back = int(o3d.t.io.read_point_cloud(dst).point.positions.shape[0])
    if back != n:
        raise SystemExit(f"{dst} reads back as {back} Gaussians, not the {n} written")
    return n


def picture(src, dst, width=1400):
    from PIL import Image
    im = Image.open(src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(dst, "JPEG", quality=86, optimize=True, progressive=True)
    return im.size


def pack_glb(src, dst):
    """A .glb that carries its data inside its text as base64 (a third larger than it need be) is rewritten with the
    data in the file's binary part; any other .glb is copied as it is."""
    b = open(src, "rb").read()
    magic, _, _ = struct.unpack("<4sII", b[:12])
    jlen, jtype = struct.unpack("<I4s", b[12:20])
    j = json.loads(b[20:20 + jlen]) if magic == b"glTF" and jtype == b"JSON" else None
    uris = [buf.get("uri", "") for buf in j.get("buffers", [])] if j else []
    if not j or 20 + jlen < len(b) or not uris or not all(u.startswith("data:") for u in uris):
        shutil.copy(src, dst)
        return
    blob, starts = bytearray(), []
    for u in uris:
        blob += bytes(-len(blob) % 4)
        starts.append(len(blob))
        blob += base64.b64decode(u.split(",", 1)[1])
    blob += bytes(-len(blob) % 4)
    for v in j.get("bufferViews", []):
        v["byteOffset"] = v.get("byteOffset", 0) + starts[v["buffer"]]
        v["buffer"] = 0
    j["buffers"] = [{"byteLength": len(blob)}]
    text = json.dumps(j, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    with open(dst, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack("<I4s", len(text), b"JSON") + text)
        fh.write(struct.pack("<I", len(blob)) + b"BIN" + bytes(1) + bytes(blob))


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "scan"


def git(clone, *args, check=True):
    r = subprocess.run(["git", *args], cwd=clone, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout.rstrip()               # not the front: a status line begins with a space when only the work tree changed


# ------------------------------------------------------------------ one scan into the clone
def stage(run, clone, sid=None, title=None, note=None, kind=None):
    run = os.path.normpath(run)
    web = os.path.join(run, "web")
    if not os.path.exists(os.path.join(web, "meta.json")):
        raise SystemExit(f"{run} is not finished (no web\\meta.json): run quest_scan.py on it")
    meta = json.load(open(os.path.join(web, "meta.json"), encoding="utf-8"))
    view = meta.get("mode") == "view"
    truth = os.path.exists(os.path.join(run, "truth", "truth.json"))
    kind = kind or ("test" if truth else "headset")
    sid = slug(sid or meta["name"])
    when = day(meta.get("made"))
    out = os.path.join(clone, "scans", "runs", sid)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    pub = {"id": sid, "kind": kind, "mode": "view" if view else "object", "name": meta["name"], "made": meta.get("made"),
           "published": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), "secure_copy": SECURE_COPY}
    for k in ("size_cm", "print", "pictures", "train", "eye_height_m", "look_yaw_rad", "look_pitch_rad", "yaw_span_rad", "room"):
        if meta.get(k) is not None:
            pub[k] = meta[k]

    # the splats, through Open3D
    src = os.path.join(web, "view.ply" if view else "object.ply")
    pub["splat"] = "view.spz" if view else "object.spz"
    pub["splat_count"] = to_spz(src, os.path.join(out, pub["splat"]))
    log(f"{sid}: {pub['splat']} {pub['splat_count']:,} Gaussians, {os.path.getsize(src) / 1e6:.1f} MB -> {os.path.getsize(os.path.join(out, pub['splat'])) / 1e6:.2f} MB")
    if os.path.exists(os.path.join(web, "scene.ply")):
        pub["scene"] = "scene.spz"
        to_spz(os.path.join(web, "scene.ply"), os.path.join(out, "scene.spz"))
    if os.path.exists(os.path.join(web, "object.glb")):
        pub["solid"] = "object.glb"
        pack_glb(os.path.join(web, "object.glb"), os.path.join(out, "object.glb"))
    if os.path.exists(os.path.join(web, "room.glb")):
        pub["model"] = "room.glb"
        pack_glb(os.path.join(web, "room.glb"), os.path.join(out, "room.glb"))

    # pictures: renders of the splat and of the model, never the camera's own pictures
    pics = []
    for name, rel, alt in (("picture.jpg", "renders/look_around.jpg" if view else "renders/turntable.jpg",
                            "The splat seen from the spot it was photographed from, looking round in eight directions" if view
                            else "The splat (top row) and the solid made from it (bottom row), from six sides"),):
        p = os.path.join(run, rel)
        if os.path.exists(p):
            w, h = picture(p, os.path.join(out, name))
            pics.append({"file": name, "alt": alt, "w": w, "h": h})
    if not pics:
        raise SystemExit(f"{run} has no render to show (renders\\{'look_around' if view else 'turntable'}.jpg): run quest_scan.py --from render")
    pub["pictures_shown"] = pics

    # files to take away
    down = [{"file": pub["splat"], "label": "the splat (.spz)"}]
    if pub.get("solid"):
        pr = (meta.get("print") or {}).get("print_size_mm")
        if os.path.exists(os.path.join(web, "object_print.stl")):
            shutil.copy(os.path.join(web, "object_print.stl"), os.path.join(out, "object_print.stl"))
            down.append({"file": "object_print.stl", "label": "STL to print" + (f" ({max(pr):.0f} mm)" if pr else "")})
        if os.path.exists(os.path.join(web, "object_h2c.3mf")):
            shutil.copy(os.path.join(web, "object_h2c.3mf"), os.path.join(out, "object_h2c.3mf"))
            down.append({"file": "object_h2c.3mf", "label": "sliced for a Bambu H2C (.3mf)"})
    if pub.get("model"):
        down.append({"file": "room.glb", "label": "the room model (.glb)"})
        stl = os.path.join(web, "room_diorama.stl")
        if os.path.exists(stl):
            with zipfile.ZipFile(os.path.join(out, "room_diorama_stl.zip"), "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
                z.write(stl, "room_diorama.stl")
            scale = ((meta.get("room") or {}).get("print") or {}).get("scale")
            down.append({"file": "room_diorama_stl.zip", "label": "diorama STL" + (f", {scale}" if scale else "") + " (zip)"})
    for d in down:
        d["bytes"] = os.path.getsize(os.path.join(out, d["file"]))
    pub["downloads"] = down

    # a test scan is measured against the shape it was drawn from
    gate = os.path.join(run, "gate.json")
    if truth and os.path.exists(gate):
        g = json.load(open(gate, encoding="utf-8"))
        acc = g.get("accuracy_mm") or {}
        pub["check"] = {"median_mm": acc.get("median"), "p95_mm": acc.get("p95"), "size_error_pct": g.get("size_error_pct"),
                        "volume_cm3": g.get("volume_cm3"), "true_volume_cm3": g.get("true_volume_cm3")}

    n = pub.get("pictures")
    if kind == "test":
        pub["title"] = title or f"{meta['name'].strip('_')} (a test of the method)"
        med = (pub.get("check") or {}).get("median_mm")
        pub["note"] = note or (f"Not a headset scan. A known model was drawn on the computer from {n} viewpoints all round it, with the "
                               "Quest 3S camera's geometry and with noise added to the depth, and those pictures went through the same steps "
                               "as a real scan." + (f" Because the true shape is known, the solid can be measured against it: half of its "
                                                    f"surface lies within {med} mm of the true one." if med is not None else ""))
    elif view:
        pub["title"] = title or f"A place looked at, {when}"
        pub["note"] = note or (f"Looked at with a Meta Quest 3S on {when}: {n} pictures. Nothing was walked round, so this is a view to look "
                               "round from where it was photographed; away from that spot it has gaps, and there is no solid."
                               + (" The 3-D model is an estimate of the room's shape." if pub.get("model") else "")
                               + " Published by the wearer; the camera pictures stay with them.")
    else:
        pub["title"] = title or f"Something scanned, {when}"
        pub["note"] = note or (f"Photographed by walking round it with a Meta Quest 3S on {when}: {n} pictures. The splat was trained from "
                               "them on a laptop; the solid was made from the splat. Published by the wearer; the camera pictures stay with them.")

    for f in os.listdir(out):
        if os.path.getsize(os.path.join(out, f)) > LIMIT:
            raise SystemExit(f"{f} is {os.path.getsize(os.path.join(out, f)) / 1e6:.0f} MB: too large for the site's repository")
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(pub, fh, indent=1)
    total = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    log(f"{sid}: {len(os.listdir(out))} files, {total / 1e6:.1f} MB in {out}")
    return sid


# ------------------------------------------------------------------ the list, the viewer, the libraries
def scans_in(clone):
    root = os.path.join(clone, "scans", "runs")
    metas = []
    for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        p = os.path.join(root, d, "meta.json")
        if os.path.exists(p):
            metas.append(json.load(open(p, encoding="utf-8")))
    # what a headset saw first, newest first; then the tests of the method
    return sorted(metas, key=lambda m: (m["kind"] == "test", [-ord(c) for c in (m.get("made") or "")], m["id"]))


def mb(n):
    return f"{n / 1e6:.0f} MB" if n >= 1e7 else f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{max(1, round(n / 1e3))} kB"


def facts(m):
    rows = []
    s, tr, pr, rm = m.get("size_cm"), m.get("train") or {}, m.get("print") or {}, m.get("room") or {}
    if m["mode"] == "object" and s:
        rows.append(("Real size", f"{s[0]} × {s[2]} × {s[1]} cm high"))
    rows.append(("Pictures", str(m.get("pictures", "—"))))
    if tr.get("gaussians"):
        part = m.get("splat_count") if m.get("splat_count") != tr["gaussians"] else None
        rows.append(("Splat", f"{tr['gaussians']:,} Gaussians trained in {tr.get('steps')} steps"
                     + ("" if not part else f"; {part:,} of them are the object itself" if m["mode"] == "object" else f"; {part:,} kept for this page")))
    if tr.get("held_out_psnr_db"):
        rows.append(("Pictures kept back", f"reproduced at {tr['held_out_psnr_db']} dB"))
    c = m.get("check") or {}
    if c.get("median_mm") is not None:
        rows.append(("Against the true shape", f"{c['median_mm']} mm (half the surface); {c.get('p95_mm')} mm (95 %)"))
    slice_words = lambda t: re.sub(r"^sliced \S+ for the H2C: ", "", t or "")
    if pr.get("print_size_mm"):
        rows.append(("Print", " × ".join(f"{v:.0f}" for v in pr["print_size_mm"]) + " mm" + (f"; {slice_words(pr.get('slice'))}" if pr.get("slice") else "")))
    if rm.get("size_m"):
        rows.append(("Room model", f"{rm['size_m'][0]} × {rm['size_m'][2]} m, {rm['size_m'][1]} m high (an estimate)"))
        rp = rm.get("print") or {}
        if rp.get("size_mm"):
            rows.append(("Diorama print", f"{rp.get('scale')}, " + " × ".join(f"{v:.0f}" for v in rp["size_mm"]) + " mm"
                         + (f"; {slice_words(rp.get('slice'))}" if rp.get("slice") else "")))
    return rows


LIST_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scans in 3-D</title>
<!-- Written by scan_publish.py from scans/runs/*/meta.json. No script: this page is the list as plain words and
     pictures; view.html draws a scan in 3-D. -->
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --ink: #16181d; --muted: #6b7280; --line: #e5e7eb; --accent: #1f4e79; --test: #92400e; --seen: #166534; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a21; --ink: #e5e7eb; --muted: #9ca3af; --line: #262a33; --accent: #7fb3e6; --test: #fbbf24; --seen: #86efac; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 28px 16px 48px; }
  a { color: var(--accent); overflow-wrap: anywhere; }
  h1 { margin: 0 0 6px; font-size: 30px; letter-spacing: -0.01em; }
  .lede { max-width: 72ch; margin: 0 0 8px; }
  .doors { display: flex; flex-wrap: wrap; gap: 8px 10px; margin: 12px 0; }
  .doors a { display: inline-block; text-decoration: none; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; }
  .doors b { color: var(--accent); }
  .muted { color: var(--muted); font-size: 13.5px; max-width: 80ch; }
  .scan { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 20px 0; }
  .pics img { display: block; width: 100%; height: auto; border-radius: 8px; background: #fff; }
  .words { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px 28px; margin-top: 14px; }
  .words > * { min-width: 0; }
  @media (min-width: 900px) { .words { grid-template-columns: minmax(0, 11fr) minmax(0, 9fr); } }
  h2 { margin: 0 0 4px; font-size: 20px; }
  .kind { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; border: 1px solid currentColor; border-radius: 999px; padding: 1px 9px; margin-bottom: 8px; }
  .kind.test { color: var(--test); } .kind.headset { color: var(--seen); }
  .note { margin: 0 0 10px; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 0 0 12px; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; }
  .open { display: inline-block; font-weight: 600; text-decoration: none; color: var(--card); background: var(--accent); border-radius: 8px; padding: 7px 14px; margin: 0 0 10px; }
  .files { margin: 0; padding: 0; list-style: none; font-size: 14px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  footer { margin-top: 28px; }
</style>
</head>
<body>
<main>
<h1>Scans in 3-D</h1>
<p class="lede">Things and places photographed with a Meta Quest 3S headset and rebuilt as Gaussian splats: clouds of soft coloured blobs, trained until they reproduce the photographs. From the splat of one object a closed solid is made and sliced for a 3-D printer.</p>
<p class="doors"><a href="live.html"><b>Live</b>: what a headset is scanning now, as Gaussians, while it scans</a> <a href="how.html"><b>How a scan is made</b>, with the tools</a></p>
<p class="muted">How a scan gets here: the headset keeps pictures, with its own position for each; a laptop trains the splat from them (Brush), makes the solid, and compresses the splat (Open3D); the viewer on this site (Spark and three.js, both kept beside the page) draws it. The headset has no lidar: where depth is used, it is the depth the headset works out from its two tracking cameras. &ldquo;Pictures kept back&rdquo;: a tenth of the pictures are not used for training, and the number says how closely the splat reproduces them (higher is closer).</p>
"""

HOW_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How a scan is made</title>
<!-- Written by scan_publish.py, which also copies the tools named here into tools/. No script. -->
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --ink: #16181d; --muted: #6b7280; --line: #e5e7eb; --accent: #1f4e79; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a21; --ink: #e5e7eb; --muted: #9ca3af; --line: #262a33; --accent: #7fb3e6; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 16px 56px; }
  a { color: var(--accent); overflow-wrap: anywhere; }
  h1 { margin: 0 0 6px; font-size: 30px; letter-spacing: -0.01em; }
  h2 { margin: 30px 0 8px; font-size: 20px; }
  h3 { margin: 18px 0 4px; font-size: 15px; color: var(--muted); font-weight: 600; }
  p, li { max-width: 74ch; }
  .muted { color: var(--muted); font-size: 13.5px; }
  ol.chain { padding-left: 22px; } ol.chain li { margin: 0 0 8px; }
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 10px; border-top: 1px solid var(--line); }
  tr:first-child th, tr:first-child td { border-top: 0; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  td.file { white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 13px; }
</style>
</head>
<body>
<main>
<p class="muted"><a href="./">← all scans</a> · <a href="live.html">live</a></p>
<h1>How a scan is made</h1>
<p>A thing or a place is photographed with a Meta Quest 3S headset, a laptop turns the photographs into a Gaussian splat and, for an object, into a closed solid sliced for a 3-D printer, and the result goes onto this site. Everything it is made with is on this page.</p>

<h2>The chain</h2>
<ol class="chain">
<li><b>The headset keeps pictures.</b> Its app keeps a picture from the passthrough camera every 5 cm or 6 degrees of head movement, with the headset's own position and direction for it and an 80 × 60 grid of depth rays behind it. Pulling the trigger on a thing names it as the object. The headset has no lidar: its depth comes from its two tracking cameras.</li>
<li><b>Live, if asked for.</b> While it scans, the app can also send one depth reading per ray to the laptop over the USB cable. The laptop keeps one per 2 cm of surface and passes them through the relay; <a href="live.html">the live page</a> draws each as a Gaussian the moment it arrives. These are placed, not trained.</li>
<li><b>The laptop trains the splat.</b> The headset's positions are used as they are, with no structure from motion. The pictures are cropped round the object and <a href="https://github.com/ArthurBrussee/brush">Brush</a> trains the Gaussians for 8,000 steps, about two minutes on a laptop's graphics card. A tenth of the pictures are kept back and compared with what the splat draws from their positions.</li>
<li><b>From splat to solid.</b> The splat's depth is drawn from every camera position and voted into a grid: outside where enough cameras see past a cell, surface where they see it, solid where none could see, so the body is closed. It is cut flat on the surface it stood on.</li>
<li><b>Sliced.</b> The solid is scaled and sliced for a Bambu H2C with the slicer's command line. Nothing is sent to a printer.</li>
<li><b>Published, if asked for.</b> <a href="https://www.open3d.org/">Open3D</a> reads the trained splat and writes it compressed, about a tenth of the size; that file, the solid, a render and the print files go into this site's repository. Open3D does not make the splat: it has no training. The camera pictures are not published.</li>
</ol>
<pre>.\\start_quest_scan.ps1                  scan, splat, solid, print file: everything stays on the laptop
.\\start_quest_scan.ps1 -Live -Publish   the same, with the live view and the finished scan on this site</pre>

<h2>What has been checked, and what has not</h2>
<ul>
<li><b>Against known shapes.</b> Two made-up scans of known models, drawn at the headset camera's geometry with noise in the depth, went through the same steps: half of the T. rex's surface lies within 0.47 mm of the true one, its sizes within 0.3 %, its volume within 0.5 %; the Triceratops, 0.37 mm. Both are <a href="./">on the list</a>, labelled as tests.</li>
<li><b>On the headset.</b> One sitting so far, from one seat in a room: 26 pictures, a view to look round rather than an object. Its depth rays land within 0.02 px sideways and 4 px vertically of where they were cast, so the camera model holds on the device.</li>
<li><b>These pages.</b> Each has a browser test that travels with it (<a href="test_scans_page.py">test_scans_page.py</a>, <a href="test_live_page.py">test_live_page.py</a>); the live page's test sends a made-up room through a relay and requires the page to draw it and let it go.</li>
<li><b>Not yet.</b> A walk all the way round one object with the headset; the live view from the headset itself (only made-up rooms have been sent so far); AR and VR inside the headset from this site; a print.</li>
</ul>

<h2>The tools</h2>
<p>Plain files, as they are used; nothing here is built. They are Python (numpy, scipy, numba, Open3D, scikit-image, Pillow, playwright), PowerShell, and one C# script for Unity 6 with Meta's XR packages. Their own defaults name folders in the user's home folder.</p>
"""

HOW_FOOT = """
<h2>What they stand on</h2>
<ul>
<li><a href="https://github.com/ArthurBrussee/brush">Brush</a> trains the splat (Apache 2.0).</li>
<li><a href="https://www.open3d.org/">Open3D</a> compresses it to <code>.spz</code> (MIT).</li>
<li><a href="https://sparkjs.dev/">Spark</a> and <a href="https://threejs.org/">three.js</a> draw it in the browser (both MIT; both kept in <code>vendor/</code> beside these pages, with their licences).</li>
<li>Meta's passthrough camera and depth interfaces on the headset; Bambu Studio's command line for slicing.</li>
</ul>
<p class="muted">Part of <a href="../">6ense.com</a> · <a href="./">scans</a> · <a href="live.html">live</a> · <a href="../space/">rooms rebuilt from walks</a></p>
</main>
</body>
</html>
"""

LIST_FOOT = """<footer class="muted">
<p>In a headset, AR and VR need a secure address, which 6ense.com does not have yet: the same page is at <a href="{secure}">{secure_words}</a>, where each scan has an Enter AR or Enter VR button.</p>
<p>Part of <a href="../">6ense.com</a> · <a href="../space/">rooms rebuilt from walks</a> · <a href="../record.html">the record as a plain page</a> · published by the wearer; the camera pictures and the raw recordings stay with them, and what is here was computed from them.</p>
</footer>
</main>
</body>
</html>
"""


def write_list(clone):
    metas = scans_in(clone)
    e = html.escape
    parts = [LIST_HEAD]
    if not metas:
        parts.append('<p class="lede">No scan is published at the moment.</p>\n')
    for m in metas:
        sid = m["id"]
        pics = "".join(f'<img src="runs/{sid}/{e(p["file"])}" alt="{e(p["alt"])}" width="{p["w"]}" height="{p["h"]}" decoding="async">'
                       for p in m["pictures_shown"])
        rows = "".join(f"<dt>{e(a)}</dt><dd>{e(b)}</dd>" for a, b in facts(m))
        files = "".join(f'<li><a href="runs/{sid}/{e(d["file"])}" download>{e(d["label"])}</a> <span class="muted">{mb(d["bytes"])}</span></li>' for d in m["downloads"])
        badge = ('<span class="kind test">a test of the method</span>' if m["kind"] == "test"
                 else '<span class="kind headset">seen by a headset</span>')
        opener = "Look round it in 3-D" if m["mode"] == "view" else "Turn it round in 3-D"
        parts.append(f"""<article class="scan" id="{sid}">
<div class="pics"><a href="view.html?scan={sid}">{pics}</a></div>
<div class="words">
<div>
<h2>{e(m["title"])}</h2>
{badge}
<p class="note">{e(m["note"])}</p>
<a class="open" href="view.html?scan={sid}">{opener}</a>
</div>
<div>
<dl>{rows}</dl>
<ul class="files">{files}</ul>
</div>
</div>
</article>
""")
    parts.append(LIST_FOOT.format(secure=SECURE_COPY, secure_words=SECURE_COPY.split("//", 1)[1]))
    root = os.path.join(clone, "scans")
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "index.html"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join(parts))
    with open(os.path.join(root, "scans.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"scans": [{k: m.get(k) for k in ("id", "title", "kind", "mode", "made", "published", "splat_count")} for m in metas]}, fh, indent=1)
    return metas


def sync_page(clone):
    """The viewer and its libraries, as they are here, into scans/."""
    sys.path.insert(0, VIEWER)
    import fetch_vendor
    if fetch_vendor.missing():
        raise SystemExit("the viewer's libraries are not here: run  python " + os.path.join(VIEWER, "fetch_vendor.py"))
    root = os.path.join(clone, "scans")
    os.makedirs(root, exist_ok=True)
    shutil.copy(os.path.join(VIEWER, "index.html"), os.path.join(root, "view.html"))
    for _, rel, _ in fetch_vendor.FILES:
        dst = os.path.join(root, "vendor", rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(VIEWER, "vendor", rel), dst)
    for name in sorted(os.listdir(EXTRA)) if os.path.isdir(EXTRA) else []:
        if os.path.isfile(os.path.join(EXTRA, name)):
            shutil.copy(os.path.join(EXTRA, name), os.path.join(root, name))
    write_how(clone)


def write_how(clone):
    """scans/how.html (how a scan is made) and scans/tools/ (the tools, as plain files)."""
    root = os.path.join(clone, "scans")
    tools = os.path.join(root, "tools")
    if os.path.isdir(tools):
        shutil.rmtree(tools)
    os.makedirs(tools)
    e = html.escape
    parts = [HOW_HEAD]
    for title, files in TOOLS:
        rows = []
        for src, job in files:
            path = src if os.path.isabs(src) else os.path.normpath(os.path.join(HERE, src))
            if not os.path.exists(path):
                raise SystemExit(f"a tool named for the site is not here: {path}")
            text = open(path, encoding="utf-8", errors="replace").read()
            home = os.path.basename(os.path.expanduser("~"))
            if re.search(r"Users[\\/]+" + re.escape(home), text, re.I):
                raise SystemExit(f"{path} names this computer's user folder: make that path relative to the home folder before it is published")
            name = os.path.basename(path)
            shutil.copy(path, os.path.join(tools, name))
            rows.append(f'<tr><td class="file"><a href="tools/{e(name)}">{e(name)}</a></td><td>{e(job)}</td></tr>')
        parts.append(f'<h3>{e(title)}</h3>\n<div class="table-scroll"><table>\n' + "\n".join(rows) + "\n</table></div>\n")
    parts.append('<p class="muted">The viewer is <a href="view.html">view.html</a> and the live page <a href="live.html">live.html</a>: their source is the page itself. '
                 '<code>scan_view.py</code> expects the viewer as <code>web/splat/index.html</code> beside it, with the libraries <code>fetch_vendor.py</code> fetches.</p>\n')
    parts.append(HOW_FOOT)
    with open(os.path.join(root, "how.html"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join(parts))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", nargs="?", help="a finished run folder (or its name under Downloads\\quest_scans)")
    ap.add_argument("--id", help="the scan's name in its address (letters, digits, dashes); default: from the folder's name")
    ap.add_argument("--title")
    ap.add_argument("--note", help="the paragraph shown with it; default: written from what the run is")
    ap.add_argument("--kind", choices=("headset", "test"), help="default: test when the run has a known answer (truth\\), else headset")
    ap.add_argument("--remove", metavar="ID")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--clone", default=CLONE, help="the local clone of the site's repository")
    ap.add_argument("--no-push", action="store_true", help="write into the clone only")
    ap.add_argument("--message")
    a = ap.parse_args()
    clone = a.clone
    if not os.path.isdir(os.path.join(clone, ".git")):
        raise SystemExit(f"{clone} is not a clone of the site's repository")
    if a.list:
        for m in scans_in(clone):
            print(f"{m['id']:<24} {m['kind']:<8} {m['mode']:<7} {m.get('made')}  {m['title']}")
        return 0
    if not (a.run or a.remove or a.rebuild):
        ap.error("give a run folder, --remove ID, --rebuild or --list")
    other = [l for l in git(clone, "status", "--porcelain").splitlines() if l and not l[3:].startswith("scans/")]
    if other and not a.no_push:
        raise SystemExit("the clone has changes outside scans/ that are not committed; deal with them first:\n  " + "\n  ".join(other[:8]))
    if not a.no_push and not git(clone, "status", "--porcelain"):
        git(clone, "pull", "-q", "--rebase", "origin", "main")            # GitHub or another publish may have moved it
    what = a.message
    if a.remove:
        sid = slug(a.remove)
        folder = os.path.join(clone, "scans", "runs", sid)
        if not os.path.isdir(folder):
            raise SystemExit(f"there is no scan called {sid} in the clone")
        shutil.rmtree(folder)
        log(f"{sid}: taken out of the clone")
        what = what or f"Scans: {sid} taken off"
    if a.run:
        run = a.run if os.path.isdir(a.run) else os.path.join(OUT_ROOT, a.run)
        # the words a scan was published under are kept with the run, so publishing it again says the same
        kept = os.path.join(run, "publish.json")
        said = json.load(open(kept, encoding="utf-8")) if os.path.exists(kept) else {}
        sid = stage(run, clone, a.id or said.get("id"), a.title or said.get("title"), a.note or said.get("note"), a.kind or said.get("kind"))
        m = json.load(open(os.path.join(clone, "scans", "runs", sid, "meta.json"), encoding="utf-8"))
        title = m["title"]
        with open(kept, "w", encoding="utf-8") as fh:
            json.dump({k: m[k] for k in ("id", "title", "note", "kind")}, fh, indent=1)
        what = what or f"Scans: {title}"
    sync_page(clone)
    metas = write_list(clone)
    log(f"the list has {len(metas)} scan(s): " + ", ".join(m["id"] for m in metas))
    if a.no_push:
        log("written into the clone; nothing committed or pushed (--no-push)")
        return 0
    git(clone, "add", "scans")
    if not git(clone, "status", "--porcelain", "scans"):
        log("nothing changed: nothing to push")
        return 0
    if not git(clone, "config", "user.name", check=False):
        raise SystemExit("the clone has no git identity (git config user.name / user.email): set it, then run again")
    git(clone, "commit", "-q", "-m", what or "Scans: the page")
    git(clone, "push", "-q", "origin", "HEAD:main")
    log("pushed. In a minute or two: http://6ense.com/scans/" + (f"view.html?scan={sid}" if a.run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

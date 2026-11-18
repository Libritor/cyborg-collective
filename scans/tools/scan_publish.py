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

and beside them, rewritten every time (write_pages): scans/index.html (the scans as cards) and scans/how.html (how a
scan is made, with the tools), both plain pages with no script whose words and markup are in scan_pages.py;
scans/view.html (the viewer, web/splat/index.html) and scans/live.html (web/scans/live.html); scans/scans.css (the
look: the home page's, see that file); scans/tools/ (the tools as plain files, TOOLS below); scans/vendor/ (three.js
and Spark: the site keeps its libraries beside its pages); scans/scans.json, scans/cover.jpg and the pages' tests.

Then it commits scans/ in the clone under the clone's own git identity and pushes it: GitHub Pages serves it a minute
or two later. A push here does not touch the relay. Publishing is public: a scan of a room shows the room.
(anaconda python: open3d, Pillow)
"""
import argparse
import base64
import datetime
import hashlib
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
        ("scan_pages.py", "The words and the markup of the list of scans and of this page."),
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


# ------------------------------------------------------------------ the pages, the viewer, the look, the libraries, the tools
def scans_in(clone):
    root = os.path.join(clone, "scans", "runs")
    metas = []
    for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        p = os.path.join(root, d, "meta.json")
        if os.path.exists(p):
            metas.append(json.load(open(p, encoding="utf-8")))
    # what a headset saw first, newest first; then the tests of the method
    return sorted(metas, key=lambda m: (m["kind"] == "test", [-ord(c) for c in (m.get("made") or "")], m["id"]))


def publish_tools(root):
    """The tools as plain files in scans/tools/; -> [(group, [(file name, what it is for), ...]), ...] for the page that lists them."""
    tools = os.path.join(root, "tools")
    if os.path.isdir(tools):
        shutil.rmtree(tools)
    os.makedirs(tools)
    home = os.path.basename(os.path.expanduser("~"))
    groups = []
    for title, files in TOOLS:
        rows = []
        for src, job in files:
            path = src if os.path.isabs(src) else os.path.normpath(os.path.join(HERE, src))
            if not os.path.exists(path):
                raise SystemExit(f"a tool named for the site is not here: {path}")
            text = open(path, encoding="utf-8", errors="replace").read()
            if re.search(r"Users[\\/]+" + re.escape(home), text, re.I):
                raise SystemExit(f"{path} names this computer's user folder: make that path relative to the home folder before it is published")
            shutil.copy(path, os.path.join(tools, os.path.basename(path)))
            rows.append((os.path.basename(path), job))
        groups.append((title, rows))
    return groups


def write_pages(clone):
    """Everything in scans/ beside the scans themselves: the list, how a scan is made, the viewer and the live page (as
    they are here, with the home page's stylesheet linked), the look, the libraries, the tests, the tools, and the one
    picture other pages show for the scans (cover.jpg: the first scan's)."""
    sys.path[:0] = [HERE, VIEWER]
    import fetch_vendor
    import scan_pages
    if fetch_vendor.missing():
        raise SystemExit("the viewer's libraries are not here: run  python " + os.path.join(VIEWER, "fetch_vendor.py"))
    root = os.path.join(clone, "scans")
    os.makedirs(root, exist_ok=True)
    css = open(os.path.join(VIEWER, "scans.css"), "rb").read()
    stamp = hashlib.sha1(css).hexdigest()[:8]              # the look's address changes when the look does, so no browser keeps an old one
    metas = scans_in(clone)

    def put(name, text):
        with open(os.path.join(root, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)

    put("index.html", scan_pages.list_page(metas, stamp))
    put("scans.json", json.dumps({"scans": [{k: m.get(k) for k in ("id", "title", "kind", "mode", "made", "published", "splat_count")} for m in metas]}, indent=1))
    put("view.html", scan_pages.with_site_style(open(os.path.join(VIEWER, "index.html"), encoding="utf-8").read(), stamp))
    put("live.html", scan_pages.with_site_style(open(os.path.join(EXTRA, "live.html"), encoding="utf-8").read(), stamp))
    with open(os.path.join(root, "scans.css"), "wb") as fh:
        fh.write(css)
    for _, rel, _ in fetch_vendor.FILES:
        dst = os.path.join(root, "vendor", rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(VIEWER, "vendor", rel), dst)
    for name in sorted(os.listdir(EXTRA)):                 # the pages' tests travel with them
        if os.path.isfile(os.path.join(EXTRA, name)) and name != "live.html":
            shutil.copy(os.path.join(EXTRA, name), os.path.join(root, name))
    put("how.html", scan_pages.how_page(publish_tools(root), stamp))
    if metas:
        shutil.copy(os.path.join(root, "runs", metas[0]["id"], metas[0]["pictures_shown"][0]["file"]), os.path.join(root, "cover.jpg"))
    return metas


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
    metas = write_pages(clone)
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

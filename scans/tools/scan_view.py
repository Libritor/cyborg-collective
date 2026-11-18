#!/usr/bin/env python3
"""Show a scan made by quest_scan.py: the splat and the solid, on this laptop and inside the Quest.

    python scan_view.py [run folder]            # newest run under Downloads\\quest_scans by default
    python scan_view.py --quest                 # also open it in the Quest Browser, through the USB cable
    python scan_view.py --check [--shot out.png]   # start, load the page in headless Chrome, report what it drew, stop

Serves web/splat (the viewer: three.js + Spark, both stored here, nothing fetched from the internet) and the
run's web folder as /data/. Listens on this computer only (127.0.0.1); the headset reaches it through
`adb reverse`, which also makes the address "localhost" there, as WebXR requires. Stop with Ctrl-C.
"""
import argparse
import functools
import http.server
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "web", "splat")
OUT_ROOT = os.path.join(os.path.expanduser("~"), "Downloads", "quest_scans")
TYPES = {".ply": "application/octet-stream", ".glb": "model/gltf-binary", ".stl": "model/stl", ".3mf": "model/3mf", ".js": "text/javascript",
         ".json": "application/json", ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif"}


def newest_run():
    runs = [os.path.join(OUT_ROOT, d) for d in os.listdir(OUT_ROOT)] if os.path.isdir(OUT_ROOT) else []
    runs = [r for r in runs if os.path.exists(os.path.join(r, "web", "meta.json"))]
    if not runs:
        raise SystemExit("no finished scan under " + OUT_ROOT + ": run quest_scan.py first")
    return max(runs, key=lambda r: os.path.getmtime(os.path.join(r, "web", "meta.json")))


class Handler(http.server.SimpleHTTPRequestHandler):
    data = None

    def translate_path(self, path):
        p = path.split("?", 1)[0].split("#", 1)[0]
        if p.startswith("/data/"):
            rel = os.path.normpath(p[len("/data/"):]).replace("\\", "/")
            if rel.startswith("..") or os.path.isabs(rel):
                return os.path.join(self.data, "__none__")
            return os.path.join(self.data, rel)
        return super().translate_path(path)

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower(), super().guess_type(path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *a):
        pass


def serve(run, port):
    """-> (server, the port it got: the one asked for, or one of the next few when an earlier viewer still has it)."""
    Handler.data = os.path.join(run, "web")
    handler = functools.partial(Handler, directory=SITE)
    for p in range(port, port + 8):
        try:
            srv = http.server.ThreadingHTTPServer(("127.0.0.1", p), handler)
        except OSError:
            continue
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv, p
    raise SystemExit(f"ports {port} to {port + 7} are all taken: stop the earlier viewers")


def check(url, shot=None, extra=""):
    """Load the page in the installed Chrome without a window; -> the page's own report."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 1280, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("response", lambda r: errs.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        pg.goto(url + "?shot=1&still=1" + extra)
        try:
            pg.wait_for_function("window.viewer && (window.viewer.ready || window.viewer.error)", timeout=20000)
        except Exception as e:                      # noqa: BLE001
            errs.append("timeout: " + str(e).splitlines()[0])
        pg.wait_for_timeout(2500)
        state = pg.evaluate("() => window.viewer ? JSON.parse(JSON.stringify(window.viewer)) : null")
        # how much of the picture is not background: the splat must actually be drawn
        drawn = pg.evaluate("""() => { const c = document.querySelector('canvas'); if (!c) return 0; const t = document.createElement('canvas'); t.width = 320; t.height = 200;
            const g = t.getContext('2d'); g.drawImage(c, 0, 0, 320, 200); const d = g.getImageData(0, 0, 320, 200).data; let n = 0;
            for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 20) > 40) n++; return n / (320 * 200); }""")
        xr = pg.evaluate("() => !!document.querySelector('button, #xr *') && typeof window.sparkXr === 'object'")
        if shot:
            pg.screenshot(path=shot)
        b.close()
    return {"state": state, "drawn_share": round(drawn, 4), "xr_helper": xr, "errors": errs[:6]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", nargs="?")
    ap.add_argument("--port", type=int, default=8093)
    ap.add_argument("--quest", action="store_true", help="open the page in the Quest Browser (headset on USB, awake)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--shot")
    ap.add_argument("--show", default="", help="for --check: what the page shows, e.g. solid or room (default: the splat)")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    sys.path.insert(0, SITE)
    import fetch_vendor
    if fetch_vendor.missing():
        raise SystemExit("the viewer's libraries are not here yet: run  python " + os.path.join(SITE, "fetch_vendor.py"))
    run = os.path.normpath(a.run) if a.run else newest_run()
    if not os.path.exists(os.path.join(run, "web", "meta.json")):
        raise SystemExit(f"{run} has no web folder yet: run quest_scan.py on it")
    srv, port = serve(run, a.port)
    a.port = port
    url = f"http://localhost:{a.port}/"
    print(f"[view] {os.path.basename(run)} at {url}", flush=True)
    if a.check:
        rep = check(url, a.shot, "".join("&" + s + "=1" for s in a.show.split(",") if s))
        srv.shutdown()
        print("[view] check:", rep)
        ok = bool(rep["state"] and rep["state"].get("ready") and rep["state"].get("splats", 0) > 0 and rep["drawn_share"] > 0.01)
        print("VIEW", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    if a.quest:
        env = dict(os.environ, MSYS_NO_PATHCONV="1")
        r = subprocess.run(["adb", "reverse", f"tcp:{a.port}", f"tcp:{a.port}"], capture_output=True, text=True, env=env)
        if r.returncode != 0:
            print("[view] no headset on adb:", (r.stderr or r.stdout).strip())
        else:
            subprocess.run(["adb", "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "com.oculus.browser"], capture_output=True, text=True, env=env)
            print("[view] opened in the Quest Browser: press Enter AR (bottom right) inside the headset", flush=True)
    elif not a.no_browser:
        import webbrowser
        webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

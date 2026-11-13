"""The rooms page: every walk loads (surface or points, the walk's line, the film of its maps) on a desktop and a phone.

    python space/test_space_page.py [URL of the space page] [folder for pictures]

Without a URL it serves this repository on a free local port. Uses the installed Chrome, because the films are
H.264 and the test browser that comes with Playwright cannot play that.
"""
import functools
import http.server
import json
import os
import re
import sys
import threading

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = {"room": True, "room-fine": False, "first": False, "lab": True}        # id -> has a fused surface
SIDE = {"room": 2, "lab": 0}          # how a surface starts: both sides (2) or seen from its front only (0), as each walk suits
passed, failed = 0, []


def check(ok, what):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(what)
        print("  FAIL", what)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files with byte ranges, which a browser needs to move about in a film (GitHub Pages serves them too)."""

    def log_message(self, *a):
        pass

    def send_head(self):
        path = self.translate_path(self.path.split("#")[0].split("?")[0])
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
        if not m or not os.path.isfile(path):
            self._left = None
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2) or 0))
        end = min(size - 1, int(m.group(2))) if m.group(1) and m.group(2) else size - 1
        if start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._left = end - start + 1
        return f

    def copyfile(self, source, out):
        left = getattr(self, "_left", None)
        try:
            if left is None:
                return super().copyfile(source, out)
            while left > 0:
                chunk = source.read(min(65536, left))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)
        except (ConnectionError, BrokenPipeError):
            pass                                    # the browser dropped a range it no longer wants


class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass


def main():
    url = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    shots = sys.argv[2] if len(sys.argv) > 2 else None
    server = None
    if not url:
        server = Server(("127.0.0.1", 0), functools.partial(Handler, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/space/" % server.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                                                      "--autoplay-policy=no-user-gesture-required",
                                                      "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"])   # the site is served over plain http
        for name, size in (("desktop", (1280, 800)), ("phone", (390, 844))):
            pg = b.new_context(viewport={"width": size[0], "height": size[1]}).new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            for rid, has_mesh in RUNS.items():
                pg.goto(url + "#" + rid, wait_until="domcontentloaded")
                pg.reload(wait_until="domcontentloaded")           # a hash change alone does not reload: start each walk cold
                pg.wait_for_function("id => window.__space && window.__space.state[id] && window.__space.state[id].loaded", arg=rid, timeout=120000)
                pg.wait_for_function("() => window.__space.video.readyState >= 2", timeout=60000)
                pg.evaluate("() => { const v = window.__space.video; v.pause(); v.currentTime = 0; }")
                pg.wait_for_timeout(400)
                first = pg.evaluate("id => window.__space.state[id].marker.position.toArray()", rid)
                pg.evaluate("() => { const v = window.__space.video; v.currentTime = v.duration * 0.6; }")
                pg.wait_for_timeout(700)
                s = pg.evaluate("""id => { const s = window.__space.state[id], v = window.__space.video, d = document.documentElement;
                  const film = document.getElementById('film').getBoundingClientRect(), panel = document.getElementById('panel').getBoundingClientRect();
                  return { mesh: !!s.mesh, points: s.points.children.length ? s.points.children[0].geometry.attributes.position.count : 0,
                    pointsShown: s.points.visible, views: s.path.centres.length, infoViews: s.info.views, fps: s.info.fps, view: s.view,
                    marker: s.marker.position.toArray(), duration: v.duration, vw: v.videoWidth, vh: v.videoHeight,
                    title: document.getElementById('run-title').textContent, facts: document.getElementById('run-facts').textContent,
                    note: document.getElementById('film-note').textContent, near: document.getElementById('near').textContent,
                    status: document.getElementById('status').textContent, pressed: [...document.querySelectorAll('#runs button[aria-pressed=true]')].map(b => b.dataset.id),
                    overflow: d.scrollWidth - d.clientWidth, film: [film.left, film.top, film.right, film.bottom], panel: [panel.left, panel.top, panel.right, panel.bottom],
                    win: [innerWidth, innerHeight], printShown: !document.getElementById('print').hidden, aboutOpen: document.getElementById('about').open,
                    panelFits: document.getElementById('panel').scrollHeight <= document.getElementById('panel').clientHeight + 1,
                    insideOff: document.getElementById('inside').disabled, side: s.mesh ? (() => { let v = null; s.mesh.traverse(o => { if (o.isMesh) v = o.material.side; }); return v; })() : null,
                    canvas: [document.querySelector('#view canvas').clientWidth, document.querySelector('#view canvas').clientHeight] }; }""", rid)
                tag = name + " " + rid
                check(s["mesh"] == has_mesh, tag + ": surface %s" % ("missing" if has_mesh else "unexpected"))
                check(s["points"] > 1000, tag + ": sparse points (%d)" % s["points"])
                check(s["pointsShown"] == (not has_mesh), tag + ": points shown exactly when there is no surface")
                check(s["views"] == s["infoViews"] and s["views"] > 50, tag + ": the walk has one position per view")
                check(abs(s["duration"] - s["views"] / s["fps"]) < 0.3, tag + ": the film is one frame per view (%.1f s for %d views)" % (s["duration"], s["views"]))
                check(s["vw"] > 500 and s["vh"] == 288, tag + ": film size %sx%s" % (s["vw"], s["vh"]))
                check(abs(s["view"] - int(s["duration"] * 0.6 * s["fps"])) <= 2, tag + ": the marker is at the view the film shows (%s)" % s["view"])
                check(sum(abs(a - c) for a, c in zip(first, s["marker"])) > 0.01, tag + ": the marker moved with the film")
                check(s["pressed"] == [rid] and s["title"] and s["facts"] and "views" in s["facts"], tag + ": the words are this walk's")
                check("m" in s["near"] and s["note"], tag + ": the colour scale is labelled")
                check(s["overflow"] <= 0, tag + ": no sideways scroll (%s)" % s["overflow"])
                check(s["film"][0] >= 0 and s["film"][2] <= s["win"][0] + 0.5 and s["film"][3] <= s["win"][1] + 0.5, tag + ": the film is inside the window %s" % s["film"])
                check(s["panel"][3] <= s["film"][1] + 0.5, tag + ": the words do not cover the film")
                check(s["printShown"] == (rid == "room"), tag + ": the print link shows only for the room that has one")
                check(s["panelFits"], tag + ": all the words fit without scrolling")
                check(s["insideOff"] == (not has_mesh) and s["side"] == SIDE.get(rid), tag + ": the surface starts drawn the way this walk suits (side %s)" % s["side"])
                check(s["canvas"][0] >= 300 and s["canvas"][1] >= 300, tag + ": the 3-D view has room %s" % s["canvas"])
                if name == "phone":
                    check(not s["aboutOpen"], tag + ": the words start closed on a phone")
                    check(s["film"][1] - s["panel"][3] >= 280, tag + ": the room shows between the words and the film (%d px)" % (s["film"][1] - s["panel"][3]))
                if shots:
                    os.makedirs(shots, exist_ok=True)
                    pg.screenshot(path=os.path.join(shots, "%s_%s.png" % (name, rid)))
                print("  %s: %s" % (tag, json.dumps({k: s[k] for k in ("mesh", "points", "views", "duration", "view", "status")})))
            check(not errors, name + ": no page errors %s" % errors[:2])
            pg.context.close()
        b.close()
    if server:
        server.shutdown()
    print("PASS %d" % passed if not failed else "FAIL %d of %d: %s" % (len(failed), passed + len(failed), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

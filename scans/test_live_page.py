#!/usr/bin/env python3
"""The live page (scans/live.html), checked in a real browser.

    python scans/test_live_page.py                        the files in this repository, served from a local port
    python scans/test_live_page.py http://6ense.com/      what is published
    add  --through wss://cyborg-collective-relay.onrender.com   to also send a labelled test pattern through that
         relay, as a headset's computer would, and require the page to draw it and let it go (about ten seconds
         on the public page under the name "Test pattern (not a room)"; use it after a relay deploy, not as a habit)
    add a folder name to keep pictures

Without --through nothing is sent anywhere: a made-up room (a box with a ball in it, as splats 6 cm apart) is handed
to the page's own entry point, as the relay would hand it on. Checked: with nobody scanning the page shows the most
recent finished scan and says so; the made-up room arrives as one Gaussian per 2 cm cell and is drawn; sent twice it
does not pile up; from outside, surfaces facing away are left out so the room can be looked into; "ride with the
headset" stands where the headset is and looks where it looks (the wall ahead, not the one behind); when the sender
leaves, the page says so and keeps what arrived; scripts off and a phone's width; nothing asked of another site.
Needs playwright, numpy and the installed Chrome (and websockets for --through).
"""
import asyncio
import base64
import functools
import http.server
import json
import os
import secrets
import sys
import threading
import time

import numpy as np
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed, failed = 0, []
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader",
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"]
NAME = "Test pattern (not a room)"
Q, ORIGIN, CELL = 0.005, [0.0, 0.0, 1.35], 0.02
AHEAD, BEHIND = (90, 130, 190), (200, 120, 90)            # the wall the made-up headset faces, and the one at its back
PIXELS = """() => { const c = document.querySelector('#stage canvas'); const t = document.createElement('canvas'); t.width = 320; t.height = 200;
  const g = t.getContext('2d'); g.drawImage(c, 0, 0, 320, 200); const d = g.getImageData(0, 0, 320, 200).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 20) > 40) n++;
  const m = g.getImageData(150, 90, 20, 20).data; let r = 0, gr = 0, b = 0; for (let i = 0; i < m.length; i += 4) { r += m[i]; gr += m[i + 1]; b += m[i + 2]; }
  return { drawn: n / (320 * 200), middle: [r / 400, gr / 400, b / 400] }; }"""
SIDEWAYS = "() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth"


def check(ok, what, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(what)
        print("  FAIL %s %s" % (what, str(detail)[:300]))


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary", ".spz": "application/octet-stream", ".jpg": "image/jpeg"})

    def log_message(self, *a):
        pass


def room():
    """A made-up room 4 m deep, 5 m wide and 2.7 m high with a ball in it, as splats 6 cm apart that face into the room.
    x forward, y left, z up, metres. -> positions, facings, colours."""
    s = 0.06
    xs, ys, zs = np.arange(-2 + s / 2, 2, s), np.arange(-2.5 + s / 2, 2.5, s), np.arange(s / 2, 2.7, s)
    parts = []

    def sheet(a, b, place, normal, colour):
        aa, bb = np.meshgrid(a, b)
        p = place(aa.ravel(), bb.ravel())
        parts.append((p, np.tile(np.array(normal, float), (len(p), 1)), np.tile(np.array(colour, float), (len(p), 1))))

    full = lambda v, n: np.full(n, float(v))
    sheet(xs, ys, lambda a, b: np.c_[a, b, full(0, len(a))], (0, 0, 1), (196, 178, 150))            # floor
    sheet(xs, ys, lambda a, b: np.c_[a, b, full(2.7, len(a))], (0, 0, -1), (232, 232, 226))        # ceiling
    sheet(ys, zs, lambda a, b: np.c_[full(2, len(a)), a, b], (-1, 0, 0), AHEAD)                     # the wall ahead
    sheet(ys, zs, lambda a, b: np.c_[full(-2, len(a)), a, b], (1, 0, 0), BEHIND)                    # the wall behind
    sheet(xs, zs, lambda a, b: np.c_[a, full(2.5, len(a)), b], (0, -1, 0), (120, 170, 120))
    sheet(xs, zs, lambda a, b: np.c_[a, full(-2.5, len(a)), b], (0, 1, 0), (205, 190, 120))
    k = np.arange(1500) + 0.5                                                                       # a ball on the floor
    phi, th = np.arccos(1 - 2 * k / 1500), np.pi * (1 + 5 ** 0.5) * k
    v = np.c_[np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)]
    parts.append((np.array([1.0, -0.8, 0.5]) + 0.35 * v, v, np.tile(np.array([230.0, 70, 60]), (1500, 1))))
    return [np.concatenate([p[i] for p in parts]) for i in range(3)]


def pack(pos, nrm, col):
    """12 bytes a splat, as quest_splat.py packs them."""
    o = nrm / np.abs(nrm).sum(1, keepdims=True)                      # the facing, folded onto an octahedron
    neg = o[:, 2] < 0
    ox, oy = o[:, 0].copy(), o[:, 1].copy()
    ox[neg] = (1 - np.abs(o[neg, 1])) * np.where(o[neg, 0] >= 0, 1, -1)
    oy[neg] = (1 - np.abs(o[neg, 0])) * np.where(o[neg, 1] >= 0, 1, -1)
    rec = np.zeros(len(pos), np.dtype([("p", "<i2", 3), ("c", "u1", 3), ("r", "u1"), ("n", "i1", 2)]))
    rec["p"] = np.round((pos - np.array(ORIGIN)) / Q)
    rec["c"], rec["r"] = np.round(col), 20                           # radius 50 mm: at 6 cm apart the Gaussians close up into surfaces
    rec["n"][:, 0], rec["n"][:, 1] = np.round(127 * ox), np.round(127 * oy)
    return rec


def chunks(per=4000):
    pos, nrm, col = room()
    order = np.random.default_rng(1).permutation(len(pos))          # as a headset would send it: from all over, not wall by wall
    rec = pack(pos[order], nrm[order], col[order])
    back = np.array(ORIGIN) + rec["p"].astype(np.float64) * Q        # where the page will put them
    cells = np.floor(back / CELL).astype(np.int64)
    expected = len(np.unique(cells, axis=0))
    out, total = [], 0
    for i in range(0, len(rec), per):
        part = rec[i:i + per]
        total += len(part)
        out.append({"t": "splat", "ts": int(time.time() * 1000), "src": "test", "n": int(len(part)), "q": Q, "origin": ORIGIN,
                    "cam": [0, 0, 1.55, 0, 0, 0, 1], "total": total, "d": base64.b64encode(part.tobytes()).decode()})
    return out, expected


def through(relay, msgs, result):
    """The same chunks sent as a headset's computer sends them: hello at tier camera, splat chunks, bye."""
    import websockets

    async def go():
        async with websockets.connect(relay.rstrip("/") + "/ingest") as ws:
            await ws.send(json.dumps({"t": "hello", "v": 1, "session": secrets.token_hex(16), "pseudonym": "splat-test", "tier": "camera",
                                      "device": "test", "name": NAME, "log": False}))
            result["hello"] = json.loads(await ws.recv())
            for m in msgs:
                await ws.send(json.dumps(m))
                await asyncio.sleep(0.45)                             # the relay passes three chunks a second
            await asyncio.sleep(result.get("hold", 4.0))
            await ws.send(json.dumps({"t": "bye", "reason": "test done"}))
            result["sent"] = sum(m["n"] for m in msgs)
    try:
        asyncio.run(go())
    except Exception as e:                                            # noqa: BLE001
        result["error"] = "%s: %s" % (type(e).__name__, e)


def main():
    args = sys.argv[1:]
    relay = args[args.index("--through") + 1] if "--through" in args else None
    rest = [a for i, a in enumerate(args) if a != "--through" and (i == 0 or args[i - 1] != "--through")]
    url = next((a for a in rest if a.startswith("http")), None)
    shots = next((a for a in rest if not a.startswith("http")), None)
    if shots:
        os.makedirs(shots, exist_ok=True)
    if url and not url.endswith("/"):
        url += "/"
    server = None
    if not url:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/" % server.server_address[1]
    host = url.split("//", 1)[1].split("/", 1)[0]
    msgs, expected = chunks()
    stamp = {"pseudonym": "splat-test", "kind": "camera", "tier": "camera", "device": "test", "name": NAME}
    first = json.load(open(os.path.join(ROOT, "scans", "scans.json"), encoding="utf-8"))["scans"][0]
    state = "() => JSON.parse(JSON.stringify(window.live || null))"

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=ARGS)

        def page(js=True, width=1280, height=800):
            ctx = b.new_context(viewport={"width": width, "height": height}, java_script_enabled=js)
            pg = ctx.new_page()
            errors, outside = [], []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("request", lambda r: outside.append(r.url) if r.url.startswith("http") and r.url.split("//", 1)[1].split("/", 1)[0] != host else None)
            pg.on("websocket", lambda w: outside.append(w.url))
            return pg, errors, outside

        print("1. nobody scanning: the most recent finished scan stands in")
        pg, errors, outside = page()
        pg.goto(url + "scans/live.html?relay=off&shot=1&still=1", wait_until="load")
        pg.wait_for_function("() => window.live && (window.live.ready || window.live.error)", timeout=60000)
        pg.wait_for_function("() => window.live.idle", timeout=30000)
        st = pg.evaluate(state)
        check(st["ready"] and st["idle"] == first["id"] and not st["live"], "the page starts, nobody is live, and it takes the first scan on the list (%s)" % first["id"], st)
        check("nobody is scanning right now" in pg.inner_text("#what") and first["title"] in pg.inner_text("#facts") and "most recent finished scan" in pg.inner_text("#facts"),
              "it says that nobody is scanning and names the finished scan it shows instead", pg.inner_text("#what"))
        frame, t0 = None, time.time()
        while not frame and time.time() - t0 < 30:                  # the frame has its address only once its page has begun to arrive
            frame = next((f for f in pg.frames if "view.html" in f.url), None)
            if not frame:
                pg.wait_for_timeout(300)
        ok = False
        if frame:
            try:
                frame.wait_for_function("() => window.viewer && (window.viewer.ready || window.viewer.error)", timeout=120000)
                ok = frame.evaluate("() => window.viewer.ready && window.viewer.splats > 0 && getComputedStyle(document.getElementById('panel')).display === 'none'")
            except Exception:
                pass
        check(pg.locator("#idle").is_visible() and ok, "that scan is drawn in the frame, without its own panel")
        check(pg.locator('#bOpen[href="view.html?scan=%s"]' % first["id"]).is_visible(), "and a button opens it in full")
        if shots:
            pg.wait_for_timeout(1500); pg.screenshot(path=os.path.join(shots, "live_idle.png"))

        print("2. a made-up room arrives")
        for m in msgs:
            pg.evaluate("m => window.liveFeed(m)", dict(m, **stamp))
        pg.wait_for_timeout(2500)
        st = pg.evaluate(state)
        check(st["live"] and st["gaussians"] == expected and st["sensor"] == "splat-test", "every 2 cm cell that was sent is one Gaussian (%d)" % expected, {k: st[k] for k in ("live", "gaussians", "sensor")})
        check(st["idle"] is None and not pg.locator("#idle").is_visible(), "the finished scan steps aside")
        check(("scanning now: " + NAME) in pg.inner_text("#what") and "Gaussians here" in pg.inner_text("#facts"), "the page says who is scanning and how much has arrived", pg.inner_text("#what"))
        px = pg.evaluate(PIXELS)
        check(px["drawn"] > 0.08, "the room is drawn (%.0f %% of the picture)" % (100 * px["drawn"]), px)
        check(0.3 * expected < st["shown"] < 0.92 * expected, "from outside, the surfaces that face away are left out, so the room can be looked into (%d of %d shown)" % (st["shown"], expected))
        if shots:
            pg.screenshot(path=os.path.join(shots, "live_room.png"))
        for m in msgs[:3]:
            pg.evaluate("m => window.liveFeed(m)", dict(m, **stamp))
        pg.wait_for_timeout(600)
        check(pg.evaluate(state)["gaussians"] == expected, "sent again, a place is refined and does not pile up")

        print("3. riding with the headset")
        pg.click("#bRide")
        pg.wait_for_timeout(1500)
        st, px = pg.evaluate(state), pg.evaluate(PIXELS)
        check(st["eye"] and max(abs(st["eye"][0]), abs(st["eye"][1] - 1.55), abs(st["eye"][2])) < 0.02, "the eye stands where the headset is", st.get("eye"))
        check(st["shown"] > 0.95 * expected, "from inside, nearly every surface faces the eye (%d of %d)" % (st["shown"], expected))
        mid = px["middle"]
        check(abs(mid[2] - AHEAD[2]) < 60 and mid[2] > mid[0] + 30, "and it looks where the headset looks: the wall ahead is in the middle of the picture, not the one behind", mid)
        if shots:
            pg.screenshot(path=os.path.join(shots, "live_ride.png"))
        pg.click("#bRide")

        print("4. the sender leaves")
        pg.evaluate("m => window.liveFeed(m)", {"t": "leave", "pseudonym": "splat-test", "reason": "test done"})
        pg.wait_for_timeout(1200)
        st = pg.evaluate(state)
        check(not st["live"] and st["gaussians"] == expected and "the scan has stopped" in pg.inner_text("#what") and "not trained" in pg.inner_text("#facts"),
              "the page says the scan has stopped, keeps what arrived, and says these were placed and not trained", pg.inner_text("#what"))
        check(pg.evaluate(PIXELS)["drawn"] > 0.08 and not errors, "what arrived is still drawn; no script error", errors[:2])
        check(not outside, "nothing was asked of another site", outside[:3])
        pg.context.close()

        print("5. the edges")
        pg, errors, outside = page(js=False)
        pg.goto(url + "scans/live.html", wait_until="load")
        check(pg.locator("#plain").is_visible() and pg.locator('#plain a[href="./"]').count() == 1 and not pg.locator("#panel").is_visible(), "scripts off: it says so and points to the list")
        pg.context.close()
        pg, errors, outside = page(width=390, height=844)
        pg.goto(url + "scans/live.html?relay=off", wait_until="load")
        pg.wait_for_timeout(2500)
        over = pg.evaluate(SIDEWAYS)
        check(over <= 0 and not errors, "a phone: the page is as wide as the screen, no script error", ("%d px too wide" % over, errors[:2]))
        pg.context.close()

        if relay:
            print("6. through the relay at " + relay)
            pg, errors, outside = page()
            pg.goto(url + "scans/live.html?shot=1&still=1&relay=" + relay.rstrip("/") + "/live", wait_until="load")
            pg.wait_for_function("() => window.live && window.live.ready && window.live.link === 'open'", timeout=60000)
            result = {"hold": 4.0}
            t = threading.Thread(target=through, args=(relay, msgs, result))
            t.start()
            try:
                pg.wait_for_function("n => window.live.live && window.live.gaussians >= n", arg=int(0.9 * expected), timeout=60000)
            except Exception:
                pass
            st = pg.evaluate(state)
            check(st["live"] and st["gaussians"] >= 0.9 * expected and st["sensor"] == "splat-test",
                  "what was sent to the relay arrives on the page as Gaussians (%d of %d cells)" % (st["gaussians"], expected), (st, result))
            check(pg.evaluate(PIXELS)["drawn"] > 0.08 and NAME in pg.inner_text("#what"), "and is drawn, under the sender's name")
            if shots:
                pg.screenshot(path=os.path.join(shots, "live_through_relay.png"))
            t.join(60)
            try:
                pg.wait_for_function("() => !window.live.live", timeout=30000)
            except Exception:
                pass
            check(not pg.evaluate(state)["live"] and "the scan has stopped" in pg.inner_text("#what") and not result.get("error") and not errors,
                  "when the sender says goodbye the page says the scan has stopped; no error", (result, errors[:2]))
            pg.context.close()
        b.close()
    if server:
        server.shutdown()
    print("PASS %d checks" % passed if not failed else "FAIL %d of %d: %s" % (len(failed), passed + len(failed), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

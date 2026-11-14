"""What has to stay true for this site to outlive its own changes. Run it before every push.

    python test_survives.py [URL]        -> "PASS <n> checks", exit 0

The site is built in layers, and each layer is allowed to fail without taking the ones under it down:

    1. plain pages     index.html's words, record.html, the films under space/: no script needed
    2. the record      app.js fills the tables from data/*.json and projects.json
    3. live            the relay (another computer): who is sharing now, the lists it keeps
    4. the band        music/: sound and the two panels at the top
    5. extras          splat-view.js, video-rtc.js, space/'s 3-D view

The checks below take the layers away one at a time and look at what is left. They also check the rules that
keep it that way: nothing is loaded from another site, every file a page asks for is in the repository, each
module is asked for under one version tag, and record.html matches the data.

Without a URL the repository is served on a free local port. Give http://6ense.com/ to check what is published
(the file checks still read this folder).
"""
import functools
import glob
import importlib.util
import json
import os
import re
import sys
import threading

sys.dont_write_bytecode = True
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.abspath(__file__))
RELAY = "cyborg-collective-relay.onrender.com"        # the one other computer the site talks to, and only for what is live
passed, failed = 0, []


def check(ok, what, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(what)
        print("  FAIL %s %s" % (what, str(detail)[:300]))


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def pages():
    out = [p for p in glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True) if os.sep + "vendor" + os.sep not in p and "test_" not in os.path.basename(p)]
    return sorted(os.path.relpath(p, ROOT).replace("\\", "/") for p in out)


def scripts():
    out = [p for p in glob.glob(os.path.join(ROOT, "**", "*.js"), recursive=True)
           if os.sep + "vendor" + os.sep not in p and not os.path.basename(p).startswith("test_") and os.sep + "node_modules" + os.sep not in p]
    return sorted(os.path.relpath(p, ROOT).replace("\\", "/") for p in out)


# ------------------------------------------------------------------ the files themselves
def file_checks():
    print("files")
    pj = json.loads(read("projects.json"))
    ok = isinstance(pj, dict) and isinstance(pj.get("projects"), list) and all(isinstance(p, dict) and p.get("id") and p.get("name") for p in pj["projects"])
    check(ok, "projects.json is an object with a list of projects, as the page reads it", type(pj).__name__)

    idx = json.loads(read("data/index.json"))
    rec = read("record.html")
    rows = len(re.findall(r"<tr><td>", rec))
    check(rows == len(idx["sessions"]), "record.html lists every session in data/index.json", "%d rows for %d sessions: run build_record.py" % (rows, len(idx["sessions"])))
    check("<script" not in rec.lower(), "record.html has no script on it")
    check(str(idx.get("built", "?")) in rec, "record.html was written from this catalogue (same build stamp)")

    # nothing is loaded from another site: a page that needs someone else's server stops when that server changes
    outside = []
    load = re.compile(r"""<(?:script|link|img|iframe|video|audio|source)\b[^>]*?\b(?:src|href)=["']?(https?:)?//[^"'\s>]+""", re.I)
    for rel in pages():
        text = read(rel)
        outside += ["%s: %s" % (rel, m.group(0)[-80:]) for m in load.finditer(text)]
        for m in re.finditer(r'<script type="importmap">(.*?)</script>', text, re.S):
            outside += ["%s: importmap %s" % (rel, u) for u in re.findall(r'"(https?://[^"]+)"', m.group(1))]
    for rel in scripts():
        outside += ["%s: %s" % (rel, m.group(0)[:90]) for m in re.finditer(r"""(?:\bfrom\s*|\bimport\s*\(\s*|importScripts\s*\(\s*)["'](?:https?:)?//[^"']+""", read(rel))]
    check(not outside, "no page or script loads code, styles, pictures or film from another site", outside[:4])

    # every local file a page or a module asks for is here
    missing = []
    for rel in pages():
        base = os.path.dirname(rel)
        for m in re.finditer(r"""<(?:script|link)\b[^>]*?\b(?:src|href)=["']?([^"'\s>]+)""", read(rel), re.I):
            u = m.group(1).split("?")[0].split("#")[0]
            if u and not re.match(r"(https?:)?//|data:|mailto:", u) and not os.path.exists(os.path.normpath(os.path.join(ROOT, base, u))):
                missing.append("%s -> %s" % (rel, u))
    imports = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}/[^"'?]+)(?:\?v=(\w+))?["']""")
    tags = {}
    for rel in scripts() + pages():
        base = os.path.dirname(rel)
        for m in imports.finditer(read(rel)):
            target = os.path.normpath(os.path.join(base, m.group(1))).replace("\\", "/")
            if not os.path.exists(os.path.join(ROOT, target)):
                missing.append("%s -> %s" % (rel, m.group(1)))
            tags.setdefault(target, set()).add(m.group(2))
    check(not missing, "every file a page or a module asks for is in the repository", missing[:5])
    # one module, one address: asked for under two version tags it would load twice and the two copies would not share state
    mixed = {t: sorted(str(v) for v in vs) for t, vs in tags.items() if len(vs) > 1 and not t.endswith("player.js")}
    check(not mixed, "each module is asked for under one version tag everywhere", mixed)

    # the head is shown as shape and grey: no scanner file and no patient field may ever sit beside it
    leaked = []
    for name in sorted(os.listdir(os.path.join(ROOT, "head"))):
        full = os.path.join(ROOT, "head", name)
        if os.path.isfile(full) and not name.endswith(".py"):
            blob = open(full, "rb").read()
            if b"DICM" in blob[:256] or b"PatientName" in blob or b"PatientBirth" in blob or b"PatientID" in blob:
                leaked.append(name)
    check(not leaked, "head/ holds no scanner file and no patient field", leaked)

    # the home page's slider steps through a sheet of pictures: the sheet must hold as many as the page says
    m = re.search(r'data-sheet="([^"]+)" data-frames="(\d+)" data-cols="(\d+)"', read("index.html"))
    sheet_ok = False
    if m and os.path.exists(os.path.join(ROOT, m.group(1))):
        from PIL import Image
        w, h = Image.open(os.path.join(ROOT, m.group(1))).size
        frames, cols = int(m.group(2)), int(m.group(3))
        cell = w // cols
        sheet_ok = w % cols == 0 and h % cell == 0 and (h // cell) * cols >= frames > (h // cell - 1) * cols
    check(sheet_ok, "the head's sheet of pictures holds the number of pictures the home page's slider steps through", m.groups() if m else "no sheet named")

    vend = os.path.join(ROOT, "space", "vendor", "three")
    check(os.path.exists(os.path.join(vend, "LICENSE")) and os.path.getsize(os.path.join(vend, "three.module.min.js")) > 500000,
          "the 3-D library the rooms page uses is kept beside it, with its licence")


# ------------------------------------------------------------------ the pages in a browser, layers taken away
ROWS = "() => document.querySelectorAll('#rows tr.row').length"
SIDEWAYS = "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
VISIBLE_TEXT = """() => { const out = []; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const e = n.parentElement; if (!n.textContent.trim() || !e || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(e.tagName)) continue;
    const r = e.getClientRects(); if (r.length && getComputedStyle(e).visibility !== 'hidden') out.push(n.textContent.trim()); }
  return out.join(' \\n '); }"""


def browser_checks(url, serve):
    from playwright.sync_api import sync_playwright
    projects = [p["name"] for p in json.loads(read("projects.json"))["projects"]]
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])

        def page(js=True, width=1280, height=900, block=()):
            ctx = b.new_context(viewport={"width": width, "height": height}, java_script_enabled=js)
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)[:160]))
            if block:
                pg.route("**/*", lambda route: route.abort() if any(k in route.request.url for k in block) else route.continue_())
            return pg, errors

        print("1. scripts off: the plain pages stand alone")
        pg, _ = page(js=False)
        pg.goto(url, wait_until="load")
        text = pg.inner_text("body")
        check("Cyborg Collective" in text and "A window the person opens" in text, "home, scripts off: says what the page is")
        check("How this page is honest" in text and "no claim" in text, "home, scripts off: the honesty list is there")
        note = pg.locator(".noscript-note")
        check(note.count() == 1 and note.is_visible() and note.locator('a[href="record.html"]').count() == 1, "home, scripts off: a note points to the record as a plain page")
        stale = [w for w in ("connecting…", "loading…", "loading the band", "Nobody is sharing right now") if pg.get_by_text(w, exact=False).first.is_visible()] if True else []
        check(not stale, "home, scripts off: nothing claims to be loading, connecting or empty", stale)
        check(pg.locator("table.sessions:visible").count() == 0 and pg.locator("#listen:visible").count() == 0, "home, scripts off: no empty tables, no dead button")
        check(pg.locator('nav a[href="space/"]').count() == 1, "home: the menu links to the rooms")
        pg.goto(url + "record.html", wait_until="load")
        n = pg.locator("table.sessions tbody tr").count()
        check(n == len(json.loads(read("data/index.json"))["sessions"]), "record.html, scripts off: every session is on the page (%d rows)" % n)
        check(any(name in pg.inner_text("body") for name in projects), "record.html: sessions carry their project names")
        pg.goto(url + "space/", wait_until="load")
        films = pg.locator("#plain a[href$='maps.mp4']")
        check(films.count() == 4 and pg.locator("#plain").is_visible(), "rooms, scripts off: the four films are offered as plain links")
        for i in range(films.count()):
            r = pg.context.request.get(url + "space/" + films.nth(i).get_attribute("href"), headers={"Range": "bytes=0-1023"})
            check(r.status in (200, 206) and "video/mp4" in r.headers.get("content-type", ""), "rooms: %s is a video file that answers" % films.nth(i).get_attribute("href"), r.status)
        pg.goto(url + "head/", wait_until="load")
        check(pg.locator("#plain").is_visible() and pg.locator("#plain img[src='still.png']").count() == 1 and "CT scan" in pg.inner_text("#plain"),
              "the head, scripts off: its still picture and its words stand in")
        check(pg.context.request.get(url + "head/still.png").status == 200, "the head: the still picture answers")
        pg.goto(url, wait_until="load")
        check(pg.locator('.head-link a[href="head/"] img').count() == 1 and pg.locator(".head-link").is_visible(), "home, scripts off: the picture of the head is there and links to it")
        check(pg.locator('.head-link a[href*="fletcher"]').count() == 1 and "Mann" not in pg.inner_text(".head-link"), "home: the head is offered as a head, with Rich Fletcher named as the inspiration")
        check(pg.locator(".head-slider:visible").count() == 0 and pg.locator(".head-link img:visible").count() == 1, "home, scripts off: no slider that could not move anything; the still picture stands")
        pg.context.close()

        print("2. the relay gone: the record and the band carry on")
        pg, errors = page(block=(RELAY,))
        pg.goto(url + "?relay=wss://127.0.0.1:9/live", wait_until="load")
        pg.wait_for_function("() => document.querySelectorAll('#rows tr.row').length > 300", timeout=60000)
        cells = pg.evaluate("() => [...document.querySelectorAll('#rows tr.row td:nth-child(2)')].map(td => td.textContent.trim())")
        named = {c for c in cells if c in projects}
        check(len(cells) > 300, "relay gone: the record's table is filled (%d rows)" % len(cells))
        check(len(named) >= 3, "relay gone: sessions are tagged with their projects (%d of the projects appear)" % len(named), sorted(named))
        pg.wait_for_function("() => window.__band || /could not load/.test(document.getElementById('listen-status').textContent)", timeout=60000)
        check(pg.evaluate("() => !!window.__band"), "relay gone: the band still loads (it plays from the record)", pg.inner_text("#listen-status"))
        check(pg.inner_text("#link").strip() != "live", "relay gone: the page does not claim to be live (%s)" % pg.inner_text("#link").strip()[:40])
        check(not errors, "relay gone: no script error", errors[:2])
        pg.context.close()

        print("3. the band gone: the page says so and the record carries on")
        pg, errors = page(block=("/music/",))
        pg.goto(url, wait_until="load")
        pg.wait_for_function("() => document.querySelectorAll('#rows tr.row').length > 300", timeout=60000)
        pg.wait_for_function("() => /could not load/.test(document.getElementById('listen-status').textContent)", timeout=30000)
        check(True, "band gone: the record's table is filled and the menu says the band could not load")
        check(not errors, "band gone: no script error", errors[:2])
        pg.context.close()

        print("4. the extras gone: the record carries on")
        pg, errors = page(block=("splat-view.js", "video-rtc.js"))
        pg.goto(url, wait_until="load")
        pg.wait_for_function("() => document.querySelectorAll('#rows tr.row').length > 300", timeout=60000)
        check(not errors, "splat and camera viewers gone: the record's table is filled, no script error", errors[:2])
        pg.context.close()

        print("5. the catalogue gone: the page says so and points to nothing broken")
        pg, errors = page(block=("data/index.json",))
        pg.goto(url, wait_until="load")
        pg.wait_for_function("() => /not loaded/.test(document.getElementById('rows').textContent)", timeout=30000)
        check("A window the person opens" in pg.inner_text("body") and not errors, "catalogue gone: the words are there, the table says it is not loaded, no script error", errors[:2])
        pg.context.close()

        print("6. the head on the home page: it turns, it opens, and the pictures stand in where it cannot be drawn")
        turning = "() => document.querySelector('.head-link').classList.contains('turning')"
        where = "() => { const h = document.querySelector('.head-live').contentWindow.__head; return Object.assign(h.where(), { drawn: h.drawn }); }"
        pg, errors = page()
        pg.goto(url, wait_until="load")
        pg.wait_for_function(turning, timeout=60000)
        pg.wait_for_timeout(600)
        lay = pg.evaluate("""() => { const f = document.querySelector('.head-live').getBoundingClientRect(), box = document.querySelector('.head-link'), i = box.querySelector('img').getBoundingClientRect();
          return { same: Math.abs(f.left - i.left) < 1 && Math.abs(f.top - i.top) < 1 && Math.abs(f.width - i.width) < 1 && Math.abs(f.height - i.height) < 1,
            still: getComputedStyle(box.querySelector('img')).visibility, ink: document.querySelector('.head-live').contentWindow.__head.coverage() }; }""")
        check(lay["same"] and lay["still"] == "hidden" and lay["ink"]["covered"] > 0.3, "the head itself stands exactly where its picture stood (drawn over %.0f %% of the frame)" % (100 * lay["ink"]["covered"]), lay)
        w0 = pg.evaluate(where)
        box = pg.locator(".head-live").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 80, cy + 20, steps=8); pg.mouse.up()
        pg.wait_for_timeout(1200)
        w1 = pg.evaluate(where)
        check(abs(w1["azimuth"] - w0["azimuth"]) > 0.5 and abs(w1["polar"] - w0["polar"]) > 0.05 and pg.url.rstrip("/") == url.rstrip("/"),
              "dragging it turns it, and the page stays where it is", (w0, w1, pg.url))
        pg.locator("#head-cut").fill("15")
        pg.wait_for_timeout(400)
        w2 = pg.evaluate(where)
        check(w2["cut"] < w1["cut"] - 30 and abs(w2["azimuth"] - w1["azimuth"]) < 0.2, "the slider opens it further, turned as it is (cut %.0f mm -> %.0f mm)" % (w1["cut"], w2["cut"]), (w1, w2))
        pg.locator("#head-cut").fill("7.5")
        pg.wait_for_timeout(300)
        check(abs(pg.evaluate(where)["cut"] - (w0["cut"] + (w2["cut"] - w0["cut"]) * (7.5 - 6) / (15 - 6))) < 1.5, "and stops anywhere between the sheet's pictures")
        y0 = pg.evaluate("() => scrollY")
        pg.mouse.move(cx, cy); pg.mouse.wheel(0, 400)
        pg.wait_for_timeout(500)
        w3 = pg.evaluate(where)
        check(pg.evaluate("() => scrollY") - y0 >= 300 and abs(w3["distance"] - w2["distance"]) < 0.01, "a mouse wheel over the head scrolls the page; the head does not swallow it to zoom")
        pg.evaluate("() => scrollTo(0, 0)")
        pg.wait_for_timeout(3500)                                           # the turn it was given dies away
        d0 = pg.evaluate(where)["drawn"]
        pg.wait_for_timeout(1500)
        check(pg.evaluate(where)["drawn"] == d0, "left alone it is not drawn again: it costs nothing while nothing moves")
        check(not errors, "the turning head: no script error", errors[:2])
        pg.mouse.click(cx, cy)
        pg.wait_for_url("**/head/", timeout=15000)
        check(pg.url.endswith("/head/"), "a click on it that does not drag still opens the head's own page, as the picture did")
        pg.context.close()

        ctx = b.new_context(viewport={"width": 390, "height": 780}, has_touch=True, is_mobile=True, device_scale_factor=2)
        pg = ctx.new_page()
        pg.goto(url, wait_until="load")
        pg.wait_for_function(turning, timeout=60000)
        pg.wait_for_timeout(600)
        cdp = ctx.new_cdp_session(pg)

        def finger(dx, dy):
            box = pg.locator(".head-live").bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1}]})
            for k in range(1, 13):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * k / 12, "y": y + dy * k / 12, "id": 1}]})
                pg.wait_for_timeout(16)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(900)

        w0, y0 = pg.evaluate(where), pg.evaluate("() => scrollY")
        finger(0, -200)
        w1, y1 = pg.evaluate(where), pg.evaluate("() => scrollY")
        check(y1 - y0 > 100 and abs(w1["polar"] - w0["polar"]) < 0.01 and abs(w1["azimuth"] - w0["azimuth"]) < 0.05,
              "a phone: a finger moving up over the head scrolls the page (%d px) and does not tip the head" % (y1 - y0), (w0, w1))
        finger(150, 0)
        w2, y2 = pg.evaluate(where), pg.evaluate("() => scrollY")
        check(abs(w2["azimuth"] - w1["azimuth"]) > 0.5 and y2 == y1, "a phone: a finger moving sideways on the head turns it, and the page stays put", (w1, w2, y1, y2))
        ctx.close()

        pg, errors = page(block=("vendor/three/",))                         # the 3-D library does not arrive: the frame says so and goes
        pg.goto(url, wait_until="load")
        pg.wait_for_function("() => document.querySelector('.head-link').classList.contains('sliding')", timeout=30000)
        check(not pg.evaluate(turning) and pg.locator(".head-live").count() == 0 and pg.locator(".head-frames").is_visible(),
              "where the head cannot be drawn, its frame is taken away and the sheet of pictures takes over")
        pg.context.close()

        pg, errors = page(block=("head/?embed",))                           # no head at all: the sheet, as before the head could turn
        pg.goto(url, wait_until="load")
        pg.locator("#head-cut").focus()                                     # touching the slider asks for the sheet at once
        pg.wait_for_function("() => document.querySelector('.head-link').classList.contains('sliding')", timeout=30000)
        at = lambda: pg.evaluate("() => document.querySelector('.head-frames').style.backgroundPosition")   # noqa: E731
        seen = []
        for value in ("0", "6", "13", "20"):
            pg.locator("#head-cut").fill(value)
            seen.append(at())
        check(len(set(seen)) == 4 and seen[0] == "0% 0%" and seen[3] == "100% 100%", "the slider steps through the pictures, closed first and fully open last", seen)
        check(pg.evaluate("() => getComputedStyle(document.querySelector('.head-link img')).visibility") == "hidden" and pg.locator(".head-frames").is_visible(),
              "while it slides, the sheet's picture stands where the still was")
        check(not errors, "the slider: no script error", errors[:2])
        pg.context.close()
        pg, errors = page(block=("head/open.webp", "head/?embed"))
        pg.goto(url, wait_until="load")
        pg.locator("#head-cut").fill("15")
        pg.wait_for_timeout(1200)
        check(pg.locator(".head-link img").is_visible() and not pg.evaluate("() => document.querySelector('.head-link').classList.contains('sliding')")
              and not pg.evaluate(turning) and not errors, "the head and the sheet both gone: the still picture stands, and nothing breaks", errors[:2])
        pg.context.close()
        pg, errors = page(block=("head/open.webp",))
        pg.goto(url, wait_until="load")
        pg.wait_for_function(turning, timeout=60000)
        pg.locator("#head-cut").fill("15")
        pg.wait_for_timeout(500)
        check(pg.evaluate(where)["cut"] < 90 and not errors, "the sheet gone but the head here: the slider opens the head itself", errors[:2])
        pg.context.close()

        print("7. a phone: nothing slides sideways")
        for path in ("", "record.html", "space/", "head/"):
            pg, _ = page(width=390, height=844)
            pg.goto(url + path, wait_until="load")
            if path == "":
                pg.wait_for_function("() => document.querySelectorAll('#rows tr.row').length > 300", timeout=60000)
            pg.wait_for_timeout(1500)
            over = pg.evaluate(SIDEWAYS)
            check(over <= 0, "phone, %s: the page is as wide as the screen" % (path or "home"), "%d px too wide" % over)
            pg.context.close()
        b.close()


def main():
    url = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    if url and not url.endswith("/"):
        url += "/"
    file_checks()
    server = None
    if not url:
        spec = importlib.util.spec_from_file_location("space_page", os.path.join(ROOT, "space", "test_space_page.py"))
        sp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sp)                      # its little server answers byte ranges, which films need
        server = sp.Server(("127.0.0.1", 0), functools.partial(sp.Handler, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/" % server.server_address[1]
    browser_checks(url, server is not None)
    if server:
        server.shutdown()
    print("PASS %d checks" % passed if not failed else "FAIL %d of %d: %s" % (len(failed), passed + len(failed), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

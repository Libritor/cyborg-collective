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
        check(pg.locator('a.head-link[href="head/"] img').count() == 1 and pg.locator("a.head-link").is_visible(), "home, scripts off: the picture of the head is there and links to it")
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

        print("6. a phone: nothing slides sideways")
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

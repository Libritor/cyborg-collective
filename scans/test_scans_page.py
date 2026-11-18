#!/usr/bin/env python3
"""The scans pages, checked in a real browser.

    python scans/test_scans_page.py                      the files in this repository, served from a local port
    python scans/test_scans_page.py http://6ense.com/    what is published
    add a folder name to keep a picture of each scan as the viewer drew it

Checks that the list needs no script, that every scan it names has its files, that the viewer loads each splat with
the number of Gaussians its record states and actually draws it, that a solid or a room model arrives where one is
offered, that every file to take away answers at its stated size, that nothing is asked of another site, and that a
phone is not made to scroll sideways. Needs playwright and the installed Chrome.
"""
import functools
import http.server
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed, failed = 0, []
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader",
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"]      # the site has no certificate yet: do not try https first
DRAWN = """() => { const c = document.querySelector('canvas'); if (!c) return 0; const t = document.createElement('canvas'); t.width = 320; t.height = 200;
  const g = t.getContext('2d'); g.drawImage(c, 0, 0, 320, 200); const d = g.getImageData(0, 0, 320, 200).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 20) > 40) n++; return n / (320 * 200); }"""
SIDEWAYS = "() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth"


def check(ok, what, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(what)
        print("  FAIL %s %s" % (what, str(detail)[:300]))


class Quiet(http.server.SimpleHTTPRequestHandler):
    # this computer's own table of file types may call a script plain text, which a browser will not run as a module
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary", ".spz": "application/octet-stream",
        ".stl": "model/stl", ".3mf": "model/3mf", ".jpg": "image/jpeg"})

    def log_message(self, *a):
        pass


def file_checks():
    print("files")
    scans = os.path.join(ROOT, "scans")
    listed = [s["id"] for s in json.load(open(os.path.join(scans, "scans.json"), encoding="utf-8"))["scans"]]
    folders = sorted(d for d in os.listdir(os.path.join(scans, "runs")) if os.path.isdir(os.path.join(scans, "runs", d)))
    check(sorted(listed) == folders, "the list names exactly the scans that have a folder", (listed, folders))
    page = open(os.path.join(scans, "index.html"), encoding="utf-8").read()
    check("<script" not in page.lower(), "the list is a page with no script on it")
    for sid in listed:
        m = json.load(open(os.path.join(scans, "runs", sid, "meta.json"), encoding="utf-8"))
        want = [m["splat"]] + [m[k] for k in ("scene", "solid", "model") if m.get(k)] + [p["file"] for p in m["pictures_shown"]] + [d["file"] for d in m["downloads"]]
        gone = [f for f in want if not os.path.exists(os.path.join(scans, "runs", sid, f))]
        sizes = [d["file"] for d in m["downloads"] if os.path.exists(os.path.join(scans, "runs", sid, d["file"])) and os.path.getsize(os.path.join(scans, "runs", sid, d["file"])) != d["bytes"]]
        check(not gone and not sizes, "%s: every file its record names is there, at the size stated" % sid, (gone, sizes))
        check('id="%s"' % sid in page and "view.html?scan=%s" % sid in page, "%s is on the list, with a link to the viewer" % sid)
        check(m["kind"] in ("headset", "test") and bool(m.get("note")) and (m["kind"] != "test" or "Not a headset scan" in m["note"]),
              "%s says what it is (%s)" % (sid, m["kind"]))
        shots = [f for f in os.listdir(os.path.join(scans, "runs", sid)) if f.lower().endswith((".jpg", ".png")) and f not in [p["file"] for p in m["pictures_shown"]]]
        check(not shots, "%s holds no picture beyond the renders it shows" % sid, shots)
    vend = os.path.join(scans, "vendor")
    check(all(os.path.exists(os.path.join(vend, f)) for f in ("THREE_LICENSE", "SPARK_LICENSE", "three.module.js", "three.core.js", "spark.module.min.js")),
          "the libraries the viewer runs on are kept beside it, with their licences")
    return listed


def browser_checks(url, listed, shots):
    host = url.split("//", 1)[1].split("/", 1)[0]
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=ARGS)

        def page(js=True, width=1280, height=800):
            ctx = b.new_context(viewport={"width": width, "height": height}, java_script_enabled=js)
            pg = ctx.new_page()
            errors, outside = [], []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("request", lambda r: outside.append(r.url) if r.url.startswith("http") and r.url.split("//", 1)[1].split("/", 1)[0] != host else None)
            return pg, errors, outside

        print("1. the list, scripts off")
        pg, errors, outside = page(js=False)
        pg.goto(url + "scans/", wait_until="load")
        cards = pg.locator("article.scan")
        check(cards.count() == len(listed), "every scan has its card (%d)" % cards.count(), listed)
        text = pg.inner_text("body")
        check("Gaussian splats" in text and "no lidar" in text, "it says what a scan is, and that the headset has no lidar")
        for sid in listed:
            card = pg.locator("article#%s" % sid)
            check(card.locator("img").count() >= 1 and card.locator('a.open[href="view.html?scan=%s"]' % sid).count() == 1 and card.locator("dl dt").count() >= 3,
                  "%s: a picture, its numbers and a link to turn it round" % sid)
            for i in range(card.locator("img").count()):
                src = card.locator("img").nth(i).get_attribute("src")
                r = pg.context.request.get(url + "scans/" + src)
                check(r.status == 200 and "image/jpeg" in r.headers.get("content-type", ""), "%s: %s is a picture that answers" % (sid, src), r.status)
        check(not outside, "the list asks nothing of another site", outside[:3])
        pg.context.close()

        print("2. the viewer, each scan")
        api = p.request.new_context()
        for sid in listed:
            m = api.get(url + "scans/runs/%s/meta.json" % sid).json()
            pg, errors, outside = page()
            extra = "&model=1" if m["mode"] == "view" and m.get("model") else "&solid=1" if m.get("solid") else ""
            pg.goto(url + "scans/view.html?scan=%s&shot=1&still=1" % sid, wait_until="load")
            try:
                pg.wait_for_function("() => window.viewer && (window.viewer.ready || window.viewer.error)", timeout=120000)
            except Exception:
                pass
            pg.wait_for_timeout(2500)
            st = pg.evaluate("() => window.viewer ? JSON.parse(JSON.stringify(window.viewer)) : null") or {}
            check(st.get("ready") and st.get("splats") == m["splat_count"], "%s: the splat loads with its %s Gaussians" % (sid, format(m["splat_count"], ",")), st)
            check(st.get("mode") == m["mode"], "%s: shown as %s" % (sid, "a view from one spot" if m["mode"] == "view" else "an object to turn"), st.get("mode"))
            drawn = pg.evaluate(DRAWN)
            check(drawn > 0.01, "%s: it is drawn (%.0f %% of the picture is not background)" % (sid, 100 * drawn), drawn)
            check(pg.inner_text("#title") == m["title"] and pg.locator("#note").is_visible() and m["note"][:40] in pg.inner_text("#note"), "%s: its title and its words are shown" % sid)
            if shots:
                pg.screenshot(path=os.path.join(shots, "%s.png" % sid))
            if extra:
                pg.goto(url + "scans/view.html?scan=%s&shot=1&still=1%s" % (sid, extra), wait_until="load")
                key = "model" if "model" in extra else "solid"
                try:
                    pg.wait_for_function("() => window.viewer && window.viewer.%s" % key, timeout=120000)
                except Exception:
                    pass
                pg.wait_for_timeout(1500)
                check(pg.evaluate("() => !!(window.viewer && window.viewer.%s)" % key), "%s: the %s arrives" % (sid, "room model" if key == "model" else "solid"))
                check(pg.evaluate(DRAWN) > 0.01, "%s: and is drawn" % sid)
                if shots:
                    pg.screenshot(path=os.path.join(shots, "%s_%s.png" % (sid, key)))
            links = pg.locator("#files a")
            check(links.count() == len(m["downloads"]), "%s: its files to take away are offered (%d)" % (sid, links.count()))
            for d in m["downloads"]:
                r = pg.context.request.head(url + "scans/runs/%s/%s" % (sid, d["file"]))
                size = int(r.headers.get("content-length", "-1"))
                check(r.status == 200 and size in (d["bytes"], -1), "%s: %s answers (%d bytes)" % (sid, d["file"], d["bytes"]), (r.status, size))
            check(not errors, "%s: no script error" % sid, errors[:2])
            check(not outside, "%s: nothing is asked of another site" % sid, outside[:3])
            pg.context.close()

        print("3. the edges")
        pg, errors, outside = page()
        pg.goto(url + "scans/view.html?scan=no-such-scan", wait_until="load")
        pg.wait_for_timeout(1500)
        check("no scan called no-such-scan" in pg.inner_text("#status") and not errors, "a scan that is not there: the page says so, no script error", errors[:2])
        pg.context.close()
        pg, errors, outside = page(js=False)
        pg.goto(url + "scans/view.html?scan=%s" % listed[0], wait_until="load")
        check(pg.locator("#plain").is_visible() and pg.locator('#plain a[href="./"]').count() == 1 and not pg.locator("#panel").is_visible(),
              "the viewer, scripts off: it says so and points to the list")
        pg.context.close()
        for path in ("scans/", "scans/view.html?scan=%s" % listed[0]):
            pg, errors, outside = page(width=390, height=844)
            pg.goto(url + path, wait_until="load")
            pg.wait_for_timeout(1500)
            over = pg.evaluate(SIDEWAYS)
            check(over <= 0, "a phone, %s: the page is as wide as the screen" % path.split("?")[0], "%d px too wide" % over)
            pg.context.close()
        b.close()


def main():
    args = sys.argv[1:]
    url = next((a for a in args if a.startswith("http")), None)
    shots = next((a for a in args if not a.startswith("http")), None)
    if shots:
        os.makedirs(shots, exist_ok=True)
    if url and not url.endswith("/"):
        url += "/"
    listed = file_checks()
    server = None
    if not url:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/" % server.server_address[1]
    browser_checks(url, listed, shots)
    if server:
        server.shutdown()
    print("PASS %d checks" % passed if not failed else "FAIL %d of %d: %s" % (len(failed), passed + len(failed), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

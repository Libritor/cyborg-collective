"""The head page: the surface is the one head.json describes, it opens, the cut shows the scan, the dots answer a
live sharer, and with scripts off the still picture stands in.

    python head/test_head_page.py [URL of the head page] [folder for pictures]
    python head/test_head_page.py --still          # also rewrite, from the page as it draws now, head/still.png and
                                                   # head/open.webp (the home page's picture and the sheet of pictures
                                                   # its slider steps through): run this after make_head.py

Without a URL it serves this repository on a free local port. Live sharers are imitated by handing messages to the
page's own handler; nothing is sent to any server.
"""
import base64
import functools
import importlib.util
import io
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# the home page's slider: this many pictures of the head, closed to fully open, on one sheet (head/open.webp)
FRAMES, SHEET_COLS, FRAME_PX, STILL_FRAME = 21, 7, 480, 6
passed, failed = 0, []


def check(ok, what, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(what)
        print("  FAIL %s %s" % (what, str(detail)[:300]))


READ = """() => { const h = window.__head, s = h.state; const mesh = document.querySelector('#view canvas');
  const geo = (() => { let g = null; for (const o of [mesh]) g = o; return g; })();
  return { cutY: s.cutY, top: s.top, low: s.low, sites: s.sites.map(e => ({ name: e.name, shown: e.dot.visible, colour: e.dot.material.color.getHex(), pulse: e.pulse, label: e.label.style.display })),
    who: document.getElementById('who').textContent, people: s.people.size, record: s.record ? s.record.entry.stamp : null,
    canvas: [mesh.clientWidth, mesh.clientHeight], sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    aboutOpen: document.getElementById('about').open, slider: Number(document.getElementById('cut').value) }; }"""
INK = "() => window.__head.coverage()"


def main():
    args = [a for a in sys.argv[1:] if a != "--still"]
    still = "--still" in sys.argv
    url = args[0] if args and args[0] else None
    shots = args[1] if len(args) > 1 else None
    info = json.load(open(os.path.join(HERE, "head.json"), encoding="utf-8"))
    server = None
    if not url:
        spec = importlib.util.spec_from_file_location("space_page", os.path.join(ROOT, "space", "test_space_page.py"))
        sp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sp)
        server = sp.Server(("127.0.0.1", 0), functools.partial(sp.Handler, directory=ROOT))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/head/" % server.server_address[1]

    # the files: what they say they are, and nothing of the scanner's
    raw = open(os.path.join(HERE, info["skin"]["file"]), "rb").read()
    nv, nt = int.from_bytes(raw[:4], "little"), int.from_bytes(raw[4:8], "little")
    check(nv == info["skin"]["vertices"] and nt == info["skin"]["triangles"] and len(raw) == 8 + nv * 6 + nt * 3 * info["skin"]["index_bytes"],
          "skin.bin holds the surface head.json describes (%d points, %d triangles)" % (nv, nt))
    for name in sorted(n for n in os.listdir(HERE) if not n.endswith(".py") and os.path.isfile(os.path.join(HERE, n))):
        blob = open(os.path.join(HERE, name), "rb").read()
        check(b"DICM" not in blob[:256] and b"PatientName" not in blob and b"PatientBirth" not in blob, "%s is not a scanner file and carries no patient field" % name)
    check(len(info["electrodes"]) == 4 and all(40 < e["pos"][1] < info["top_y_mm"] for e in info["electrodes"]), "four electrode sites, on the head")

    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for name, size in (("desktop", (1280, 860)), ("phone", (390, 844))):
            pg = b.new_context(viewport={"width": size[0], "height": size[1]}).new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
            outside = []
            pg.on("request", lambda r: outside.append(r.url) if not r.url.startswith(url.rsplit("/head/", 1)[0]) and not r.url.startswith(("ws", "data:", "blob:")) else None)
            pg.goto(url + "?relay=wss://127.0.0.1:9/live", wait_until="load")          # no relay: the page must stand without one
            pg.wait_for_function("() => window.__head && window.__head.ready", timeout=60000)
            pg.wait_for_function("() => window.__head.state.opened && window.__head.state.record", timeout=30000)
            pg.wait_for_timeout(800)
            s = pg.evaluate(READ)
            ink = pg.evaluate(INK)
            tag = name
            check(not errors, tag + ": no script error", errors[:2])
            check(not outside, tag + ": nothing is loaded from another site", outside[:3])
            check(s["canvas"][0] >= 300 and s["canvas"][1] >= 300 and ink["covered"] > 0.12, tag + ": the head is drawn (%.0f %% of the view)" % (100 * ink["covered"]))
            check(s["cutY"] < s["top"] - 20, tag + ": it arrives opened (cut %.0f mm, top %.0f mm)" % (s["cutY"], s["top"]))
            check(s["people"] == 0 and "Nobody is sharing" in s["who"] and s["record"], tag + ": with nobody live it says so and keeps time with the recorded minute")
            check(s["sideways"] <= 0, tag + ": the page is as wide as the window (%s)" % s["sideways"])
            if name == "phone":
                check(not s["aboutOpen"], tag + ": the words start closed on a phone")
            # closed, the dots all show; opened to the bottom, none do
            pg.evaluate("() => window.__head.setCut(0)"); pg.wait_for_timeout(250)
            closed = pg.evaluate(READ); ink_closed = pg.evaluate(INK)
            pg.evaluate("() => window.__head.setCut(1)"); pg.wait_for_timeout(250)
            opened = pg.evaluate(READ); ink_open = pg.evaluate(INK)
            check(all(e["shown"] for e in closed["sites"]) and not any(e["shown"] for e in opened["sites"]), tag + ": electrodes above the cut are taken away with what they sat on")
            check(ink_open["covered"] < 0.8 * ink_closed["covered"], tag + ": opening removes the top of the head (%.0f %% -> %.0f %% of the view)" % (100 * ink_closed["covered"], 100 * ink_open["covered"]))
            # the slider
            pg.locator("#cut").fill("300"); pg.wait_for_timeout(250)
            mid = pg.evaluate(READ)
            check(abs(mid["cutY"] - (mid["top"] - 0.3 * (mid["top"] - mid["low"]))) < 0.5, tag + ": the slider sets the cut")
            # a live sharer: contacts on the dots, a name in the words, and it goes when they leave
            pg.evaluate("""() => { const h = window.__head.feed;
              h({ t: 'snapshot', people: [{ pseudonym: 'p1', name: '<b>Test</b> Wearer', tier: 'bands', last: { quality: { hsi: { TP9: 1, AF7: 2, AF8: 4, TP10: 1 } } } }] });
              h({ t: 'bands', pseudonym: 'p1', rel: { delta: [0.2, 0.2, 0.2, 0.2], theta: [0.2, 0.2, 0.2, 0.2], alpha: [0.45, 0.1, 0.1, 0.4], beta: [0.1, 0.3, 0.3, 0.1], gamma: [0.05, 0.2, 0.2, 0.1] } }); }""")
            pg.wait_for_timeout(900)
            live = pg.evaluate(READ)
            colours = {e["name"]: e["colour"] for e in live["sites"]}
            check(colours == {"AF7": 0xd97706, "AF8": 0xdc2626, "TP9": 0x16a34a, "TP10": 0x16a34a}, tag + ": each dot takes its contact's colour", colours)
            pulses = {e["name"]: e["pulse"] for e in live["sites"]}
            check(pulses["TP9"] > 2 * pulses["AF7"] > 0, tag + ": a dot swells with the alpha at its own electrode", pulses)
            check("<b>Test</b> Wearer is sharing live" in live["who"] and pg.locator("#who b").count() == 1 and pg.locator("#who b b").count() == 0,
                  tag + ": the sharer is named, as text and not as markup")
            if shots:
                os.makedirs(shots, exist_ok=True)
                pg.screenshot(path=os.path.join(shots, "head_%s_live.png" % name))
            pg.evaluate("() => window.__head.feed({ t: 'leave', pseudonym: 'p1' })"); pg.wait_for_timeout(400)
            check("Nobody is sharing" in pg.evaluate(READ)["who"], tag + ": when they leave, the page says nobody is sharing")
            if shots:
                pg.screenshot(path=os.path.join(shots, "head_%s.png" % name))
            pg.context.close()

        # scripts off: the picture and the words
        pg = b.new_context(viewport={"width": 1280, "height": 860}, java_script_enabled=False).new_page()
        pg.goto(url, wait_until="load")
        check(pg.locator("#plain").is_visible() and pg.locator("#plain img").count() == 1 and "CT scan" in pg.inner_text("#plain"), "scripts off: the still picture and the words stand in")
        r = pg.context.request.get(url + "still.png")
        check(r.status == 200 and len(r.body()) > 20000, "the still picture is there (%d KB)" % (len(r.body()) // 1024 if r.status == 200 else 0))
        pg.context.close()

        if still:                                       # the page's own drawing, as pictures with nothing behind them
            from PIL import Image
            pg = b.new_context(viewport={"width": 640, "height": 640}, device_scale_factor=2).new_page()
            pg.goto(url + "?still=1", wait_until="load")
            pg.wait_for_function("() => window.__head && window.__head.ready", timeout=60000)
            pg.wait_for_timeout(1500)
            # one picture for every position of the home page's slider, closed to fully open, all cut from the same square
            shots_ = []
            for k in range(FRAMES):
                data = pg.evaluate("a => { window.__head.setCut(a); return window.__head.png(); }", k / (FRAMES - 1))
                shots_.append(Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGBA"))
            boxes = [im.getbbox() for im in shots_]
            pad = 24
            x0, y0 = max(0, min(bx[0] for bx in boxes) - pad), max(0, min(bx[1] for bx in boxes) - pad)
            x1, y1 = min(shots_[0].width, max(bx[2] for bx in boxes) + pad), min(shots_[0].height, max(bx[3] for bx in boxes) + pad)
            side = max(x1 - x0, y1 - y0)

            def square(im):
                sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                sq.paste(im.crop((x0, y0, x1, y1)), ((side - (x1 - x0)) // 2, (side - (y1 - y0)) // 2))
                return sq

            rows_ = (FRAMES + SHEET_COLS - 1) // SHEET_COLS
            sheet = Image.new("RGBA", (SHEET_COLS * FRAME_PX, rows_ * FRAME_PX), (0, 0, 0, 0))
            for k, im in enumerate(shots_):
                sheet.paste(square(im).resize((FRAME_PX, FRAME_PX), Image.LANCZOS), ((k % SHEET_COLS) * FRAME_PX, (k // SHEET_COLS) * FRAME_PX))
            sheet.save(os.path.join(HERE, "open.webp"), quality=80, method=6)
            # the picture that stands before the sheet is here, and with scripts off: the same square, at the slider's starting position
            out = square(shots_[STILL_FRAME]).resize((640, 640), Image.LANCZOS).quantize(colors=200, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
            out.save(os.path.join(HERE, "still.png"), optimize=True)
            for name in ("still.png", "open.webp"):
                print("%s rewritten: %d KB" % (name, os.path.getsize(os.path.join(HERE, name)) // 1024))
            pg.context.close()
        b.close()
    if server:
        server.shutdown()
    print("PASS %d checks" % passed if not failed else "FAIL %d of %d: %s" % (len(failed), passed + len(failed), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

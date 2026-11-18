#!/usr/bin/env python3
"""The words and the markup of the scans pages on the site (6ense.com/scans/), for scan_publish.py.

    list_page(metas, stamp)      scans/index.html   the scans, as cards
    how_page(groups, stamp)      scans/how.html     how a scan is made, with the tools
    with_site_style(html, stamp) a page kept as a file here (view.html, live.html) as it goes onto the site

The pages wear the home page's look: each loads the home page's stylesheet (../style.css) and then scans.css, which
adds what only these pages have. They are plain pages with no script (the two with a 3-D stage aside), laid out as
the home page is: a masthead with the words on the left and a dark panel on the right, tiles, cards, and a footer
that says how the page is honest.
"""
import html
import re

SITE = "http://6ense.com/"
SECURE_COPY = "https://cyborg-collective-relay.onrender.com/scans/"
MARK = "<!-- site-style -->"                      # in view.html and live.html: where the home page's stylesheet is linked on the site
e = html.escape


def styles(stamp):
    return f'<link rel="stylesheet" href="../style.css">\n<link rel="stylesheet" href="scans.css?v={stamp}">'


def with_site_style(page, stamp):
    """A page that also runs on the laptop, as it is published: the home page's stylesheet first, scans.css stamped."""
    if MARK not in page or '<link rel="stylesheet" href="scans.css">' not in page:
        raise SystemExit("the page has no place for the site's stylesheet (the site-style comment and the scans.css link)")
    return page.replace(MARK, '<link rel="stylesheet" href="../style.css">').replace(
        '<link rel="stylesheet" href="scans.css">', f'<link rel="stylesheet" href="scans.css?v={stamp}">')


def head(title, description, stamp):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:image" content="{SITE}scans/cover.jpg">
<!-- Written by scan_publish.py (scan_pages.py). No script on this page. -->
{styles(stamp)}
</head>
<body>
"""


def menu(here):
    items = [("../", "Home"), ("./", "Scans"), ("live.html", "Live"), ("how.html", "How a scan is made"), ("../space/", "Rooms in 3-D"), ("../record.html", "The record")]
    return '<nav aria-label="Scans">\n  ' + "".join(
        f'<a href="{h}"' + (' aria-current="page"' if h == here else "") + f">{t}</a>" for h, t in items) + "\n</nav>\n"


def chain_figure():
    """The chain from headset to print and to this site, drawn the way the home page draws its chains: balls on lines."""
    nodes = [  # x, y, name, what, class
        (70, 78, "headset", "a Quest 3S, worn", ""),
        (232, 78, "pictures", "with position + depth rays", ""),
        (410, 78, "splat", "trained by Brush, ~2 min", ""),
        (566, 78, "solid", "closed, flat base", ""),
        (700, 78, "print file", "sliced, Bambu H2C", ""),
        (232, 256, "live Gaussians", "one per depth reading", "live"),
        (410, 168, "compressed", "Open3D, .spz, a tenth", ""),
        (640, 226, "this site", "live · scans", "gold"),
    ]
    edges = [  # from, to, class
        (0, 1, ""), (1, 2, ""), (2, 3, ""), (3, 4, ""), (0, 5, "live"), (5, 7, "live"), (2, 6, ""), (6, 7, "gold")]
    r = 13
    out = ['<svg class="chain-svg" viewBox="0 0 770 316" role="img" aria-labelledby="chain-title chain-desc">',
           '<title id="chain-title">The chain from a headset to a print file and to this site</title>',
           '<desc id="chain-desc">A headset, worn, keeps pictures with its position and depth rays. A laptop trains a Gaussian splat from them, makes a closed solid from the splat and slices it into a print file. '
           'While scanning, live Gaussians, one per depth reading, go to this site. Afterwards the trained splat, compressed, goes to this site too.</desc>']
    for a, b, cls in edges:
        x1, y1, x2, y2 = nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]
        if y1 == y2:                                    # along the row
            d = f"M{x1 + r} {y1} L{x2 - r} {y2}"
        elif x1 == x2:                                  # straight down
            d = f"M{x1} {y1 + r} L{x2} {y2 - r}"
        elif y2 > y1 and x2 > x1 and a == 0:            # down from the headset, then across into the ball's left
            d = f"M{x1} {y1 + r} C{x1} {y2}, {x1 + 40} {y2}, {x2 - r} {y2}"
        elif abs(y2 - y1) < 40:                         # from the right of one into the left of the other, a little lower or higher
            mx = (x1 + x2) / 2
            d = f"M{x1 + r} {y1} C{mx} {y1}, {mx} {y2}, {x2 - r} {y2}"
        else:                                           # across, then down into the top of the ball
            d = f"M{x1 + r} {y1} C{x2 - 60} {y1}, {x2} {y1 + 10}, {x2} {y2 - r}"
        out.append(f'<path class="pc-edge {cls}" d="{d}"/>')
    for x, y, name, what, cls in nodes:
        out.append(f'<circle class="pc-ball {cls}" cx="{x}" cy="{y}" r="{r}"/>')
        up = y == nodes[0][1]                            # the top row's words stand over their balls: lines leave downwards
        out.append(f'<text class="pc-name {cls}" x="{x}" y="{y - 37 if up else y + 31}">{e(name)}</text>')
        out.append(f'<text class="pc-what" x="{x}" y="{y - 22 if up else y + 46}">{e(what)}</text>')
    out.append("</svg>")
    return ('<figure class="dark-panel chain-panel">\n'
            '<figcaption><b>6ense™</b> the chain · from what a headset sees to something that can be held</figcaption>\n'
            '<p class="how">Blue is what a laptop makes after the scan; <span style="color:#37d67a">green</span> goes out while the headset is still scanning; '
            '<span class="gold">gold</span> is this site.</p>\n'
            '<div class="table-scroll">' + "\n".join(out) + "</div>\n</figure>\n")


def honest():
    return f"""<footer>
  <b>How these pages are honest</b>
  <ul>
    <li>Seen by a headset, or a test: every scan carries one of the two labels. A test was drawn on a computer from a model whose shape is known, so that the result could be measured; it is not passed off as a headset scan.</li>
    <li>What is published is what was computed: the splat, the solid, renders of them and the print files. The camera pictures stay with the person who took them.</li>
    <li>A place photographed from one spot is shown as that: a view to look round from where it was taken, with gaps away from that spot and no solid. A room model beside it is an estimate, and its card says where its shape comes from.</li>
    <li>Live Gaussians are placed, not trained: one for each reading of the headset's depth sensing, drawn as it arrives. The trained splat of the same sitting comes minutes later. The relay passes the live ones on and keeps none.</li>
    <li>The headset has no lidar: its depth is what it works out from its two tracking cameras.</li>
    <li>Not yet done, and said where it matters: a walk all the way round one object with the headset; the live view from the headset itself (made-up rooms have been sent so far); AR and VR inside the headset from this site; a print.</li>
  </ul>
  <p>In a headset, AR and VR need a secure address, which 6ense.com does not have yet: the same pages are at <a href="{SECURE_COPY}">{SECURE_COPY.split("//", 1)[1]}</a>, where a scan has an Enter AR or Enter VR button. Part of <a href="../">6ense.com</a> · <a href="../space/">rooms rebuilt from walks</a> · <a href="../record.html">the record as a plain page</a>.</p>
</footer>
</body>
</html>
"""


def mb(n):
    return f"{n / 1e6:.0f} MB" if n >= 1e7 else f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{max(1, round(n / 1e3))} kB"


def sliced(text):
    """'sliced x.stl for the H2C: 1h 33m 49s print time, 30.44 g PLA, 373 layers' -> '1h 33m 49s, 30.44 g PLA'."""
    t = re.sub(r"^sliced \S+ for the H2C: ", "", text or "")
    return re.sub(r", \d+ layers$", "", t.replace(" print time", ""))


def facts(m):
    rows = []
    s, tr, pr, rm = m.get("size_cm"), m.get("train") or {}, m.get("print") or {}, m.get("room") or {}
    if m["mode"] == "object" and s:
        rows.append(("Real size", f"{s[0]} × {s[2]} × {s[1]} cm high"))
    rows.append(("Pictures", str(m.get("pictures", "—"))))
    if tr.get("gaussians"):
        part = m.get("splat_count") if m.get("splat_count") != tr["gaussians"] else None
        rows.append(("Splat", f"{tr['gaussians']:,} Gaussians, {tr.get('steps'):,} steps"
                     + ("" if not part else f"; {part:,} are the object" if m["mode"] == "object" else f"; {part:,} shown here")))
    if tr.get("held_out_psnr_db"):
        rows.append(("Pictures kept back", f"reproduced at {tr['held_out_psnr_db']} dB"))
    c = m.get("check") or {}
    if c.get("median_mm") is not None:
        rows.append(("From the true shape", f"{c['median_mm']} mm for half the surface, {c.get('p95_mm')} mm for 95 %"))
    if pr.get("print_size_mm"):
        rows.append(("Print", " × ".join(f"{v:.0f}" for v in pr["print_size_mm"]) + " mm" + (f"; {sliced(pr.get('slice'))}" if pr.get("slice") else "")))
    if rm.get("size_m"):
        rows.append(("Room model", f"{rm['size_m'][0]} × {rm['size_m'][2]} m, {rm['size_m'][1]} m high (an estimate)"))
        rp = rm.get("print") or {}
        if rp.get("size_mm"):
            rows.append(("Diorama print", f"{rp.get('scale')}, " + " × ".join(f"{v:.0f}" for v in rp["size_mm"]) + " mm"
                         + (f"; {sliced(rp.get('slice'))}" if rp.get("slice") else "")))
    return rows


def tiles(metas):
    seen = sum(1 for m in metas if m["kind"] != "test")
    gauss = sum((m.get("train") or {}).get("gaussians") or 0 for m in metas)
    pics = sum(m.get("pictures") or 0 for m in metas)
    best = min((m["check"]["median_mm"] for m in metas if (m.get("check") or {}).get("median_mm") is not None), default=None)
    secs = [(m.get("train") or {}).get("seconds") for m in metas if (m.get("train") or {}).get("seconds")]
    out = [(str(len(metas)), "scans here"), (str(seen), "seen by a headset"), (f"{gauss:,}", "Gaussians trained"), (str(pics), "pictures they were trained from")]
    if best is not None:
        out.append((f"{best} mm", "closest to a known shape (half the surface)"))
    if secs:
        out.append((f"{min(secs) / 60:.1f}–{max(secs) / 60:.1f} min" if len(secs) > 1 else f"{secs[0] / 60:.1f} min", "to train one on a laptop"))
    return '<div class="tiles">\n' + "\n".join(f'  <div class="tile"><b>{e(v)}</b><span>{e(l)}</span></div>' for v, l in out) + "\n</div>\n"


def list_page(metas, stamp):
    title = "Scans in 3-D"
    desc = ("What a person wearing a headset looks at, rebuilt in 3-D: drawn as Gaussians while they look, trained into a Gaussian splat "
            "minutes later, and for an object made into a solid that can be printed and held.")
    parts = [head(title, desc, stamp), f"""<div class="masthead">
<header class="top">
  <p class="crumb"><a href="../">Cyborg Collective</a> · <span class="mark6">6ense™</span></p>
  <h1>{title}</h1>
  <p class="tag">{e(desc)}</p>
  <p class="about">A headset on the head is a camera that knows where it is. These pages use that and little else: its pictures, its own positions, and the depth it works out from its two tracking cameras (it has no lidar). A laptop does the rest, with tools that are published beside the results, and every result says what it is: seen by a headset, or a test of the method against a shape that is known.</p>
</header>
{menu("./")}<div class="side">
{tiles(metas)}<div class="doors">
  <a class="card door" href="live.html"><b>Live Gaussian splatting</b><span>What a headset is scanning now, drawn as Gaussians while it scans. When nobody is scanning, the most recent finished scan.</span></a>
  <a class="card door" href="how.html"><b>How a scan is made</b><span>The chain from headset to print file, what has been checked and what has not, and every tool as a plain file.</span></a>
</div>
</div>
<div class="band-col">
{chain_figure()}</div>
</div>
<main>
<section id="scans">
  <h2>The scans</h2>
  <p class="sub">Each opens in 3-D: an object to turn round, beside the solid made from it; a place to look round from where it was photographed. “Pictures kept back”: a tenth of the pictures are not used for training, and the number says how closely the splat reproduces them (higher is closer).</p>
"""]
    if not metas:
        parts.append('  <div class="card">No scan is published at the moment.</div>\n')
    else:
        parts.append('  <div class="grid">\n')
        for m in metas:
            sid = m["id"]
            pics = "".join(f'<img src="runs/{sid}/{e(p["file"])}" alt="{e(p["alt"])}" width="{p["w"]}" height="{p["h"]}">' for p in m["pictures_shown"])
            rows = "".join(f"<dt>{e(a)}</dt><dd>{e(b)}</dd>" for a, b in facts(m))
            files = " · ".join(f'<a href="runs/{sid}/{e(d["file"])}" download>{e(d["label"])}</a> {mb(d["bytes"])}' for d in m["downloads"])
            badge = ('<span class="badge test first">a test of the method</span>' if m["kind"] == "test" else '<span class="badge seen first">seen by a headset</span>')
            opener = "Look round it in 3-D" if m["mode"] == "view" else "Turn it round in 3-D"
            parts.append(f"""  <article class="card scan" id="{sid}">
    <a class="scan-pic" href="view.html?scan={sid}">{pics}</a>
    <h3>{e(m["title"])}</h3>
    <div>{badge}</div>
    <p class="note">{e(m["note"])}</p>
    <dl>{rows}</dl>
    <p class="actions"><a class="btn primary open" href="view.html?scan={sid}">{opener}</a><span class="files">{files}</span></p>
  </article>
""")
        parts.append("  </div>\n")
    parts.append("</section>\n</main>\n")
    parts.append(honest())
    return "".join(parts)


def how_page(groups, stamp):
    """groups: [(title, [(file name, what it is for), ...]), ...] for the tools published in scans/tools/."""
    title = "How a scan is made"
    desc = "From a headset's pictures to a Gaussian splat, a solid and a print file: the chain, what has been checked and what has not, and every tool as a plain file."
    tools = []
    for group, files in groups:
        rows = "\n".join(f'      <tr><td><a href="tools/{e(n)}">{e(n)}</a></td><td>{e(job)}</td></tr>' for n, job in files)
        tools.append(f'  <div class="card">\n    <h3>{e(group)}</h3>\n    <div class="table-scroll"><table class="sessions">\n{rows}\n    </table></div>\n  </div>\n')
    return head(title, desc, stamp) + f"""<div class="masthead">
<header class="top">
  <p class="crumb"><a href="../">Cyborg Collective</a> · <a href="./">Scans in 3-D</a></p>
  <h1>{title}</h1>
  <p class="tag">{e(desc)}</p>
  <p class="about">A thing or a place is photographed with a Meta Quest 3S headset. A laptop turns the photographs into a Gaussian splat and, for an object, into a closed solid sliced for a 3-D printer, and the result goes onto this site. Everything it is made with is on this page.</p>
</header>
{menu("how.html")}<div class="side">
<div class="card run">
  <code>.\\start_quest_scan.ps1</code><span>scan, splat, solid, print file</span>
  <code>.\\start_quest_scan.ps1 -Live -Publish</code><span>the same, live on this site while scanning and published here afterwards</span>
</div>
<p class="status">One command on the laptop the headset is plugged into. Without <code>-Live</code> or <code>-Publish</code> everything stays on that laptop; nothing is ever sent to a printer.</p>
</div>
<div class="band-col">
{chain_figure()}</div>
</div>
<main>
<section id="chain">
  <h2>The chain</h2>
  <p class="sub">Six steps. The two with a dashed edge happen only when asked for, because they are public.</p>
  <ol class="steps">
    <li class="card"><b>The headset keeps pictures</b>Its app keeps a picture from the passthrough camera every 5 cm or 6 degrees of head movement, with the headset's own position and direction for it and an 80 × 60 grid of depth rays behind it. Pulling the trigger on a thing names it as the object. The headset has no lidar: its depth comes from its two tracking cameras.</li>
    <li class="card asked"><b>Live, if asked for</b>While it scans, the app also sends one depth reading per ray to the laptop over the USB cable. The laptop keeps one per 2 cm of surface and passes them through the relay; <a href="live.html">the live page</a> draws each as a Gaussian the moment it arrives. These are placed, not trained.</li>
    <li class="card"><b>The laptop trains the splat</b>The headset's positions are used as they are, with no structure from motion. The pictures are cropped round the object and <a href="https://github.com/ArthurBrussee/brush">Brush</a> trains the Gaussians for 8,000 steps, about two minutes on a laptop's graphics card. A tenth of the pictures are kept back and compared with what the splat draws from their positions.</li>
    <li class="card"><b>From splat to solid</b>The splat's depth is drawn from every camera position and voted into a grid: outside where enough cameras see past a cell, surface where they see it, solid where none could see, so the body is closed. It is cut flat on the surface it stood on.</li>
    <li class="card"><b>Sliced</b>The solid is scaled and sliced for a Bambu H2C with the slicer's command line, which reports the time and the grams. Nothing is sent to a printer.</li>
    <li class="card asked"><b>Published, if asked for</b><a href="https://www.open3d.org/">Open3D</a> reads the trained splat and writes it compressed, about a tenth of the size; that file, the solid, a render and the print files go into this site's repository. Open3D does not make the splat: it has no training. The camera pictures are not published.</li>
  </ol>
</section>

<section id="checked">
  <h2>What has been checked, and what has not</h2>
  <div class="tiles">
    <div class="tile"><b>0.47 mm</b><span>T. rex: half the surface within this of the true shape</span></div>
    <div class="tile"><b>0.37 mm</b><span>Triceratops, the same measure</span></div>
    <div class="tile"><b>0.3 %</b><span>T. rex: its sizes, against the true ones</span></div>
    <div class="tile"><b>0.5 %</b><span>T. rex: its volume</span></div>
    <div class="tile"><b>0.02 px</b><span>real depth rays against the camera model, sideways</span></div>
    <div class="tile"><b>26</b><span>pictures in the one sitting on the headset so far</span></div>
  </div>
  <div class="checked">
    <div class="card"><b>Against known shapes</b>Two made-up scans of known models, drawn at the headset camera's geometry with noise in the depth, went through the same steps as a real scan. The solids are measured against the models they were drawn from. Both are <a href="./">on the list</a>, labelled as tests.</div>
    <div class="card"><b>On the headset</b>One sitting so far, from one seat in a room: a view to look round rather than an object. Its depth rays land within 0.02 px sideways and 4 px vertically of where they were cast, so the camera model holds on the device.</div>
    <div class="card"><b>These pages</b>Each has a browser test that travels with it (<a href="test_scans_page.py">test_scans_page.py</a>, <a href="test_live_page.py">test_live_page.py</a>). The live page's test sends a made-up room through a relay and requires the page to draw it and let it go.</div>
    <div class="card notyet"><b>Not yet</b>A walk all the way round one object with the headset; the live view from the headset itself (only made-up rooms have been sent so far); AR and VR inside the headset from this site; a print.</div>
  </div>
</section>

<section id="tools">
  <h2>The tools</h2>
  <p class="sub">Plain files, as they are used; nothing here is built. Python (numpy, scipy, numba, Open3D, scikit-image, Pillow, playwright), PowerShell, and one C# script for Unity 6 with Meta's XR packages. Their defaults name folders in the user's home folder. The viewer is <a href="view.html">view.html</a> and the live page <a href="live.html">live.html</a>: their source is the page itself, with <a href="scans.css">scans.css</a>.</p>
  <div class="tools">
{"".join(tools)}  </div>
</section>

<section id="stand">
  <h2>What they stand on</h2>
  <div class="tiles">
    <div class="tile"><b><a href="https://github.com/ArthurBrussee/brush">Brush</a></b><span>trains the splat (Apache 2.0)</span></div>
    <div class="tile"><b><a href="https://www.open3d.org/">Open3D</a></b><span>compresses it to .spz (MIT)</span></div>
    <div class="tile"><b><a href="https://sparkjs.dev/">Spark</a></b><span>draws Gaussian splats in the browser (MIT; kept in vendor/)</span></div>
    <div class="tile"><b><a href="https://threejs.org/">three.js</a></b><span>the 3-D underneath (MIT; kept in vendor/)</span></div>
    <div class="tile"><b>Meta's XR interfaces</b><span>the headset's passthrough camera and depth</span></div>
    <div class="tile"><b>Bambu Studio</b><span>its command line slices the solid</span></div>
  </div>
</section>
</main>
""" + honest()

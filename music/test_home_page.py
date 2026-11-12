"""Browser check of the home page's band: the SWIM waves and the 'what you are hearing' note.

    python -m http.server 8771 --bind 127.0.0.1        (in the repository root, in another terminal)
    python music/test_home_page.py [URL] [FOLDER]      -> "PASS <n> checks", exit 0

URL defaults to the local copy; give http://6ense.com/ to check the published page. With FOLDER, screenshots are
saved there. Needs playwright with its Chromium (pip install playwright; playwright install chromium).

The check that matters most is section 2: it recomputes, from the bytes of the published music/eeg/<stamp>.bin,
where every dot of the sweep in progress belongs, and looks for the ink there; then it reads the same recording
half a second late and shows that the wrong stretch does not fit. Live sharers are imitated by handing frames to
the page's own relay object; nothing is sent to any server.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8771/"
OUT = sys.argv[2] if len(sys.argv) > 2 else None
if OUT:
    os.makedirs(OUT, exist_ok=True)


def shot(page, name, **kw):
    if OUT:
        page.screenshot(path=os.path.join(OUT, name), **kw)
results = []


def check(ok, label, detail=""):
    results.append(bool(ok))
    print(("  ok   " if ok else "  FAIL ") + label + (f"   [{detail}]" if detail and not ok else ""), flush=True)


READY = "() => { const b = document.getElementById('listen'); return b && !b.disabled; }"
STATE = """() => {
  const note = document.getElementById('listen-note');
  const c = document.getElementById('waves');
  let inked = 0;
  if (c && c.width) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) inked += 1;
  }
  const r = note ? note.getBoundingClientRect() : null;
  return {
    playing: window.__player.playing, mode: window.__player.mode, piece: window.__player.piece,
    drawn: window.__player.waves, shares: window.__player.shares,
    waves: JSON.parse(JSON.stringify(window.__waves.state)),
    inked,
    noteHidden: note.hidden, noteText: note.innerText.replace(/\\s+/g, ' '), floating: note.classList.contains('floating'),
    noteInView: r ? (r.top >= 0 && r.bottom <= innerHeight && r.width > 0) : false,
    notePos: getComputedStyle(note).position,
    sounding: document.getElementById('mark-6ense').classList.contains('sounding'),
    status: document.getElementById('listen-status').textContent,
    scrollY: Math.round(scrollY),
  };
}"""

# Hold the picture against the published file: recompute where the dots of the sweep in progress belong, from the
# bytes of music/eeg/<stamp>.bin filtered afresh, and look for ink at those places. `shift` reads the samples that
# many samples late, as a control: the wrong stretch of the recording must not fit the picture.
ON_THE_SAMPLES = """async (shift) => {
  const { decodeCounts, splitBands } = await import('./music/eegbands.js');
  const { BANDS } = await import('./music/hearing.js');
  const index = await (await fetch('music/eeg/index.json', { cache: 'no-store' })).json();
  const entry = index.sessions.find((e) => e.stamp === window.__player.piece);
  if (!entry) return { error: 'the piece has no stored minute' };
  const bands = splitBands(decodeCounts(await (await fetch('music/eeg/' + entry.file)).arrayBuffer(), entry.uv_per_count), entry.fs);
  const p = window.__waves.probe();
  if (!p || !p.sweep || p.sweep.kind !== 'record') return { error: 'no record sweep in progress' };
  const c = document.getElementById('waves');
  const g = c.getContext('2d');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const length = entry.samples - 2 * entry.lead;
  // `looked`/`inked`: every place, any ink strong enough to be a dot and not a glow. `far`/`own`: the places past the
  // first third of the way, where the five rays have parted, and the ink must be the band's own colour.
  let looked = 0, inked = 0, far = 0, own = 0;
  const per = {};
  BANDS.forEach((band, i) => {
    let bl = 0, bh = 0;
    for (let n = 40; n <= p.sweep.painted[i] - 4; n += 7) {
      const at = (p.sweep.first + n + shift) % length;
      const y = clamp(bands[band.key][entry.lead + at] * p.pxPerUv, -p.amp, p.amp);
      const d = p.firstD + (n / p.sweep.need) * p.reach;
      const x = p.cx + d * p.rays[i].ux + y * p.rays[i].uy;
      const yy = p.cy + d * p.rays[i].uy - y * p.rays[i].ux;
      if (x < 2 || x > c.width / p.dpr - 2) continue;
      const px = g.getImageData(Math.round(x * p.dpr - 0.5), Math.round(yy * p.dpr - 0.5), 1, 1).data;
      const [r, gr, b] = [parseInt(band.color.slice(1, 3), 16), parseInt(band.color.slice(3, 5), 16), parseInt(band.color.slice(5, 7), 16)];
      looked += 1;
      if (px[3] > 60) inked += 1;
      if (n / p.sweep.need < 0.34) continue;
      far += 1; bl += 1;
      if (px[3] > 60 && Math.abs(px[0] - r) < 60 && Math.abs(px[1] - gr) < 60 && Math.abs(px[2] - b) < 60) { own += 1; bh += 1; }
    }
    per[band.key] = bl ? Math.round((100 * bh) / bl) : null;
  });
  return { looked, inked, far, own, per, electrode: entry.electrode, first: p.sweep.first, painted: p.sweep.painted };
}"""

FEED = """(opts) => {
  let k = 0;
  const feed = () => {
    const r = window.__band.relay;
    const who = opts.who || 'test-head';
    r.ingest({ t: 'quality', pseudonym: who, playable: opts.playable !== false, hsi: { TP9: 1, AF7: 1, AF8: 1, TP10: 1 } });
    const row = { delta: 0.2, theta: 0.1, alpha: 0.45, beta: 0.2, gamma: 0.05 };
    r.ingest({ t: 'bands', pseudonym: who, rel: { TP9: row, AF7: row, AF8: row, TP10: row } });
    if (opts.raw) {
      // sixteen samples a frame, sixteen frames a second: 15 uV at 10 Hz on an 800 uV standing level, on every electrode
      const x = [0, 1, 2, 3].map(() => Array.from({ length: 16 }, (_, j) => 800 + 15 * Math.sin((2 * Math.PI * 10 * (k + j)) / 256)));
      k += 16;
      r.ingest({ t: 'eeg', pseudonym: who, fs: 256, ch: ['TP9', 'AF7', 'AF8', 'TP10'], x });
    }
  };
  feed();
  window.__feeds = window.__feeds || [];
  window.__feeds.push(setInterval(feed, 62.5));
}"""
UNFEED = "() => { (window.__feeds || []).forEach(clearInterval); window.__feeds = []; }"
SWINGS = """async () => {
  // the tallest each band's newest dot stands over three seconds, in px
  const tall = [0, 0, 0, 0, 0];
  for (let k = 0; k < 90; k += 1) {
    const p = window.__waves.probe();
    if (p && p.sweep && p.sweep.kind === 'live') p.sweep.last.forEach((v, i) => { tall[i] = Math.max(tall[i], Math.abs(v)); });
    await new Promise((r) => setTimeout(r, 33));
  }
  return tall;
}"""


def new_page(browser, **kw):
    ctx = browser.new_context(viewport={"width": kw.pop("width", 1280), "height": kw.pop("height", 800)}, **kw)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    def on_console(m):
        if m.type != "error":
            return
        url = (m.location or {}).get("url", "")
        # app.js first asks its own host for a relay; a static host has none and answers 404 (now and then 503) for these four
        if any(url.split("?")[0].rstrip("/").endswith(path) for path in ("/stats", "/record", "/checkins", "/shares")):
            return
        errors.append(f"{m.text} {url}")

    page.on("console", on_console)
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_function(READY, timeout=60000)
    return page, errors


with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])

    print("1. play from the button")
    page, errors = new_page(b)
    s = page.evaluate(STATE)
    check(not s["playing"] and s["noteHidden"] and s["inked"] == 0 and not s["sounding"] and not s["waves"]["inked"], "before play: silent, no note, nothing drawn", json.dumps(s)[:300])
    page.click("#listen")
    page.wait_for_timeout(5200)
    s = page.evaluate(STATE)
    check(s["playing"] and s["mode"] == "record", "playing the day's piece from the record", s["mode"])
    check(s["waves"]["running"] and s["waves"]["source"] == "record" and s["waves"]["sweeps"] >= 1 and s["waves"]["dots"] > 2500 and s["inked"] > 20,
          "the wand has left the mark and is laying down dots from the stored minute", json.dumps(s["waves"]) + f" inked {s['inked']}")
    check(s["drawn"] and s["drawn"]["kind"] == "record" and s["drawn"]["electrode"] in ("TP9", "AF7", "AF8", "TP10"), "the page knows the waves are the record's own samples, and from which electrode", json.dumps(s["drawn"]))
    check(s["waves"]["level"] > 0.2, "the wand's lights follow the level of the sound", str(s["waves"]["level"]))
    check(s["sounding"], "the 6ense mark is lit")
    check(not s["noteHidden"] and not s["floating"] and s["noteInView"] and s["notePos"] == "relative", "the note is shown under the menu", json.dumps({k: s[k] for k in ("noteHidden", "floating", "noteInView", "notePos")}))
    check("What you are hearing" in s["noteText"] and "not a recording" in s["noteText"] and "summary of one session" in s["noteText"], "the note says what the music is", s["noteText"][:200])
    check("that session's own EEG: one minute from the electrode" in s["noteText"] and "Every dot is one stored sample" in s["noteText"] and "SWIM (Sequential Wave Imprinting Machine)" in s["noteText"],
          "the note says the waves are the session's own EEG, sample by sample, drawn as a SWIM draws", s["noteText"][-330:])
    check(all(name in s["noteText"] for name in ("delta", "theta", "alpha", "beta", "gamma")), "the note names the five bands")
    shot(page, "swim_light.png", clip={"x": 0, "y": 0, "width": 1280, "height": 470})

    print("2. the dots are the published samples")
    fit = page.evaluate(ON_THE_SAMPLES, 0)
    check("error" not in fit and fit["looked"] >= 400 and fit["inked"] >= 0.99 * fit["looked"],
          f"there is a dot at {fit.get('inked')} of {fit.get('looked')} places computed afresh from the bytes of the published file", json.dumps(fit))
    check("error" not in fit and fit["far"] >= 200 and fit["own"] >= 0.98 * fit["far"] and all(v is not None and v >= 96 for v in fit["per"].values()),
          f"and where the five rays have parted it is the band's own colour ({fit.get('own')} of {fit.get('far')}; per band {fit.get('per')})", json.dumps(fit))
    wrong = page.evaluate(ON_THE_SAMPLES, 128)
    check("error" not in wrong and wrong["own"] <= 0.6 * wrong["far"],
          f"the same recording read half a second late does not fit the picture ({wrong.get('own')} of {wrong.get('far')})", json.dumps(wrong))

    print("3. the canvas does not swallow clicks")
    page.click("nav a[href='#record']")
    page.wait_for_timeout(900)
    check(page.evaluate("() => location.hash") == "#record", "a menu link under the waves still works")
    page.evaluate("() => scrollTo(0, 0)")

    print("4. stop")
    page.click("#listen")
    page.wait_for_timeout(500)
    s = page.evaluate(STATE)
    check(not s["playing"] and s["noteHidden"] and not s["sounding"] and not s["waves"]["running"], "stopped: note gone, mark unlit, the wand has stopped", json.dumps(s)[:300])
    dots = s["waves"]["dots"]
    page.wait_for_timeout(3000)
    s = page.evaluate(STATE)
    check(not s["waves"]["inked"] and s["inked"] == 0 and s["waves"]["dots"] == dots, "the picture faded and the canvas is clean", json.dumps(s["waves"]) + f" inked {s['inked']}")

    print("5. play again, close the note")
    page.click("#listen")
    page.wait_for_timeout(1500)
    s = page.evaluate(STATE)
    check(not s["noteHidden"], "the note comes back with the music")
    page.click("#listen-note .x")
    page.wait_for_timeout(4500)          # two bars go by
    s = page.evaluate(STATE)
    check(s["playing"] and s["noteHidden"], "closed with the cross: it stays closed while the music plays", json.dumps({k: s[k] for k in ("playing", "noteHidden")}))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("6. a live sharer who sends band powers only (frames fed to the page by hand; nothing is sent anywhere)")
    page, errors = new_page(b)
    page.click("#listen")
    page.wait_for_timeout(1500)
    page.evaluate(FEED, {"raw": False})
    page.wait_for_timeout(7500)
    s = page.evaluate(STATE)
    check(s["mode"] == "live" and "1 person sharing live" in s["status"], "the band follows the live head", s["status"])
    sh = s["shares"] or {}
    check(abs(sh.get("alpha", 0) - 0.45) < 0.03 and abs(sh.get("beta", 0) - 0.2) < 0.03 and abs(sh.get("delta", 0) - 0.2) < 0.03, "the band shares are the live head's", json.dumps(sh))
    check(s["drawn"] and s["drawn"]["kind"] == "powers" and s["waves"]["source"] == "powers", "no raw trace is coming, so the waves are drawn from band powers", json.dumps(s["drawn"]) + " " + str(s["waves"]["source"]))
    check("following 1 person" in s["noteText"] and "how strong each of the five bands is for the people sharing" in s["noteText"]
          and "band powers, not from a raw trace" in s["noteText"] and "sample" not in s["noteText"] and "summary of one session" not in s["noteText"],
          "the note says the band is following them, and that the waves are band powers, not samples", s["noteText"])

    print("7. the same sharer starts sending a raw trace")
    page.evaluate(UNFEED)
    page.evaluate(FEED, {"raw": True})
    page.wait_for_timeout(7500)
    s = page.evaluate(STATE)
    check(s["drawn"] and s["drawn"]["kind"] == "live" and s["drawn"]["electrode"] == "TP9" and s["waves"]["source"] == "live", "the waves are now the raw trace as it arrives", json.dumps(s["drawn"]) + " " + str(s["waves"]["source"]))
    check("one sharer's raw trace as it arrives, from the electrode behind the left ear" in s["noteText"] and "stored" not in s["noteText"], "the note says so", s["noteText"])
    tall = page.evaluate(SWINGS)
    scale = s["waves"]["pxPerUv"]
    check(abs(tall[2] - 15 * scale) < 2.0 and tall[0] < 2.5 and tall[4] < 1.5,
          f"a 15 uV wave at 10 Hz stands {tall[2]:.1f} px tall in alpha ({15 * scale:.1f} expected) and is all but absent from delta and gamma", json.dumps(tall))
    shot(page, "swim_live_raw.png", clip={"x": 0, "y": 0, "width": 1280, "height": 470})
    page.evaluate(UNFEED)
    page.evaluate("() => { window.__band.relay.ingest({ t: 'leave', pseudonym: 'test-head' }); }")
    page.wait_for_timeout(6500)
    s = page.evaluate(STATE)
    check("summary of one session" in s["noteText"] and s["mode"] == "record" and s["drawn"]["kind"] == "record" and s["waves"]["source"] == "record",
          "when they leave, the band and the waves go back to the record, and the note says so", s["noteText"][:200] + " " + json.dumps(s["drawn"]))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("8. a sharer who did not open their headband to the music")
    page, errors = new_page(b)
    page.click("#listen")
    page.wait_for_timeout(1500)
    page.evaluate(FEED, {"raw": True, "playable": False, "who": "closed-head"})
    page.wait_for_timeout(7500)
    s = page.evaluate(STATE)
    check(s["mode"] == "record" and s["drawn"]["kind"] == "record" and s["waves"]["source"] == "record" and "raw trace" not in s["noteText"],
          "their raw trace is not played and not drawn", json.dumps(s["drawn"]) + " " + s["mode"])
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("9. the first tap far down the page")
    page, errors = new_page(b)
    page.evaluate("() => scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(500)
    box = page.evaluate("() => { const r = document.querySelector('footer b').getBoundingClientRect(); return [r.left + 5, r.top + 5]; }")
    page.mouse.click(box[0], box[1])
    page.wait_for_timeout(3000)
    s = page.evaluate(STATE)
    check(s["playing"] and s["scrollY"] > 500, "a tap on the page starts the band", json.dumps({k: s[k] for k in ("playing", "scrollY")}))
    check(not s["noteHidden"] and s["floating"] and s["noteInView"] and s["notePos"] == "fixed", "the note is pinned in the window, in sight", json.dumps({k: s[k] for k in ("noteHidden", "floating", "noteInView", "notePos")}))
    shot(page, "swim_floating.png")
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("10. a visitor who asked for less motion")
    page, errors = new_page(b, reduced_motion="reduce")
    page.click("#listen")
    page.wait_for_timeout(4500)
    s = page.evaluate(STATE)
    check(s["playing"] and s["waves"]["reduced"] and s["waves"]["dots"] == 0 and s["inked"] == 0, "music plays, nothing moves", json.dumps(s["waves"]) + f" inked {s['inked']}")
    check(not s["noteHidden"] and "waves" not in s["noteText"] and "What you are hearing" in s["noteText"], "the note leaves the waves out", s["noteText"][-200:])
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("11. phone width, dark")
    page, errors = new_page(b, width=390, height=800, color_scheme="dark")
    page.click("#listen")
    page.wait_for_timeout(5000)
    s = page.evaluate(STATE)
    w = page.evaluate("() => { const r = document.getElementById('listen-note').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), document.getElementById('waves').getBoundingClientRect().width]; }")
    check(not s["noteHidden"] and w[0] >= 0 and w[1] <= 390 and w[2] <= 390, "the note and the waves fit a phone screen", str(w))
    check(s["waves"]["sweeps"] >= 1 and s["waves"]["dots"] > 2500 and s["inked"] > 10, "the dots are drawn on the phone", json.dumps(s["waves"]))
    fit = page.evaluate(ON_THE_SAMPLES, 0)
    check("error" not in fit and fit["looked"] >= 100 and fit["inked"] >= 0.99 * fit["looked"], f"and stand where the published samples say ({fit.get('inked')} of {fit.get('looked')})", json.dumps(fit))
    shot(page, "swim_phone_dark.png")
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    b.close()

bad = results.count(False)
print(f"\n{'FAIL ' + str(bad) + ' of' if bad else 'PASS'} {len(results)} checks")
sys.exit(1 if bad else 0)

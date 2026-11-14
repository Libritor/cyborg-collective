"""Browser check of the home page's band: the brain-wave panel (SWIM), the chains panel and the 'what you are hearing' note.

    python -m http.server 8771 --bind 127.0.0.1        (in the repository root, in another terminal)
    python music/test_home_page.py [URL] [FOLDER]      -> "PASS <n> checks", exit 0

URL defaults to the local copy; give http://6ense.com/ to check the published page. With FOLDER, screenshots are
saved there. Needs playwright with its Chromium (pip install playwright; playwright install chromium).

The check that matters most is section 2: it recomputes, from the bytes of the published music/eeg/<stamp>.bin,
where every dot belongs on the panel's axes (seconds across, microvolts up), and looks for the ink there; then it
reads the same recording half a second late and shows that the wrong stretch does not fit. Live sharers are
imitated by handing frames to the page's own relay object; nothing is sent to any server.

The band plays by default on every visit, so arrival is checked both ways: where the browser holds the sound back
until the visitor touches the page (the wand and the chains must run in silence, the page must ask for the tap, and
the sound must join on the first tap or key press, anywhere), and where it lets a page sound at once (the band must
be playing on arrival, untouched, also for a visitor who stopped it last time). The test browser itself
always lets a page sound (it counts its own navigation as a gesture), so the first case is made by HOLD_SOUND
below: an AudioContext that stays suspended, and whose resume() stays pending, until the page has had a real
(trusted) tap or key press.

Section 13 is an iPhone, as far as a desk can make one: a phone's address line, a touch screen, and a stand-in for
the audio session a phone's browser has. It shows that the page asks for what an iPhone's silent switch respects
(the session set to playback, a silent loop playing beside the band, both from the tap itself) and that a touch
brings the sound back after the phone takes it away. What the switch then does can only be heard on an iPhone.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")       # the page's words include characters a Windows console lacks
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
# What most browsers do on a first visit: a context made before any gesture is suspended, and resume() does not
# resolve until the page has had a trusted tap or key press (the test's own clicks and key presses are trusted).
HOLD_SOUND = """(() => {
  const Real = window.AudioContext;
  let touched = false;
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchend']) {
    window.addEventListener(type, (event) => { if (event.isTrusted) touched = true; }, true);
  }
  const waiting = [];
  window.AudioContext = class extends Real {
    constructor(...args) { super(...args); if (!touched) super.suspend(); }
    resume() {
      if (!touched) return new Promise((resolve) => { waiting.push(resolve); });
      return super.resume().then(() => { while (waiting.length) waiting.shift()(); });
    }
  };
})();"""
IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
          "Version/18.1 Mobile/15E148 Safari/604.1")
# the audio session an iPhone's browser has and this one does not, and a list of every media element the page plays
PHONE = """(() => {
  if (!navigator.audioSession) Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
  window.__media = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { if (!window.__media.includes(this)) window.__media.push(this); return play.apply(this, args); };
})();"""
PHONE_STATE = """() => {
  const a = window.__audible ? window.__audible.state : {}, m = window.__media || [], el = m[0];
  let rate = null;
  if (el && el.src.startsWith('data:audio/wav;base64,')) {
    const bytes = Uint8Array.from(atob(el.src.split(',')[1]), (c) => c.charCodeAt(0));
    rate = new DataView(bytes.buffer).getUint32(24, true);
  }
  return { playing: window.__player.playing, stopped: window.__player.stopped, ctx: window.__band.ctx.state, ctxRate: window.__band.ctx.sampleRate,
    session: navigator.audioSession ? navigator.audioSession.type : null, apple: a.apple, loop: a.loop, media: m.length,
    looping: el ? el.loop : null, paused: el ? el.paused : null, inPage: el ? document.contains(el) : null, rate,
    status: document.getElementById('listen-status').textContent }; }"""
OVER_HEAD = """() => {
  const note = document.getElementById('listen-note'), stage = document.querySelector('.head-stage');
  const a = note.getBoundingClientRect(), b = stage.getBoundingClientRect();
  return { hidden: note.hidden, floating: note.classList.contains('floating'), headInView: b.top < innerHeight && b.bottom > 0,
    over: !note.hidden && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top }; }"""
STATE = """() => {
  const note = document.getElementById('listen-note');
  const r = note ? note.getBoundingClientRect() : null;
  return {
    playing: window.__player.playing, preview: window.__player.preview, waiting: window.__player.waiting, stopped: window.__player.stopped,
    ask: (() => { const a = document.getElementById('sound-ask'); return a && !a.hidden && a.getBoundingClientRect().width > 0 ? a.textContent : null; })(),
    mode: window.__player.mode, piece: window.__player.piece,
    ctx: window.__band ? window.__band.ctx.state : null,
    drawn: window.__player.waves, shares: window.__player.shares,
    waves: JSON.parse(JSON.stringify(window.__waves.state)),
    caption: document.getElementById('swim-caption').textContent,
    chains: (() => {
      const root = document.getElementById('chains');
      const graph = (name) => root.querySelector(`svg[data-graph="${name}"]`);
      const labels = (svg, pick) => (svg ? [...svg.querySelectorAll(pick)].map((n) => n.textContent) : []);
      const chord = graph('the chord chain');
      const signal = graph('the signal chain');
      const ball = (svg, id, cls) => { const n = svg && svg.querySelector(`.ch-node[data-node="${id}"] .${cls}`); return n ? n.textContent : null; };
      return {
        hidden: root.hidden, state: JSON.parse(JSON.stringify(window.__chains.state)), text: root.innerText.replace(/\\s+/g, ' '),
        steps: labels(chord, '.ch-node[data-node^="step:"] .ch-label'),
        lit: labels(chord, '.ch-node[data-state="current"] .ch-label, .ch-node[data-state="armed"] .ch-label'),
        signalBalls: signal ? signal.querySelectorAll('.ch-node').length : 0,
        terms: signal ? signal.querySelectorAll('.ch-node[data-kind="term"]').length : 0,
        C: ball(signal, 'C', 'ch-value'),
      };
    })(),
    noteHidden: note.hidden, noteText: note.innerText.replace(/\\s+/g, ' '), floating: note.classList.contains('floating'),
    noteInView: r ? (r.top >= 0 && r.bottom <= innerHeight && r.width > 0) : false,
    noteBegins: r ? (r.top >= 0 && r.top <= innerHeight - 60 && r.width > 0) : false,
    statusInView: (() => { const q = document.getElementById('listen-status').getBoundingClientRect(); return q.top >= 0 && q.bottom <= innerHeight && q.width > 0; })(),
    notePos: getComputedStyle(note).position,
    sounding: document.getElementById('mark-6ense').classList.contains('sounding'),
    status: document.getElementById('listen-status').textContent,
    scrollY: Math.round(scrollY),
  };
}"""

# Hold the picture against the published file: recompute where the dots on the panel belong, from the bytes of
# music/eeg/<stamp>.bin filtered afresh and the panel's own axes, and look for ink of the band's colour at those
# places. `shift` reads the samples that many samples late, as a control: the wrong stretch must not fit.
ON_THE_SAMPLES = """async (shift) => {
  const { decodeCounts, splitBands } = await import('./music/eegbands.js');
  const { BANDS } = await import('./music/hearing.js');
  const index = await (await fetch('music/eeg/index.json', { cache: 'no-store' })).json();
  const entry = index.sessions.find((e) => e.stamp === window.__player.piece);
  if (!entry) return { error: 'the piece has no stored minute' };
  const bands = splitBands(decodeCounts(await (await fetch('music/eeg/' + entry.file)).arrayBuffer(), entry.uv_per_count), entry.fs);
  // Fetching and splitting the minute takes a moment, and the wand does not wait for it: a sweep that was nearly
  // done when this began may have given way to a new, empty one. Hold on until the sweep on the panel has laid most
  // of its dots, then read it at once.
  const began = performance.now();
  let p = window.__waves.probe();
  while ((!p || !p.sweep || p.sweep.kind !== 'record' || !(p.sweep.painted[0] > 0.7 * p.sweep.need)) && performance.now() - began < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    p = window.__waves.probe();
  }
  if (!p || !p.sweep || p.sweep.kind !== 'record') return { error: 'no record picture on the panel' };
  const c = document.getElementById('waves');
  const g = c.getContext('2d');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const length = entry.samples - 2 * entry.lead;
  let looked = 0, own = 0;
  const per = {};
  BANDS.forEach((band, i) => {
    let bl = 0, bh = 0;
    for (let n = 8; n <= p.sweep.painted[i] - 14; n += 5) {
      const at = (p.sweep.first + n + shift) % length;
      const x = p.x0 + (n / p.sweep.need) * p.plotW;
      const y = p.bases[i] - clamp(bands[band.key][entry.lead + at] * p.pxPerUv, -p.amp, p.amp);
      const px = g.getImageData(Math.round(x * p.dpr - 0.5), Math.round(y * p.dpr - 0.5), 1, 1).data;
      const [r, gr, b] = [parseInt(band.color.slice(1, 3), 16), parseInt(band.color.slice(3, 5), 16), parseInt(band.color.slice(5, 7), 16)];
      looked += 1; bl += 1;
      // ink of this band's own colour, strongly enough to be the dot itself and not a neighbour's glow
      if (px[3] > 60 && Math.abs(px[0] - r) < 60 && Math.abs(px[1] - gr) < 60 && Math.abs(px[2] - b) < 60) { own += 1; bh += 1; }
    }
    per[band.key] = bl ? Math.round((100 * bh) / bl) : null;
  });
  return { looked, own, per, still: p.still, electrode: entry.electrode, first: p.sweep.first, painted: p.sweep.painted };
}"""

# The panel keeps to itself, and carries its axes: no overlap with the text, the menu or the note; ink where the
# band names and microvolt ticks go (left of the plot) and where the seconds go (under it).
LAYOUT = """() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top + scrollY, r: r.right, b: r.bottom + scrollY }; };
  const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const panel = box(document.getElementById('swim'));
  const chains = document.getElementById('chains');
  const others = { text: document.querySelector('header.top'), menu: document.querySelector('nav'), note: document.getElementById('listen-note'), main: document.querySelector('main'), chains };
  const overlaps = {};
  const shown = (el) => el && !el.hidden && getComputedStyle(el).position !== 'fixed';
  for (const [name, el] of Object.entries(others)) overlaps[name] = shown(el) ? Math.round(overlap(panel, box(el))) : 0;
  // the chains panel keeps to itself too
  if (shown(chains)) for (const name of ['text', 'menu', 'note', 'main']) overlaps[`chains/${name}`] = shown(others[name]) ? Math.round(overlap(box(chains), box(others[name]))) : 0;
  const chainsBox = shown(chains) ? box(chains) : null;
  const p = window.__waves.probe();
  const c = document.getElementById('waves');
  const g = c.getContext('2d');
  const ink = (x, y, w, h) => {
    const d = g.getImageData(Math.round(x * p.dpr), Math.round(y * p.dpr), Math.max(1, Math.round(w * p.dpr)), Math.max(1, Math.round(h * p.dpr))).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 80) n += 1;
    return n;
  };
  return {
    overlaps,
    panel: { width: Math.round(panel.r - panel.l), right: Math.round(panel.r), left: Math.round(panel.l) },
    chains: chainsBox ? { width: Math.round(chainsBox.r - chainsBox.l), right: Math.round(chainsBox.r), left: Math.round(chainsBox.l) } : null,
    window: innerWidth,
    bases: p.bases.map((y) => Math.round(y)),          // each lane's zero line, in BANDS order (delta first)
    left: ink(2, 14, p.x0 - 12, p.H - 50),             // band names and microvolt ticks
    under: ink(p.x0 - 4, p.H - 28, p.plotW + 8, 26),   // seconds and the axis title
    plot: { x0: p.x0, plotW: Math.round(p.plotW), H: p.H },
  };
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
  // how far from its zero line each band's newest dot stands at most, over three seconds, in px
  const tall = [0, 0, 0, 0, 0];
  for (let k = 0; k < 90; k += 1) {
    const p = window.__waves.probe();
    if (p && p.sweep && p.sweep.kind === 'live') p.sweep.last.forEach((y, i) => { if (p.sweep.painted[i] >= 0) tall[i] = Math.max(tall[i], Math.abs(y - p.bases[i])); });
    await new Promise((r) => setTimeout(r, 33));
  }
  return tall;
}"""
PICTURE = """() => {
  const c = document.getElementById('waves');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 53) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}"""


def new_page(browser, hold=True, **kw):
    init = kw.pop("init", None)
    ctx = browser.new_context(viewport={"width": kw.pop("width", 1280), "height": kw.pop("height", 800)}, **kw)
    if hold:
        ctx.add_init_script(HOLD_SOUND)
    if init:
        ctx.add_init_script(init)
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
    page.wait_for_timeout(1100)          # the page tries to start on arrival; give it the moment that takes
    return page, errors


def keeps_to_itself(page, label):
    lay = page.evaluate(LAYOUT)
    check(all(v == 0 for v in lay["overlaps"].values()), f"{label}: the panels cover no text, menu or note, nor each other", json.dumps(lay["overlaps"]))
    if lay["chains"]:
        check(lay["chains"]["left"] >= 0 and lay["chains"]["right"] <= lay["window"], f"{label}: the chains panel fits the window ({lay['chains']['width']} px wide)", json.dumps(lay["chains"]))
    check(lay["panel"]["left"] >= 0 and lay["panel"]["right"] <= lay["window"] and lay["plot"]["plotW"] >= 200, f"{label}: the panel fits the window ({lay['panel']['width']} px wide, plot {lay['plot']['plotW']} px)", json.dumps(lay))
    check(lay["left"] > 150 and lay["under"] > 60, f"{label}: its axes are drawn: band names and microvolt ticks up the left, seconds underneath", json.dumps({k: lay[k] for k in ("left", "under")}))
    check(len(lay["bases"]) == 5 and all(a > b for a, b in zip(lay["bases"], lay["bases"][1:])), f"{label}: the lanes run from gamma at the top down to delta at the bottom", json.dumps(lay["bases"]))


with sync_playwright() as p:
    # 6ense.com has no certificate of its own yet: the browser's habit of trying https first only adds a wait, and on a
    # slow line that wait outlasts the test's patience
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable"])

    print("1. arriving where the browser holds the sound back, then the listen button")
    page, errors = new_page(b)
    s = page.evaluate(STATE)
    check(not s["playing"] and s["ctx"] == "suspended" and s["noteHidden"] and not s["sounding"], "on arrival, untouched: no sound (the browser has not allowed it), no note", json.dumps(s)[:300])
    check(s["waiting"] and s["preview"] and s["waves"]["preview"] and s["waves"]["running"] and not s["waves"]["still"]
          and "session of" in s["caption"] and "no sound yet" in s["caption"] and "tap anywhere or press a key for sound" in s["status"],
          "the wand is already sweeping the stored minute in silence, and the page says there is no sound yet", s["caption"] + " | " + s["status"] + " " + json.dumps(s["waves"]))
    check(s["ask"] and "tap anywhere for sound" in s["ask"], "a plain request sits on the panel: tap anywhere for sound", str(s["ask"]))
    page.wait_for_function("() => { const p = window.__waves.probe(); return p && p.sweep && p.sweep.kind === 'record' && p.sweep.painted[0] > 0.6 * p.sweep.need; }", timeout=20000)
    fit = page.evaluate(ON_THE_SAMPLES, 0)
    check("error" not in fit and fit["looked"] >= 300 and fit["own"] >= 0.99 * fit["looked"],
          f"what the silent wand draws stands on the published samples ({fit.get('own')} of {fit.get('looked')} places)", json.dumps(fit))
    c = s["chains"]
    check(not c["hidden"] and c["state"]["shown"] and "no sound yet" in c["state"]["bar"] and len(c["steps"]) >= 2 and len(c["lit"]) == 1 and c["signalBalls"] >= 18,
          f"the chains are already stepping through the day's piece in silence ({c['state']['bar']}; {' '.join(c['steps'])}, lit {c['lit']})", json.dumps(c)[:300])
    seen = {c["state"]["bar"]}
    for _ in range(4):
        page.wait_for_timeout(1000)
        seen.add(page.evaluate("() => window.__chains.state.bar"))
    check(len(seen) >= 2, f"and are redrawn bar by bar ({sorted(seen)})")
    keeps_to_itself(page, "silent")
    shot(page, "panel_silent.png", clip={"x": 0, "y": 0, "width": 1280, "height": 560})
    page.click("#listen")
    page.wait_for_timeout(5200)
    s = page.evaluate(STATE)
    check(s["playing"] and s["mode"] == "record", "playing the day's piece from the record", s["mode"])
    check(s["waves"]["running"] and not s["waves"]["still"] and s["waves"]["source"] == "record" and s["waves"]["sweeps"] >= 1 and s["waves"]["dots"] > 2500,
          "the wand is crossing the panel, laying down dots from the stored minute", json.dumps(s["waves"]))
    check(s["drawn"] and s["drawn"]["kind"] == "record" and s["drawn"]["electrode"] in ("TP9", "AF7", "AF8", "TP10"), "the page knows the waves are the record's own samples, and from which electrode", json.dumps(s["drawn"]))
    check(s["waves"]["level"] > 0.2, "the wand's lights follow the level of the sound", str(s["waves"]["level"]))
    check(s["sounding"], "the 6ense mark is lit")
    check("session of" in s["caption"] and "electrode" in s["caption"] and "listen" not in s["caption"] and "no sound" not in s["caption"], "the line over the panel says whose session and which electrode", s["caption"])
    check(not s["waiting"] and s["ask"] is None and "no sound" not in s["chains"]["state"]["bar"], "with the sound in, the request for a tap is gone", json.dumps({"ask": s["ask"], "bar": s["chains"]["state"]["bar"]}))
    # The head with its slider now stands between the words and the menu, so in a window this tall the note no
    # longer fits whole under the menu: it begins in sight and runs on below. What a visitor must not have to scroll
    # for is why there is music and how to stop it, and that is the line in the menu itself.
    check(not s["noteHidden"] and not s["floating"] and s["noteBegins"] and s["notePos"] == "relative", "the note is shown under the menu, beginning in sight", json.dumps({k: s[k] for k in ("noteHidden", "floating", "noteBegins", "notePos")}))
    check(s["statusInView"] and "stops it" in s["status"], "the menu's own line, in sight whole, says why there is music and how to stop it", s["status"])
    check("What you are hearing" in s["noteText"] and "not a recording" in s["noteText"] and "summary of one session" in s["noteText"], "the note says what the music is", s["noteText"][:200])
    check("that session's own EEG: one minute from the electrode" in s["noteText"] and "Every dot is one stored sample, in microvolts against seconds" in s["noteText"]
          and "SWIM (Sequential Wave Imprinting Machine)" in s["noteText"],
          "the note says the waves are the session's own EEG, sample by sample, in microvolts against seconds, drawn as a SWIM draws", s["noteText"][-360:])
    check(all(name in s["noteText"] for name in ("delta", "theta", "alpha", "beta", "gamma")), "the note names the five bands")
    c = s["chains"]
    check(not c["hidden"] and c["state"]["shown"] and "how this bar of music was made" in c["text"] and "bar " in c["state"]["bar"] and "bpm" in c["state"]["bar"],
          "the chains panel is shown under the brain waves, and says which bar it is drawing", json.dumps(c)[:300])
    check(len(c["steps"]) >= 2 and c["steps"] == c["state"]["steps"] and len(c["lit"]) == 1 and c["lit"][0] == c["state"]["current"] and c["state"]["current"] in c["state"]["walk"],
          f"the chord chain: the progression's steps ({' '.join(c['steps'])}), with the one being played lit ({c['lit']})", json.dumps(c)[:400])
    check("why this bar:" in c["text"] and "THE CHORD CHAIN" in c["text"].upper(), "with the generator's own reason for the bar beside it", c["text"][:300])
    check(c["signalBalls"] >= 18 and c["terms"] == 0 and c["C"] == f"{c['state']['C']:.2f}" and "from the session's summary" in c["text"] and f"C {c['state']['C']:.2f}" in c["text"],
          f"the signal chain: C {c['C']} and what it opens, from the session's summary (no headband, so no terms)", json.dumps({k: c[k] for k in ("signalBalls", "terms", "C")}))
    shot(page, "panel_playing.png", clip={"x": 0, "y": 0, "width": 1280, "height": 1000})
    seen = {c["state"]["bar"]}
    for _ in range(4):
        page.wait_for_timeout(1000)
        seen.add(page.evaluate("() => window.__chains.state.bar"))
    check(len(seen) >= 2, f"the chains are redrawn bar by bar ({sorted(seen)})")

    print("2. the dots are the published samples, on the panel's axes")
    # wait until the sweep in progress is well under way, so there is a good stretch of it to hold against the file
    page.wait_for_function("() => { const p = window.__waves.probe(); return p && p.sweep && p.sweep.kind === 'record' && p.sweep.painted[0] > 0.7 * p.sweep.need; }", timeout=20000)
    fit = page.evaluate(ON_THE_SAMPLES, 0)
    check("error" not in fit and not fit["still"] and fit["looked"] >= 150 and fit["own"] >= 0.99 * fit["looked"] and all(v is not None and v >= 97 for v in fit["per"].values()),
          f"a dot of the band's own colour at {fit.get('own')} of {fit.get('looked')} places computed afresh from the bytes of the published file (per band {fit.get('per')})", json.dumps(fit))
    # the wand may have begun a new sweep since: wait until there is a stretch painted to hold the late read against
    page.wait_for_function("() => { const p = window.__waves.probe(); return p && p.sweep && p.sweep.kind === 'record' && p.sweep.painted[0] > 0.7 * p.sweep.need; }", timeout=20000)
    wrong = page.evaluate(ON_THE_SAMPLES, 128)
    # How badly the wrong stretch fits depends on how far the waves swing: on a quiet forehead electrode the fast
    # bands barely leave their line, so a late read still lands on their ink. The slow bands swing widest in any
    # recording; they are the ones that must stop fitting, and the whole must fit clearly worse than the true read.
    slow = [wrong.get("per", {}).get(band) for band in ("delta", "theta")]
    check("error" not in wrong and wrong["looked"] >= 150 and wrong["own"] <= 0.88 * wrong["looked"] and all(v is not None and v <= 75 for v in slow),
          f"the same recording read half a second late does not fit the picture ({wrong.get('own')} of {wrong.get('looked')}; delta and theta at {slow[0]} % and {slow[1]} %)", json.dumps(wrong))

    print("3. the panel keeps to itself")
    keeps_to_itself(page, "playing")
    page.click("nav a[href='#record']")
    page.wait_for_timeout(900)
    check(page.evaluate("() => location.hash") == "#record", "the menu still works")
    page.evaluate("() => scrollTo(0, 0)")

    print("4. stop")
    page.click("#listen")
    page.wait_for_timeout(500)
    s = page.evaluate(STATE)
    check(not s["playing"] and s["noteHidden"] and not s["sounding"] and not s["waves"]["running"], "stopped: note gone, mark unlit, the wand has stopped", json.dumps(s)[:300])
    dots = s["waves"]["dots"]
    page.wait_for_timeout(3000)
    s = page.evaluate(STATE)
    check(s["waves"]["still"] and s["waves"]["dots"] == dots and "listen sets the wand going" in s["caption"], "the sweep faded and the still picture is back", json.dumps(s["waves"]) + " " + s["caption"])
    check(s["chains"]["hidden"] and s["stopped"] and "stopped" in s["status"] and s["ask"] is None, "the chains are put away with the music, and the page says it is stopped", s["status"])

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
    check(s["caption"] == "band powers of the people sharing live · no raw trace to draw", "and so does the line over the panel", s["caption"])
    c = s["chains"]
    check("from 1 person sharing live" in c["text"] and c["terms"] == 3 and c["C"] == f"{c['state']['C']:.2f}",
          f"the signal chain is now drawn from the live head: three terms weighed into C {c['C']}", json.dumps({k: c[k] for k in ("terms", "C")}) + " " + c["text"][-200:])

    print("7. the same sharer starts sending a raw trace")
    page.evaluate(UNFEED)
    page.evaluate(FEED, {"raw": True})
    page.wait_for_timeout(7500)
    s = page.evaluate(STATE)
    check(s["drawn"] and s["drawn"]["kind"] == "live" and s["drawn"]["electrode"] == "TP9" and s["waves"]["source"] == "live", "the waves are now the raw trace as it arrives", json.dumps(s["drawn"]) + " " + str(s["waves"]["source"]))
    check("one sharer's raw trace as it arrives, from the electrode behind the left ear" in s["noteText"] and "stored" not in s["noteText"]
          and s["caption"] == "brain waves, live · electrode TP9, behind the left ear", "the note and the line over the panel say so", s["noteText"] + " | " + s["caption"])
    tall = page.evaluate(SWINGS)
    scale = s["waves"]["pxPerUv"]
    check(abs(tall[2] - 15 * scale) < 2.0 and tall[0] < 2.5 and tall[4] < 1.5,
          f"a 15 uV wave at 10 Hz stands {tall[2]:.1f} px from alpha's zero line ({15 * scale:.1f} expected at {scale:.2f} px per uV) and is all but absent from delta and gamma", json.dumps(tall))
    shot(page, "panel_live_raw.png", clip={"x": 0, "y": 0, "width": 1280, "height": 560})
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
    check(s["mode"] == "record" and s["drawn"]["kind"] == "record" and s["waves"]["source"] == "record" and "raw trace" not in s["noteText"] and "live" not in s["caption"],
          "their raw trace is not played and not drawn", json.dumps(s["drawn"]) + " " + s["mode"] + " " + s["caption"])
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("9. any touch brings the sound: a link, a key, a tap far down the page")
    page, errors = new_page(b)
    page.click("nav a[href='#record']")
    page.wait_for_timeout(2500)
    s = page.evaluate(STATE)
    check(s["playing"] and s["ctx"] == "running" and not s["preview"] and page.evaluate("() => location.hash") == "#record",
          "a tap on a menu link follows the link and brings the sound", json.dumps({k: s[k] for k in ("playing", "ctx", "preview")}))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()
    page, errors = new_page(b)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(2500)
    s = page.evaluate(STATE)
    check(s["playing"] and s["ctx"] == "running", "a key press brings the sound", json.dumps({k: s[k] for k in ("playing", "ctx", "preview")}))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()
    page, errors = new_page(b)
    page.evaluate("() => scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(500)
    box = page.evaluate("() => { const r = document.querySelector('footer b').getBoundingClientRect(); return [r.left + 5, r.top + 5]; }")
    page.mouse.click(box[0], box[1])
    page.wait_for_timeout(3000)
    s = page.evaluate(STATE)
    check(s["playing"] and s["scrollY"] > 500, "a tap on the page starts the band", json.dumps({k: s[k] for k in ("playing", "scrollY")}))
    check(not s["noteHidden"] and s["floating"] and s["noteInView"] and s["notePos"] == "fixed", "the note is pinned in the window, in sight", json.dumps({k: s[k] for k in ("noteHidden", "floating", "noteInView", "notePos")}))
    shot(page, "panel_floating_note.png")
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("10. a visitor who asked for less motion")
    page, errors = new_page(b, reduced_motion="reduce")
    before = page.evaluate(PICTURE)
    page.click("#listen")
    page.wait_for_timeout(2500)
    one = page.evaluate(PICTURE)
    page.wait_for_timeout(2000)
    two = page.evaluate(PICTURE)
    s = page.evaluate(STATE)
    # `before` may differ from `one`: the request for a tap leaves the line over the panel when the sound comes in, and the
    # still picture is laid out again in the room that frees. What must not happen is movement while the music plays.
    check(s["playing"] and s["waves"]["reduced"] and s["waves"]["dots"] == 0 and s["waves"]["still"] and one == two, "music plays, and the picture on the panel does not move", json.dumps(s["waves"]) + f" {before} {one} {two}")
    check(not s["noteHidden"] and "waves in the panel" not in s["noteText"] and "What you are hearing" in s["noteText"] and "held still" in s["caption"],
          "the note leaves the wand out, and the line over the panel says the picture is held still", s["noteText"][-200:] + " | " + s["caption"])
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("11. phone width, dark")
    page, errors = new_page(b, width=390, height=800, color_scheme="dark")
    keeps_to_itself(page, "phone, silent")
    page.click("#listen")
    page.wait_for_timeout(5000)
    s = page.evaluate(STATE)
    w = page.evaluate("() => { const r = document.getElementById('listen-note').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }")
    check(not s["noteHidden"] and w[0] >= 0 and w[1] <= 390, "the note fits a phone screen", str(w))
    keeps_to_itself(page, "phone, playing")
    lit = page.evaluate("""() => {
      const ball = document.querySelector('#chains .ch-node[data-state="current"] .ch-ball, #chains .ch-node[data-state="armed"] .ch-ball');
      if (!ball) return null;
      const b = ball.getBoundingClientRect(); const box = ball.closest('.ch-scroll').getBoundingClientRect();
      return { inside: b.left >= box.left - 1 && b.right <= box.right + 1, left: Math.round(b.left), right: Math.round(b.right), box: [Math.round(box.left), Math.round(box.right)] };
    }""")
    check(lit is None or lit["inside"], "on a phone the chord being played is kept in sight inside the chains panel", json.dumps(lit))
    check(s["waves"]["sweeps"] >= 1 and s["waves"]["dots"] > 2500, "the dots are drawn on the phone", json.dumps(s["waves"]))
    fit = page.evaluate(ON_THE_SAMPLES, 0)
    check("error" not in fit and fit["looked"] >= 60 and fit["own"] >= 0.99 * fit["looked"], f"and stand where the published samples say ({fit.get('own')} of {fit.get('looked')})", json.dumps(fit))
    shot(page, "panel_phone_dark.png")
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("12. arriving where the browser lets a page sound without a gesture")
    page, errors = new_page(b, hold=False)
    page.wait_for_function("() => window.__player.playing", timeout=8000)
    page.wait_for_timeout(4000)
    s = page.evaluate(STATE)
    check(s["playing"] and s["ctx"] == "running" and not s["preview"] and s["sounding"], "the band is playing on arrival, with nothing touched", json.dumps({k: s[k] for k in ("playing", "ctx", "preview", "sounding")}))
    check(s["waves"]["running"] and s["waves"]["level"] > 0.2 and s["waves"]["dots"] > 1500 and not s["noteHidden"] and not s["chains"]["hidden"],
          "with sound, the wand, the note and the chains", json.dumps(s["waves"]))
    shot(page, "panel_arrival_playing.png", clip={"x": 0, "y": 0, "width": 1280, "height": 1000})
    page.click("#listen")
    page.wait_for_timeout(600)
    s = page.evaluate(STATE)
    check(not s["playing"] and s["stopped"], "the button stops it")
    page.mouse.click(700, 700)
    page.wait_for_timeout(1500)
    check(not page.evaluate("() => window.__player.playing"), "and once stopped, a tap on the page does not start it again behind the visitor's back")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function(READY, timeout=60000)
    page.wait_for_function("() => window.__player.playing", timeout=8000)
    page.wait_for_timeout(2500)
    s = page.evaluate(STATE)
    check(s["playing"] and not s["stopped"] and not s["chains"]["hidden"] and s["waves"]["running"],
          "the stop was for that visit only: on the next visit the band, the wand and the chains are playing again on arrival", json.dumps({k: s[k] for k in ("playing", "stopped")}))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()

    print("13. an iPhone: the page says its sound is playback, which the phone's silent switch leaves alone")
    page, errors = new_page(b, width=390, height=780, has_touch=True, is_mobile=True, user_agent=IPHONE, init=PHONE)
    s = page.evaluate(PHONE_STATE)
    check(s["apple"] and not s["playing"] and s["session"] == "auto" and s["media"] == 0 and s["loop"] == "none",
          "on arrival, untouched: nothing is set and nothing is made", json.dumps(s))
    box = page.locator("p.tag").bounding_box()                   # the line under the title: plain words, at the top of the page
    page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_function("() => window.__player.playing", timeout=8000)
    page.wait_for_timeout(1200)
    s = page.evaluate(PHONE_STATE)
    check(s["playing"] and s["ctx"] == "running", "one tap of a finger on the words at the top brings the band", json.dumps(s))
    o = page.evaluate(OVER_HEAD)
    check(o["headInView"] and o["floating"] and o["over"], "at the top of a phone's page the pinned note lands on the head's picture", json.dumps(o))
    page.wait_for_timeout(9500)
    o = page.evaluate(OVER_HEAD)
    check(o["headInView"] and not o["hidden"] and not o["floating"] and not o["over"] and page.evaluate("() => window.__player.playing"),
          "after a few seconds there it steps aside to its place under the menu: the head is in the clear and the band plays on", json.dumps(o))
    check(s["session"] == "playback", "the tap set the audio session to playback", json.dumps(s))
    check(s["media"] == 1 and s["loop"] == "playing" and s["looping"] and not s["paused"] and not s["inPage"],
          "and started one silent loop beside the band, which is not put on the page", json.dumps(s))
    check(s["rate"] == s["ctxRate"], f"the silence is at the band's own sample rate ({s['rate']} Hz)", json.dumps(s))
    page.evaluate("() => window.__band.ctx.suspend()")          # the phone takes the sound away: a call, another app
    page.wait_for_timeout(500)
    s = page.evaluate(PHONE_STATE)
    check(s["playing"] and s["ctx"] == "suspended" and "interrupted" in s["status"] and "tap" in s["status"],
          "when the phone takes the sound away, the line under the menu says so and asks for a tap", s["status"])
    page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(1200)
    s = page.evaluate(PHONE_STATE)
    check(s["playing"] and s["ctx"] == "running" and "interrupted" not in s["status"] and "stops it" in s["status"],
          "and the next tap brings it back", json.dumps(s))
    page.locator("#listen").tap()
    page.wait_for_timeout(600)
    s = page.evaluate(PHONE_STATE)
    check(not s["playing"] and s["stopped"] and s["paused"] and s["loop"] == "resting", "the button stops the band, and the silent loop with it", json.dumps(s))
    page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(1000)
    s = page.evaluate(PHONE_STATE)
    check(not s["playing"] and s["paused"], "once stopped, a tap on the page starts neither again", json.dumps(s))
    page.locator("#listen").tap()
    page.wait_for_function("() => window.__player.playing", timeout=8000)
    page.wait_for_timeout(800)
    s = page.evaluate(PHONE_STATE)
    check(s["playing"] and s["media"] == 1 and not s["paused"] and s["loop"] == "playing", "the button starts both again, with the same loop", json.dumps(s))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()
    page, errors = new_page(b, init=PHONE)
    page.mouse.click(700, 300)
    page.wait_for_function("() => window.__player.playing", timeout=8000)
    page.wait_for_timeout(800)
    s = page.evaluate(PHONE_STATE)
    check(s["playing"] and not s["apple"] and s["media"] == 0 and s["loop"] == "none", "on a computer the band plays and no silent loop is made", json.dumps(s))
    check(not errors, "no script errors on the page", "; ".join(errors)[:300])
    page.context.close()
    b.close()

bad = results.count(False)
print(f"\n{'FAIL ' + str(bad) + ' of' if bad else 'PASS'} {len(results)} checks")
sys.exit(1 if bad else 0)

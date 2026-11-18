"""Is the public relay passing splats on to the public page?  One short, labelled test: a small coloured ball is
sent as a headset gateway would send a room, a browser opens 6ense.com, and the page must draw it.

    python splat_live_check.py [--page http://6ense.com/] [--relay wss://cyborg-collective-relay.onrender.com] [--shot out.png]

The ball is on the public page for about five seconds under the name "Test pattern (not a room)", then it leaves.
Nothing about this computer or its user is sent. Use it after a relay deploy, not as a habit.
"""
import argparse
import asyncio
import base64
import json
import secrets
import sys
import threading
import time

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def ball(n, seed):
    """n splats on a ball half a metre across, two metres ahead: 12 bytes each, as quest_splat.py packs them."""
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 3)); v /= np.linalg.norm(v, axis=1, keepdims=True)
    q, origin = 0.005, np.array([2.0, 0.0, 1.2])
    pos = np.round(v * 0.25 / q).astype("<i2")
    col = np.clip((v * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    o = v / np.abs(v).sum(1, keepdims=True)                       # the facing, folded onto an octahedron
    neg = o[:, 2] < 0
    ox, oy = o[:, 0].copy(), o[:, 1].copy()
    ox[neg] = (1 - np.abs(o[neg, 1])) * np.where(o[neg, 0] >= 0, 1, -1)
    oy[neg] = (1 - np.abs(o[neg, 0])) * np.where(o[neg, 1] >= 0, 1, -1)
    rec = np.zeros(n, np.dtype([("p", "<i2", 3), ("c", "u1", 3), ("r", "u1"), ("n", "i1", 2)]))
    rec["p"], rec["c"], rec["r"] = pos, col, 6                    # radius 15 mm
    rec["n"][:, 0], rec["n"][:, 1] = np.round(127 * ox), np.round(127 * oy)
    return q, origin.tolist(), rec.tobytes()


async def send(relay, chunks, per, result):
    import websockets
    async with websockets.connect(relay.rstrip("/") + "/ingest") as ws:
        await ws.send(json.dumps({"t": "hello", "v": 1, "session": secrets.token_hex(16), "pseudonym": "splat-test",
                                  "tier": "camera", "device": "test", "name": "Test pattern (not a room)", "log": False}))
        result["hello"] = json.loads(await ws.recv())
        total = 0
        for k in range(chunks):
            q, origin, raw = ball(per, k)
            total += per
            await ws.send(json.dumps({"t": "splat", "ts": int(time.time() * 1000), "src": "test", "n": per, "q": q, "origin": origin,
                                      "cam": [0, 0, 1.2, 0, 0, 0, 1], "total": total, "d": base64.b64encode(raw).decode()}))
            await asyncio.sleep(0.45)
        await asyncio.sleep(2.0)
        await ws.send(json.dumps({"t": "bye", "reason": "test done"}))
        result["sent"] = total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", default="http://6ense.com/")
    ap.add_argument("--relay", default="wss://cyborg-collective-relay.onrender.com")
    ap.add_argument("--shot")
    a = ap.parse_args()
    from playwright.sync_api import sync_playwright
    result = {}
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(a.page, wait_until="domcontentloaded")
        pg.wait_for_function("() => document.getElementById('link') && document.getElementById('link').textContent === 'live'", timeout=90000)
        t = threading.Thread(target=lambda: asyncio.run(send(a.relay, 6, 600, result)), daemon=True)
        t.start()
        ok = True
        try:
            pg.wait_for_function("() => window.__splat && window.__splat.count() >= 600", timeout=30000)
        except Exception:
            ok = False
        pg.wait_for_timeout(2500)
        seen = pg.evaluate("""() => ({ count: window.__splat ? window.__splat.count() : 0,
          cards: [...document.querySelectorAll('#grid > *')].map(c => (c.querySelector('.name') || {}).textContent || c.className) })""")
        if a.shot:
            pg.screenshot(path=a.shot)
        t.join(timeout=20)
        pg.wait_for_timeout(2500)
        after = pg.evaluate("() => [...document.querySelectorAll('#grid > *')].map(c => (c.querySelector('.name') || {}).textContent || c.className)")
        b.close()
    print(json.dumps({"hello": result.get("hello"), "sent": result.get("sent"), "drawn": seen, "cards_after": after, "page_errors": errors[:3]}, ensure_ascii=False))
    good = ok and seen["count"] >= 600 and "Test pattern (not a room)" in seen["cards"] and "Test pattern (not a room)" not in after and not errors
    print("PASS: the public page drew the test splats and let them go" if good else "FAIL")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""The computer that turns phones' scans into Gaussian splats on the site.

A phone (MuseLog, "Scan in 3-D") sends its recording to the relay, which keeps it in its scan box
and hands it to nobody but this worker. For each scan that waits, the worker

  1 tells the relay it has started (the page then says "a computer is making the splat now"),
  2 fetches the bag and checks it arrived whole,
  3 makes the splat (phone_scan.py: pictures -> where each was taken from -> training),
  4 publishes it under scans/ of the site (scan_publish.py), and
  5 tells the relay where it is; the relay then deletes its copy of the bag.

A scan its owner removed from their phone is taken off the site the next time the worker looks.
The camera's pictures are deleted here once the splat is made (keep them with --keep-pictures).

  python phone_scan_worker.py --make-key        once: makes the key, says where to put it on the relay
  python phone_scan_worker.py                   look every minute, for as long as it runs
  python phone_scan_worker.py --once            look once
  python phone_scan_worker.py --relay http://127.0.0.1:8765 --no-push --once     against a private relay

The key: the relay hands a bag only to whoever sends the key it was started with
(SCANBOX_WORKER_KEY in its environment). Here it is read from the same variable, or from the file
~/.6ense/scan_worker.key. Needs the anaconda python and a graphics card (see phone_scan.py).
"""
import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phone_scan as PS                                                 # noqa: E402

RELAY = "https://cyborg-collective-relay.onrender.com"
KEY_FILE = os.path.join(os.path.expanduser("~"), ".6ense", "scan_worker.key")
CLONE = os.path.join(os.path.expanduser("~"), "cyborg-collective-site")
STOP_FILE = os.path.join(HERE, "STOP_PHONE_SCANS")


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def read_key():
    key = os.environ.get("SCANBOX_WORKER_KEY", "").strip()
    if not key and os.path.exists(KEY_FILE):
        key = open(KEY_FILE, encoding="utf-8").read().strip()
    return key


def make_key():
    if os.path.exists(KEY_FILE):
        print(f"there is a key already: {KEY_FILE}\n(delete the file first to make a new one; the relay then needs the new one too)")
        return
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    key = secrets.token_urlsafe(32)
    with open(KEY_FILE, "w", encoding="utf-8") as fh:
        fh.write(key + "\n")
    print(f"the key is in {KEY_FILE}\n\n"
          "Give the relay the same key: on Render, the service cyborg-collective-relay -> Environment ->\n"
          "add SCANBOX_WORKER_KEY with the contents of that file -> Save (the relay restarts by itself).\n"
          "Do not put the key in a repository, a chat or a page.")


class Relay:
    def __init__(self, base, key):
        self.base, self.key = base.rstrip("/"), key

    def call(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-Worker-Key": self.key, "Content-Type": "application/json",
                                              "User-Agent": "phone-scan-worker"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}

    def fetch(self, scan_id, dest):
        req = urllib.request.Request(f"{self.base}/scanbox/bag/{scan_id}",
                                     headers={"X-Worker-Key": self.key, "User-Agent": "phone-scan-worker"})
        h = hashlib.sha256()
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(req, timeout=120) as r, open(dest + ".part", "wb") as out:
            for block in iter(lambda: r.read(1024 * 1024), b""):
                out.write(block)
                h.update(block)
        os.replace(dest + ".part", dest)
        return h.hexdigest()

    def state(self, scan_id, state, **more):
        status, r = self.call("POST", f"/scanbox/state/{scan_id}", {"state": state, **more})
        if status != 200:
            log(f"{scan_id}: the relay did not take '{state}' ({status} {r.get('error', '')})")
        return r.get("state")


def publish(a, *args):
    cmd = [sys.executable, os.path.join(HERE, "scan_publish.py"), *args, "--clone", a.clone] + (["--no-push"] if a.no_push else [])
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (p.stdout + p.stderr).strip().splitlines()[-6:]:
        log("   publish:", line)
    return p.returncode == 0


def words_for(e, summary):
    """The title and the paragraph a phone's scan is published under."""
    head = e.get("kind") == "head"
    who = e.get("name") or e.get("pseudonym") or ""
    title = e.get("title") or ("A head, scanned with a phone" if head else "A place, scanned with a phone")
    pl, bag = summary.get("placing") or {}, summary.get("bag") or {}
    when = time.strftime("%d %B %Y").lstrip("0")
    note = (f"{'A head' if head else 'A place'} photographed with a phone" + (f" by {who}" if who else "") + f", made into a splat on {when}: "
            f"{pl.get('pictures')} pictures"
            + (f", of which {pl.get('placed')} could be placed" if pl.get("placed") != pl.get("pictures") else "") + ". "
            "A phone does not know where it is, so where each picture was taken from was worked out from the pictures themselves, "
            "and the splat was trained from them on a computer with a graphics card. "
            + ("" if head else "It is to be looked round from the spot one of the pictures was taken from. ")
            + "Its size is a guess: pictures alone carry no scale. "
            + (f"The recording also holds {bag.get('eeg'):,} samples of the brain waves of the headband worn while it was made. " if bag.get("eeg") else "")
            + "Sent by the person who made it, who can take it down from their phone; the pictures themselves are not published.")
    return title, note


def make(a, relay, e):
    scan_id = e["id"]
    sid = "phone-" + scan_id
    if relay.state(scan_id, "processing") == "remove":
        return
    run_dir = os.path.join(PS.OUT_ROOT, sid)
    bag = os.path.join(run_dir, "bag", sid + ".mcap")
    try:
        digest = relay.fetch(scan_id, bag)
        if e.get("sha256") and digest != e["sha256"]:
            raise PS.Unusable("the recording did not arrive whole at the computer making the splat")
        log(f"{sid}: fetched {os.path.getsize(bag) / 1e6:.1f} MB")
        run_dir, summary = PS.run(bag, kind=e.get("kind"), name=sid, steps=a.steps, title=e.get("title"),
                                  keep_pictures=a.keep_pictures)
        title, note = words_for(e, summary)
        if not publish(a, run_dir, "--id", sid, "--kind", "phone", "--title", title, "--note", note):
            raise RuntimeError("publishing failed")
        left = relay.state(scan_id, "published", url=f"scans/view.html?scan={sid}",
                           splats=summary.get("shown_gaussians") or (summary.get("train") or {}).get("gaussians"),
                           note=f"{summary['placing']['placed']} of {summary['placing']['pictures']} pictures placed")
        if left == "remove":
            # its owner removed it while it was being made: it comes straight down again
            publish(a, "--remove", sid)
            relay.state(scan_id, "removed")
            shutil.rmtree(run_dir, ignore_errors=True)
            log(f"{sid}: removed by its owner while it was being made; taken down")
            return
        log(f"{sid}: published")
    except PS.Unusable as u:
        log(f"{sid}: no splat: {u}")
        relay.state(scan_id, "failed", note=str(u))
    except (Exception, SystemExit) as ex:  # noqa: BLE001  one bad scan must not stop the others
        log(f"{sid}: failed: {ex}")
        traceback.print_exc()
        relay.state(scan_id, "failed", note="the computer making the splat ran into an error")
    finally:
        if not a.keep_pictures:
            shutil.rmtree(os.path.join(run_dir, "bag"), ignore_errors=True)   # the pictures are not kept


def take_down(a, relay, e):
    sid = "phone-" + e["id"]
    if os.path.isdir(os.path.join(a.clone, "scans", "runs", sid)):
        if not publish(a, "--remove", sid):
            log(f"{sid}: could not be taken off the site; it stays asked for")
            return
    shutil.rmtree(os.path.join(PS.OUT_ROOT, sid), ignore_errors=True)
    relay.state(e["id"], "removed")
    log(f"{sid}: taken down at its owner's request")


def look(a, relay):
    status, q = relay.call("GET", "/scanbox/queue")
    if status == 503:
        raise SystemExit("the relay has no worker key set (SCANBOX_WORKER_KEY): run --make-key and follow what it says")
    if status == 403:
        raise SystemExit("the relay does not accept this key: it must be the same on both sides")
    if status != 200:
        log(f"the relay answered {status}; trying again later")
        return 0
    scans = q.get("scans") or []
    for e in scans:
        if e.get("state") == "remove":
            take_down(a, relay, e)
    for e in scans:
        if e.get("state") != "remove":
            log(f"{e['id']}: {e.get('kind')}, {e.get('pictures')} pictures, {(e.get('bytes') or 0) / 1e6:.1f} MB")
            make(a, relay, e)
    return len(scans)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--relay", default=RELAY, help="the relay's http address")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--every", type=int, default=60, help="seconds between looks")
    ap.add_argument("--steps", type=int, default=7000, help="training steps for each splat")
    ap.add_argument("--clone", default=CLONE, help="the local clone of the site's repository")
    ap.add_argument("--no-push", action="store_true", help="write into the clone only (for trying things out)")
    ap.add_argument("--keep-pictures", action="store_true", help="keep each scan's bag and pictures on this computer")
    ap.add_argument("--make-key", action="store_true")
    a = ap.parse_args()
    if a.make_key:
        return make_key()
    key = read_key()
    if not key:
        raise SystemExit("no key: run with --make-key first")
    relay = Relay(a.relay, key)
    log(f"looking for phones' scans on {a.relay}" + ("" if a.once else f" every {a.every} s; stop with Ctrl-C or by creating {STOP_FILE}"))
    while True:
        try:
            look(a, relay)
        except urllib.error.URLError as e:
            log(f"the relay cannot be reached ({e.reason}); trying again later")
        if a.once or os.path.exists(STOP_FILE):
            break
        time.sleep(a.every)


if __name__ == "__main__":
    main()

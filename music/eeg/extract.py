"""Cut the minute of EEG the home page draws out of a stored MuseLog recording.

    python music/eeg/extract.py PATH/muse_session_<stamp>_<headband>.csv [more.csv ...]
    python music/eeg/extract.py --check PATH/muse_session_<stamp>_<headband>.csv

The waves that leave the 6ense mark while the band plays are drawn from the
samples in the recording itself. This tool reads one recording, finds its
steadiest minute on its steadiest electrode, and writes that minute here:

    music/eeg/<stamp>.bin     the samples, exactly as stored: one little-endian
                              uint16 per sample, the headband's own ADC count
    music/eeg/index.json      one entry per recording: which electrode, where
                              in the recording the minute starts, the sampling
                              rate, and microvolts per count

The file holds two seconds more at each end than the minute that is drawn
(`lead` samples): band filters need a moment to settle, and they settle on the
recording's own samples there instead of on an invented edge.

Nothing is filtered, resampled or rounded on the way: the CSV prints each
sample as count x a fixed number of microvolts (1450 / 16383 for the 14-bit
headbands, 1650 / 4095 for the 12-bit ones; CONVERTERS below), and the count is
what is kept, so the file gives back the CSV's numbers digit for digit (--check
proves it, and every run checks what it has just written). Which converter a
recording used is read off its own numbers and written into its index entry. The page does the band filtering in
the browser, where anyone can read it (music/swim.js).

Only one electrode and one minute leave the laptop; the rest of the recording
stays where it is. Run it only on recordings whose wearer agreed to this: the
page's promise is that raw recordings stay with the person who made them, and
an excerpt is published here only for the sessions listed in index.json.

Needs numpy and scipy (the filtering here is only used to judge steadiness).
"""
import argparse
import csv
import json
import os
import re
import sys

import numpy as np
from scipy.signal import butter, sosfiltfilt

HERE = os.path.dirname(os.path.abspath(__file__))
RECORD = os.path.normpath(os.path.join(HERE, "..", "..", "data", "index.json"))
INDEX = os.path.join(HERE, "index.json")

ELECTRODES = ("TP9", "AF7", "AF8", "TP10")
SITES = {"TP9": "behind the left ear", "AF7": "left forehead", "AF8": "right forehead", "TP10": "behind the right ear"}
PREFER = ("TP9", "TP10", "AF7", "AF8")       # on a tie the ear electrodes, where alpha is strongest
FS = 256                                     # Hz, the headband's EEG rate
# (microvolts per count, highest count): what a headband's converter prints a sample as
CONVERTERS = (
    (1450.0 / 16383.0, 16383),               # 14 bits over 1450 microvolts (Muse S)
    (1650.0 / 4095.0, 4095),                 # 12 bits over 1650 microvolts (Muse 2 and the 2016 Muse)
)
EPOCH_S = 2
LEAD_S = 2                                   # kept at each end of the drawn stretch for the page's filters to settle on
CLEAN_PP_UV = 100.0                          # a 2 s epoch is steady when its 1-45 Hz swing stays under this
FLAT_RMS_UV = 0.5                            # ... and it is not a dead line
ABOUT = ("One minute of one electrode from each recording listed here, exactly as stored: uint16 ADC counts, "
         "little-endian, `fs` samples a second, microvolts = count x `uv_per_count`. The file starts `lead` samples "
         "before the minute and ends `lead` samples after it; those are there for the band filters to settle on and "
         "are not drawn. Written by music/eeg/extract.py; drawn by music/swim.js. Every other part of every recording "
         "stays with the person who made it.")


def read_eeg(path):
    """The EEG rows of a MuseLog CSV: the printed text of each sample, the elapsed clock and the contact codes."""
    text = {ch: [] for ch in ELECTRODES}
    hsi = {ch: [] for ch in ELECTRODES}
    ms = []
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)
        col = {name: i for i, name in enumerate(header)}
        for need in ["PACKET_TYPE", "ms_ELAPSED"] + [f"{ch}_RAW" for ch in ELECTRODES]:
            if need not in col:
                raise SystemExit(f"{path}: no {need} column; this is not a MuseLog recording")
        raw_i = [col[f"{ch}_RAW"] for ch in ELECTRODES]
        hsi_i = [col.get(f"{ch}_CONNECTION_STRENGTH(HSI)") for ch in ELECTRODES]
        kind_i, ms_i = col["PACKET_TYPE"], col["ms_ELAPSED"]
        for row in reader:
            if len(row) <= max(raw_i) or row[kind_i] != "EEG" or not row[raw_i[0]]:
                continue
            ms.append(float(row[ms_i] or "nan"))
            for ch, ri, hi in zip(ELECTRODES, raw_i, hsi_i):
                text[ch].append(row[ri])
                hsi[ch].append(row[hi] if hi is not None and hi < len(row) else "")
    return text, hsi, np.array(ms)


def to_counts(texts):
    """Printed microvolts -> (ADC counts, microvolts per count, highest count), or None when the numbers are
    not whole counts of a converter listed in CONVERTERS."""
    uv = np.array([float(t) if t else np.nan for t in texts])
    if not np.isfinite(uv).all():
        return None
    for per, top in CONVERTERS:
        counts = np.round(uv / per)
        if counts.min() >= 0 and counts.max() <= top and np.abs(uv - counts * per).max() <= 1e-6:
            return counts.astype(np.uint16), per, top
    return None


def printed(count, per):
    return f"{count * per:.6f}"


def steadiest(counts, hsi, ms, seconds):
    """(clean fraction, electrode, first sample) of the steadiest stretch of `seconds`, or None.
    `counts` maps an electrode to what to_counts gave for it."""
    n_epoch = EPOCH_S * FS
    want = seconds // EPOCH_S
    sos = butter(4, [1.0, 45.0], btype="bandpass", fs=FS, output="sos")
    best = None
    for ch in PREFER:
        if counts.get(ch) is None or len(counts[ch][0]) < seconds * FS:
            continue
        c, per, top = counts[ch]
        x = sosfiltfilt(sos, c.astype(float) * per)
        epochs = len(c) // n_epoch
        e = x[:epochs * n_epoch].reshape(epochs, n_epoch)
        raw = c[:epochs * n_epoch].reshape(epochs, n_epoch)
        clean = (np.ptp(e, axis=1) < CLEAN_PP_UV) & (e.std(axis=1) > FLAT_RMS_UV)
        clean &= (raw.min(axis=1) > 0) & (raw.max(axis=1) < top)                         # never on the rails
        contact = np.array([code in ("", "1", "1.0") for code in hsi[ch][:epochs * n_epoch]]).reshape(epochs, n_epoch)
        clean &= contact.all(axis=1)                                                     # good contact where it was logged
        run = np.convolve(clean.astype(float), np.ones(want), mode="valid") / want
        for first in np.argsort(-run, kind="stable"):
            a, b = first * n_epoch, first * n_epoch + seconds * FS
            took = (ms[b - 1] - ms[a]) / 1000.0
            if abs(took - seconds) <= 0.02 * seconds:                                    # no dropped packets inside
                if best is None or run[first] > best[0] + 1e-9:
                    best = (float(run[first]), ch, int(a))
                break
    return best


def record_row(stamp):
    with open(RECORD, encoding="utf-8") as f:
        for row in json.load(f).get("sessions", []):
            if row.get("stamp") == stamp:
                return row
    return None


def load_index():
    if os.path.exists(INDEX):
        with open(INDEX, encoding="utf-8") as f:
            return json.load(f)
    return {"about": ABOUT, "sessions": []}


def check(path, entry, text=None):
    """True when the published file gives back the recording's own numbers, digit for digit."""
    if text is None:
        text, _, _ = read_eeg(path)
    with open(os.path.join(HERE, entry["file"]), "rb") as f:
        counts = np.frombuffer(f.read(), dtype="<u2")
    a = entry["first_sample"]
    stored = text[entry["electrode"]][a:a + entry["samples"]]
    if len(counts) != entry["samples"] or len(stored) != entry["samples"]:
        return False
    return all(printed(int(c), entry["uv_per_count"]) == t for c, t in zip(counts, stored))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("csv", nargs="+", help="muse_session_<stamp>_<headband>.csv")
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--min-clean", type=float, default=0.8, help="refuse a recording with no stretch this steady")
    ap.add_argument("--check", action="store_true", help="only compare what is published against the recording")
    a = ap.parse_args()

    index = load_index()
    index["about"] = ABOUT
    by_stamp = {e["stamp"]: e for e in index["sessions"]}
    failed = 0
    for path in a.csv:
        m = re.search(r"muse_session_(\d{8}_\d{6})_", os.path.basename(path))
        if not m:
            print(f"SKIP {path}: the name carries no session stamp"); failed += 1; continue
        stamp = m.group(1)
        if a.check:
            entry = by_stamp.get(stamp)
            ok = bool(entry) and check(path, entry)
            print(f"{'SAME' if ok else 'DIFFERENT'} {stamp}: "
                  + (f"{entry['samples']} samples of {entry['electrode']} from sample {entry['first_sample']}" if entry else "not published"))
            failed += 0 if ok else 1
            continue

        row = record_row(stamp)
        if not row:
            print(f"SKIP {stamp}: not in the record (data/index.json), so no piece could be made from it"); failed += 1; continue
        text, hsi, ms = read_eeg(path)
        if not len(ms):
            print(f"SKIP {stamp}: no EEG rows"); failed += 1; continue
        rate = (len(ms) - 1) / max(1e-9, (ms[-1] - ms[0]) / 1000.0)
        if abs(rate - FS) > 0.03 * FS:
            print(f"SKIP {stamp}: {rate:.1f} samples a second, not {FS}"); failed += 1; continue
        counts = {ch: to_counts(text[ch]) for ch in ELECTRODES}
        if all(c is None for c in counts.values()):
            print(f"SKIP {stamp}: the samples are not whole counts of a converter this tool knows (CONVERTERS)"); failed += 1; continue
        whole = a.seconds + 2 * LEAD_S                 # the minute and the two ends the filters settle on
        found = steadiest(counts, hsi, ms, whole)
        if not found or found[0] < a.min_clean:
            print(f"SKIP {stamp}: no steady stretch of {whole} s"
                  + (f" (best {found[0]:.2f} clean on {found[1]})" if found else "")); failed += 1; continue
        clean, ch, first = found
        chunk = counts[ch][0][first:first + whole * FS]
        lead = LEAD_S * FS
        name = f"{stamp}.bin"
        with open(os.path.join(HERE, name), "wb") as f:
            f.write(chunk.astype("<u2").tobytes())
        entry = {
            "stamp": stamp, "file": name, "electrode": ch, "site": SITES[ch],
            "fs": FS, "samples": int(len(chunk)), "lead": lead, "seconds": a.seconds,
            "first_sample": first, "from_s": round((ms[first + lead] - ms[0]) / 1000.0, 1),
            "uv_per_count": counts[ch][1], "clean": round(clean, 3),
            "recorded": row.get("date"), "minutes": row.get("minutes"),
        }
        if not check(path, entry, text):
            os.remove(os.path.join(HERE, name))
            print(f"FAIL {stamp}: the file written does not give back the recording's numbers"); failed += 1; continue
        by_stamp[stamp] = entry
        print(f"OK   {stamp}: {ch} ({SITES[ch]}), {a.seconds} s from {entry['from_s']} s into {row.get('minutes')} min "
              f"(+{LEAD_S} s each end), {clean:.0%} steady, {len(chunk) * 2} bytes, same as the recording digit for digit")

    if not a.check:
        index["sessions"] = [by_stamp[s] for s in sorted(by_stamp)]
        with open(INDEX, "w", encoding="utf-8", newline="\n") as f:
            json.dump(index, f, indent=1)
            f.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

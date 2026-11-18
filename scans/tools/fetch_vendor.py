#!/usr/bin/env python3
"""Fetch the two libraries the viewer runs on into web/splat/vendor/ (they are not kept in the repository).

    python fetch_vendor.py

three.js 0.180.0 and Spark 2.4.0 (the Gaussian-splat renderer for three.js by World Labs), both MIT licensed, from
the npm mirror at cdn.jsdelivr.net, each file checked against the SHA-256 recorded here. After this the viewer
needs no internet: scan_view.py serves these copies, also to the headset.
"""
import hashlib
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")
THREE = "https://cdn.jsdelivr.net/npm/three@0.180.0/"
SPARK = "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.4.0/"
FILES = [
    (THREE + "build/three.module.js", "three.module.js", "c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a"),
    (THREE + "build/three.core.js", "three.core.js", "eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20"),
    (THREE + "examples/jsm/controls/OrbitControls.js", "addons/controls/OrbitControls.js", "b97879c748170baadeb3fb84cea1ffdf4674e283dc06042f34e2acb95a76042c"),
    (THREE + "examples/jsm/loaders/GLTFLoader.js", "addons/loaders/GLTFLoader.js", "67ac5551fdafa6e349bd80c8f8e5e39c136d6b2fb1ad647db9abb21dc86f9e4a"),
    (THREE + "examples/jsm/utils/BufferGeometryUtils.js", "addons/utils/BufferGeometryUtils.js", "fda7e946b8e0b5ab39b779206589e7a1079a22eb24efb89d7223e03fdfb1f751"),
    (THREE + "examples/jsm/postprocessing/Pass.js", "addons/postprocessing/Pass.js", "444b409c235ead986893c472e720da1b779a56985c7d10b279c7944b52bd61c5"),
    (THREE + "LICENSE", "THREE_LICENSE", "bfe119ea4fd413f5f7ca3fcd63adb0c4a073ed39daa2fe7d3e6b769e21272601"),
    (SPARK + "dist/spark.module.min.js", "spark.module.min.js", "a2f01f68dbcd5e060d55348f803e509fc789b97904e01b98763fcf0314351aaf"),
    (SPARK + "LICENSE", "SPARK_LICENSE", "51829693e5dccd9ca1daa093991faac3aaa93238eb8fd5f5cb4130af85791d64"),
]


def missing():
    """The vendor files that are not there or not the recorded ones."""
    out = []
    for _, rel, sha in FILES:
        p = os.path.join(VENDOR, rel)
        if not os.path.exists(p) or hashlib.sha256(open(p, "rb").read()).hexdigest() != sha:
            out.append(rel)
    return out


def main():
    bad = 0
    for url, rel, sha in FILES:
        p = os.path.join(VENDOR, rel)
        if os.path.exists(p) and hashlib.sha256(open(p, "rb").read()).hexdigest() == sha:
            print("have   ", rel)
            continue
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fetch_vendor"}), timeout=120).read()
        got = hashlib.sha256(data).hexdigest()
        if got != sha:
            print(f"REFUSED {rel}: its SHA-256 is {got}, not the recorded one; nothing written")
            bad += 1
            continue
        with open(p, "wb") as fh:
            fh.write(data)
        print("fetched", rel, f"({len(data) // 1024} KB)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

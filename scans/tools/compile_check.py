"""Compile the project's runtime scripts with Unity's own compiler against the assemblies the last build left,
in a few seconds, so a mistake is caught before the nine-minute APK build.

    python Assets/PrintSee/Editor/compile_check.py

Exit code 0 when both the editor and the Android variant compile. Warnings are not shown. Nothing is written
into the project: the throwaway output goes to the system's temporary folder and is removed.
"""
import glob
import os
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
UNITY = r"C:\Program Files\Unity\Hub\Editor\6000.3.8f1\Editor\Data"
DOTNET = os.path.join(UNITY, "NetCoreRuntime", "dotnet.exe")
CSC = os.path.join(UNITY, "DotNetSdkRoslyn", "csc.dll")
NETSTD = os.path.join(UNITY, "NetStandard", "ref", "2.1.0", "netstandard.dll")
MODULES = os.path.join(UNITY, "Managed", "UnityEngine")
SCRIPT_ASM = os.path.join(ROOT, "Library", "ScriptAssemblies")


def sources():
    out = []
    for p in glob.glob(os.path.join(ROOT, "Assets", "**", "*.cs"), recursive=True):
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        if "/Editor/" not in rel:
            out.append(p)
    return out


def references():
    refs = [NETSTD] + glob.glob(os.path.join(MODULES, "UnityEngine.*Module.dll"))
    for p in glob.glob(os.path.join(SCRIPT_ASM, "*.dll")):
        name = os.path.basename(p).lower()
        if name.startswith("assembly-csharp") or "editor" in name:      # ours, and what only the editor uses
            continue
        refs.append(p)
    return refs


def run(defines, label):
    tmp = tempfile.mkdtemp(prefix="printsee_check_")
    out, rsp = os.path.join(tmp, label + ".dll"), os.path.join(tmp, label + ".rsp")
    try:
        with open(rsp, "w", encoding="utf-8") as f:
            f.write("-nologo\n-target:library\n-nostdlib\n-noconfig\n-langversion:9.0\n-warn:0\n-nowarn:1701,1702\n-unsafe\n")
            f.write('-out:"%s"\n' % out)
            for d in defines:
                f.write("-define:%s\n" % d)
            for r in references():
                f.write('-r:"%s"\n' % r)
            for s in sources():
                f.write('"%s"\n' % s)
        proc = subprocess.run([DOTNET, CSC, "@" + rsp], capture_output=True, text=True)
    finally:
        for p in (out, rsp):
            if os.path.exists(p):
                os.remove(p)
        os.rmdir(tmp)
    errors = [l for l in proc.stdout.splitlines() if " error " in l]
    print("== %s: %s (%d errors)" % (label, "OK" if proc.returncode == 0 else "FAILED", len(errors)))
    for l in errors[:40]:
        print("  " + l.replace(ROOT + os.sep, ""))
    if proc.returncode != 0 and not errors:
        print(proc.stdout[-3000:], proc.stderr[-2000:])
    return proc.returncode == 0


def main():
    common = ["UNITY_5_3_OR_NEWER", "UNITY_2017_1_OR_NEWER", "UNITY_2019_1_OR_NEWER", "UNITY_2020_1_OR_NEWER",
              "UNITY_2021_1_OR_NEWER", "UNITY_2022_1_OR_NEWER", "UNITY_2023_1_OR_NEWER", "UNITY_6000_0_OR_NEWER",
              "UNITY_6000_3_OR_NEWER", "ENABLE_INPUT_SYSTEM"]
    ok_editor = run(common + ["UNITY_EDITOR", "UNITY_STANDALONE_WIN"], "editor")
    ok_android = run(common + ["UNITY_ANDROID"], "android")
    sys.exit(0 if ok_editor and ok_android else 1)


if __name__ == "__main__":
    main()

"""Always-on stream of a Bambu printer's chamber camera to 6ense.com, for a PC
that stays beside the printer. Runs cam_gateway.py (go2rtc + allow-listed proxy +
cloudflared quick tunnel + the card on the relay) and keeps it running:

  * finds the printer by its access code: the last address, the address typed at
    install, the printer's own announcements (UDP 2021), then a scan of this PC's
    networks for its control port (8883) where the access code logs in; the
    printer is told apart from any other Bambu printer by that login
  * waits for the camera (port 322, "LAN Only Liveview" on the printer) and says
    so in the log while it is off
  * restarts everything after a failure or a lost printer, and holds the PC
    awake (Windows) while running
  * stops cleanly, card off the page, when a file named STOP appears in its folder

Everything lives in the folder of the program: settings.json, go2rtc.yaml
(written here, holds the access code), logs/.

    printer_stream.exe            run (what the scheduled task starts)
    printer_stream.exe --check    find the printer, test the camera, print a report
"""
import argparse
import asyncio
import ctypes
import ipaddress
import json
import os
import socket
import ssl
import struct
import sys
import time

HERE = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
if os.path.isdir(os.path.join(HERE, "vendor")):          # the Mac kit carries websockets here
    sys.path.insert(0, os.path.join(HERE, "vendor"))
sys.path.insert(0, HERE)
SETTINGS = os.path.join(HERE, "settings.json")
LOGS = os.path.join(HERE, "logs")
STOP = os.path.join(HERE, "STOP")


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, flush=True)


def load():
    with open(SETTINGS, encoding="utf-8-sig") as f:      # PowerShell 5 writes a byte-order mark
        s = json.load(f)
    for k in ("serial", "access_code"):
        if not s.get(k):
            raise SystemExit(f"settings.json needs {k!r}")
    return s


def save(s):
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, SETTINGS)


def mqtt_login(ip, code, timeout=4.0):
    """True when the printer at ip accepts user bblp with this access code."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((ip, 8883), timeout=timeout) as raw:
            with ctx.wrap_socket(raw, server_hostname=ip) as s:
                def enc(b):
                    return struct.pack(">H", len(b)) + b
                body = enc(b"MQTT") + bytes([4, 0xC2]) + struct.pack(">H", 30) + enc(b"ps-check") \
                    + enc(b"bblp") + enc(code.encode())
                s.sendall(bytes([0x10, len(body)]) + body)
                r = s.recv(4)
                return len(r) == 4 and r[0] == 0x20 and r[3] == 0
    except Exception:
        return False


def port_open(ip, port, timeout=3.0):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def ssdp_listen(serial, seconds=12):
    """The address of the printer with this serial from its own announcements."""
    found = None
    socks = []
    for port in (2021, 1990):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("", port))
            try:
                s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                             socket.inet_aton("239.255.255.250") + socket.inet_aton("0.0.0.0"))
            except OSError:
                pass
            s.settimeout(0.5)
            socks.append(s)
        except OSError:
            pass
    end = time.time() + seconds
    while socks and time.time() < end and not found:
        for s in socks:
            try:
                data, addr = s.recvfrom(4096)
            except (socket.timeout, OSError):
                continue
            if serial.encode() in data:
                found = addr[0]
                break
    for s in socks:
        s.close()
    return found


def _interface_cidrs():
    """'a.b.c.d/len' for this computer's IPv4 interfaces (Windows: PowerShell;
    macOS/Linux: ifconfig), virtual and VPN adapters left out."""
    import subprocess
    if os.name == "nt":
        try:
            return subprocess.run(["powershell", "-NoProfile", "-Command",
                                   "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "
                                   "'Loopback|vEthernet|WSL|Hyper-V|VirtualBox|VMware|Tailscale|Bluetooth' } | "
                                   "ForEach-Object { $_.IPAddress + '/' + $_.PrefixLength }"],
                                  capture_output=True, text=True, timeout=20,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.split()
        except Exception:
            return []
    out = []
    try:
        text = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        text = ""
    iface = ""
    for line in text.splitlines():
        if line and not line[0].isspace():
            iface = line.split(":")[0]
        if iface.startswith(("lo", "utun", "bridge", "awdl", "llw", "vmnet", "docker", "tailscale", "gif", "stf")):
            continue
        parts = line.split()
        if len(parts) >= 4 and parts[0] == "inet" and "netmask" in parts:
            mask = parts[parts.index("netmask") + 1]
            try:
                bits = bin(int(mask, 16)).count("1") if mask.startswith("0x") else \
                    ipaddress.ip_network(f"0.0.0.0/{mask}").prefixlen
                out.append(f"{parts[1]}/{bits}")
            except ValueError:
                pass
    if not out:                       # no ifconfig: the address used to reach the internet, as a /24
        try:
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            u.connect(("1.1.1.1", 53))
            out.append(f"{u.getsockname()[0]}/24")
            u.close()
        except OSError:
            pass
    return out


def local_networks():
    """This computer's IPv4 networks worth scanning (at most /22 each), from the
    addresses of its interfaces; loopback, link-local and virtual adapters skipped."""
    nets = []
    out = _interface_cidrs()
    for item in out:
        try:
            iface = ipaddress.ip_interface(item)
        except ValueError:
            continue
        if iface.ip.is_loopback or iface.ip.is_link_local:
            continue
        net = iface.network if iface.network.prefixlen >= 22 else ipaddress.ip_network(f"{iface.ip}/24", strict=False)
        nets.append((iface.ip, net))
    return nets


async def scan_for(code):
    sem = asyncio.Semaphore(256)
    hits = []

    async def one(ip):
        async with sem:
            try:
                _, w = await asyncio.wait_for(asyncio.open_connection(str(ip), 8883), 3.0)
                w.close()
                hits.append(str(ip))
            except Exception:
                pass
    tasks = [one(h) for me, net in local_networks() for h in net.hosts() if h != me]
    await asyncio.gather(*tasks)
    for ip in hits:
        if await asyncio.to_thread(mqtt_login, ip, code):
            return ip, len(hits)
    return None, len(hits)


def find_printer(s, quick=False):
    """(ip, how) or (None, why)."""
    code = s["access_code"]
    for key in ("ip", "ip_hint"):
        ip = s.get(key)
        if ip and mqtt_login(ip, code):
            return ip, f"at its {'last' if key == 'ip' else 'given'} address"
    ip = ssdp_listen(s["serial"], 6 if quick else 12)
    if ip and mqtt_login(ip, code):
        return ip, "from its own announcement"
    ip, n = asyncio.run(scan_for(code))
    if ip:
        return ip, f"by scanning this PC's network ({n} Bambu-like devices answered)"
    return None, (f"not found: {n} device(s) on this PC's network answer on the printer port and none takes "
                  "this access code" if n else "no printer answers on this PC's network")


_CAFFEINATE = []


def keep_awake(on):
    """Hold the computer awake while running: Windows SetThreadExecutionState,
    macOS caffeinate tied to this process."""
    if os.name == "nt":
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if on else 0x80000000)
    elif sys.platform == "darwin":
        import subprocess
        if on and not _CAFFEINATE and os.path.exists("/usr/bin/caffeinate"):
            _CAFFEINATE.append(subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())]))
        elif not on:
            for p in _CAFFEINATE:
                p.terminate()
            _CAFFEINATE.clear()


def _bin(name):
    """go2rtc / cloudflared beside this program (Windows kit) or in bin/ (Mac kit)."""
    exe = name + (".exe" if os.name == "nt" else "")
    for d in (HERE, os.path.join(HERE, "bin"), os.path.join(os.path.dirname(HERE), "bin")):
        if os.path.exists(os.path.join(d, exe)):
            return os.path.join(d, exe)
    return os.path.join(HERE, exe)


def write_go2rtc(s, ip):
    path = os.path.join(HERE, "go2rtc.yaml")
    with open(path, "w", encoding="utf-8") as f:
        f.write("# written by printer_stream; holds the printer's access code: do not share\n"
                'api:\n  listen: "127.0.0.1:1984"\nrtsp:\n  listen: ""\nwebrtc:\n  listen: ""\nsrtp:\n  listen: ""\n'
                "log:\n  level: info\nstreams:\n"
                f"  h2c: rtspx://bblp:{s['access_code']}@{ip}:322/streaming/live/1\n")
    return path


def open_log():
    os.makedirs(LOGS, exist_ok=True)
    path = os.path.join(LOGS, "printer_stream.log")
    if os.path.exists(path) and os.path.getsize(path) > 5_000_000:
        os.replace(path, path + ".1")
    f = open(path, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = f


def run_gateway(s, ip):
    import cam_gateway as g
    g.CAMERAS.clear(); g.ALLOWED.clear(); g.VIEWERS.clear()
    g.ONLINE["ok"] = True
    g.CHANGED = asyncio.Event()
    g.STARTED_MS = int(time.time() * 1000)
    g.CAMERAS.append({"id": "h2c", "model": s.get("model", "Bambu Lab H2C"),
                      "label": s.get("label", "Bambu H2C printer, live from the chamber camera"),
                      "w": 1920, "h": 1080})
    g.ALLOWED.add("h2c")
    g.ARGS = argparse.Namespace(
        go2rtc=_bin("go2rtc"), go2rtc_config=write_go2rtc(s, ip),
        cloudflared=_bin("cloudflared"), base=None, port=int(s.get("port", 8099)),
        relay=s.get("relay", g.RELAY), owner=s.get("owner", "Alex"), pseudonym=s.get("pseudonym", "printer-cam-h2c"),
        note=s.get("note", "MannLab printer, live while it prints"), no_relay=False, stop_file=STOP,
        remove_stop_file=False, log_dir=LOGS, probe=f"{ip}:322")
    asyncio.run(g.main())


def check():
    s = load()
    print(f"printer serial {s['serial']}; looking for it (up to a minute)...", flush=True)
    ip, how = find_printer(s, quick=True)
    if not ip:
        print("PRINTER NOT FOUND: " + how)
        print("  Is the printer on the same Wi-Fi as this PC, and switched on? On some networks devices cannot")
        print("  see each other; then type the address shown on the printer's Network screen into settings.json")
        print("  as \"ip_hint\", or ask IT to allow it.")
        return 1
    print(f"printer found at {ip} {how}; the access code is accepted")
    cam = port_open(ip, 322)
    print("camera stream: " + ("ON (port 322 answers)" if cam else
          "OFF - on the printer turn on LAN Only Liveview (Settings, Network); the stream starts by itself "
          "once it is on"))
    s["ip"] = ip
    save(s)
    return 0 if cam else 2


def main_loop():
    open_log()
    log("printer_stream starting")
    keep_awake(True)
    try:
        while not os.path.exists(STOP):
            s = load()
            ip, how = find_printer(s)
            if not ip:
                log("printer not found (" + how + "); trying again in 60 s")
                time.sleep(60)
                continue
            if ip != s.get("ip"):
                s["ip"] = ip
                save(s)
            log(f"printer at {ip} ({how})")
            if not port_open(ip, 322):
                log("camera port closed: turn on LAN Only Liveview on the printer; checking again in 60 s")
                time.sleep(60)
                continue
            try:
                run_gateway(s, ip)
            except SystemExit as e:
                log(f"gateway stopped: {e}")
            except Exception as e:
                log(f"gateway failed: {e!r}")
            if os.path.exists(STOP):
                break
            log("restarting in 15 s")
            time.sleep(15)
    finally:
        keep_awake(False)
        if os.path.exists(STOP):
            os.remove(STOP)
        log("printer_stream stopped")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    sys.exit(check() if a.check else main_loop())

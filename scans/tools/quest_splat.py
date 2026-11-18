#!/usr/bin/env python3
"""The Quest as a wearable splat sensor: what its depth sensing sees, as a growing cloud of
coloured blobs ("splats"), recorded on this computer and shown live on 6ense.com.

    python quest_splat.py                       # headset on USB: start the app's splat mode, record, stream
    python quest_splat.py --seconds 120 --relay off
    python quest_splat.py --simulate            # no headset: a made-up room sends the same packets
    python quest_splat.py --no-launch           # listen only: scan_session.py --live starts the app (a scan and this at once)

What this is, and is not. The Quest 3S has no LiDAR; it works depth out from its tracking cameras.
The headset app (Print What I See, splat mode) casts a grid of rays into that depth a few times a
second and sends every hit here over USB: where it is, which way the surface faces, the colour of the
camera picture there, and how much of the picture it covers. Each hit becomes one splat. Nothing is
trained: these are splats seeded from depth and colour, not an optimised Gaussian-splat scene. They
are kept in a map of 2 cm cells, so looking at the same place again refines it instead of piling up.

Outputs, in --out/<stamp>/ :
    bag/                 rosbag2 (mcap): /quest/splat/points (sensor_msgs/PointCloud2: x y z, normal, rgb,
                         radius; one message per sweep of the headset) and /quest/camera/pose
    splat.ply            the whole map in the layout Gaussian-splat viewers read (position, colour as the
                         DC term, opacity, log scales, rotation): a flat disc per splat, facing its surface
    splat_summary.json   how many splats, sweeps, seconds, bytes

Live: every 0.4 s the splats that changed (and a rolling share of the older ones, so a visitor who
arrives late still gets the whole room) go to the relay as "splat" chunks, from a card at tier
"camera". The relay passes them to the page and keeps none.

Frame "quest_world": the headset's world turned to the ROS convention (x forward, y left, z up, metres);
a Unity point (x, y, z) is (z, -x, y) there.

Wire format from the headset (little-endian): b"QSP1", uint32 payload bytes, then
    float64 t_unix_ms | float32 cam_pos[3] | float32 cam_rot[4] | uint16 W, H | float32 focal | uint32 n |
    n x { float32 x, y, z | int8 normal x, y, z (x127) | uint8 r, g, b | uint16 radius in half-millimetres }
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import secrets
import struct
import subprocess
import sys
import time
from datetime import datetime

import numpy as np

PKG = "com.mersivity.printsee"
ACTIVITY = f"{PKG}/com.unity3d.player.UnityPlayerGameActivity"
MAGIC = b"QSP1"
HEAD = struct.Struct("<d3f4fHHfI")          # t_unix_ms, cam_pos, cam_rot, W, H, focal, n
HIT = np.dtype([("p", "<f4", 3), ("n", "i1", 3), ("c", "u1", 3), ("r", "<u2")])
assert HIT.itemsize == 20
CELL = 0.02                                 # metres: one splat per cell of the map
Q = 0.005                                   # metres: the step positions are sent in
CHUNK = 4000                                # splats in one message to the relay (the relay's cap)
SEND_EVERY = 0.4                            # seconds between messages (the relay allows 3 a second)
DEFAULT_RELAY = "wss://cyborg-collective-relay.onrender.com/ingest"


def log(*a):
    print(f"[splat] {time.strftime('%H:%M:%S')}", *a, flush=True)


def flu(p):
    """Unity points (N, 3), left-handed with y up -> ROS: x forward, y left, z up."""
    p = np.asarray(p, dtype=np.float32)
    return np.stack([p[..., 2], -p[..., 0], p[..., 1]], axis=-1)


def flu_quat(q):
    return (-float(q[2]), float(q[0]), -float(q[1]), float(q[3]))


# ----------------------------------------------------------------------------- the map
class SplatMap:
    """One splat per 2 cm cell: position, facing, colour and radius, refined each time the cell is seen again."""

    def __init__(self, limit=1_500_000):
        self.limit = limit
        self.n = 0
        cap = 65536
        self.pos = np.zeros((cap, 3), np.float32)
        self.nrm = np.zeros((cap, 3), np.float32)
        self.col = np.zeros((cap, 3), np.float32)
        self.rad = np.zeros(cap, np.float32)
        self.hits = np.zeros(cap, np.int32)
        self.fresh = np.zeros(cap, bool)        # changed since it was last sent
        self.index = {}
        self.cursor = 0                         # where the rolling re-send of older splats has got to

    def _grow(self):
        for name in ("pos", "nrm", "col", "rad", "hits", "fresh"):
            a = getattr(self, name)
            b = np.zeros((a.shape[0] * 2,) + a.shape[1:], a.dtype)
            b[: a.shape[0]] = a
            setattr(self, name, b)

    def add(self, pos, nrm, col, rad):
        """Hits of one sweep, already in quest_world. Returns how many cells were new."""
        cells = np.floor(pos / CELL).astype(np.int64) + (1 << 20)
        keys = cells[:, 0] | (cells[:, 1] << 21) | (cells[:, 2] << 42)
        uniq, first = np.unique(keys, return_index=True)
        new = 0
        for key, i in zip(uniq.tolist(), first.tolist()):
            j = self.index.get(key)
            if j is None:
                if self.n >= self.limit:
                    continue
                if self.n >= self.pos.shape[0]:
                    self._grow()
                j = self.n
                self.n += 1
                self.index[key] = j
                self.pos[j], self.nrm[j], self.col[j], self.rad[j], self.hits[j] = pos[i], nrm[i], col[i], rad[i], 1
                new += 1
            else:
                w = 1.0 / min(self.hits[j] + 1, 6)        # a running average that still follows a change
                self.pos[j] += (pos[i] - self.pos[j]) * w
                self.col[j] += (col[i] - self.col[j]) * w
                m = self.nrm[j] + (nrm[i] - self.nrm[j]) * w
                self.nrm[j] = m / max(1e-6, float(np.linalg.norm(m)))
                self.rad[j] += (rad[i] - self.rad[j]) * w
                self.hits[j] += 1
            self.fresh[j] = True
        return new

    def take(self, count=CHUNK):
        """Indices for the next message: everything that changed, newest cells first, then older ones in turn."""
        if not self.n:
            return np.zeros(0, np.int64)
        changed = np.flatnonzero(self.fresh[: self.n])
        if len(changed) > count:
            changed = changed[-count:]
        self.fresh[changed] = False
        room = count - len(changed)
        if room > 0 and self.n > len(changed):
            older = (self.cursor + np.arange(min(room, self.n))) % self.n
            self.cursor = int((self.cursor + len(older)) % self.n)
            changed = np.unique(np.concatenate([changed, older]))
        return changed


def oct_encode(n):
    """Unit vectors (N, 3) -> two int8 each (octahedral), so a facing costs two bytes."""
    n = n / np.maximum(1e-6, np.abs(n).sum(axis=1, keepdims=True))
    xy = n[:, :2].copy()
    back = n[:, 2] < 0
    xy[back] = (1 - np.abs(xy[back][:, ::-1])) * np.where(xy[back] >= 0, 1.0, -1.0)
    return np.clip(np.round(xy * 127), -127, 127).astype(np.int8)


def encode_chunk(m: SplatMap, idx, origin):
    """The relay message body for these splats: 12 bytes each, base64."""
    rec = np.zeros(len(idx), np.dtype([("p", "<i2", 3), ("c", "u1", 3), ("r", "u1"), ("n", "i1", 2)]))
    rec["p"] = np.clip(np.round((m.pos[idx] - origin) / Q), -32767, 32767).astype(np.int16)
    rec["c"] = np.clip(np.round(m.col[idx]), 0, 255).astype(np.uint8)
    rec["r"] = np.clip(np.round(m.rad[idx] / 0.0025), 1, 255).astype(np.uint8)
    rec["n"] = oct_encode(m.nrm[idx])
    return base64.b64encode(rec.tobytes()).decode("ascii")


# ----------------------------------------------------------------------------- recording
class Recorder:
    def __init__(self, folder, max_mb):
        from rosbags.rosbag2 import StoragePlugin, Writer
        from rosbags.typesys import Stores, get_typestore

        self.folder = folder
        self.ts = get_typestore(Stores.ROS2_JAZZY)
        self.T = self.ts.types
        self.max_bytes = max_mb * 1e6
        self.bytes = 0
        self.sweeps = 0
        self.full = False
        self.writer = Writer(os.path.join(folder, "bag"), version=9, storage_plugin=StoragePlugin.MCAP)
        self.writer.open()
        self.cloud = self.writer.add_connection("/quest/splat/points", "sensor_msgs/msg/PointCloud2", typestore=self.ts)
        self.pose = self.writer.add_connection("/quest/camera/pose", "geometry_msgs/msg/PoseStamped", typestore=self.ts)
        Field = self.T["sensor_msgs/msg/PointField"]
        names = ["x", "y", "z", "normal_x", "normal_y", "normal_z", "rgb", "radius"]
        self.fields = [Field(name=n, offset=4 * i, datatype=7, count=1) for i, n in enumerate(names)]

    def header(self, t_ns, frame):
        T = self.T
        return T["std_msgs/msg/Header"](stamp=T["builtin_interfaces/msg/Time"](sec=int(t_ns // 10**9), nanosec=int(t_ns % 10**9)), frame_id=frame)

    def sweep(self, t_ms, cam_pos, cam_quat, pos, nrm, col, rad):
        if self.full:
            return
        T = self.T
        t_ns = int(t_ms * 1e6)
        pts = np.zeros((len(pos), 8), np.float32)
        pts[:, 0:3], pts[:, 3:6], pts[:, 7] = pos, nrm, rad
        c = np.clip(np.round(col), 0, 255).astype(np.uint32)
        pts[:, 6] = ((c[:, 0] << 16) | (c[:, 1] << 8) | c[:, 2]).view(np.float32)       # PCL's packed rgb
        raw = pts.tobytes()
        msg = T["sensor_msgs/msg/PointCloud2"](
            header=self.header(t_ns, "quest_world"), height=1, width=len(pts), fields=self.fields, is_bigendian=False,
            point_step=32, row_step=32 * len(pts), data=np.frombuffer(raw, dtype=np.uint8), is_dense=True)
        self.writer.write(self.cloud, t_ns, self.ts.serialize_cdr(msg, "sensor_msgs/msg/PointCloud2"))
        P, Qn = T["geometry_msgs/msg/Point"], T["geometry_msgs/msg/Quaternion"]
        pose = T["geometry_msgs/msg/PoseStamped"](header=self.header(t_ns, "quest_world"), pose=T["geometry_msgs/msg/Pose"](
            position=P(x=float(cam_pos[0]), y=float(cam_pos[1]), z=float(cam_pos[2])),
            orientation=Qn(x=cam_quat[0], y=cam_quat[1], z=cam_quat[2], w=cam_quat[3])))
        self.writer.write(self.pose, t_ns, self.ts.serialize_cdr(pose, "geometry_msgs/msg/PoseStamped"))
        self.bytes += len(raw)
        self.sweeps += 1
        if self.bytes > self.max_bytes:
            self.full = True
            log(f"the bag reached {self.max_bytes / 1e6:.0f} MB: recording of sweeps stops here; the map and the stream go on")

    def close(self):
        self.writer.close()


def write_ply(path, m: SplatMap):
    """The map as a Gaussian-splat .ply: a flat disc per splat, facing its surface, coloured by the camera."""
    n = m.n
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
             "rot_0", "rot_1", "rot_2", "rot_3"]
    out = np.zeros((n, len(names)), np.float32)
    out[:, 0:3], out[:, 3:6] = m.pos[:n], m.nrm[:n]
    out[:, 6:9] = (m.col[:n] / 255.0 - 0.5) / 0.28209479          # colour as the zeroth spherical-harmonic term
    out[:, 9] = math.log(0.92 / 0.08)                             # opacity 0.92, stored as its logit
    r = np.maximum(m.rad[:n], 0.002)
    out[:, 10], out[:, 11], out[:, 12] = np.log(r), np.log(r), np.log(r * 0.12)     # thin along the facing
    # the rotation that turns the disc's own z axis onto the surface normal, as (w, x, y, z)
    z = np.array([0.0, 0.0, 1.0], np.float32)
    v = np.cross(np.broadcast_to(z, (n, 3)), m.nrm[:n])
    w = 1.0 + m.nrm[:n, 2]
    q = np.concatenate([w[:, None], v], axis=1)
    flip = w < 1e-6
    q[flip] = [0.0, 1.0, 0.0, 0.0]
    out[:, 13:17] = q / np.maximum(1e-9, np.linalg.norm(q, axis=1, keepdims=True))
    head = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + "".join(f"property float {x}\n" for x in names) + "end_header\n"
    with open(path + ".tmp", "wb") as f:
        f.write(head.encode("ascii"))
        f.write(out.astype("<f4").tobytes())
    os.replace(path + ".tmp", path)


# ----------------------------------------------------------------------------- a made-up room
def simulated_sweep(t, rng, w=1280, h=960, focal=1153.7, step=16):
    """What the headset would send, standing in a 4 x 5 m room and turning slowly: Unity coordinates, y up."""
    yaw = 0.35 * t
    pitch = -0.15 + 0.2 * math.sin(0.5 * t)
    pos = np.array([0.4 * math.sin(0.2 * t), 1.55, 0.3 * math.cos(0.17 * t)], np.float32)
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    right = np.array([cy, 0, -sy]); up = np.array([sy * sp, cp, cy * sp]); fwd = np.array([sy * cp, -sp, cy * cp])
    nx, ny = w // step, h // step
    u = (np.arange(nx) + rng.random()) * step - w / 2
    v = (np.arange(ny) + rng.random()) * step - h / 2
    uu, vv = np.meshgrid(u, v)
    d = uu[..., None] * right / focal + vv[..., None] * up / focal + fwd
    d = (d / np.linalg.norm(d, axis=-1, keepdims=True)).reshape(-1, 3)
    best = np.full(len(d), np.inf)
    nrm = np.zeros((len(d), 3))
    col = np.zeros((len(d), 3))

    def plane(point, normal, colour):
        normal = np.array(normal, float)
        denom = d @ normal
        tt = ((np.array(point) - pos) @ normal) / np.where(np.abs(denom) < 1e-6, 1e-6, denom)
        ok = (tt > 0.05) & (tt < best) & (denom < 0)
        hit = pos + d[ok] * tt[ok, None]
        best[ok] = tt[ok]
        nrm[ok] = normal
        col[ok] = colour(hit)

    def checker(a, b, c1, c2):
        return lambda p: np.where((((np.floor(p[:, a] * 2) + np.floor(p[:, b] * 2)) % 2) == 0)[:, None], c1, c2)

    plane([0, 0, 0], [0, 1, 0], checker(0, 2, [196, 178, 150], [150, 132, 110]))          # floor
    plane([0, 2.7, 0], [0, -1, 0], lambda p: np.broadcast_to([232, 232, 226], p.shape))    # ceiling
    plane([0, 0, 2.5], [0, 0, -1], checker(0, 1, [90, 130, 190], [110, 150, 210]))        # the wall ahead
    plane([0, 0, -2.5], [0, 0, 1], lambda p: np.broadcast_to([200, 120, 90], p.shape))
    plane([2, 0, 0], [-1, 0, 0], lambda p: np.broadcast_to([120, 170, 120], p.shape))
    plane([-2, 0, 0], [1, 0, 0], checker(2, 1, [205, 190, 120], [180, 160, 100]))
    centre, radius = np.array([0.6, 0.9, 1.4]), 0.35                                       # a ball on a stand
    oc = pos - centre
    b = d @ oc
    disc = b * b - (oc @ oc - radius * radius)
    tt = -b - np.sqrt(np.maximum(disc, 0))
    ok = (disc > 0) & (tt > 0.05) & (tt < best)
    hit = pos + d[ok] * tt[ok, None]
    best[ok] = tt[ok]
    nrm[ok] = (hit - centre) / radius
    col[ok] = np.where((np.floor(hit[:, 1] * 12) % 2 == 0)[:, None], [230, 70, 60], [250, 220, 90])
    ok = np.isfinite(best) & (best < 5.0)
    hits = np.zeros(int(ok.sum()), HIT)
    hits["p"] = pos + d[ok] * best[ok, None]
    hits["n"] = np.clip(np.round(nrm[ok] * 127), -127, 127)
    hits["c"] = col[ok]
    hits["r"] = np.clip(best[ok] * step / focal * 0.75 * 2000, 4, 65535)
    half = [math.sin(pitch / 2) * math.cos(yaw / 2), math.cos(pitch / 2) * math.sin(yaw / 2),
            -math.sin(pitch / 2) * math.sin(yaw / 2), math.cos(pitch / 2) * math.cos(yaw / 2)]
    body = HEAD.pack(time.time() * 1000, *pos.tolist(), *half, w, h, focal, len(hits)) + hits.tobytes()
    return MAGIC + struct.pack("<I", len(body)) + body


async def simulate(port, stop):
    rng = np.random.default_rng(7)
    await asyncio.sleep(0.5)
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    t0 = time.time()
    while not stop.is_set():
        writer.write(simulated_sweep(time.time() - t0, rng))
        await writer.drain()
        await asyncio.sleep(0.33)
    writer.close()


# ----------------------------------------------------------------------------- the relay
def sensor_pseudonym(folder):
    """A made-up name for this sensor, kept between runs so the page shows one card for it.
    It is random: nothing about this computer or the headset goes to the relay."""
    path = os.path.join(folder, "sensor_id.txt")
    try:
        tag = open(path, encoding="ascii").read().strip()
    except OSError:
        tag = ""
    if len(tag) != 6 or any(c not in "0123456789abcdef" for c in tag):
        tag = secrets.token_hex(3)
        os.makedirs(folder, exist_ok=True)
        with open(path, "w", encoding="ascii") as f:
            f.write(tag)
    return "quest-splat-" + tag


async def relay_task(url, name, state, stop, pseudonym):
    import websockets

    session = secrets.token_hex(16)
    hello = {"t": "hello", "v": 1, "session": session, "pseudonym": pseudonym, "tier": "camera", "device": "Quest 3S", "name": name}
    while not stop.is_set():
        try:
            async with websockets.connect(url, max_size=2**20, open_timeout=20) as ws:
                await ws.send(json.dumps(hello))
                reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
                log(f"on the relay as {reply.get('pseudonym')} (tier {reply.get('tier')})")
                last_hb = time.time()
                while not stop.is_set():
                    await asyncio.sleep(SEND_EVERY)
                    m: SplatMap = state["map"]
                    idx = m.take()
                    if len(idx) and state["origin"] is not None:
                        cam = state["cam"]
                        await ws.send(json.dumps({
                            "t": "splat", "ts": int(time.time() * 1000), "src": "quest", "n": int(len(idx)), "q": Q,
                            "origin": [round(float(v), 3) for v in state["origin"]], "total": int(m.n),
                            "cam": [round(float(v), 4) for v in cam] if cam else None,
                            "d": encode_chunk(m, idx, state["origin"])}))
                        state["sent"] += int(len(idx))
                        state["messages"] += 1
                        last_hb = time.time()
                    elif time.time() - last_hb > 15:
                        await ws.send(json.dumps({"t": "hb"}))
                        last_hb = time.time()
                await ws.send(json.dumps({"t": "bye", "reason": "splat sensor stopped"}))
                return
        except Exception as e:  # noqa: BLE001
            if stop.is_set():
                return
            log(f"relay: {type(e).__name__}: {e}; trying again in 5 s")
            await asyncio.sleep(5)


# ----------------------------------------------------------------------------- the headset
def adb(*args, serial=None, timeout=20):
    cmd = ["adb"] + (["-s", serial] if serial else []) + list(args)
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def start_headset(port, serial, launch=True):
    out = adb("reverse", f"tcp:{port}", f"tcp:{port}", serial=serial)
    if out.returncode != 0:
        raise SystemExit("adb reverse failed (is the headset on USB?): " + out.stderr.strip())
    if not launch:
        # another program starts the app (scan_session.py, which adds --ei printsee_splat to its own start)
        log(f"listening on port {port} through adb; waiting for the app to be started in splat mode")
        return
    top = adb("shell", "dumpsys", "activity", "activities", serial=serial).stdout
    if "SensorLock" in top:
        raise SystemExit("the headset is at its privacy screen: press its power button once, then run this again")
    for perm in ("android.permission.CAMERA", "horizonos.permission.HEADSET_CAMERA", "com.oculus.permission.USE_SCENE"):
        adb("shell", "pm", "grant", PKG, perm, serial=serial)
    adb("shell", "am", "force-stop", PKG, serial=serial)
    adb("shell", "am", "start", "-n", ACTIVITY, "--ei", "printsee_splat", str(port), serial=serial)
    log(f"started the app in splat mode; it sends to this computer through adb on port {port}")


async def main_async(a):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = os.path.join(a.out, stamp)
    os.makedirs(folder, exist_ok=True)
    state = {"map": SplatMap(), "origin": None, "cam": None, "sent": 0, "messages": 0, "sweeps": 0, "hits": 0, "first": None, "last": None}
    rec = Recorder(folder, a.max_bag_mb)
    stop = asyncio.Event()

    async def client(reader, writer):
        log("the headset is connected" if not a.simulate else "the simulated headset is connected")
        try:
            while not stop.is_set():
                head = await reader.readexactly(8)
                if head[:4] != MAGIC:
                    log("not a splat packet: closing"); break
                body = await reader.readexactly(struct.unpack("<I", head[4:])[0])
                t_ms, px, py, pz, qx, qy, qz, qw, w, h, focal, n = HEAD.unpack_from(body)
                hits = np.frombuffer(body, HIT, count=n, offset=HEAD.size)
                if not n:
                    continue
                pos = flu(hits["p"])
                nrm = flu(hits["n"].astype(np.float32) / 127.0)
                nrm /= np.maximum(1e-6, np.linalg.norm(nrm, axis=1, keepdims=True))
                col = hits["c"].astype(np.float32)
                rad = hits["r"].astype(np.float32) / 2000.0
                cam_pos = flu(np.array([px, py, pz]))
                cam_quat = flu_quat((qx, qy, qz, qw))
                if state["origin"] is None:
                    state["origin"] = np.round(cam_pos, 1)
                    state["first"] = t_ms
                state["cam"] = [*cam_pos.tolist(), *cam_quat]
                state["map"].add(pos, nrm, col, rad)
                rec.sweep(t_ms, cam_pos, cam_quat, pos, nrm, col, rad)
                state["sweeps"] += 1
                state["hits"] += int(n)
                state["last"] = t_ms
        except (asyncio.IncompleteReadError, ConnectionResetError):
            log("the headset's connection closed")
        finally:
            writer.close()

    server = await asyncio.start_server(client, "127.0.0.1", a.port)
    tasks = []
    if a.simulate:
        tasks.append(asyncio.create_task(simulate(a.port, stop)))
    else:
        start_headset(a.port, a.serial, launch=not a.no_launch)
    if a.relay != "off":
        tasks.append(asyncio.create_task(relay_task(a.relay, a.name, state, stop, sensor_pseudonym(a.out))))
    t0 = time.time()
    try:
        while not stop.is_set():
            await asyncio.sleep(5)
            m = state["map"]
            log(f"{state['sweeps']} sweeps, {state['hits']} hits, {m.n} splats in the map; sent {state['sent']} in {state['messages']} messages")
            if a.seconds and time.time() - t0 >= a.seconds:
                break
            if a.stop_file and os.path.exists(a.stop_file):
                break
    except asyncio.CancelledError:
        pass
    finally:
        stop.set()
        server.close()
        await asyncio.sleep(SEND_EVERY + 0.3)
        for task in tasks:
            task.cancel()
        rec.close()
        m = state["map"]
        if m.n:
            write_ply(os.path.join(folder, "splat.ply"), m)
        seconds = (state["last"] - state["first"]) / 1000 if state["first"] else 0
        summary = {"splats": int(m.n), "sweeps": state["sweeps"], "hits": state["hits"], "seconds": round(seconds, 1),
                   "bag_bytes": sum(os.path.getsize(os.path.join(folder, "bag", f)) for f in os.listdir(os.path.join(folder, "bag"))),
                   "sent_splats": state["sent"], "relay_messages": state["messages"], "simulated": bool(a.simulate),
                   "frame": "quest_world: x forward, y left, z up, metres", "cell_m": CELL}
        with open(os.path.join(folder, "splat_summary.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1)
        log(f"saved {m.n} splats from {state['sweeps']} sweeps in {folder}")
        print(json.dumps(summary))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--serial", default=None)
    ap.add_argument("--simulate", action="store_true", help="a made-up room instead of the headset")
    ap.add_argument("--no-launch", action="store_true", help="do not start the app: something else starts it with --ei printsee_splat <port>")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (default: until Ctrl-C or the stop file)")
    ap.add_argument("--stop-file", default=None)
    ap.add_argument("--relay", default=DEFAULT_RELAY, help="the relay's /ingest address, or 'off'")
    ap.add_argument("--name", default="Quest 3S splat sensor")
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), "Downloads", "quest_splats"))
    ap.add_argument("--max-bag-mb", type=float, default=400)
    a = ap.parse_args()
    try:
        asyncio.run(main_async(a))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

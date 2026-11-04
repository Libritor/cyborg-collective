# Stream a camera to 6ense.com

You can show any camera live on 6ense.com, under **Live now**. That includes a 3D printer's chamber camera, an IP or RTSP camera, a webcam, or a Meta Quest headset's view.

The picture never goes through 6ense.com. A small gateway runs on **your** computer and serves it through a temporary public tunnel, and each viewer's browser plays it straight from there. The Collective relay only carries a small card: who is streaming, the tunnel address, which cameras are on and how many people are watching. When you stop the gateway, the card disappears.

```
camera (RTSP / RTSPS / exec)  ->  go2rtc (127.0.0.1:1984, never exposed)
                                     ^
                     cam_gateway.py proxy (127.0.0.1:8099)
                     lets through ONLY the player paths of the streams you name
                                     ^
                     cloudflared quick tunnel -> https://<random>.trycloudflare.com
                                     |
                     card -> wss://cyborg-collective-relay.onrender.com/ingest (tier "camera")
                                     |
                     6ense.com shows the card; viewers' browsers play from your tunnel
```

## What you need

- **Python 3.10+** and `pip install "websockets>=13"`. That is the only dependency.
- **go2rtc**, a single executable: <https://github.com/AlexxIT/go2rtc/releases>
- **cloudflared**, a single executable. It needs no account for quick tunnels: <https://github.com/cloudflare/cloudflared/releases>

Put the two executables in a `bin/` folder next to `cam_gateway.py`, or anywhere you like and pass their paths.

## 1. Describe your camera(s) for go2rtc

Copy `go2rtc.example.yaml` to `go2rtc.yaml` and fill in your camera. **`go2rtc.yaml` holds your camera's password, so never commit or share it.** It is already in `.gitignore`.

```yaml
api:    {listen: "127.0.0.1:1984"}   # localhost only: go2rtc's API can run programs
rtsp:   {listen: ""}
webrtc: {listen: ""}
streams:
  cam1: rtsp://user:password@192.168.1.20:554/stream1
```

Some common sources:

| Camera | go2rtc source |
|---|---|
| Bambu Lab H2C / X1 / P2S (turn on *LAN Only Liveview* on the printer) | `rtspx://bblp:<access code>@<printer ip>:322/streaming/live/1` |
| Generic IP camera | `rtsp://user:pass@<ip>:554/<path>` |
| USB webcam (Windows) | `ffmpeg:device?video=<camera name>#video=h264` (needs ffmpeg) |
| Meta Quest headset view | `exec:python -u quest_feed.py --serial <headset ip>:5555 --max-size 1080` (see below) |

Check it locally first. Run `bin/go2rtc.exe -config go2rtc.yaml` and open <http://127.0.0.1:1984>, where the stream should play. Stop go2rtc again before step 2.

## 2. Run the gateway

```
python cam_gateway.py --go2rtc bin/go2rtc.exe --go2rtc-config go2rtc.yaml \
    --cloudflared bin/cloudflared.exe \
    --camera "cam1:My Camera:What viewers see:1920x1080" \
    --owner "<your name>" --pseudonym "<short-id>" --note "one line under the card" \
    --stop-file STOP --log-dir logs
```

- `--camera STREAM:MODEL:LABEL[:WxH]` takes the stream name from `go2rtc.yaml`, then the device name, a label and the picture size. **Repeat it** to show several cameras on one card. For example, a printer and a headset from one gateway use one tunnel and one card.
- `--probe HOST:PORT` makes the card show the camera as *off* while that port does not answer, for example `<printer ip>:322`.
- `--no-relay` serves the stream but sends no card. Use it for testing.

Within about 30 s the gateway prints `on the relay as ...`, and the card appears on 6ense.com.

**To stop:** press Ctrl+C, or create the file you passed as `--stop-file`. The card comes down cleanly.

Keep the computer awake while streaming. On Windows, a sleeping PC freezes the stream.

## Always-on printer stream (Bambu)

`printer_stream.py` runs the gateway unattended on a PC that sits beside a Bambu printer:

- It finds the printer by its access code, even when its IP address changes.
- It waits for the camera.
- It restarts after failures and keeps the PC awake.
- It stops when a `STOP` file appears.

Put it next to `cam_gateway.py`, with `go2rtc` and `cloudflared` beside it or in `bin/`. Copy `settings.example.json` to `settings.json`, which is also never committed, and fill in the printer's serial and access code. Then run:

```
python printer_stream.py --check    # find the printer, test the camera, print a report
python printer_stream.py            # run (make it a start-up task to keep it always on)
```

## Quest headset view

`quest_feed.py` is a go2rtc `exec:` source. It runs scrcpy's server on the headset over adb and uses the headset's own H.264 encoder. It starts only while someone watches. Setup:

1. Turn on developer mode on the Quest and install `adb` (Android platform-tools).
2. Download scrcpy v5.0.1 and put `scrcpy-server` at `bin/scrcpy/scrcpy-win64-v5.0.1/scrcpy-server`.
3. For Wi-Fi adb, connect USB once after each headset reboot and run `adb tcpip 5555`, then `adb connect <headset ip>:5555`. Plain USB also works: pass the USB serial from `adb devices` instead.
4. Use `--crop 1440:1440:150:230` to show one eye. Lower `--bit-rate`, for example `2M`, when streaming over a phone hotspot.

Two gotchas:

- The picture is **black** when the headset is not worn (the display sleeps) or when the Quest's *Settings* panel is open (a secure layer). Close Settings with `adb shell am force-stop com.oculus.panelapp.settings`.
- Streaming drains the battery faster than laptop USB charges it, so use a wall charger.

## Safety

- go2rtc stays on 127.0.0.1. Only `/api/ws?src=<your streams>`, its HLS fallback and an empty `/bags` pass the proxy. Everything else returns 404.
- The tunnel address is random and only lasts while the gateway runs.
- The camera's password stays in your local `go2rtc.yaml` or `settings.json`. Neither 6ense.com nor the relay ever sees it.
- Anyone who opens 6ense.com can watch while your card is up, so point the camera accordingly.
- Please test with `--no-relay`, or briefly, rather than leaving test cards on the live page.

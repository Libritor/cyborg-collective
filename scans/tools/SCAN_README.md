# Quest 3S object scan: Gaussian splat and print file

Scan a real object with the headset, get a Gaussian splat of it to look at (on the laptop and in the headset) and a
closed solid sliced for the Bambu H2C.

## One command

    .\start_quest_scan.ps1                  # right controller
    .\start_quest_scan.ps1 -HandsFree 120   # no controller
    .\start_quest_scan.ps1 -View            # show the last result again
    .\start_quest_scan.ps1 -Live -Publish   # the whole chain to 6ense.com (see "To the website")

(in PowerShell, from the folder that holds `start_quest_scan.ps1`: on the laptop that is `printer_cam` in the home folder)

Headset on USB. The script installs the current build, waits until the headset is worn (if it shows "press the
power button to enable cameras", press it once; the script waits and does not get round that screen), starts the
app, waits for the scan, makes everything, and opens the result in the Quest Browser.

In the headset:

1. Put the object on a table or the floor with room to walk round it. Good light, nothing touching it.
2. Point the right controller at it and pull the **trigger** (hands-free: just look at it from about half a metre).
   A ring of grey dots appears round it.
3. Walk slowly all the way round, keeping the object in the middle of the view, 30 to 60 cm away. A dot turns green
   for every side photographed. Go round once at chest height and once from higher up, looking down.
   "slower" on the status line means the picture would smear.
4. Press **B** when all the dots are green (hands-free: it saves by itself after the full circle or the picture count).
5. Take the headset off or wait: after about four minutes the browser page opens. **Enter AR** puts the object in the
   room at real size. Right stick: turn and resize. Left stick: move. Trigger: splat / solid / both.

Two kinds of result, chosen by what the sitting recorded (the `mode:` line of `quest_scan.py` says which and why):

- **Object**: one of the picked things was photographed from at least 140 degrees round it in at least 20 pictures.
  Splat, solid, print file.
- **View**: nothing was walked round (pictures from one seat, or nothing picked). A splat of the surroundings, to be
  looked at from where it was photographed (`renders\look_around.jpg`, and the viewer puts you on that spot). No
  solid: from one spot there is no way to know the back of anything. `--solid` forces the solid all the same.

The headset keeps a picture every 5 cm or 6 degrees of head movement from the moment the app starts, whatever it
looks at (up to 400). The trigger only says which thing is the object; pull it on one thing, not on everything.
A sitting from before 17 Nov 16:30 kept scan pictures only while the first-picked thing was in view; for those,
`scan_view_folder.py <object folder>` gathers the scan pictures and the one-per-trigger pictures into `view\`.

## What comes out

`Downloads\quest_scans\<name>\`

| file | what |
|---|---|
| `object\object_splat.ply` | the object's Gaussians alone (3DGS .ply, origin at the middle of its base, y up, metres) |
| `gs\out\splat_<steps>.ply` | the trained splat with the table round the object |
| `object\<name>_real_size.stl` | the solid at 1:1, millimetres, standing on the bed |
| `object\<name>_print.stl` | scaled so its longest side is `--print-mm` (120); smaller objects stay 1:1 |
| `object\<name>_h2c.3mf`, `<name>.gcode` | sliced for the H2C, PLA, tree supports |
| `renders\photo_splat_solid.jpg` | photograph / splat / solid from four of the scan's own camera positions |
| `renders\turntable.jpg`, `.gif` | the splat and the solid from all round |
| `summary.json` | every number: pictures, sides covered, held-out PSNR, sizes, slicer time and grams |

Nothing is sent to the printer: open the 3MF in Bambu Studio. The pictures of the room stay on this computer.

## To the website

Two separate things can go to 6ense.com, each only when asked for, because both are public:

    scan  ->  [-Live]  rough blobs, as it happens  ->  relay  ->  6ense.com, "Live now"
    scan  ->  train (Brush)  ->  compress (Open3D, .spz)  ->  [-Publish]  ->  6ense.com/scans/

- **`-Live`** (`scan_session.py --live`). While the scan runs, the headset app also casts depth rays and sends one
  coloured blob per hit (untrained: this is not a Gaussian splat of the place, it is its depth readings with the
  camera's colours); `quest_splat.py --no-launch` passes them through the relay and the home page draws them under
  "Live now". It ends when the scan is saved. A trained splat cannot be streamed while scanning: it does not exist
  until the pictures have been trained on, and the headset cannot train one.
- **`-Publish`** (`scan_session.py --publish`, or afterwards `python scan_publish.py <run folder>`). The trained splat
  is read by Open3D and written as `.spz` (about a tenth of the size; read back and counted), and goes to
  `scans/runs/<id>/` of the site with the solid or room model (`.glb`), a render, the print files and `meta.json`.
  The list `6ense.com/scans/` is a plain page (no script); `scans/view.html?scan=<id>` is this folder's viewer.
  The camera pictures are not published. `-Title` and `-Note` set the words; they are kept in the run's
  `publish.json`. `python scan_publish.py --remove <id>` takes a scan off; `--list` shows what is up;
  `--no-push` writes into the clone of the site without committing.
- **The live page**, `6ense.com/scans/live.html` (`web/scans/live.html`): live Gaussian splatting. Each splat the
  relay passes on becomes one Gaussian (a flat soft disc on the surface it hit, from its position, facing, size and
  colour) and the site's splat renderer draws them as they arrive: one per 2 cm cell, surfaces seen from behind
  left out so a room can be looked into, a marker where the headset is, and "ride with the headset" to stand
  there. When nobody is scanning it shows the most recent finished scan and says so. The home page's live card
  links to it. Placed, not trained: the trained splat is the one `-Publish` puts up afterwards.
- **The tools themselves** are on the site as plain files, `6ense.com/scans/tools/`, listed with what each is for
  on `6ense.com/scans/how.html` (how a scan is made). `scan_publish.py` writes both (`TOOLS` in it is the list)
  and refuses a tool that names this computer's user folder.
- **AR and VR in the headset** need a secure address, which 6ense.com does not have yet. The relay serves a copy of
  the whole site at one: `https://cyborg-collective-relay.onrender.com/scans/`. The viewer on 6ense.com points there.
- Open3D cannot make a splat (0.20 reads, shows and converts them; it has no training). Its job here is the
  compression. The splat is made by Brush.

On the site since 17 Nov 2026: `room-17-nov` (the first sitting's view, with its room model and diorama),
`trex-test` and `triceratops-test` (the two synthetic scans, each labelled a test of the method, not a headset scan).

## The parts

| file | job |
|---|---|
| `Assets/PrintSee/PrintWhatISee.cs` (Unity project `Mersivity\MersivityQuest` in the home folder) | scan mode of the headset app: a JPEG, the camera pose and an 80 x 60 grid of depth rays every 5 cm of head movement |
| `scan_session.py` | the sitting: install, wait for the headset, start the app, follow its log, then the two below |
| `quest_scan.py` | check, dataset, train, object, print, render, web (each can be redone with `--run <folder> --from <stage>`) |
| `scan_lib.py` | scan folder, camera model, COLMAP dataset writer, splat .ply reader/writer |
| `splat_render.py` | Gaussian-splat renderer on the CPU (numba): colour, median depth, coverage |
| `scan_solid.py` | support surface, the object's Gaussians, depth carving into a closed solid, mesh |
| `scan_view.py` + `web/splat/` | the viewer, on 127.0.0.1 and through `adb reverse`. It runs on three.js 0.180 and Spark 2.4 (both MIT), which are not in the repository: `python web/splat/fetch_vendor.py` fetches them once into `web/splat/vendor/`, checked against recorded hashes |
| `scan_synth.py`, `scan_gate.py` | a made-up scan with a known answer, and the comparison against it |
| `scan_view_folder.py` | an old-style sitting's scan pictures + one-per-trigger pictures as one folder (`view\`), with the trigger points as `anchors.json` |
| `scan_mono_depth.py` | depth for pictures that have none: a depth network's map per picture, scaled to the headset's depth rays or to the trigger point; `mono\*.npy`, `mono_points.ply` (use as `quest_scan.py --points`) |
| `scan_room_model.py` | a view run's depth maps fused into a coloured shell of the room (`room\room_model.glb`) and a printable diorama (`room\room_diorama.stl`, `_h2c.3mf`) |
| `scan_publish.py` + `web/scans/test_scans_page.py` | a finished run onto 6ense.com/scans/ (and off again); the page's browser test, which travels with the page |
| `quest_splat.py` | the rough live view: listens for the app's splat packets, records them, passes them to the relay (`--no-launch` when the scan session starts the app) |
| `brush\brush_app.exe` in the home folder | the trainer (Brush 0.3.0): runs on the laptop's RTX 4060 through its own graphics API, no CUDA install |

## How it works

- **Capture.** Passthrough camera pictures (1280 x 960) with the headset's own pose for each; no structure from
  motion. The poses are used as they are (on a real lab walk, triangulating with them fixed gave 1.0 px error).
- **"Lidar".** The Quest 3S has no lidar and no depth sensor of its own: its depth comes from the two tracking
  cameras with infrared floodlights, through Meta's depth API. That depth is used four ways: as the starting cloud
  of the splat (so it starts in the right place, in metres), to find the object and the table before training,
  to cross-check the camera model (a depth ray must project back to the pixel it was cast through), and as a
  final check of the solid against it.
- **Training.** The pictures are cropped to a window round the object, so the trainer's detail goes to the object.
  8,000 steps take about two minutes. A tenth of the pictures are kept back and compared with the splat's renders.
- **Solid.** The splat's depth is rendered from every camera position and voted into a voxel grid: outside where
  enough cameras see past a voxel, surface where they see it, solid where no camera could see (so the body is
  closed), limited to the convex hull of the object's Gaussians, cut flat on the table.
- **A splat is slightly too small.** Measured against known models: the rendered depth of a small object lies
  about two picture pixels behind the true surface (0.8 mm at 61 cm, 0.5 mm at 39 cm). `--inset-px 2` corrects it.

## Checked, and not

Checked on this laptop (17 Nov 2026):

- Synthetic scans with a known model, drawn at the Quest camera's geometry with noisy depth (`scan_synth.py`,
  `scan_gate.py`): T. rex 18 cm long from 61 cm: median distance to the true surface 0.47 mm, sizes within 0.3 %,
  volume within 0.5 %; Triceratops 13 cm from 39 cm: 0.37 mm, sizes within 1.9 %. Both closed, both sliced.
- Real Quest pictures (lab walk of 8 Nov): the splat reproduces held-out photographs at 27 to 32 dB.
- The viewer page draws the splat, the solid and the room in desktop Chrome.

- First sitting on the headset (17 Nov 16:00, a room, from one seat): 12 scan pictures + 14 trigger pictures.
  The real depth rays project back to within 0.02 px sideways and 4.1 px vertically of where they were cast (the
  4 px is Meta's ray function against the picture's own principal point, as predicted from the lab walk), so the
  pose and camera conventions hold on the device. View splat: 218,000 Gaussians, held-out pictures 32.9 dB.
  The app FROZE after the 14th pick (it was drawing 49,500 voxels and reading the camera with a blocking call);
  since then: camera read without waiting, at most 12,000 voxels drawn, picks capped at 3,000 spots.

- Publishing (17 Nov 19:30): the three scans are on the site. `python scans/test_scans_page.py http://6ense.com/`
  (in the site's repository) passes 63 checks: the list with scripts off, each splat loaded with its stated number
  of Gaussians and drawn, the solids and the room model, every file at its stated size, nothing asked of another
  site, phone width. The same passes on the relay's secure copy. The site's own tests pass with the scans in
  (durability 71, home page 101, rooms 146).
- Live view: `scan_session.py`'s start and stop of `quest_splat.py --no-launch` on this laptop (listening, the
  port forwarded through adb, stopped by its stop file).
- The live page: `python scans/test_live_page.py` (18 checks: nobody scanning, a made-up room arriving as one
  Gaussian per cell and drawn, not piling up when sent twice, the look-in from outside, riding with the headset
  towards the right wall, the sender leaving, scripts off, a phone); with `--through <relay>` the made-up room goes
  through a relay as a headset's computer would send it (21 checks; passed through a private relay and through the
  public one to the published page).

Not checked: a walk round one object on the headset (so: the real depth API's quality on a small object, the ring
of dots, B), the rebuilt app's waiting-free camera read on the device, the page inside the Quest Browser, a print,
a scan and the live view running together on the headset (`-Live`: the app was rebuilt at 19:35 so that the splat
sensor reads the camera without waiting, as the scan does, and one read runs at a time; installed, never run),
and Enter AR / Enter VR from the secure copy of the site in a headset.

Limits: the object must stand apart on a level surface; shiny, transparent and very dark things do not
reconstruct; what the walk did not see is closed off by a flat hull face; the bottom is flat; the lowest 4 mm are
straight-sided (toes become stumps).

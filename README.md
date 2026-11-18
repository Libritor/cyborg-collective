# Cyborg Collective (6ense.com)

The public page: live headbands shared on the person's own terms, and the record of every recording behind them. Built from the MuseLog recorder's catalogue: summaries and previews, no raw samples, with one exception that the page states (the minute of one electrode listed in `music/eeg/`).

http://6ense.com/ (the domain has no https certificate yet) · https://libritor.github.io/cyborg-collective/

## How it is built to last

The site is plain files. There is no build step, no framework and nothing to install in order to serve it; any static host will do. No page loads code, styles, pictures or film from another site: the libraries it uses are kept beside the pages that use them (three.js for the rooms in `space/vendor/`; three.js and Spark, which draws Gaussian splats, for the scans in `scans/vendor/`). The only other computer it talks to is the relay, and only for what is live.

It is made of layers. Each needs only the ones above it in this table, and each can fail without taking those down:

| Layer | Files | Needs | If it is missing |
|---|---|---|---|
| Plain pages | the words in `index.html`, `record.html`, the films under `space/runs/`, the list of scans `scans/index.html` | a browser | nothing to fall back to: this is the floor |
| The record | `app.js`, `data/*.json`, `projects.json` | scripts on | the table says it is not loaded; `record.html` still lists every session |
| Live | the relay (`cyborg-collective-relay.onrender.com`) | the relay being up | the page says it is not connected; the record and the band carry on |
| The band | `music/` | Web Audio | the menu says the band could not load; everything else carries on |
| Extras | `splat-view.js`, `video-rtc.js`, the 3-D views in `space/`, `head/` and `scans/view.html` | WebGL, WebRTC | cards show without a picture; `space/` offers its films as plain links; `scans/` lists every scan with a picture, its numbers and its files; `head/` shows its still picture; the home page's head, which is `head/?embed=1` in a frame over that picture, gives way to the picture and the slider's sheet of pictures |

`test_survives.py` takes the layers away one at a time and checks what is left. It also checks the rules that keep this true: nothing loaded from another site, every file a page asks for present, each module asked for under one version tag, `record.html` in step with the data, `projects.json` in the shape the page reads.

## Changing it

Run these before a push; all of them should pass:

    npm test                              the band's logic, in node
    python test_survives.py               the layers and the rules above
    python music/test_home_page.py        the home page in a browser (serve the folder on 8771 first; the file says how)
    python space/test_space_page.py       the rooms page (needs Chrome, for the films)
    python head/test_head_page.py         the head page
    python scans/test_scans_page.py       the scans: the list and each scan in the viewer (needs Chrome)
    python scans/test_live_page.py        the live page: nobody scanning, a made-up room arriving, the sender leaving

Give any of the three Python tests `http://6ense.com/` (or `.../space/`) to check what is published.

Where things come from:

- `index.html`, `app.js`, `style.css`, `splat-view.js`, `video-rtc.js`, `mood.*`, `projects.json` and `data/` are published from the MuseLog repository (`collective/site/`) by its `deploy.py`, which also writes `record.html` from the data it has just copied. Change them there, or change both.
- `music/`, `space/` and `head/` live only here. `space/runs/<walk>/` is written by `maps_to_web.py` from a reconstruction's depth maps.
- `scans/live.html` is live Gaussian splatting: while a headset scans with its live view on, each depth reading the relay passes on is drawn as one Gaussian the moment it arrives (placed, not trained); when nobody is scanning it shows the most recent finished scan and says so. `scans/how.html` tells how a scan is made and links the tools themselves, which are published as plain files in `scans/tools/`. `python scans/test_live_page.py` checks the live page with a made-up room (add `--through wss://<relay>` to send it through a relay).
- `scans/` is written by `scan_publish.py` (one of the tools in `scans/tools/`; it is run where the scans are made): one folder per scan under `scans/runs/` (the Gaussian splat compressed to `.spz`, the solid or the room model as `.glb`, a render, the files to print, `meta.json`), the list `scans/index.html` and `scans/scans.json` rewritten from those folders, and the viewer `scans/view.html` with its libraries. `python scan_publish.py --remove <id>` takes a scan off. The camera pictures a scan was made from are not published. Each scan says whether a headset saw it or whether it is a test of the method drawn on a computer. AR and VR in a headset need a secure address: until the domain has its certificate, the relay's copy of the site (`https://cyborg-collective-relay.onrender.com/scans/`) is the one that offers them.
- `head/` is Steve Mann's head from his own CT scan, shown with his agreement: a skin surface and a small grey copy of the slices, written by `head/make_head.py` from the scan, which stays on the computer that has it. Nothing from the scan's headers is published; `python head/test_head_page.py --still` re-renders the still pictures from the page.
- A browser keeps a file for ten minutes. `deploy.py` stamps the addresses in `index.html`; inside `music/`, a module that changes is asked for under the next `?v=` number by every file that imports it.

What the site cannot promise by itself: the relay is one small server, so the live part is only as lasting as that server; and the band and the 3-D view rest on Web Audio and WebGL staying in browsers.

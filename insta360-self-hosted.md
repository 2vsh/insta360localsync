# Self-Hosting Insta360 Footage (No Cloud Subscription)

> **Runnable Windows PC concept:** double-click `Start-Sync.cmd` to choose a local download folder and open the X5 control page. See [README.md](README.md) for setup, demo mode, validation, and optional Windows Server startup. The Raspberry Pi setup below is the earlier reference proposal.

Notes on getting footage off an Insta360 camera and onto your own server, plus a Raspberry Pi sync setup and an idea for a lightweight 360 viewer.

---

## Part 1: Can the camera send footage to your own server?

Yes. Insta360 publishes developer tools that can pull footage off the camera, so you don't need their cloud just to back up your files.

### What's available

- **OSC API (HTTP over the camera's Wi-Fi):** works with the X6, X5, X4 Air, X4, X3, ONE RS 1-Inch, ONE RS, ONE X2, ONE R, and ONE X. It covers file retrieval, transfer, and deletion along with camera status and shooting control. This is the route the Pi setup below uses.
- **Official SDKs:** Mobile (iOS/Android) and Desktop (Windows/Linux). You apply on Insta360's developer site and download after approval. The Media SDK can also stitch footage.
- **Community Python library:** `pip install insta360`. Developed and tested on the X3 and X4; you connect to the camera's Wi-Fi network (named after the model, ending in `.OSC`).

### Catches

- **The camera doesn't push files.** It acts as its own Wi-Fi hotspot, so something has to join that network and pull the files. A Raspberry Pi with a second Wi-Fi adapter works well.
- **Wi-Fi is slow for big 360 video files.** USB or an SD card reader is much faster. Plugging the camera into a PC and running a sync script avoids the API entirely.
- **You get raw unstitched files** (`.insv` / `.insp`), not finished video. Insta360 Studio (free) or the Media SDK is still needed to reframe and export.

### Sources

- [Insta360 OSC developer guide](https://www.insta360.com/it/developer/tutorial?type=osc)
- [Insta360 SDK overview](https://www-sit.insta360.com/sdk/home)
- [Insta360 OSC docs on GitHub](https://github.com/Insta360Develop/Insta360_OSC)
- [insta360 on PyPI](https://pypi.org/project/insta360/0.1.18/)

---

## Part 2: Raspberry Pi sync over Wi-Fi

The Pi keeps a second Wi-Fi adapter joined to the camera's hotspot. Every 2 minutes it checks whether the camera is there, pulls anything new over the OSC API, and rsyncs it to your server over its normal connection (Ethernet or built-in Wi-Fi).

```
camera hotspot ──(wlan1, USB adapter)── Pi ──(eth0 / wlan0)── home network ── server
```

### What the script does

1. Checks the camera is reachable at `192.168.42.1`.
2. Lists every file on the SD card (`camera.listFiles`, paginated).
3. Downloads anything not already uploaded into a staging folder, resuming partial downloads.
4. Rsyncs the staging folder to your server, removing local copies once sent.
5. Records what was uploaded so nothing is fetched twice.
6. Optionally deletes uploaded files from the camera (off by default).

It was tested against a simulated camera: an interrupted download resumed, uploaded files were byte-identical, nothing re-downloaded on later runs, new clips were picked up, and delete only removed files already confirmed on the server. It has **not** been tested against a real camera yet; if the firmware rejects the file-listing command, the log shows the exact error.

### What you need

- A Raspberry Pi running Raspberry Pi OS Bookworm (uses NetworkManager)
- A USB Wi-Fi adapter for the camera link. If the camera's Wi-Fi runs on 5 GHz, get an adapter that supports 5 GHz, or switch the camera to 2.4 GHz.
- The camera activated once in the official Insta360 app (the OSC API refuses commands on an unactivated camera)
- The camera's Wi-Fi name and password: on the camera, Settings → Wi-Fi Settings. The network name ends in `.OSC`.

### Step 1: Join the camera's Wi-Fi on the second adapter

Check the USB adapter shows up as `wlan1`:

```bash
nmcli device
```

Create a saved connection for the camera. `never-default` stops the Pi from trying to reach the internet through the camera.

```bash
sudo nmcli con add type wifi ifname wlan1 con-name insta360 \
  ssid "X4 ABC123.OSC" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "YOUR_CAMERA_WIFI_PASSWORD" \
  ipv4.never-default yes ipv6.method ignore \
  connection.autoconnect yes connection.autoconnect-retries 0
```

`autoconnect-retries 0` makes NetworkManager retry forever, so the Pi rejoins whenever the camera's Wi-Fi comes back.

Test it with the camera on and Wi-Fi enabled:

```bash
nmcli con up insta360
curl -s http://192.168.42.1/osc/info
```

You should get JSON back with the camera model. While connected, confirm the Pi still has internet (`ping -c2 1.1.1.1`); if not, `never-default` didn't take.

### Step 2: Let the Pi log in to your server

Skip this if `DEST` will be a mounted NAS share instead of SSH.

```bash
ssh-keygen -t ed25519            # press Enter through the prompts
ssh-copy-id syncuser@192.0.2.10    # replace with your server's user and address
ssh syncuser@192.0.2.10 'mkdir -p /srv/insta360'
```

Run these as the same user set in `User=` in the service file (default `pi`).

### Step 3: Install the sync

```bash
sudo apt install -y rsync
sudo mkdir -p /opt/insta360-sync
sudo cp insta360_sync.py /opt/insta360-sync/
sudo cp insta360-sync.conf /etc/
sudo cp insta360-sync.service insta360-sync.timer /etc/systemd/system/
sudo nano /etc/insta360-sync.conf                      # set DEST
sudo nano /etc/systemd/system/insta360-sync.service    # set User= if not pi
sudo systemctl daemon-reload
```

Run once by hand and check the log:

```bash
sudo systemctl start insta360-sync.service
journalctl -u insta360-sync -n 50 --no-pager
```

When that looks right, enable the 2-minute schedule:

```bash
sudo systemctl enable --now insta360-sync.timer
```

### Step 4 (optional): Free up the SD card

After a few good syncs, set `DELETE_AFTER_UPLOAD=1` in `/etc/insta360-sync.conf`. Files are only deleted from the camera once rsync confirms they reached the server.

### Day-to-day use

Turn the camera on with Wi-Fi enabled and plug it into a charger near the Pi. Wi-Fi drains the battery and transfers take a while, so charging keeps it from shutting off midway. Disable auto power-off while it's syncing. Watch progress with:

```bash
journalctl -u insta360-sync -f
```

If a transfer is cut off, the partial file stays on the Pi and the next run resumes it.

### Notes

- **Speed:** Wi-Fi transfers of a few GB take several minutes; the log prints the speed for every file.
- **Files you get:** raw `.insv` (video, often two per clip, one per lens) and `.insp` (photos). LRV proxy files are skipped by default; set `SKIP_LRV=0` to keep them.
- **Upload tracking** lives in `/var/lib/insta360-sync/uploaded.json`. Delete an entry (or the file) to force a re-upload.

### File: `/etc/insta360-sync.conf`

```ini
# Where footage goes. Either an rsync-over-SSH target or a locally mounted share:
#   DEST=syncuser@192.0.2.10:/srv/insta360/
#   DEST=/mnt/nas/insta360/
DEST=syncuser@192.0.2.10:/srv/insta360/

# Camera's address on its own Wi-Fi (same for every recent Insta360 model)
CAMERA_IP=192.168.42.1

# 1 = skip LRV low-res proxy files (Insta360 Studio rebuilds them). 0 = back them up too.
SKIP_LRV=1

# 1 = delete files from the camera once they're confirmed on the server.
# Leave at 0 until you've watched a few syncs work.
DELETE_AFTER_UPLOAD=0

# SSH command rsync uses (add -i /path/to/key or -p PORT if needed)
RSYNC_SSH=ssh -o BatchMode=yes
```

### File: `/etc/systemd/system/insta360-sync.service`

```ini
[Unit]
Description=Pull new Insta360 footage over Wi-Fi and push it to the server
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Change to the Pi user that owns the SSH key for your server
User=pi
EnvironmentFile=/etc/insta360-sync.conf
StateDirectory=insta360-sync
ExecStart=/usr/bin/python3 /opt/insta360-sync/insta360_sync.py
Nice=10
```

### File: `/etc/systemd/system/insta360-sync.timer`

```ini
[Unit]
Description=Check for the Insta360 camera every 2 minutes

[Timer]
OnBootSec=1min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
```

### File: `/opt/insta360-sync/insta360_sync.py`

```python
#!/usr/bin/env python3
"""
insta360_sync.py - pull new footage off an Insta360 camera over its Wi-Fi (OSC API)
and push it to your own server with rsync.

Flow each run:
  1. Check the camera is reachable at 192.168.42.1 (Pi's second Wi-Fi joined to it).
  2. List every file on the SD card (camera.listFiles, paginated).
  3. Download anything not already uploaded into a local staging folder
     (resumes partial downloads if the camera's web server supports Range).
  4. rsync the staging folder to your server, removing local copies once sent.
  5. Record what was uploaded so it's never fetched twice.
  6. Optionally delete uploaded files from the camera (OFF by default).

Standard library only. Configure with environment variables (see insta360-sync.conf).
"""

import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------- config ----------
CAMERA_IP = os.environ.get("CAMERA_IP", "192.168.42.1")
STAGING_DIR = Path(os.environ.get("STAGING_DIR", "/var/lib/insta360-sync/staging"))
STATE_FILE = Path(os.environ.get("STATE_FILE", "/var/lib/insta360-sync/uploaded.json"))
LOCK_FILE = Path(os.environ.get("LOCK_FILE", "/var/lib/insta360-sync/sync.lock"))
DEST = os.environ.get("DEST", "")  # e.g. syncuser@192.0.2.10:/srv/insta360/  or  /mnt/nas/insta360/
RSYNC_SSH = os.environ.get("RSYNC_SSH", "ssh -o BatchMode=yes")
SKIP_LRV = os.environ.get("SKIP_LRV", "1") == "1"  # LRV = low-res proxy files; Studio rebuilds them
DELETE_AFTER_UPLOAD = os.environ.get("DELETE_AFTER_UPLOAD", "0") == "1"
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "50"))
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "30"))

BASE = f"http://{CAMERA_IP}"
HEADERS = {
    "Content-Type": "application/json;charset=utf-8",
    "Accept": "application/json",
    "X-XSRF-Protected": "1",
}


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------- OSC helpers ----------
def osc_post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode() or "{}")


def osc_get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode() or "{}")


def camera_reachable():
    try:
        info = osc_get("/osc/info")
        log(f"Camera online: {info.get('model', 'unknown model')} "
            f"(fw {info.get('firmwareVersion', '?')})")
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def execute(name, parameters):
    resp = osc_post("/osc/commands/execute", {"name": name, "parameters": parameters})
    if resp.get("state") == "error":
        raise RuntimeError(f"{name} failed: {resp.get('error')}")
    return resp


def list_all_files():
    """Paginate camera.listFiles. Insta360 firmware has been seen accepting params both
    directly (OSC v2 spec) and nested under 'options', so fall back if needed."""
    entries, start = [], 0
    nested = False
    while True:
        params = {"fileType": "all", "entryCount": PAGE_SIZE, "maxThumbSize": 0,
                  "startPosition": start}
        try:
            resp = execute("camera.listFiles", {"options": params} if nested else params)
        except RuntimeError:
            if nested or start:
                raise
            nested = True
            continue
        results = resp.get("results", {})
        batch = results.get("entries", [])
        entries.extend(batch)
        total = results.get("totalEntries", len(entries))
        start += len(batch)
        if not batch or start >= total:
            break
    return entries


def delete_from_camera(urls):
    for i in range(0, len(urls), 20):
        execute("camera.delete", {"fileUrls": urls[i:i + 20]})


# ---------- state ----------
def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    tmp.replace(STATE_FILE)


def record(state, name, size):
    state[name] = {"size": size, "uploaded": int(time.time())}


# ---------- download ----------
def download(entry, dest_dir):
    """Download one file to dest_dir/<name>, resuming a .part file when possible.
    Returns the final Path, or None if it couldn't be completed."""
    name, url, size = entry["name"], entry["fileUrl"], int(entry.get("size", 0))
    final = dest_dir / name
    if final.exists() and final.stat().st_size == size:
        return final
    part = dest_dir / (name + ".part")
    have = part.stat().st_size if part.exists() else 0

    req = urllib.request.Request(url)
    if have:
        req.add_header("Range", f"bytes={have}-")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            if have and r.status != 206:  # server ignored Range: start over
                have = 0
            mode = "ab" if have else "wb"
            t0, got = time.time(), 0
            with open(part, mode) as f:
                while chunk := r.read(1024 * 1024):
                    f.write(chunk)
                    got += len(chunk)
        secs = max(time.time() - t0, 0.001)
        log(f"  {name}: {got / 1e6:.1f} MB in {secs:.0f}s ({got / 1e6 / secs:.1f} MB/s)")
    except (urllib.error.URLError, OSError) as e:
        log(f"  {name}: download interrupted ({e}); will resume next run")
        return None

    if size and part.stat().st_size != size:
        log(f"  {name}: size mismatch ({part.stat().st_size} vs {size}); will retry")
        if part.stat().st_size > size:
            part.unlink()
        return None
    part.replace(final)
    return final


# ---------- upload ----------
def rsync_to_server(state):
    """Send staged files; record each one rsync confirmed (and removed locally)."""
    files = {p.name: p.stat().st_size for p in STAGING_DIR.iterdir()
             if p.is_file() and not p.name.endswith(".part")}
    if not files:
        return
    cmd = ["rsync", "-a", "--partial", "--remove-source-files", "--exclude=*.part",
           "-e", RSYNC_SSH, f"{STAGING_DIR}/", DEST]
    log(f"Uploading {len(files)} file(s) to {DEST}")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        log(f"rsync failed ({res.returncode}): {res.stderr.strip()}")
    for name, size in files.items():
        if not (STAGING_DIR / name).exists():  # removed by rsync => confirmed sent
            record(state, name, size)
    save_state(state)


# ---------- main ----------
def main():
    if not DEST:
        sys.exit("Set DEST (rsync destination) in the config file.")
    if not shutil.which("rsync"):
        sys.exit("rsync isn't installed: sudo apt install rsync")
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("Another sync is running; exiting.")
        return

    state = load_state()

    if not camera_reachable():
        log("Camera not reachable; nothing to pull.")
        rsync_to_server(state)  # still flush anything staged earlier (e.g. server was down)
        return

    entries = list_all_files()
    if SKIP_LRV:
        entries = [e for e in entries if not e["name"].upper().startswith("LRV_")]

    def uploaded(e):
        return state.get(e["name"], {}).get("size") == int(e.get("size", -1))

    pending = [e for e in entries if not uploaded(e)]
    log(f"{len(entries)} file(s) on camera, {len(pending)} new/changed")

    for e in pending:
        download(e, STAGING_DIR)

    rsync_to_server(state)

    if DELETE_AFTER_UPLOAD:
        done = [e for e in entries if uploaded(e)]
        if done:
            log(f"Deleting {len(done)} uploaded file(s) from camera")
            delete_from_camera([e["fileUrl"] for e in done])

    log("Done.")


if __name__ == "__main__":
    main()
```

---

## Part 3: Idea — a lightweight `.insv` viewer

A custom viewer with manual rotate, pan and zoom is realistic.

### What's inside the files

- An `.insv` is basically a normal MP4 (H.264 or H.265) with Insta360's own data appended at the end.
- The frames are raw circular fisheye images, one per lens. Depending on model and resolution, both lenses are side by side in one file, or split into a `_00_` / `_10_` pair.
- The appended data includes lens calibration (an "offset" string describing each lens's center, radius and angle) and the gyro log.
- `.insp` photos work the same way: a JPEG holding the two fisheye circles.

### How it would work

1. **Decode the video** with a plain `<video>` element. H.265 support depends on browser and hardware, but most modern setups handle it.
2. **Unwrap the fisheyes in a shader.** For each viewing direction, the GPU works out which lens covers it and which pixel in that fisheye circle to sample, using the calibration numbers. That gives a full sphere.
3. **Render the sphere with a virtual camera.** Drag to rotate and pan; scroll or pinch to zoom by changing field of view. A "tiny planet" mode comes almost for free.

This fits in one web page using three.js or plain WebGL, and could be hosted on the same server the footage syncs to.

### Limits compared to Insta360 Studio

- **Seams:** Studio uses optical-flow stitching. A shader-based viewer picks or crossfades at the lens boundary, so close objects near the seam look doubled or misaligned. Distant scenery looks fine.
- **Stabilization:** Studio uses gyro data (FlowState). Parsing the gyro log and counter-rotating each frame is possible but the hardest part — a phase two.
- **Split-lens files:** separate per-lens files mean playing two videos in sync, which is doable but less smooth.
- **Undocumented format:** calibration parsing relies on community reverse-engineering and testing against real files.

### To build it

Needed: the camera model and a short (few-second) `.insv` sample clip, since the file layout varies by model and the lens mapping has to be tuned on real footage.

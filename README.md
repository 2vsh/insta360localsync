# Insta360 Local Sync

A local **Insta360 X5 downloader, gallery, 360° viewer, and director cut editor** for Windows. It runs on your PC with Node.js 22.13 or newer, uses FFmpeg for media processing, and has no npm dependencies. The downloader also supports a future Windows Server installation.

## Start on your Windows PC

1. Install [Node.js 22.13 or newer](https://nodejs.org/en/download), then double-click **`Start-Sync.cmd`**. No npm install is needed.
2. On first launch, choose a download folder in the Windows folder picker. The control page opens at **http://127.0.0.1:8640**.
3. Turn on your X5 and enable its Wi-Fi. In **Windows Settings → Network & internet → Wi-Fi**, join the camera's Wi-Fi network using its password. Accept Windows' “no internet” warning and stay connected.
4. Open **Sync** and click **Sync now**. Use **Settings** to choose a backup policy, destination, schedule, and verification options between transfers and media jobs.
5. Optionally enable **Sync automatically while the app is running**. Keep the launcher window open; automatic checks continue while the app is running. Closing just the browser leaves the app running.

Keep the X5 powered, awake, and idle during a transfer. Close the phone app if it competes for the connection. Connecting one Wi-Fi adapter to the camera can temporarily disconnect the PC from its normal Wi-Fi; the downloader does not need internet access. Ethernet or a second Wi-Fi adapter can keep the normal network available.

**A real X5 transfer was verified on Windows on 2026-10-18.** One short recording downloaded successfully; its size and SHA-256 matched the local backup record, and both video streams and audio decoded without errors. Physical-camera pagination and interrupted-transfer resumption have not yet been verified. The implementation follows Insta360's OSC documentation, which lists the X5 and `192.168.42.1`; firmware differences may require adjusting the file-list request. Exact camera errors are shown in **Transfer activity**.

## Gallery, viewer, and director cuts

Install a current [FFmpeg](https://ffmpeg.org/download.html) build containing **ffmpeg**, **ffprobe**, the **v360**, **remap**, **displace**, and **framerate** filters, **libx264**, and **FFV1**, and make both executables available on PATH. One Windows option is:

```powershell
winget install --id Gyan.FFmpeg --exact
ffmpeg -version
ffprobe -version
```

Open a new terminal and restart the launcher after installation. Camera downloads still work without FFmpeg. Use a current Chrome or Edge browser with hardware acceleration enabled for the interactive viewer and folder selection when saving a cut.

1. Open **Library** to browse thumbnails, search filenames, sort, and filter videos or photos. The library uses completed backups in the selected destination's manifest. Older two-file lens pairs appear as one clip.
2. Open a clip. The app creates and caches a browser-compatible playback preview on this PC. First preparation can take time, especially for long recordings; progress and cancellation are available. Later openings reuse the preview.
3. Drag the image to pan and tilt; scroll or pinch to zoom. Use **Rotate** for roll and **Field of view** for zoom. Arrow keys pan, Q/E rotate, +/− zoom, R resets, and Space plays or pauses when the viewer canvas has focus.
4. In **Director cut**, choose Start/End times in seconds, use the playhead buttons, or select **Whole clip**. Choose landscape, portrait, or square, and 720p or 1080p.
5. Set your opening view, then click **Record camera moves**. Pan, rotate, and zoom as the video plays. Recording stops at End; **Finish take** uses the shorter recorded section. A stationary view is also a valid take. Pause to adjust your view without advancing the recording.
6. **Preview take** replays the recorded path. **Render MP4** creates a standard H.264/AAC video with those movements and the original audio. **Save MP4 as…** opens a save picker in supported browsers so you can choose a filename and folder. Other browsers download through their normal download settings; enable their “ask where to save” option to choose a location.

Take drafts are saved in this browser's local storage. Export progress and completed download buttons remain available in the library while the page stays open. Reloading or restarting clears that session's export list; the next render creates another file. Ranges are limited to six hours per cut. Media jobs run one at a time; closing the viewer cancels its preview preparation, while an MP4 render can continue in the background until cancelled or the app stops.

**Stitching quality:** Supported X5 V3/V6 calibration supplies recorded lens geometry, distortion, sensor crop, guard profiles, and track order. The viewer identifies this as **Calibrated lens stitch** or **Lens-guard corrected stitch**. Videos also match textured overlap patches ten times per second and apply smoothed, bounded local alignment; the viewer adds **overlap aligned** when ready. This reduces seam kinks and doubled edges. Close objects, occlusions, reflections and fast motion can still show artifacts. It does **not** reproduce Insta360's proprietary stitching, FlowState stabilization, or horizon leveling. Unsupported/missing calibration uses the labelled **Basic lens stitch** fallback. Dual-stream recordings and older separate `_00_`/`_10_` pairs remain supported.

**Lens guard correction:** in **Settings > Playback and export**, switch correction on to use the supported guard profile recorded in the clip, or off to use bare-lens geometry. Save, then reopen the clip. On is the default and does not invent a guard profile for footage recorded without one. Native per-camera calibration, sensor crop, and track order are retained in either mode. Separate previews and browser drafts prevent a changed projection from silently replacing a take; completed download links and exports retain their optical setting.

Thumbnails use the recorded static geometry; playback and director cuts also share local overlap alignment. Preview and export share a 2880 × 1440 panorama; 1080p export does not recover full original detail. Use Insta360 Studio for its stitching/stabilization and original-resolution results. Existing 2:1 panoramas and ordinary videos are also supported. JPEG/PNG and decodable JPEG-compatible `.insp` photos can be explored; RAW and standalone audio remain backups for desktop tools. The calibration format/projection reference is credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

After updating from the earlier basic stitch, restart `Start-Sync.cmd`, refresh the page, and reopen the clip. The cache version changes automatically, so old thumbnails and previews are rebuilt without deleting originals or previously rendered exports. Saved camera paths may need reframing because the corrected projection changes the view. First preparation takes additional time for overlap analysis, calibrated maps and preview rendering. The current cache generation is 7.

Thumbnails, previews, camera paths, and exported MP4s are private derived files under **`.local/media/` in the app folder**. Allow disk space for these in addition to your originals. They never replace or edit the source files. To reclaim the cache, stop the app, save any wanted exports elsewhere, then remove `.local/media/`; previews regenerate when reopened. The camera need not remain connected to view completed local backups.

## Interface design

The interface uses task names (Library, Sync, Settings), filename search, backup dates and sizes, and direct action labels. Connection instructions sit beside Sync; technical playback details expand on demand. Controls have visible keyboard focus, labelled inputs, readable contrast, reduced-motion support and responsive layouts. The lens guard control follows the native checkbox switch pattern with a stable label and explicit On/Off state. These choices apply [Nielsen Norman Group's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [GOV.UK's interface-writing guidance](https://www.gov.uk/service-manual/design/writing-for-user-interfaces), and W3C's [WCAG 2.2 guidance](https://www.w3.org/TR/WCAG22/) and [switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/).

## Try it without a camera

Double-click **`Start-Demo.cmd`**, or run:

```powershell
node server.mjs --demo --port 8641
```

Open http://127.0.0.1:8641. This starts a simulated X5, downloads three synthetic fixtures, and skips a proxy file. Pressing Sync now again shows that they are already backed up. Demo settings and downloads live under `.demo/`, separate from your real settings. **Demo .insv/.insp files are transfer fixtures, not playable footage.**

## How files are stored

```text
Your chosen folder/
  Insta360_X5-<serial>-<identity>/
    DCIM/
      Camera01/
        VID_..._00_001.insv
        VID_..._10_001.insv
        IMG_....insp
  .insta360-sync/
    manifest.json
    partials/
      <identity>.part
```

- Original filenames and camera subdirectories are retained. Lens pairs stay together for Insta360 Studio. All listed `.insv`, `.insp`, `.mp4`, `.mov`, `.jpg`, `.jpeg`, `.png`, `.webm`, `.lrv`, `.dng`, `.wav`, and `.m4a` files are eligible; proxies beginning `LRV_` or ending `.lrv` are skipped by default.
- Files stream to disk with bounded memory use. An interrupted transfer remains in `partials/` and resumes on the next check if the camera supports HTTP Range. If Range is ignored, the download restarts safely.
- A file is published only after its byte count matches the camera's advertised size. A local SHA-256 is recorded after reading the completed file back from disk. **The camera does not provide a reference checksum**, so this is local integrity tracking, not an independent comparison with a camera-side hash.
- Backup history is saved after every completed file. Existing matching files are skipped; missing files are downloaded again. If a local file's size or modification time changes, it is rechecked. Existing files with different contents are preserved and reported as conflicts; move the conflicting file aside and retry.
- The default **Keep both** policy never removes camera originals. Other policies can delete camera files after the checks below. The app never formats the card or starts recording. There is no cloud upload.
- The gallery lists historical completed backups with pagination. It is not a live filesystem integrity audit. The next sync rechecks the camera's current list against local files; the viewer rejects originals whose size or modification time changed.
- Originals remain suitable for Insta360 Studio. The local viewer and director cuts use separate derived previews.

## Backup policies and settings

Settings contains four policies. **Keep both** is the default, including for existing configurations.

| Policy | What happens after sync |
| --- | --- |
| Keep both | Keep completed PC backups even after camera deletion. Missing PC files download again. No automatic camera removal. |
| Mirror deletions | Establish a baseline of recordings present on both sides, then follow whole-recording deletions in either direction. Camera deletion moves PC copies to local recovery; PC deletion permanently removes the camera originals. |
| Archive on this PC | Download and verify complete recordings, then remove their camera originals. The PC becomes the remaining copy. |
| Make room when needed | Keep both copies until the camera reaches 90% used, then remove the oldest verified camera recordings toward 80% used. Keep footage from the last 24 hours. Thresholds and retention are adjustable. |

Enabling a deletion policy requires acknowledging its effect in Settings. **Preview next sync** reads the camera and history using unsaved settings without downloading, moving, deleting, or advancing mirror grace. Newly downloaded footage can become eligible for cleanup during a real sync even when the preview says it first needs a backup.

Mirror starts fresh when the policy, destination, or camera address changes. Existing PC-only backups are retained; this does not upload arbitrary PC files to the camera. Deletions require two complete, stable checks separated by the configured grace period (24 hours by default). Remove the entire recording, including companion lenses/proxies: partial deletions pause that recording. Removing the whole camera backup directory pauses camera removal rather than treating a missing disk/folder as intentional deletion.

All deletion policies include listed proxy companions even if proxy skipping is selected. Archive/space cleanup re-reads every local companion and compares SHA-256, checks camera identity, ready storage and stable inventories, and confirms the requested files disappeared. Failed transfers, conflicts, uncertain capture times, busy/unsupported storage responses or inventory changes pause cleanup. There is no independent camera checksum. Camera removals are permanent. Mirror intentionally follows a complete PC deletion without requiring a remaining PC copy.

Other settings include automatic checks, a 5 GB PC free-space reserve, a 10-minute minimum recording age for archive/space cleanup, a 50-recording cleanup limit per pass, optional full SHA-256 rechecking on every sync, request timeout and pagination size. Cleanup runs during sync while the app is running and camera is connected; it does not monitor an offline camera or make room while recording. Capacity targets may remain unmet when protected/unbacked files occupy the card.

Local mirror removals stay under `<destination>/.insta360-sync/recovery/` until manually removed while the app is stopped. **Local recovery ? Restore** verifies and returns them to the PC folder without uploading them or immediately mirroring their absence again. Existing conflicting files are preserved. Interrupted recovery operations can be retried. Recovery consumes destination space; it has no automatic expiry. Keep the destination metadata with its backups.

Deletion behavior has been tested against a simulated OSC camera, including refusal/partial removal and failure cases. Physical X5 deletion and storage responses remain unverified; unsupported responses pause cleanup while ordinary backups remain available.

## Configuration and command line

`config.json` is created by the launcher or when you save settings. See `config.example.json`. Relative destination paths resolve against the configuration file's directory. In JSON, use `D:/Footage/X5` or escaped backslashes, `D:\\Footage\\X5`.

```powershell
# Foreground local control page; automatic checks depend on your settings
node server.mjs

# One download pass, then exit; nonzero exit code for connection/file failures
node server.mjs --once --destination "D:\Footage\X5"

# A separate config or port
node server.mjs --config "C:\Insta360\config.json" --port 8642

# Launcher without a folder dialog or browser, also suitable for Server Core
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Sync.ps1 -Destination "D:\Footage\X5" -NoBrowser

# The Windows launcher can also download once and exit
.\Start-Sync.cmd -Destination "D:\Footage\X5" -Once
```

Command-line overrides apply to the running process. Saving settings in the page persists them. Port changes take effect on restart. The HTTP page always binds to loopback; it is intended to be opened on the same PC. No firewall changes, Docker, rsync, Python, or cloud account are required.

The X5's OSC address defaults to `http://192.168.42.1`. This app does not join Wi-Fi automatically or change your network settings. You can test connectivity in PowerShell:

```powershell
Invoke-RestMethod http://192.168.42.1/osc/info -TimeoutSec 5
```

If this times out, check which Wi-Fi network Windows has joined. For the default camera address, the PC must join the **X5's own Wi-Fi hotspot**; having the PC and camera connected to your home router does not establish that connection. On the X5, open **Settings → Wi-Fi Settings**, enable Wi-Fi, and find the camera's network name and password. Join that network from Windows and accept **No internet**. Disconnect the phone from the camera first if it is connected. You can leave the PC's Ethernet connected to your router for internet access. Keep the camera awake, then retry the command and **Sync now**. See Insta360's [OSC connection guide](https://github.com/Insta360Develop/Insta360-Developer_Docs/blob/main/docs/en/sdk/x-ace-go/osc/guide.md).

Activity is shown in the console and page; console activity is not persisted across app restarts. The manifest and partial transfers are persisted in the destination.

## Optional Windows startup

For your PC, first enable automatic checks and save settings, then close the foreground app and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-StartupTask.ps1 -StartNow
```

This registers a Task Scheduler task for the current user at sign-in. A task is not installed automatically. Stop or remove it before running another instance on the same port. The default PC task may show a console; close that console to stop it, or stop it in Task Scheduler.

For a future Windows Server, copy the project to a stable local folder such as `C:\Insta360Sync`, install Node.js 22, and create settings using the launcher with `-Destination` and `-NoBrowser`. With automatic checks enabled, run the following in **Administrator PowerShell**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-StartupTask.ps1 -AtBoot -StartNow
```

The boot task runs as SYSTEM and needs no interactive desktop. Use a local disk destination that SYSTEM can access; mapped drives, OneDrive folders, and authenticated network shares are not supported by that task setup. The server still needs a network route to the X5. This is a scheduled process, not an SCM Windows service. The server mode has been prepared and its PowerShell syntax checked, but has not been deployed on Windows Server.

Remove the task with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Remove-StartupTask.ps1
```

After an unexpected crash, a lock from a dead local process is recovered automatically. An unreadable lock, a reused PID, or a lock from another machine is kept conservatively. Stop all sync processes before manually removing `<destination>\.insta360-sync\sync.lock`. If a crash happened during lock recovery, also remove the empty `sync.lock.recovery` directory. Use one collecting PC per destination.

## Validation

```powershell
node --test
```

Tests exercise simulated-camera transfers, exact bytes, pagination, resumption, duplicate and conflict handling, locks, crash recovery, the local API, the Unicode-path Windows launcher, and publication safeguards. Media tests generate synthetic footage and run real FFmpeg jobs for dual-stream and separate-file lenses, photos, flat videos, trimmed MP4s with and without audio, cancellation, protected Range downloads, manifest confinement, and matching camera-path projection and zoom. Calibration tests reconstruct a known sphere with reversed tracks, unequal lenses, guards and sensor crop; an independent separated-camera fixture checks seam-error reduction. FFmpeg-dependent tests are skipped if the tools are missing. No startup task was registered. Separately, the actual downloaded X5 clip was viewed and used for a selected-section director cut with audio; desktop and mobile layouts were checked in a browser. Windows Server deployment and long recordings remain unverified.

## Publishing the source

The repository contains source, generic examples, and synthetic fixtures generated in memory. Your camera password is entered in Windows Wi-Fi settings, never in this app. The default OSC address `192.168.42.1` is a camera network address, not a credential.

Keep personal settings in the ignored `config.json`, or put custom `--config` profiles under `.local/`. Download footage outside the checkout when practical. `.gitignore` also excludes camera media, partial transfers, backup metadata, demo/test output, logs, environment files, and private key files. Camera serial numbers, local paths, hostnames, and filenames can appear in local settings, backup history, console output, and screenshots; review those before sharing them in an issue.

Before committing or pushing from a Git checkout, run:

```powershell
npm run check:public
node --test
git diff --cached --stat
```

The public-file check scans tracked files and non-ignored new files for private artifacts, personal home-directory paths, runtime configuration, and common credential formats. It also inspects staged content, so a clean working copy cannot hide a sensitive staged version. It reports filenames and rule names without printing matching values. It is a focused safeguard, not an exhaustive secret scanner, and does not inspect older commits. Ignoring a file does not remove it from Git's index or history. `"private": true` in `package.json` only prevents accidental npm publication; it does not control GitHub visibility.

See [SECURITY.md](SECURITY.md) for the local app's access model and reporting guidance.

Protocol references: [Insta360 OSC guide](https://github.com/Insta360Develop/Insta360-Developer_Docs/blob/main/docs/en/sdk/x-ace-go/osc/guide.md), [Insta360 OSC API](https://github.com/Insta360Develop/Insta360-Developer_Docs/blob/main/docs/en/sdk/x-ace-go/osc/api.md), [OSC pagination](https://developers.google.com/streetview/open-spherical-camera/reference/camera/listfiles), [Node.js 22 platform support](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list).

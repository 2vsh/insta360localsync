# Insta360 Local Sync

A working downloader concept for an **Insta360 X5 → local Windows folder**. It runs on your PC with Node.js 22.13 or newer and has no npm dependencies. The same app can run on Windows Server 2019/2022/2025 with Node.js 22.

## Start on your Windows PC

1. Install [Node.js 22.13 or newer](https://nodejs.org/en/download), then double-click **`Start-Sync.cmd`**. No npm install is needed.
2. On first launch, choose a download folder in the Windows folder picker. The control page opens at **http://127.0.0.1:8640**.
3. Turn on your X5 and enable its Wi-Fi. In **Windows Settings → Network & internet → Wi-Fi**, join the camera's Wi-Fi network using its password. Accept Windows' “no internet” warning and stay connected.
4. In the control page, click **Download new footage**. You can paste a different folder path into **Save footage to** and save settings at any time between transfers.
5. Optionally enable **Check for new footage automatically**. Keep the launcher window open; automatic checks continue while the app is running. Closing just the browser leaves the app running.

Keep the X5 powered, awake, and idle during a transfer. Close the phone app if it competes for the connection. Connecting one Wi-Fi adapter to the camera can temporarily disconnect the PC from its normal Wi-Fi; the downloader does not need internet access. Ethernet or a second Wi-Fi adapter can keep the normal network available.

**The real X5 hardware has not been tested here.** The implementation follows Insta360's OSC documentation, which lists the X5 and `192.168.42.1`; firmware differences may require adjusting the file-list request. Exact camera errors are shown in **Transfer activity**.

## Try it without a camera

Double-click **`Start-Demo.cmd`**, or run:

```powershell
node server.mjs --demo --port 8641
```

Open http://127.0.0.1:8641. This starts a simulated X5, downloads three synthetic fixtures, and skips a proxy file. Pressing Download again shows that they are already backed up. Demo settings and downloads live under `.demo/`, separate from your real settings. **Demo .insv/.insp files are transfer fixtures, not playable footage.**

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
- Files are **never deleted from the camera**. The app never sends a delete, format, or capture command. There is no cloud upload.
- The page lists historical completed backups (up to 200 displayed). It is not a live filesystem integrity audit. The next sync rechecks the camera's current list against local files.
- The app downloads original media. Use Insta360 Studio for stitching, stabilization, playback, and reframing.

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
Invoke-RestMethod http://192.168.42.1/osc/info
```

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

Tests exercise real HTTP downloads from a simulated OSC camera: exact bytes, lens pairing, pagination and firmware-parameter fallback, interrupted transfers, ignored/incorrect Range replies, deduplication, missing-file recovery, conflicting files, changed local content, concurrent-process locks, crash recovery, corrupt history, unreachable cameras, and the local HTTP API's request protections. The Windows launcher test downloads to a folder with Unicode characters and exits successfully. Publication checks are tested against temporary Git repositories, including private files already tracked by Git. Desktop and narrow layouts were checked in a browser, including downloading again and saving automatic-check settings. No startup task was registered or real camera contacted during validation.

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

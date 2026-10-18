# Instructions for future agents

Read this file at the start of each session, then read `README.md` and `SECURITY.md`. Check the actual files, Git status, branch, and remote before relying on the handoff below. Treat this file as a maintained project handoff, not a transcript.

## Keep this file current

The user explicitly requested that future models write the current project state and the user's intended next explorations here so work can resume easily.

- Before ending a session with meaningful work or new user direction, update the handoff sections below. Include changes made, remaining work, decisions, relevant validation, and unresolved blockers.
- Record the user's newly stated priorities and exploration ideas. Distinguish explicit requests from agent recommendations and ideas found in older notes. Do not invent requirements or treat an exploration as authorization to implement it.
- Replace stale information instead of accumulating a long session log. Keep durable instructions separate from the dated handoff.
- Report validation accurately: record what was actually checked, distinguish simulated-camera tests from physical hardware tests, and identify anything unverified.
- Record commit and publication status when relevant. Verify a push before claiming it succeeded. Use `git log` for the latest commit rather than trying to embed this file's own commit hash in itself.
- Keep this file safe for a public GitHub repository. Never include credentials, real camera serial numbers, Wi-Fi passwords, personal home-directory paths, footage, or copied private logs. Use repository-relative paths and generic examples.

## User requirements and working constraints

- Camera: **Insta360 X5**.
- The current collecting machine is the user's **Windows PC**, not an actual Windows Server. The immediate goal is for that PC to download footage into a user-selected **local folder**.
- Preserve compatibility with a possible future Windows Server deployment; do not assume a server is already deployed.
- Source must be suitable for a **public GitHub repository**. Keep personal settings, media, backup metadata, and generated artifacts out of commits.
- Publish to **`https://github.com/2vsh/insta360localsync`**, branch **`main`**, as explicitly requested by the user. Preserve existing remote history and verify every push.
- Preserve camera originals. The Windows downloader must not send delete, format, or capture commands.
- Keep the control page local to the collecting PC. Its loopback binding and request protections are part of the current access model.

## Current project state — 2026-10-18

A runnable Windows downloader, gallery, interactive viewer, and director cut editor are implemented using **Node.js 22.13+**, Node built-ins, and plain HTML/CSS/JavaScript. There are no npm dependencies. Media preparation and MP4 rendering require locally installed **FFmpeg and FFprobe** on PATH, including v360 and libx264; downloads work without them.

- `Start-Sync.cmd` and `scripts/Start-Sync.ps1` provide the Windows launcher, first-run folder selection, browser opening, and optional `-Once`/`-NoBrowser` operation.
- `server.mjs` provides the local control page and API at `http://127.0.0.1:8640` by default. Manual and automatic checks are supported. The user joins the X5 Wi-Fi in Windows; the app does not change network settings.
- `lib/sync.mjs` implements sequential OSC requests, paginated listing, streaming downloads, safe HTTP Range resumption, duplicate skipping, conflict preservation, destination locks, and persistent backup history.
- Original filenames and lens pairs are retained. Proxies are skipped by default. Completed files receive a local SHA-256; the camera supplies no reference checksum.
- `public/` contains a responsive thumbnail gallery with search, filters, sorting, and pagination, a separate Sync & settings page, and a full-window viewer. `viewer.js` uses WebGL for pan, tilt, roll, zoom, and fullscreen, plus accessible controls, keyboard shortcuts, pointer/pinch gestures, and mobile recording controls. Video textures refresh on actual decoded-frame callbacks, including initial load and seeking.
- Director cuts support a selected section or whole clip, live camera-move recording, replay, local browser drafts, landscape/portrait/square output, 720p/1080p, cancellable MP4 rendering with audio, and a Save As picker (ordinary browser download fallback). Export status survives closing the viewer, but the export list is page-session state; reloading clears it. Ranges are capped at six hours.
- `lib/media.mjs` queues local FFmpeg processing, prepares thumbnails/H.264 previews, validates camera paths, renders MP4 exports, and serves protected derived assets with HTTP Range seeking. `public/view-path.js` shares interpolation and camera math with the renderer. Runtime commands set absolute rotation and both horizontal/vertical field of view so zoom preserves the frame shape.
- Real X5 dual-stream `.insv` files and older separate lens pairs use a **basic dual-fisheye stitch**, without Insta360 calibration, FlowState, or horizon leveling. Seams are visible; panoramas are 2880 × 1440 and exports do not recover original 8K detail. Preserve this limitation in the UI/docs. Existing 2:1 panoramas, ordinary videos, and JPEG-compatible photos are supported; RAW/audio are backups for desktop tools. Demo fixtures remain unplayable.
- Private derived thumbnails, previews, take paths, and exports live under ignored `.local/media/`, outside the original destination. Never commit them or QA screenshots. Originals remain untouched. Cache cleanup is manual while stopped, after saving wanted exports elsewhere; assets regenerate on demand.
- `Start-Demo.cmd` and `lib/mock-camera.mjs` provide a simulated camera with synthetic transfer fixtures. Demo media is not playable footage.
- `scripts/Install-StartupTask.ps1` and `scripts/Remove-StartupTask.ps1` support optional sign-in or server boot scheduling. No startup task was installed during agent validation.
- `.gitignore`, `scripts/check-public.mjs`, and `SECURITY.md` protect publication. The public-file check scans Git-visible working files and staged blobs, including private files that were already tracked. It does not inspect older history or guarantee detection of every secret.
- `insta360-self-hosted.md` contains older Raspberry Pi reference code and a viewer proposal. It is not the Windows implementation. Its optional camera-deletion setting must not be copied into the Windows workflow.

### Last verified checks

- **23 automated tests passed on 2026-10-18** on Windows with FFmpeg available: transfer behavior, local API, PowerShell launcher with a Unicode destination, publication safeguards, path validation/confinement, dual-stream and separate lenses, photos, flat video, cancelled and failed processing, trimmed MP4s with/without audio, protected byte-range downloads, and pixel comparisons for rendered camera movement and zoom. Three FFmpeg-dependent tests skip when the tools are absent; require a tool-equipped run when changing media rendering.
- The public-file check passed for **26 source files, including this `AGENTS.md`**. Rerun it after edits and staging; do not assume that count stays fixed. JavaScript syntax and Git whitespace checks also passed.
- Browser QA at desktop and 390px mobile widths verified the actual X5 clip's initial frame, seeking, live pan/tilt/roll/zoom, selected-section recording, take replay/restoration, recording another take after replay, MP4 rendering, a completed browser download, empty/search/filter states, portrait framing, and no horizontal overflow. The resulting three-second H.264/AAC export fully decoded. A regression check protects the new take's timestamps from the replayed view's clock. Save As uses the browser's native picker; its OS dialog was not automated. Transfer settings were retained; their earlier browser validation is separate from this viewer QA.
- **One physical X5 transfer was verified on Windows on 2026-10-18.** The user performed the transfer and requested inspection of the destination. The local app reported one file downloaded, zero failed, and no history error. Read-only destination checks found one completed recording, matching byte count and SHA-256 against the local backup manifest, and no partial, temporary, or lock files. FFprobe found two HEVC video streams and stereo AAC audio; a full FFmpeg decode of both video streams and audio passed. This verifies the downloaded sample against its local backup record, not an independent camera-side checksum. Physical-camera pagination, interrupted-transfer resumption, and Windows Server deployment remain untested.
- **Connection timeout resolved:** joining the X5's own hotspot with PC Wi-Fi established a direct camera-subnet route while Ethernet remained on the home LAN. The user confirmed the app worked, and its status reported the X5 reachable with a successful download. `README.md` now explains this timeout and the direct-hotspot setup. Do not copy private network identifiers, footage names, or camera serial numbers into this handoff.

Run from the active project checkout:

```powershell
node --test
node scripts/check-public.mjs
# Equivalent publication check when npm is available:
npm run check:public
```

### Publication handoff

- The active checkout is on **`main`**, with `origin` pointing to the requested GitHub repository. On **2026-10-18**, a push of the application and maintained handoff succeeded, and GitHub's `refs/heads/main` was verified to match local `HEAD`. Consult `git log` for the latest commit and compare local `HEAD` with the remote branch to verify future publications; do not embed this file's own commit hash here.
- The required downloader/documentation checkpoint was pushed to `main` and verified **before any gallery/viewer implementation**. Gallery/viewer implementation and validation are now complete; publish the feature update after the final staged public-file check, then verify GitHub's main ref again.
- GitHub was reachable with the required network access using the explicit repository URL. Earlier connectivity failures no longer describe the verified remote state.
- Work in the active checkout. Any old ignored **`.local/publish/`** copy is temporary and is not shipped in the source repository; do not recreate that workaround unless needed.
- Keep private `config.json`, custom profiles under `.local/`, demo/test output, and footage out of commits. Run the public-file check on staged content before committing or pushing. Preserve remote history; do not force-push.

## Next work and exploration

- **Explicit current priority:** maintain this handoff as the project evolves so the user can resume without restating context.
- **Explicit product direction:** X5 downloads handled by a Windows PC into a chosen local folder, with future Windows Server compatibility and public-safe source.
- **Requested publication:** the application source is verified on the requested GitHub `main` branch. Keep this handoff with the published source and verify remote state after future pushes.
- **Suggested validation next, not a new user feature request:** extend the successful short physical X5 transfer to multi-page listings and interrupted-transfer resumption, and separately validate server scheduling when a server becomes available.
- **Completed explicit feature request:** polished local gallery, video viewer with rotation/pan/zoom, and director cuts recording live camera movements over a selected section or whole clip into a downloadable MP4. Restart an already-running launcher after updating so the new media API is loaded. FFmpeg and FFprobe must be on its PATH.
- **Known limits / possible future exploration, not additional user requests:** calibrated stitching and stabilization through an Insta360-supported workflow, long-clip performance/storage, persistent export management, and original-resolution rendering. The older viewer proposal is reference material, not the current implementation. No cloud deployment or network-setting automation was requested.
- **Completed request:** inspect the successful download in the chosen local destination. Connection and sample transfer checks passed as recorded above. Home-router discovery and automatic Windows network changes have not been requested.

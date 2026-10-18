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
- Keep both is the default and preserves camera originals. The user authorized explicit mirror/archive/space deletion policies. Never validate destructive modes on physical hardware or the user?s footage. Do not send format or capture commands.
- Keep the control page local to the collecting PC. Its loopback binding and request protections are part of the current access model.

## Current project state — 2026-10-18

A runnable Windows downloader, gallery, interactive viewer, and director cut editor are implemented using **Node.js 22.13+**, Node built-ins, and plain HTML/CSS/JavaScript. There are no npm dependencies. Media preparation and MP4 rendering require locally installed **FFmpeg and FFprobe** on PATH, including v360 and libx264; downloads work without them.

- `Start-Sync.cmd` and `scripts/Start-Sync.ps1` provide the Windows launcher, first-run folder selection, browser opening, and optional `-Once`/`-NoBrowser` operation.
- `server.mjs` provides the local control page and API at `http://127.0.0.1:8640` by default. Manual and automatic checks are supported. The user joins the X5 Wi-Fi in Windows; the app does not change network settings.
- `lib/sync.mjs` implements sequential OSC requests, paginated listing, streaming downloads, safe HTTP Range resumption, duplicate skipping, conflict preservation, destination locks, and persistent backup history.
- Original filenames and lens pairs are retained. Proxies are skipped by default in Keep both; deletion policies include companion proxies. Completed files receive a local SHA-256; the camera supplies no reference checksum.
- `public/` contains a responsive thumbnail gallery with search, filters, sorting, and pagination, separate Sync and unified Settings pages, and a full-window viewer. `viewer.js` uses WebGL for pan, tilt, roll, zoom, and fullscreen, plus accessible controls, keyboard shortcuts, pointer/pinch gestures, and mobile recording controls. Video textures refresh on actual decoded-frame callbacks, including initial load and seeking.
- Director cuts support a selected section or whole clip, live camera-move recording, replay, local browser drafts, landscape/portrait/square output, 720p/1080p, cancellable MP4 rendering with audio, and a Save As picker (ordinary browser download fallback). Export status survives closing the viewer, but the export list is page-session state; reloading clears it. Ranges are capped at six hours.
- `lib/policy.mjs` implements keep, mirror deletions, PC archive, and oldest-backed-up cleanup near full. Mirror baselines/grace/two checks prevent historical absence from becoming deletion; PC mirror removals have persistent local recovery and verified restore. Archive/space rehash all local companions. Stable counts/inventories, camera identity, storage readiness, transfer success, age protection, disk reserve and per-pass caps gate cleanup. Settings includes a read-only unsaved-policy preview. Physical-camera deletion remains unverified.
- `lib/media.mjs` queues local FFmpeg processing, prepares thumbnails/H.264 previews, validates camera paths, renders MP4 exports, and serves protected derived assets with HTTP Range seeking. `public/view-path.js` shares interpolation and camera math with the renderer. Runtime commands set absolute rotation and both horizontal/vertical field of view so zoom preserves the frame shape.
- `lib/stitch.mjs` reads bounded INSV metadata and supports X5 V3/V6 calibration, unequal intrinsics, distortion, module rotations, reversed tracks, sensor crop and supported bare/guard profiles. Unsupported current optics never fall back to older offsets. See `THIRD_PARTY_NOTICES.md` and the Apache license for the projection reference.
- `lib/seam.mjs` matches textured overlap patches at 10 fps and generates smoothed symmetric displacements capped at ten final panorama pixels. Playback/exports share alignment; thumbnails use static geometry. Nearby/occluded objects and fast motion can still show artifacts. This is not Insta360's proprietary stitching, FlowState or horizon leveling. Panoramas remain 2880 x 1440; exports do not recover 8K detail.
- Media cache generation is 6. Restart and reopen footage to rebuild previews. Originals/old exports are preserved; saved paths may need reframing. Analysis adds first-preparation time. Preview duration is limited because static map inputs loop.
- Private derived thumbnails, previews, take paths, and exports live under ignored `.local/media/`, outside the original destination. Never commit them or QA screenshots. Originals remain untouched. Cache cleanup is manual while stopped, after saving wanted exports elsewhere; assets regenerate on demand.
- `Start-Demo.cmd` and `lib/mock-camera.mjs` provide a simulated camera with synthetic transfer fixtures. Demo media is not playable footage.
- `scripts/Install-StartupTask.ps1` and `scripts/Remove-StartupTask.ps1` support optional sign-in or server boot scheduling. No startup task was installed during agent validation.
- `.gitignore`, `scripts/check-public.mjs`, and `SECURITY.md` protect publication. The public-file check scans Git-visible working files and staged blobs, including private files that were already tracked. It does not inspect older history or guarantee detection of every secret.
- `insta360-self-hosted.md` contains older Raspberry Pi reference code and a viewer proposal. It is not the Windows implementation. The Windows policies are implemented separately with their own checks.

### Last verified checks

- **50 automated tests passed on 2026-10-18, zero skipped**, with FFmpeg on Windows. These cover transfers, local API, launcher, publication, media confinement, cancellation, exports, and simulated deletion policies. Policy cases include changed bytes with matching mtime, unstable/missing inventory counts, refusal/partial camera deletion, missing folders, recovery conflicts/links, grace, retention, caps and disk reserve. Settings browser checks verified preview, acknowledgment, save, mock sync, no duplicate IDs, and no horizontal overflow at 390px; browser errors were absent. Calibration tests cover malformed metadata, reversed tracks, unequal lenses and guards/crop. An independent separated-camera fixture reduced mean seam RGB error from 6.95 to 5.25 (24%); patch tests cover wraparound, rejection and bounded maps. Six FFmpeg tests skip without tools; use a tool-equipped run for media changes.
- Rerun the public-file check after edits and staging, plus JavaScript syntax and Git whitespace checks. Do not assume the source-file count stays fixed.
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
- The required downloader/documentation checkpoint was pushed to `main` and verified **before any gallery/viewer implementation**. The completed gallery/viewer feature was then committed and pushed on 2026-10-18; GitHub's `refs/heads/main` matched the local feature commit. The final handoff update belongs with the published source; verify subsequent pushes the same way.
- GitHub was reachable with the required network access using the explicit repository URL. Earlier connectivity failures no longer describe the verified remote state.
- Work in the active checkout. Any old ignored **`.local/publish/`** copy is temporary and is not shipped in the source repository; do not recreate that workaround unless needed.
- Keep private `config.json`, custom profiles under `.local/`, demo/test output, and footage out of commits. Run the public-file check on staged content before committing or pushing. Preserve remote history; do not force-push.

## Next work and exploration

- [ ] **Explicit user TODO:** add an optional camera-smoothing setting for Director Cut panning. Mouse-driven panning on PC currently looks choppy; let users enable smoothing for smoother camera movement in recorded cuts. This request is to record the TODO; implementation remains pending.
- **Explicit current priority:** maintain this handoff as the project evolves so the user can resume without restating context.
- **Explicit product direction:** X5 downloads handled by a Windows PC into a chosen local folder, with future Windows Server compatibility and public-safe source.
- **Requested publication:** the application source is verified on the requested GitHub `main` branch. Keep this handoff with the published source and verify remote state after future pushes.
- **Suggested validation next, not a new user feature request:** extend the successful short physical X5 transfer to multi-page listings and interrupted-transfer resumption, and separately validate server scheduling when a server becomes available.
- **Completed explicit feature request:** polished local gallery, video viewer with rotation/pan/zoom, and director cuts recording live camera movements over a selected section or whole clip into a downloadable MP4. Restart an already-running launcher after updating so the new media API is loaded. FFmpeg and FFprobe must be on its PATH.
- **Stitch refinement:** the user confirmed guard/crop correction was significantly better, then requested further tweaking. Overlap alignment further reduces the fan seam in checked frames at 0, 5 and 10 seconds and an actual 1.5-second square H.264/AAC export that fully decoded. Browser console checks were clean. A blurred reflection is already within one original physical lens. Final alignment awaits the user's comparison.
- **Completed implementation:** unified Settings with keep-both, mirror deletions, PC archive, capacity cleanup, recovery, preview, scheduling, reserve, verification and connection controls. Deletion validation was simulated only. The user requested a separate publication checkpoint before the next GUI work.
- **Explicit next priority:** after publishing settings, research UI practices and overhaul the GUI: remove slogans and decorative microcopy, use useful headings/status and readable controls, and add a lens-guard correction on/off switch using recorded optics profiles. Publish the finished work to main.
- **Publication checkpoints:** stitching was pushed and remote verified before settings implementation. Verify the settings checkpoint and subsequent GUI publication against remote main.
- **Known limits / possible future exploration, not additional user requests:** vendor-quality optical-flow stitching and stabilization through an Insta360-supported workflow, long-clip performance/storage, persistent export management, and original-resolution rendering. The older viewer proposal is reference material, not the current implementation. No cloud deployment or network-setting automation was requested.
- **Completed request:** inspect the successful download in the chosen local destination. Connection and sample transfer checks passed as recorded above. Home-router discovery and automatic Windows network changes have not been requested.

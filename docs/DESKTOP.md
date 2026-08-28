# Rasterform Desktop

This document is the architecture, quality, security, and release contract for the macOS Electron edition of Rasterform. The browser app remains a first-class product: the normal Vite build and its behavior must continue to work without Electron, and desktop-only capabilities must sit behind a narrow optional bridge.

Living Form is shared visible-editor code, not a desktop fork. The macOS and web editions use the same deterministic motion evaluator, controls, High 2× frame renderer, PNG validation, lossless ZIP/ZIP64 manifest, cancellation path, capacity projection, and private temporary-file streaming when Chromium origin storage is available. Abandoned Rasterform loop archives older than 24 hours are scavenged at startup or before the next export. The desktop bridge adds only a separately versioned, metadata-only long-export lifecycle: it prevents app suspension and Chromium background throttling while rendering, warns before a protected window closes, and keeps that protection until Electron's matching `DownloadItem` reports the ZIP fully written. Frame and archive bytes never cross this IPC boundary. Living Loop is a separate, explicitly labeled High 2× output; it never substitutes for, lowers, or changes the still-image Final contract below.

## Supported platform

The initial desktop runtime is pinned to **Electron 43.3.0** and targets **macOS 12 Monterey or later**. The primary downloadable application is the native Apple-silicon (`arm64`) build. Intel (`x64`) remains a separately labeled legacy compatibility artifact for actual Intel Macs; a universal build is available only as an explicit migration/testing artifact. Keeping the primary Apple-silicon application arm64-only prevents it from being mistaken for an Intel/Rosetta application now or by future macOS releases.

Electron follows an approximately eight-week major-release cadence and officially supports only its latest three stable majors. Electron 43 is scheduled to reach end of life on **January 5, 2027**. Electron 44 removes macOS 12 support and therefore requires **macOS 13 Ventura or later**. See Electron's [release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [release schedule](https://releases.electronjs.org/schedule), and [breaking-change notice](https://www.electronjs.org/docs/latest/breaking-changes).

Our platform policy is:

- Stay on the newest verified Electron 43.x patch while Monterey remains a supported target and Electron 43 remains upstream-supported. Patch upgrades still require every gate in this document.
- Move the main desktop release to Electron 44 or newer once macOS 13 is an acceptable minimum. That change must update the package metadata, this document, the release notes, and the tested support matrix together.
- Preserve the last signed and notarized Electron 43 native-architecture release artifacts as the **legacy Monterey release**. After Electron 43 reaches end of life they receive no promise of new features, compatibility fixes, or security updates. Do not hold the current release on an unsupported Electron solely to retain Monterey.
- Never silently raise the minimum macOS version. Treat it as a user-facing release decision.

## Process architecture

Rasterform Desktop uses three trust and responsibility boundaries:

1. The visible, sandboxed `BrowserWindow` runs the same Vue studio as the web app. It owns interaction, camera framing, model editing, export controls, progress display, and cancellation UI. It has no Node.js access.
2. The Electron main process owns window lifecycle, the native Save dialog, validated IPC routing, power-suspension protection, crash recovery, and filesystem writes. It never performs path tracing on its event loop.
3. A second, always-hidden, sandboxed `BrowserWindow` owns Final rendering. It loads a small render-only entry point, reconstructs a snapshot of the mesh, camera, appearance, background, and HDR environment, and calls the shared Final exporter. It is created with `show: false` and `backgroundThrottling: false` and must have a different renderer-process PID from the visible window.

The hidden renderer is a `BrowserWindow`, not a Web Worker and not Electron's offscreen-rendering mode. This distinction is important: `three-mesh-bvh` may create its normal module worker directly from the hidden renderer without creating the nested-worker topology that previously left Final preparation hanging. The hidden window's bounds are small and never determine export resolution; Final continues to render bounded 1,024-pixel tiles into its internal canvases. Starting Final must not resize the visible window, viewport, or WebGL canvas.

Both renderers use `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Preloads expose individual typed methods, never raw `ipcRenderer`. Every request, progress event, cancellation, result, and error carries a unique `jobId`. The main process validates the message shape, sender `webContents`, active job, dimensions, and typed-array lengths before forwarding it.

Cycles Pro and Blender project preparation add optional desktop-only execution boundaries through newly spawned Blender command-line processes. Neither is part of the browser build and neither replaces the hidden Final renderer. The visible renderer can access each only through a separately versioned, validated preload bridge; when a bridge or compatible Blender installation is absent, the web application, High/Final paths, and Exact GLB continue normally.

The packaged Electron executable is hardened after ASAR creation and before any future release signing. `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`, Node CLI inspection, and legacy elevated `file://` privileges are disabled. Embedded ASAR integrity validation and `OnlyLoadAppFromAsar` are enabled together. Every current V1 fuse is configured explicitly with `strictlyRequireAllFuses`, so an Electron upgrade fails packaging instead of inheriting a newly introduced fuse. The app uses its restricted `rasterform:` protocol, not `file://`.

The regular browser path remains available when the desktop bridge is absent. Electron main/preload code must never be imported into the web bundle.

## Non-negotiable Final quality

Desktop Final calls the same implementation in [`src/lib/final-image-export.ts`](../src/lib/final-image-export.ts). There is no desktop copy of the renderer and no desktop-specific sample target. An IPC caller cannot supply or lower the sample count.

The quality invariant is:

- 6,144 samples per output tile for original color, height color, and matte clay.
- 8,192 samples per output tile for specular (glossy or metallic) clay. This fourfold production budget is intentional: a native 2K render must be clean without depending on 4K downsampling to hide noise.
- Four path-tracing bounces and two transmissive bounces.
- Multiple importance sampling enabled.
- Glossy filtering factor `0.75`.
- Path-tracer work split into a 3 × 3 schedule, with `renderScale = 1`, `dynamicLowRes = false`, and no rasterized-scene fallback.
- Output tiles no larger than 1,024 pixels, with the existing eight-pixel denoise overlap.
- Denoising remains `{ sigma: 2.5, kSigma: 1.5, threshold: 0.055 }`.
- PNG output preserves the requested 2K or 4K dimensions, transparency or selected flat studio background, RGBA content, and 300 PPI metadata.

Progress scheduling, process isolation, direct-to-disk saving, and a long runtime are allowed. Reducing samples, bounces, resolution, denoising, material behavior, or lighting to satisfy an arbitrary time limit is not allowed. Elapsed time is diagnostic data, not a pass/fail quality criterion.

## Optional Cycles Pro renderer

Cycles Pro requires a separately installed **Blender 5.2 LTS or newer**. Blender is deliberately not bundled in Rasterform. The desktop app probes the Blender executable in Applications (and supported command-line installation locations), verifies the version, and selects Metal when a compatible device is available or CPU otherwise. Pro is a desktop-only still renderer; the shared web application does not depend on Blender and retains every existing render and export option.

Each Pro job launches a new Blender process with `--background`, `--factory-startup`, and `--disable-autoexec`, unique private configuration/data/temp directories, a validated render manifest, and a bundled scene-construction script. It never connects to Blender's UI process, reads or writes its current `.blend`, saves that project, or closes it. A user may therefore keep an unrelated Blender project open while Rasterform renders. Both processes still compete for the same physical GPU, unified memory, CPU, and thermal budget, so simultaneous heavy work can slow either application or create memory pressure.

The production preset uses adaptive Cycles with an 8,192-sample maximum, a 512-sample minimum, a `0.001` noise threshold, 12 light bounces, and Blender's High-quality OpenImageDenoise pass guided by albedo and normals. Rasterform does not create a floor plane or grid. A Pro render produces a display-ready AgX RGBA PNG and a matching PIZ-compressed multipart EXR. Combined and Diffuse Color use 16-bit half-float color channels; Normal and the other data, noisy, and denoising-guide passes retain their appropriate data precision. Do not describe the whole EXR as half-float.

Blender writes both files only inside the job's private directory. The Electron main process accepts success only after validating the requested dimensions, RGBA PNG, multipart EXR structure, required pass channels, and terminal renderer metadata. It then commits the PNG and EXR as one recoverable pair; cancellation or validation failure removes private output and preserves existing destinations. Cancellation signals only the exact child process owned by that job and never searches for or terminates another Blender process. There is no render-duration timeout and no timeout-driven reduction in samples, bounces, output resolution, passes, or denoising.

## Blender project export

Exact GLB remains the shared browser/desktop, triangle-based interchange format. The optional `.blend` path exists because Blender projects can preserve editable quads and project-specific UV/shading state that GLB cannot represent. Its independent V1 contract snapshots the visible model, baked Living Form phase, material mode, appearance, and one explicit topology choice: Exact, Balanced, or Lightweight. Wireframe is excluded because it is a display primitive rather than an editable surface.

Each job uses a private manifest, typed-array mesh files, private Blender configuration/home/temp directories, `--background --factory-startup --disable-autoexec`, and the bundled `cycles/export_blend.py`. Exact preserves source triangles and UVs. Optimized image reliefs are recognized by their full row-major index contract and rebuilt deterministically as lower-density quad grids; an error-aware height envelope retains narrow peaks and grooves between target samples. Other meshes use fixed-seed QuadriFlow with sharp edges, boundaries, and point colors preserved. Optimized outputs receive a padded Smart Project `UVMap` and smooth-by-angle shading. The project contains exactly one mesh and no camera, light, floor, grid, or plane; saved viewport grid overlays are disabled.

Blender first saves a compressed `.blend` only inside the private job, reopens it with scripts disabled, and reports its byte length and SHA-256 only after the scene and UV map survive that reopen. Electron verifies those values before and after same-directory staging, then uses one POSIX rename to atomically replace a regular selected destination without a missing-file crash window. Cancellation signals only that job's exact child. There is no optimization-duration timeout and no silent fallback to a different topology mode. An already-open Blender project remains untouched; simultaneous Blender work may still share CPU and memory.

## Desktop protocol and security

Packaged windows load only local application resources through the privileged `rasterform:` scheme. Register the scheme before `app.ready` as standard and secure with Fetch API support, then install its handler after readiness. The handler has two fixed, isolated hosts: `rasterform://app/` for the visible studio and `rasterform://render/` for the hidden Final host.

The protocol handler must:

- Accept only the expected scheme, the exact `app` or `render` host, and read-only resource requests.
- Decode and normalize paths once, reject NUL bytes and traversal, resolve the target, and verify that it remains inside the packaged renderer directory.
- Return correct MIME types for HTML, JavaScript module and worker chunks, CSS, SVG, PNG, and HDR files.
- Serve the visible entry, hidden-render entry, Vite dynamic chunks, `three-mesh-bvh` worker chunks, and `public/hdri/studio_small_08_1k.hdr` from the packaged ASAR.
- Return a real not-found response instead of falling back to arbitrary files.

Production Content Security Policy should default to local self-owned resources. Module workers must be allowed from the application origin; development-only localhost allowances must never ship. Deny unrequested navigation, new windows, permissions, and downloads. Open an external URL only through a narrowly validated main-process action.

The browser stylesheet may request the project’s Typekit and Google-hosted faces, but desktop staging deliberately removes only those two exact `@import` rules from its copied CSS. No remote font URL ships in `.stage/web` or the ASAR, CSP stays local-only, and the browser `dist` output is not modified. Electron uses the stylesheet’s existing Helvetica/system UI and SFMono/Consolas monospace fallback stacks; proprietary Adobe font files are neither copied nor redistributed.

IPC follows the same least-privilege rule. Structured-clone messages contain primitives and copied typed arrays, never Three.js instances, DOM objects, functions, `AbortSignal`, arbitrary filesystem paths, or Electron objects. The visible renderer may request a save operation, but only the main process may show a dialog or choose a destination.

## Progress, cancellation, crashes, and saving

Final progress is relayed from the hidden renderer through the main process to the visible studio. The visible progress bar reports the existing `preparing`, `rendering`, and `finishing` phases and maps those phase-local values into one monotonic overall bar. The per-tile sample counter may reset at a tile boundary. Events from stale or cancelled job IDs are ignored.

Cancellation follows this sequence:

1. The visible studio immediately enters a cancelling state and asks the main process to cancel the active job.
2. The main process forwards cancellation to the hidden renderer's `AbortController`.
3. Normal cancellation occurs at the shared exporter's existing cooperative checkpoints and releases renderer, path-tracer, BVH-worker, canvas, and power-blocker resources.
4. Synchronous GPU shader compilation cannot always observe IPC immediately. If the hidden renderer does not acknowledge cancellation within the documented grace period, the main process destroys that hidden `BrowserWindow`, treats the job as cancelled, and creates a clean renderer for the next request. The visible studio is never destroyed.

If the hidden renderer exits, crashes, loses its WebGL context, or returns an invalid result, the main process rejects that job, stops `powerSaveBlocker('prevent-app-suspension')`, removes temporary output, and reports an actionable error. Chromium may label a legitimate long shader compile as unresponsive, so that event alone never imposes a timeout or reduces quality; Cancel still destroys the isolated window after its grace period. A late result can never save after cancellation or replace the result of a newer job.

The asynchronous native Save dialog is attached to the visible window and resolves before rendering begins. Cancelling the dialog starts no job. The chosen destination is held only by the main process. No destination file is modified until Final has completed and the PNG contract has been validated. Saving writes a uniquely named temporary sibling, flushes and closes it, then atomically renames it into place. Cancellation or failure removes only that temporary file and preserves any existing destination. A success message is emitted only after the final rename succeeds.

For long work, the main process starts `prevent-app-suspension`, which allows the display to sleep but prevents macOS from suspending the render. It must stop the blocker on every terminal path.

## Shared-GPU limitation

Separate renderer processes keep Final's JavaScript, BVH preparation, and synchronous shader compilation out of the visible renderer, so controls, progress, cancellation, and window management remain responsive. Chromium still shares a GPU process and the physical GPU across windows. A full-quality render can therefore lower preview frame rate or increase GPU pressure. Process isolation is not a promise that the preview will maintain its idle frame rate, and the app must report context loss honestly rather than silently switching to a lower-quality renderer.

## Reproducible build and release

The npm lockfile is part of the release input and must be committed. CI and release machines use `npm ci`, never an unconstrained install. Electron and packaging dependencies are pinned exactly; upgrades update both `package.json` and `package-lock.json` in the same reviewed change.

From a clean checkout of the exact release commit:

```bash
npm ci
npm --prefix electron ci
npm test
npm run build
npm run desktop:check
npm run desktop:test
npm run desktop:build
npm run desktop:smoke
```

The implemented architecture packages are ad-hoc signed for local development integrity only; they are not Developer ID-signed or notarized:

```bash
npm run desktop:package
npm run desktop:package:arm64
npm run desktop:package:lab:arm64
npm run desktop:package:x64
npm run desktop:package:universal
```

The unqualified command detects the physical build host's native architecture. On an Apple-silicon Mac it creates an arm64-only application—even when invoked from an x64 Node process under Rosetta; on an Intel Mac it creates an x64-only application. Cross-architecture and universal packaging must always be requested explicitly.

The Pro renderer candidate is packaged as a separate native Apple-silicon application:

```text
electron/out-lab/Rasterform Renderer Lab-darwin-arm64/Rasterform Renderer Lab.app
```

It uses bundle ID `io.atil.rasterform.rendererlab` and installs as `/Applications/Rasterform Renderer Lab.app`. It must remain separate from the known-good stable checkpoint at `/Applications/Rasterform.app`. Build and exercise the actual packaged Lab app with:

```bash
npm run desktop:smoke:packaged:lab:arm64
```

Each package command verifies the restrictive App Transport Security dictionary (`NSAllowsArbitraryLoads` is false), graphics-design category, custom Rasterform icon, absence of irrelevant camera/microphone/Bluetooth usage declarations, embedded ASAR hash, and the read-back value of every Electron fuse. It also derives the required architecture set from the requested artifact (`arm64`, `x64`, or `universal`), checks the main executable against that label, discovers every nested Mach-O file by header, and requires the same architecture set and macOS 12.0 deployment target on every slice. A strict deep `codesign` verification proves that the package’s ad-hoc development seal remains internally consistent after fuse mutation. That check does **not** authenticate a Developer ID identity and does **not** assess Gatekeeper or notarization. The standard packaged gate is self-contained: it rebuilds the host-native package, then launches the actual packaged ASAR—not the staging directory—with:

```bash
npm run desktop:smoke:packaged
```

Architecture-specific, self-contained packaged smoke commands are also available as `desktop:smoke:packaged:arm64` and `desktop:smoke:packaged:x64`, but they must run on matching physical hardware. The smoke launcher consults macOS hardware/translation state and rejects an x64 package on an arm64 host (and vice versa) instead of invoking Rosetta, including when the launcher itself is running under Rosetta. Maintainers who intentionally want to re-run an already-built package can use the Electron-local `smoke:packaged:existing:{arm64,x64,universal}` helpers; the same native-host guard applies. The smoke switch is a narrow self-test environment marker: it does not enable DevTools, the Node inspector, or a remote-debugging port, and it exits when the internal protocol/process-isolation probe completes. The harness strips `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and `NODE_EXTRA_CA_CERTS`; packaged executables also ignore those variables at the fuse layer.

The runtime probe requires more than loading the generated worker URL: it sends an indexed one-triangle geometry to the bundled BVH module worker and accepts only a completed serialized BVH response. Process isolation still requires distinct visible/hidden renderer PIDs, a hidden window, unchanged editor bounds, and a measured 1,000-millisecond busy loop in the hidden renderer. Visible-renderer interval timestamps count only when they fall inside that hidden block’s wall-clock interval. Two such beats are sufficient proof of independent scheduling, and startup variance gets at most three bounded attempts; ticks before or after the block do not count.

The committed `electron/assets/Rasterform.icns` is generated directly from `public/favicon.svg` and includes standard and Retina PNG-backed ICNS entries through 1,024 pixels. It is not an Electron placeholder or an AI-generated redesign. Regeneration is an explicit maintainer action and requires the `rsvg-convert` executable from librsvg:

```bash
npm --prefix electron run icon:generate
```

These outputs are development packages, not distributable releases. Once signing credentials are configured, add a single release orchestrator so Developer ID signing, notarization, stapling, and verification cannot be accidentally reordered. The intended command contract is:

```bash
npm run desktop:release:mac
```

That future `desktop:release:mac` command must start from clean generated-output directories, rebuild instead of reusing an old `dist`, produce separately labeled arm64 and x64 artifacts (plus a universal artifact only if deliberately retained), sign them with hardened runtime, submit them for notarization, staple the accepted tickets, and run the verification gates below on matching hardware. Record the source commit, lockfile hash, Electron/Chromium/Node versions, build host version, artifact SHA-256, and verification result alongside each release. Do not add or advertise that command until it is exercised with real Apple credentials.

## Signing and notarization credentials

Direct distribution outside the Mac App Store requires membership in the Apple Developer Program and these private inputs:

- A **Developer ID Application** certificate and its private key, installed in the release keychain or supplied to the packaging tool as an encrypted `.p12`/base64 credential plus its password.
- A stable Apple Team ID and bundle identifier.
- Notarization credentials. Prefer an App Store Connect API key: issuer ID, key ID, and private `.p8` key. The supported alternative is an Apple ID, an app-specific password, and the Team ID.
- A CI keychain password when CI creates a temporary signing keychain.

Never commit certificates, private keys, passwords, or notarization tokens. Release CI should load them from its encrypted secret store, create a temporary keychain with the narrowest useful lifetime, and delete that keychain after the job. The application uses hardened runtime and only the entitlements it demonstrably needs; it must not disable library validation or the renderer sandbox as a packaging shortcut.

The final artifact must pass all of these on macOS:

```bash
codesign --verify --deep --strict --verbose=2 "/path/to/Rasterform.app"
spctl --assess --type execute --verbose=2 "/path/to/Rasterform.app"
xcrun stapler validate "/path/to/Rasterform.app"
```

Mac App Store distribution is a separate product decision. It requires the MAS Electron build, App Sandbox entitlements, provisioning, and security-scoped save permissions; a Developer ID build must not be relabeled as MAS-compatible without a dedicated implementation and test pass.

## Verification gates

A desktop change is not complete until evidence covers every applicable gate:

1. **Web parity:** all existing unit/integration tests pass, the normal Vite production build succeeds, and a browser smoke test with no desktop bridge proves the studio and existing browser exports still work.
2. **Type and contract safety:** main, preload, visible renderer, and hidden renderer type-check independently. Runtime IPC validators reject malformed payloads, invalid buffer lengths, impossible dimensions, wrong senders, and stale job IDs.
3. **Quality audit:** automated tests assert the exact sample targets, bounces, MIS, render scale, tile schedule, denoiser settings, and absence of a raster fallback. The desktop request has no caller-controlled sample field.
4. **Process isolation:** a runtime test verifies different visible/hidden `webContents` IDs and OS PIDs, unchanged visible-window bounds, hidden-window invisibility, an actual BVH worker result, and visible-renderer heartbeat timestamps inside a measured 1,000-millisecond hidden-renderer block. Startup scheduling may trigger at most three bounded attempts.
5. **Progress and cancellation:** tests cover monotonic overall progress, accessible UI updates, cancellation during preparation and accumulation, forced teardown during an uninterruptible compile, stale-result rejection, resource cleanup, and a successful job immediately after cancellation.
6. **Native saving:** tests cover dialog cancellation, byte-identical main-process writes, extension sanitization, permission errors, atomic replacement, preservation of an existing destination on failure, and removal of temporary files.
7. **Packed resources:** smoke the packaged ASAR, not only the development server. Both entries, HDR, dynamic imports, and the generated BVH module worker must load through `rasterform://app/` with correct MIME types. Traversal and unknown-host tests must fail closed.
8. **Architecture:** derive the expected set from the artifact label, then recursively enumerate every packaged Mach-O file, including the main executable, Electron Framework, Helpers, nested frameworks, dynamic libraries, crash handler, and updater tools. Every file must report the exact `lipo -archs` set and one macOS 12.0 `LC_BUILD_VERSION` deployment target per slice. The universal application must report both `x86_64` and `arm64`. Launch architecture-specific packages on matching Intel and Apple-silicon machines or CI runners.
9. **Distribution:** verify the Developer ID identity, hardened runtime, Gatekeeper assessment, notarization, and stapling. Passing the ad-hoc integrity smoke does not make a package distributable.
10. **Real full-quality Final:** the packaged, signed candidate renders the bundled deterministic scene at 2,048 × 1,536 using glossy clay and the real 8,192-sample path. It must run in the hidden PID while the visible studio remains interactive, report real progress, save through the native path, and produce a decodable 300-PPI RGBA PNG with expected transparency and nonempty image content. Do not impose a wall-clock failure threshold; record elapsed time but never reduce quality to satisfy an invented deadline.
11. **Cycles Pro:** on real Apple-silicon hardware with Blender 5.2 LTS or newer, the separately packaged Lab app must pass its Blender compatibility probe and complete an isolated render while another Blender project remains untouched. Validate the full-resolution PNG and multipart EXR, including 16-bit Combined/Diffuse Color channels and required normal/data/guide passes; prove cancellation addresses only the owned child process and prove paired-save rollback preserves existing files.
12. **Blender project export:** real Blender 5.2 tests must reopen Exact, structured-grid, and freeform/QuadriFlow `.blend` outputs; verify one mesh only, topology reduction, quad dominance, UV bounds/loop count, color/material presence, disabled grid overlays, no camera/light/floor, strict path containment, atomic destination preservation, and exact-child cancellation.

Pixel hashes are not a portable quality gate because GPU output can vary slightly. Validate structure, metadata, content, sample count, and the configured renderer instead.

## Restore and upgrade checklist

Use this checklist for a damaged development environment, a dependency refresh, or an Electron major upgrade:

1. Preserve user work. Inspect `git status`; do not reset or discard unrelated changes.
2. For the known-good state immediately before the Pro experiment, create a new branch from `checkpoint/pre-pro-renderer-2026-08-26` rather than copying generated files from an old machine. Keep `/Applications/Rasterform.app` as the stable checkpoint; build and install Pro experiments only as `/Applications/Rasterform Renderer Lab.app`.
3. Confirm the expected Node version, exact Electron pin, committed lockfile, and clean release checkout. Run `npm ci`.
4. Run the web tests and browser build first. A desktop repair may not regress the web app.
5. Run `desktop:check`, `desktop:test`, `desktop:build`, and `desktop:smoke`.
6. Confirm the custom protocol serves both HTML entries, HDR, every dynamic chunk, and the BVH worker from the ASAR. Check production CSP and preload injection.
7. Confirm Final still imports the shared exporter and compare every value in the quality invariant above. Search explicitly for new sample overrides, raster fallbacks, timeout-driven quality changes, or duplicate Final implementations.
8. Test progress, normal cancellation, forced renderer teardown, render-process crash recovery, atomic save failure, and a second successful job.
9. Run the real full-quality Final gate. Keep its PNG and diagnostic manifest as release evidence.
10. Package arm64 and x64, construct the universal application, inspect every Mach-O architecture, and launch on both architectures.
11. Sign, notarize, staple, verify, and hash the release candidate. Never reuse a previously signed bundle after changing its contents.
12. For an Electron upgrade, read the target release notes and breaking changes, confirm its macOS minimum and support/EOL dates, update the exact dependency and lockfile, then repeat every gate. Pay special attention to protocol privileges, sandbox/preload module rules, worker URLs, IPC structured-clone behavior, Chromium WebGL changes, and signing requirements.
13. If the minimum macOS version changes, update metadata, documentation, CI runners, download labeling, and release notes in the same change. Preserve the last verified Monterey build under the legacy policy instead of weakening the current runtime.

No generated `dist`, package, signature, or prior test result is authoritative after source, dependency, Electron, Xcode, entitlement, or packaging configuration changes. Rebuild and reverify from the committed inputs.

# Installing and running Rasterform on macOS

You can use the downloadable app without installing developer tools or building the source.

## Download and try it

1. [Download Rasterform for Apple silicon Macs](https://github.com/lolusername/rasterform/releases/download/v1.0.0-preview.20261011/Rasterform-macOS-arm64.zip).
2. Double-click the ZIP to extract **Rasterform.app**.
3. Double-click the app to try it from that folder. To install it, drag the complete **Rasterform.app** bundle into **Applications**, then open it there.

The download is for **Apple silicon Macs (M1 or newer), macOS 12 Monterey or later**. It includes the Electron runtime; Node.js, npm, and the repository are not needed to run it. This release does not include Intel, Windows, or Linux binaries. [Release notes](https://github.com/lolusername/rasterform/releases/tag/v1.0.0-preview.20261011) list the tested platform and build details.

You can also keep the app in `~/Applications` for your user account only. A `.app` is a bundle that Finder displays as one item; move or copy the whole bundle.

## First launch of the preview

This preview is ad-hoc signed for integrity, but is not Developer ID-signed or notarized by Apple. macOS may block a downloaded copy on first launch.

After trying to open it, if you trust the download from this repository:

1. Open **System Settings → Privacy & Security**.
2. Find the Rasterform message and click **Open Anyway**, then authenticate if prompted.
3. Confirm **Open** in the following dialog.

See [Apple's first-launch instructions](https://support.apple.com/en-us/102445). Do not globally disable Gatekeeper. If macOS reports that the app is damaged, download a fresh copy and check its checksum rather than removing security attributes.

For an optional integrity check, download `SHA256SUMS.txt` from the same release into the folder containing the ZIP, then run:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The checksum detects changes to the archive; it does not supply Apple notarization or a Developer ID identity.

## Optional Blender installation

Rasterform's editing, High/Final PNG renders, Living Loop exports, GLB, STL, and complete project files work without Blender.

**Cycles Pro** and **Blender project (.blend)** export require **Blender 5.2 LTS or newer, minimum 5.2.0**. Blender is not included in the Rasterform ZIP.

1. Download the Apple silicon build from the [official Blender 5.2 LTS release page](https://www.blender.org/releases/5-2/).
2. Open Blender's disk image and drag **Blender.app** into **Applications**.
3. In Rasterform, use the Blender readiness recheck if it was already running when you installed Blender.

Rasterform probes the version before running a job. It also recognizes supported version-named Blender apps in Applications and common Homebrew command-line locations.

Each job uses a new background Blender process and private temporary files. It does not attach to an already-open Blender window or change that window's project. Concurrent heavy rendering shares GPU, memory, and CPU resources.

## Save work and update the app

Use **Save project** to save a complete `.rasterform` design. Local session recovery can help after a reload, but a project file is the portable copy of your work. Keep exports in your chosen folders.

To update:

1. Save your current project and quit Rasterform with **Command–Q**.
2. Download and unzip the newer preview.
3. Drag **Rasterform.app** into **Applications** and choose **Replace** if Finder asks.
4. Open the replacement app.

This preview does not auto-update. Replacing the bundle normally preserves local preferences and recovery; saved projects and exports remain in their selected folders.

## Build from source

On macOS, with **Node.js 22.12 or newer** installed:

```bash
git clone https://github.com/lolusername/rasterform.git
cd rasterform
npm ci
npm --prefix electron ci
npm run desktop:package:arm64
npm --prefix electron run smoke:packaged:existing:arm64
```

The Apple silicon app is created at:

```text
electron/out/Rasterform-darwin-arm64/Rasterform.app
```

The package command builds the web studio and native code, assembles Electron, hardens the package, and verifies its architecture and signature integrity. The smoke command then launches that packaged app for a short self-test and closes it. Neither command installs the app. Open the bundle from Finder or copy it into Applications yourself.

### Other development commands

| Command | Result |
| --- | --- |
| `npm run dev` | Runs the browser studio through Vite. |
| `npm run desktop:dev` | Builds and launches the development desktop app. |
| `npm run desktop:build` | Builds and stages native runtime files without packaging an app. |
| `npm run desktop:package:arm64` | Creates the Apple silicon `.app`. |
| `npm run desktop:package:x64` | Creates an Intel compatibility build; test on an actual Intel Mac. |
| `npm run desktop:package:universal` | Creates a larger bundle containing both architectures. |
| `npm run desktop:package:lab:arm64` | Creates a separate **Rasterform Renderer Lab.app** for experiments. |

The normal `desktop:package` command selects the physical Mac's native architecture. Intel and universal packages are explicit compatibility builds, not the tested downloadable preview.

Renderer Lab has the separate bundle ID `io.atil.rasterform.rendererlab` and is built at `electron/out-lab/Rasterform Renderer Lab-darwin-arm64/Rasterform Renderer Lab.app`. Keep its name and install it alongside Rasterform when needed. Do not rename it to `Rasterform.app` or merge the two bundles. The source tag `checkpoint/pre-pro-renderer-2026-08-26` preserves the earlier pre-Pro implementation for maintainers.

For renderer settings, process isolation, supported-platform policy, and the future Developer ID/notarization workflow, see [Rasterform Desktop](DESKTOP.md).

## Remove the app

Quit Rasterform, then move its `.app` bundle to the Trash. Keep any `.rasterform` projects and exports you want. Removing the app does not remove those files or its local recovery/preferences.

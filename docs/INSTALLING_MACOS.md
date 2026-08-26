# Installing and running Rasterform on macOS

This guide assumes no experience with Electron or macOS app development.

## Is Rasterform installed right now?

At the time this guide was written, **no**. Rasterform has been built and tested, but it is still inside the source-code project rather than the Mac's Applications folder.

The Apple-silicon build is here:

```text
electron/out/Rasterform-darwin-arm64/Rasterform.app
```

The app is considered installed for all users when this exists:

```text
/Applications/Rasterform.app
```

It can also be installed for only the current user in:

```text
~/Applications/Rasterform.app
```

Check at any time with:

```bash
if test -d /Applications/Rasterform.app; then
  echo "Rasterform is installed"
else
  echo "Rasterform is not installed"
fi
```

## Build the `.app` from source

Yes—Rasterform has an Electron packaging command that creates a real macOS `.app` bundle.

Open Terminal, move into the project, and run:

```bash
cd /Users/atiliobarreda/Desktop/software/personal/atil.io/portfolio-labs/rasterform
npm run desktop:package:arm64
```

That is the recommended command for this Apple-silicon Mac. It builds the shared web application, type-checks the desktop code, builds the hidden Final renderer, assembles Electron, applies the security hardening, verifies the package, and creates:

```text
electron/out/Rasterform-darwin-arm64/Rasterform.app
```

The packaging command **builds** the app but does not **install** it. After it finishes, copy the resulting `Rasterform.app` into `/Applications` using the Finder steps below.

### First build on a fresh checkout

Install the locked project dependencies once before packaging:

```bash
cd /Users/atiliobarreda/Desktop/software/personal/atil.io/portfolio-labs/rasterform
npm ci
npm --prefix electron ci
npm run desktop:package:arm64
```

Rasterform's desktop toolchain requires Node.js 22.12 or newer. Check with:

```bash
node --version
```

### What the similar commands do

| Command | Result |
| --- | --- |
| `npm run desktop:dev` | Builds and launches a temporary development app. It is for coding, not installation. |
| `npm run desktop:build` | Builds and stages the desktop files, but does not create a packaged `.app`. |
| `npm run desktop:package:arm64` | Creates the native Apple-silicon `.app`. Use this on this Mac. |
| `npm run desktop:package` | Detects the physical Mac architecture and packages its native version. On this Apple-silicon Mac it should also produce arm64. |
| `npm run desktop:package:x64` | Creates an Intel build for an actual Intel Mac. Do not use this as the normal build on an M-series Mac. |
| `npm run desktop:package:universal` | Creates a larger bundle containing both Intel and Apple-silicon slices. It is not needed for this Mac. |

To run the automated packaged-app check after building without rebuilding it again:

```bash
npm --prefix electron run smoke:packaged:existing:arm64
```

This launches the packaged app in a self-test mode and closes it automatically. It is a verification command, not the way to use Rasterform normally.

## What “installing” a Mac app means

Most Mac apps are `.app` bundles. A bundle looks like one file in Finder, but it is really a folder containing the program, icon, frameworks, and resources it needs.

For this kind of app, installation normally means copying the complete `.app` bundle into `Applications`. There is no separate setup wizard, registry, or `npm install` step. A packaged Electron app contains its own Electron/Chromium runtime; Node.js and the source code are needed to develop or rebuild it, but not to use the packaged app.

Rasterform can run from its build folder without being installed. Moving it to `Applications` simply puts it in the normal permanent location so Finder, Spotlight, Launchpad, and the Dock can find it easily.

## Install Rasterform with Finder — recommended

1. Open Finder.
2. Press **Command–Shift–G** to open **Go to Folder**.
3. Paste this path and press Return:

   ```text
   /Users/atiliobarreda/Desktop/software/personal/atil.io/portfolio-labs/rasterform/electron/out/Rasterform-darwin-arm64
   ```

4. A file named **Rasterform.app** will appear.
5. Open a second Finder window and choose **Applications** in the sidebar.
6. Drag **Rasterform.app** into **Applications**. macOS may ask for your password or Touch ID.
7. Open **Applications**, then double-click **Rasterform**.
8. Optional: while Rasterform is running, Control-click its Dock icon and choose **Options → Keep in Dock**.

The current primary build is native Apple silicon (`arm64`). It is the correct build for an M-series Mac and does not contain an Intel executable slice.

## Run it without installing it

Double-click `Rasterform.app` in the build folder, or run this from Terminal while the project directory is open:

```bash
open electron/out/Rasterform-darwin-arm64/Rasterform.app
```

Running from the build folder is useful for testing. Installing it in `Applications` is better for normal use.

## Install it from Terminal — optional

From the Rasterform project directory:

```bash
ditto electron/out/Rasterform-darwin-arm64/Rasterform.app /Applications/Rasterform.app
open /Applications/Rasterform.app
```

If an older Rasterform is already installed, quit it first and use Finder to replace the old app with the new one. Finder makes the replacement explicit and avoids accidentally merging two app bundles.

Once installed, either open Rasterform from Finder/Spotlight or use:

```bash
open -a Rasterform
```

## The first-launch security warning

This local development build is ad-hoc signed for integrity, but it is not yet signed with an Apple Developer ID or notarized by Apple. Because of that, Gatekeeper may show a warning the first time it opens.

For a build you created and trust:

1. Control-click **Rasterform.app** in Finder and choose **Open**.
2. Click **Open** in the confirmation dialog if macOS offers it.
3. If it is still blocked, open **System Settings → Privacy & Security**.
4. Find the message about Rasterform and choose **Open Anyway**, then authenticate.

Do not globally disable Gatekeeper. If macOS says an app is *damaged*, stop and rebuild or obtain a fresh copy instead of blindly removing security attributes. A normal public release should be Developer ID signed, notarized, and stapled so users do not need these development-build steps.

## Update Rasterform

This development build does not auto-update.

1. Quit Rasterform completely with **Rasterform → Quit Rasterform** or **Command–Q**.
2. Build or obtain the new `Rasterform.app`.
3. Drag it into **Applications**.
4. Choose **Replace** when Finder asks.
5. Launch Rasterform again.

Replacing the app does not normally erase its preferences or exported files. Exports remain wherever they were saved.

## Uninstall Rasterform

1. Quit Rasterform.
2. Open **Applications** in Finder.
3. Drag **Rasterform.app** to the Trash.
4. Empty the Trash whenever convenient.

That removes the application. To perform a complete reset, optional settings may also exist under:

```text
~/Library/Application Support/Rasterform
~/Library/Preferences/io.atil.rasterform.plist
~/Library/Caches/Rasterform
```

Those files are small. Leave them alone if you may reinstall and want Rasterform to remember its last export location.

## How Mac apps are commonly distributed

| Format | What to do |
| --- | --- |
| Mac App Store | Click **Get** or the price; macOS installs and updates it automatically. |
| `.dmg` disk image | Open the DMG, then drag the app onto the Applications shortcut shown inside it. Eject the DMG afterward. |
| `.zip` archive | Double-click to unzip it, then drag the resulting `.app` into Applications. |
| `.pkg` installer | Double-click it and follow the installer. PKGs are used when software needs files outside its app bundle. |
| Plain `.app` bundle | Drag the whole app into Applications, as with this Rasterform build. |

Only install software from a source you trust. Publicly distributed apps should normally be signed and notarized. Check that a download is intended for your Mac:

- **Apple silicon / arm64:** M1, M2, M3, M4, and later Apple chips.
- **Intel / x64:** older Intel-based Macs.
- **Universal:** contains both architectures and is larger.

To see which Mac you have, choose **Apple menu → About This Mac**. A line labeled **Chip** means Apple silicon; a line labeled **Processor** usually identifies an Intel Mac.

## Electron in plain language

Electron packages a web interface together with Chromium and a small native main process as a normal desktop app. Rasterform's Vue/Three.js studio is shared with the web edition, while Electron adds Mac-specific behavior such as native windows, Save dialogs, preventing sleep during long exports, Recent Documents, notifications, and a separate Final-render process.

You do not need to know Electron to run the packaged app. Treat `Rasterform.app` like any other Mac application.

For developers, the source app and the installed app are different things:

- `npm run dev` starts the browser development server.
- `npm run desktop:dev` builds and launches a temporary Electron development copy.
- `npm run desktop:package:arm64` creates the installable Apple-silicon `.app`.
- Copying that `.app` to Applications installs it.

The full desktop architecture, signing, security, and release checklist is in [DESKTOP.md](DESKTOP.md).

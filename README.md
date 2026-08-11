# Rasterform

**Turn color, light, and texture into dimensional form.**

Rasterform is a browser-based 3D form studio for artists and designers. Bring in a PNG, JPEG, or WebP and choose which parts should rise or recede, or switch to the separate Text workspace and turn an installed font into beveled, extruded geometry. Then shape, light, and export the result as a finished image or 3D object.

It is a focused **2.5D tool**: more tactile than an image editor, more immediate than building a displacement setup in Blender, and honest about what it creates. Rasterform interprets the image you can see; it does not invent hidden depth.

## A visual workflow

1. **Choose Image or Text** — derive height from brightness, hue, saturation, color channels, transparency, or edges; or type directly with an installed font.
2. **Compose the form** — layer image signals, tune text extrusion and bevels, or use Blob mode to dilate and round either source into organic forms.
3. **Find the material** — explore original color, height gradients, clay finishes, or wireframe structure.
4. **Light and export** — work quickly in the HDR studio preview, switch to a progressive Final Render, or continue in other tools.

Right-click the 3D viewport to choose a white, dark-gray, or black background, or use the `W`, `G`, and `B` shortcuts. The background is always a flat color—no floor or grid geometry is added to the viewport or image exports.

Opening Export swaps the right-hand inspector without resizing the screen-bounded viewport or visible WebGL canvas. High images use a dedicated background renderer when supported. Final keeps the full path-traced sample and denoising contract on the main thread, where its BVH worker is not nested inside another worker; it may pause the studio while it renders, but preserves the requested resolution, material, lighting, and background options.

The optional macOS desktop edition keeps that web behavior intact while moving Final into a separate hidden Electron renderer process. It uses the same quality owner and exact 1,536/2,048-sample contract, but the visible studio remains responsive and shows progress while the native shell prevents sleep and saves the completed PNG atomically.

Rasterform can export transparent 2K/4K/8K PNGs, height maps, reusable recipes, GLB geometry for Blender, and watertight STL files when the topology is ready to fabricate.

## Text workspace

Text generates automatically as you type. On supported desktop Chromium browsers, **Browse installed fonts** uses the permission-gated Local Font Access API to load the exact face you select. Other browsers passively verify a curated set of common installed faces and always retain a system-font default. Font bytes stay in memory for the current session and are never uploaded or written into recipes.

The resulting masks are contoured into closed, indexed meshes with counters preserved, then extruded and beveled. Tracking, line height, alignment, outline detail, extrusion, bevel width/depth/smoothness, material color, matte/glossy/metallic finish, and Blob dilation/smoothing are all editable. Text uses the same HDR viewport and full-quality High/Final, GLB, STL, and recipe export paths as image reliefs.

## Why channels matter

Every image contains several possible landscapes. Brightness might reveal volume; saturation can isolate intensity; hue can select a color family; edges can become ridges. Rasterform lets you combine these readings non-destructively, so creating form feels closer to art direction than mesh construction.

Processing stays in your browser—no account, upload, server, analytics, or remote inference.

## Run the app

```bash
npm install
npm run dev
```

To verify the project:

```bash
npm test
npm run build
```

## macOS desktop edition

The desktop toolchain is isolated under `electron/`; the normal `npm run dev` and `npm run build` commands remain the browser app. Desktop development requires Node 22.12 or newer.

```bash
npm ci
npm --prefix electron ci
npm run desktop:test
npm run desktop:build
npm run desktop:smoke
npm run desktop:dev
```

Ad-hoc-signed local development packages can be built for Apple silicon, Intel, or both architectures. They are not Developer ID-signed or notarized:

```bash
npm run desktop:package
npm run desktop:package:arm64
npm run desktop:package:x64
npm run desktop:package:universal
npm run desktop:smoke:packaged
```

The unqualified package and packaged-smoke commands build and run only the physical host Mac's native architecture (`arm64` on Apple silicon), even if Node itself was started through Rosetta. Intel and universal artifacts are explicit compatibility builds; Rasterform refuses to launch the x64 smoke test on an Apple-silicon Mac. Package verification still checks restrictive ATS metadata, the Rasterform icon, embedded ASAR integrity, locked Electron fuse values, every nested Mach-O architecture/deployment target, and the internal consistency of the ad-hoc code-signature seal. That integrity check does not authenticate a Developer ID identity or verify notarization; distributable releases still require the separate Apple-credentialed release workflow.

See [docs/DESKTOP.md](docs/DESKTOP.md) for the architecture, quality guarantees, macOS support policy, verification gates, and signing/notarization release checklist.

## Rendering credits

Progressive rendering uses [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). Studio lighting uses **Studio Small 08** by Sergej Majboroda from [Poly Haven](https://polyhaven.com/a/studio_small_08), provided under CC0.

# Rasterform

**Turn color, light, and texture into dimensional form.**

Rasterform is a browser-based 3D form studio for artists and designers. Bring in a PNG, JPEG, or WebP and choose which parts should rise or recede, or switch to the separate Text workspace and turn an installed font into beveled, extruded geometry. Then shape, light, and export the result as a finished image or 3D object.

It is a focused **2.5D tool**: more tactile than an image editor, more immediate than building a displacement setup in Blender, and honest about what it creates. Rasterform interprets the image you can see; it does not invent hidden depth.

## A visual workflow

1. **Choose Image or Text** — derive height from brightness, hue, saturation, color channels, transparency, or edges; or type directly with an installed font.
2. **Compose the form** — layer image signals, tune text extrusion and bevels, or use Blob mode to dilate and round either source into organic forms.
3. **Bring it to life** — enable Living Form to make the finished mesh breathe, ripple, flow, or melt on an exact procedural loop.
4. **Find the material** — explore original color, height gradients, clay finishes, or wireframe structure.
5. **Light and export** — work quickly in the HDR studio preview, switch to a progressive Final Render, or continue in other tools.

Right-click the 3D viewport to choose a white, dark-gray, or black background, or use the `W`, `G`, and `B` shortcuts. The background is always a flat color—no floor or grid geometry is added to the viewport or image exports.

Opening Export swaps the right-hand inspector without resizing the screen-bounded viewport or visible WebGL canvas. High images use a dedicated background renderer when supported. Final keeps the full path-traced sample and denoising contract on the main thread, where its BVH worker is not nested inside another worker; it may pause the studio while it renders, but preserves the requested resolution, material, lighting, and background options.

Living Form is deterministic and post-mesh: it never rewrites the source image, text contours, or base geometry, and every displayed or exported frame is evaluated from that immutable base rather than the previous frame. Image and Text keep independent motion settings. Still PNG, GLB, STL, and recipe exports bake the visible phase. Living Loop export creates a transparent or studio-background, lossless RGBA PNG-sequence ZIP at High 2× quality with a timing manifest; frames use `phase = index / frameCount`, so no duplicate terminal frame introduces a hitch. Long sequences stream through private browser storage when available instead of retaining every rendered frame in memory. The archive switches to ZIP64 when it crosses the classic 4 GiB boundary, checks available storage as soon as the first frame establishes a useful size projection, and scavenges abandoned private archives after 24 hours.

Living Loop is deliberately labeled **High 2×**, not Final. It does not replace or weaken the existing still-image Final path tracer: Final uses 6,144 samples for diffuse/matte work and 8,192 samples for specular (glossy or metallic) work, while retaining its full bounce, MIS, tile, and denoising contract.

The optional macOS desktop edition keeps that web behavior intact while moving Final into a separate hidden Electron renderer process. It uses the same quality owner and exact 6,144/8,192-sample contract, but the visible studio remains responsive and shows progress while the native shell prevents sleep and saves the completed PNG atomically. Living Loop remains the same shared renderer and ZIP writer; the shell adds app-suspension protection, disables background throttling for the active job, warns before quit, waits for the ZIP to finish writing, and adds successful loops to Reveal Last Export and Recent Documents.

On macOS, **Cycles Pro** is an optional desktop-only still-render path when Blender 5.2 LTS or newer is installed. Its production preset keeps adaptive Cycles at up to 8,192 samples with a 512-sample floor, a `0.001` noise threshold, 12 light bounces, and the High-quality OpenImageDenoise pass guided by albedo and normals. It saves a display-ready AgX RGBA PNG and a matching PIZ-compressed multipart EXR. The EXR's Combined and Diffuse Color passes use 16-bit half-float color channels; Normal and the other data or denoising-guide passes retain the precision appropriate to those passes. Rasterform starts a new `--background --factory-startup` Blender process with private configuration and temporary directories: it never opens, attaches to, saves, or closes the `.blend` project in an already-running Blender app. Both can run together, although they share the Mac's GPU and memory and can therefore slow each other down. No floor plane or grid is created in the Cycles scene.

Rasterform can export transparent 2K/4K/8K still PNGs, lossless 2K/4K Living Form frame sequences, height maps, reusable recipes, GLB geometry for Blender, and watertight STL files when the topology is ready to fabricate.

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
npm run desktop:package:lab:arm64
npm run desktop:package:x64
npm run desktop:package:universal
npm run desktop:smoke:packaged
npm run desktop:smoke:packaged:lab:arm64
```

`npm run desktop:build` only builds and stages the desktop runtime. To create an installable `.app`, run `npm run desktop:package:arm64` on an Apple-silicon Mac. The result is `electron/out/Rasterform-darwin-arm64/Rasterform.app`; packaging does not copy it into `/Applications`.

`npm run desktop:package:lab:arm64` creates the renderer experiment separately at `electron/out-lab/Rasterform Renderer Lab-darwin-arm64/Rasterform Renderer Lab.app`, with bundle ID `io.atil.rasterform.rendererlab`. Install it as `/Applications/Rasterform Renderer Lab.app`; it remains independent from the known-good `/Applications/Rasterform.app` checkpoint. Blender is intentionally not bundled, so install Blender 5.2 LTS or newer in `/Applications` to enable Cycles Pro. The source recovery tag for the stable pre-Pro checkpoint is `checkpoint/pre-pro-renderer-2026-08-26`.

The unqualified package and packaged-smoke commands build and run only the physical host Mac's native architecture (`arm64` on Apple silicon), even if Node itself was started through Rosetta. Intel and universal artifacts are explicit compatibility builds; Rasterform refuses to launch the x64 smoke test on an Apple-silicon Mac. Package verification still checks restrictive ATS metadata, the Rasterform icon, embedded ASAR integrity, locked Electron fuse values, every nested Mach-O architecture/deployment target, and the internal consistency of the ad-hoc code-signature seal. That integrity check does not authenticate a Developer ID identity or verify notarization; distributable releases still require the separate Apple-credentialed release workflow.

New to Mac app bundles or Electron? See [docs/INSTALLING_MACOS.md](docs/INSTALLING_MACOS.md) for a beginner-friendly guide to installing, launching, updating, and removing Rasterform. See [docs/DESKTOP.md](docs/DESKTOP.md) for the architecture, quality guarantees, macOS support policy, verification gates, and signing/notarization release checklist.

## Rendering credits

Progressive rendering uses [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). Studio lighting uses **Studio Small 08** by Sergej Majboroda from [Poly Haven](https://polyhaven.com/a/studio_small_08), provided under CC0.

The optional desktop Pro path uses Blender Cycles and Blender's OpenImageDenoise integration through a separate locally installed Blender 5.2 LTS (or newer) process.

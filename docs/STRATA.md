# Strata: contour-cut image layers

Strata is an optional geometry mode in the Image workspace. It turns the complete processed height field into independently closed, stacked contour sheets. It does not slice the picture into horizontal strips, paint contour lines on a slab, or extract objects with AI.

## Use it

1. Choose an image and build its height field using the existing Channels and Surface controls.
2. In Properties → Geometry, choose **Strata**.
3. Set **Layers** (2–24), **Thickness**, and **Separation**. Thickness and separation use the same normalized model units as the existing relief controls; the image's longer side is 2 units.
4. Orbit the model to see through the gaps. The camera fits changing stacks inside the existing viewport; the canvas does not become larger than the screen.
5. Try Surface smoothing or Blob for broader, more organic contours. These remain whole-image controls. There are no brushes or manual masks.

The default is 12 layers, thickness 0.025, and separation 0.055. The regular relief depth, midpoint, and base-thickness settings are retained when switching modes; they are not applied to Strata. Mesh detail remains available and controls contour precision and the density of sampled Photo colors.

A completely flat height field produces one sheet, not a fabricated stack of identical cards. The layer thresholds span the actual height range in the processed image. A broad, constant-height region can legitimately recur on several lower layers. Holes and disconnected islands follow the height data rather than a semantic interpretation of the picture.

The lowest rectangular sheet belongs to the generated model. It is not a separate background floor; the app still creates no background plane or grid.

## Motion

In Living Form, choose **Expand**, enable kinetic form, and press Play. The gaps close and reopen in a seamless loop while every sheet stays rigid and aligned. Full intensity closes the gaps completely at the middle of the loop; lower intensity leaves some space. Phase zero is the configured open stack. Thickness stays constant.

Breathe, Ripple, Flow, and Melt remain available when intentional deformation is wanted. Expand is offered only for Strata. The existing lossless PNG-sequence export captures the same procedural motion and visible appearance.

## Images and Blender

- **Web:** High and Final still PNGs, optional alpha, straight-on output, and Living Form PNG sequences remain available within the existing 2K web limit. There are still no web model exports.
- **Desktop:** Existing image dimensions, High, Final, Cycles Pro, alpha, straight-on output, sequences, GLB, `.blend`, STL, and recipe options remain available. No sampling, denoising, bounce, supersampling, or Pro-preset quality settings were lowered for Strata.
- **GLB:** Each height layer is a named object (`Rasterform_Strata_01`, etc.). Disconnected islands at one height belong to the same layer object. Desktop Source image embeds one full-resolution bitmap shared across every top cap; sides and undersides remain neutral. Current appearance exports the chosen colors and material instead.
- **Blender Exact:** Preserves the generated triangles, spacing, image UVs, and visible motion phase, with one object per layer.
- **Blender Balanced:** Joins compatible, coplanar triangles into editable quads within each layer. It does not merge layers or bridge their gaps.
- **Blender Lightweight:** Dissolves coplanar interior edges when the bitmap or uniform surface color can be preserved. For Photo vertex colors, it retains the color samples and uses compatible quad joining instead.
- **SourceUV / UVMap:** SourceUV preserves image placement. The retopology options generate an additional padded UVMap for editing. The full bitmap is packed into the `.blend`; reopening does not require the original image file.
- **STL:** Contains the closed layer shells at the current pose. The shells are separate, not a fused manufacturing-ready union.

Straight-on images can hide much of the separation because the layers overlap in projection. Use an angled current view to emphasize the layered construction.

Use the original source photograph to recreate a design's height field. A previously rendered PNG is a flattened picture of the model, not its original height map; uploading that render creates new geometry from the rendered pixels. The earlier AI concept was illustrative, not exact computed geometry.

## Implementation and verification

`src/lib/strata.ts` clips the same sampled height triangles used by image reliefs against ordered thresholds, creates top and bottom caps, and closes contour and image-boundary edges. Shared intersections, Float32-aware endpoint handling, and removal of unused vertices prevent cracks and collapsed facets. Interior cap vertices preserve sampled Photo colors. Gap/thickness changes reuse the contour topology.

`MeshData.strata` records contiguous layer boundaries. Desktop validators reject missing, overlapping, cross-layer, and out-of-range metadata. The 256 MiB native mesh-byte limit is unchanged; Strata has a separate vertex/index allowance for its repeated caps. There is no automatic detail or render-quality reduction.

Useful checks:

```sh
npm test
npm run build
npm run desktop:check
npm run desktop:package:arm64
npm run desktop:smoke:packaged:arm64
```

The tests cover nested footprints, holes, disconnected islands, zero-area triangle prevention, closed topology, UVs and bitmap materials, loop closure, camera fitting, unchanged relief modes, and desktop contracts. Real Blender tests create temporary projects, export all three topology options, remove the external texture, then reopen in a fresh process and inspect every layer. They never open or modify an existing user Blender project.

### Executed release checks — September 14, 2026

- The full suite passed: 41 test files, 308 tests, including 14 real Blender export/reopen cases and a maximum-detail, 24-layer stress case.
- The web build and desktop TypeScript checks passed.
- The web UI produced and downloaded 2,048 × 1,536 transparent High and Final PNGs. Final completed all 6,144 samples; both outputs were visually inspected. Browser controls were temporarily unavailable during Final rendering, then recovered on completion.
- Straight-on High export also completed at the demo source's original 360 × 270 dimensions with alpha, without changing the orbit view.
- Expand was scrubbed to its fully closed middle phase and exported through the web UI as a one-second, 12-frame, 2,048 × 1,536 lossless RGBA PNG sequence. The ZIP manifest, dimensions, alpha, and collapsed frame were checked.
- The unchanged desktop Pro preset rendered the 12-layer demo through an isolated Blender 5.2.0 LTS process on the Apple M3 Max Metal GPU: all 8,192 samples, minimum 512 samples, 0.001 noise threshold, 12 bounces, and denoising. The 2,048 × 1,536 PNG and multilayer EXR passed production output validation; the PNG was visually inspected. That specific render reported 151.567 seconds, not a general performance guarantee.
- A new arm64 `.app` was packaged. All 15 native binaries were arm64, signature integrity and hardened fuses passed verification, and the packaged startup smoke passed its editor/hidden-renderer, HDR, worker, Cycles, and Blender-export bridge checks. Packaging did not replace the installed app or deploy the website.

For macOS installation and rebuild instructions, see [Installing Rasterform](INSTALLING_MACOS.md).

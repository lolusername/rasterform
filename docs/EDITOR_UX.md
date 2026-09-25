# Editing, recovery, and output previews

These controls do not replace Rasterform's image-to-field-to-mesh pipeline or any renderer. Existing geometry, material, sample, denoising, alpha, and edition limits remain unchanged.

## A screen-bounded studio

The application fits the available window, including short and narrow windows. Inspectors scroll independently; the model does not become an export-sized canvas. At narrow widths, use **Build** and **Properties / Export** to choose the inspector beneath the model. Short landscape windows put controls beside the model instead.

Export resolution is separate from the visible canvas. A 4K or 8K output, where supported, does not need a 4K or 8K screen. Export uses its existing offscreen or separate-process rendering path.

**Current view** previews the output aspect with the editing camera's pose. **Straight on** previews the same front-aligned camera policy used by capture. Returning to editing preserves the orbit. The preview shows composition, not the completed Final/Cycles lighting or denoising. A transparency checker is optional and affects only the preview; the default stays a flat background. No floor or grid geometry is introduced.

Use **Fit** or `F` to frame the model while editing. Straight-on output fits automatically, so Fit is unavailable in that view.

## Undo, kept versions, and recovery

- **Undo / Redo** recover authored changes, including preset replacement, imported images, and the very first camera adjustment. A slider gesture is one action. `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` work outside text-entry controls, where normal text editing keeps its own shortcuts.
- **Keep version** captures a design and thumbnail for this session. **Compare** switches between it and current work with one camera and lighting setup. **Back to current** discards the comparison; **Use version** adopts it as an undoable action. Comparisons are read-only.
- Up to eight kept alternatives and 100 undo actions are retained in memory. Image pixel/Blob assets are immutable and shared between history entries, not recopied on every slider movement.
- The latest design is saved locally through IndexedDB after edits. Reloading offers **Recover session**; it never silently replaces the current design. This is device/browser-local recovery, not cloud backup. Storage failures are reported and do not block editing.
- Desktop **Save project / Open project** uses versioned `.rasterform` design files containing the original image bytes, working pixels, both workspace settings, material, motion, and camera. Export preferences are separate and remain as currently selected. Existing Recipe JSON remains a lighter descriptive export, not a complete project.
- The desktop **File** menu offers **Open Project…** and **Save Project As…**, using the same project actions as the buttons. **Edit → Undo / Redo** follows design history outside text-entry controls and ordinary text history inside them. Native shortcuts are routed once, not once by the menu and again by the page.
- Recovery saves deferred by a long-open file dialog or a font operation retry when that operation finishes. A pending recovery offer or read-only comparison is never overwritten by that retry.
- A required font must be available or embedded from granted local-font access. Missing fonts are reported rather than silently changing typography. Project/session data stays local; do not distribute embedded fonts unless their license permits it.

## Understand a transformation without changing it

**Inspect transformation** shows the source image, selected raw channel signal, actual composite before and after that channel, and final processed height field. White is high; black is low. The first enabled channel establishes the base, and later operations can be nonlinear. These are real intermediate fields, not percentages of attribution.

**Compare one setting**, in Surface, shows real height-field variations of smoothing, contrast, or Blob dilation. All other settings stay fixed. The form changes only after **Apply**, and that change is undoable. Numeric controls accept typed values and expose individual resets without changing their original ranges or steps. Typed values snap to the same supported steps as the slider; out-of-range entries clamp visibly and blank entries restore the current value.

Presets replace Channels and Surface settings; they do not change the selected geometry mode, material, camera, or render quality. Blob remains optional; rough or spiky forms are not treated as errors.

## Long renders

The render card identifies the captured version, renderer, dimensions, stage, and elapsed time. It has one cancel action. Editing a later version does not change an already captured still. Desktop Final/Cycles remain isolated; web Final may pause the studio. No faster substitute is chosen to meet an arbitrary time target.

Desktop Blender/Cycles readiness has an explicit recheck action. A failed readiness check does not silently change a Pro selection to High. Native saves can be located with Reveal Last Export; a browser download is described as started, not guaranteed saved.

## Verification

Run the unit/integration suite and both type/build checks:

```sh
npm test
npm run build
npm run desktop:check
```

With a development server running and Playwright installed or provided through `PLAYWRIGHT_MODULE`:

```sh
TEST_URL=http://127.0.0.1:5173 node scripts/verify-viewport-layout.mjs
TEST_URL=http://127.0.0.1:5173 node scripts/verify-viewport-additional.mjs
TEST_URL=http://127.0.0.1:5173 node scripts/verify-editor-recovery.mjs
TEST_URL=http://127.0.0.1:5173 node scripts/verify-editor-controls.mjs
```

The viewport sweep checks actual DOM/canvas bounds and independent scrolling through editing, export, straight-on, and return-to-edit at 13 window sizes. It also uploads a portrait PNG, checks edition-specific dimensions and 4K/8K preview-size invariance, and simulates desktop job-card transitions through an explicitly labeled bridge fixture. The simulated jobs test layout, not rendering. Recovery checks use an isolated browser context, including delayed storage initialization with and without an existing session. Offscreen export buffers are allowed to be larger than the display; the visible viewport is not.

The additional viewport sweep covers Text and Image Living Loop inspectors, frame-rate/duration/background options, and DPR 2 displays in representative narrow and short windows. Device-pixel scaling of the visible canvas is intentional; export-resolution scaling is not.

The controls regression uses Vue's development metadata to read the preview camera, so run it against the development server rather than a production preview.

For real native project-file checks after building the desktop staging directory:

```sh
npm run desktop:build
node scripts/verify-desktop-projects.mjs
node electron/scripts/smoke-texture-exports.mjs
node scripts/verify-desktop-final.mjs
```

The native project harness uses the actual staged main process, preload, and UI with an isolated profile. Only dialog destinations and Finder reveal are substituted with temporary fixtures; it never opens or overwrites the user's projects. The texture smoke produces actual image exports and checks source-textured model handoff through Blender.

The Final check runs the real 2K transparent render at its normal sample target, edits the current design after capture, and inspects the completed PNG. It deliberately has no overall rendering deadline or quality override. Allow several minutes. A temporary artifact directory contains the result and job-state screenshots. Native QA scripts also use Playwright; set `PLAYWRIGHT_MODULE` when it is not installed locally.

For release verification, also inspect actual downloaded PNG dimensions, alpha, and composition and run the staged/packaged Electron smoke tests. Unit tests alone do not establish that a real render or native save completed.

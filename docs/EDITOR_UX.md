# Editing, recovery, and output previews

## A screen-bounded studio

The application fits the available window, including short and narrow windows. Inspectors scroll independently; the model does not become an export-sized canvas. At narrow widths, use **Build** and **Properties / Export** to choose the inspector beneath the model. Short landscape windows put controls beside the model instead.

Choose **Export** to preview the output aspect. **Current view** uses the editing camera. In the Image workspace, **Straight on** frames the source head-on. Returning to editing restores the orbit. The optional transparency checker helps you see the silhouette. Final lighting and denoising appear in the downloaded render.

Use **Fit** or `F` to frame the model while editing. Straight-on output fits automatically, so Fit is unavailable in that view.

## Undo, kept versions, and recovery

- **Undo / Redo** recover authored changes, including preset replacement, imported images, and the very first camera adjustment. A slider gesture is one action. `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` work outside text-entry controls, where normal text editing keeps its own shortcuts.
- **Keep version** captures a design and thumbnail for this session. **Compare** switches between it and current work with one camera and lighting setup. **Back to current** discards the comparison; **Use version** adopts it as an undoable action. Comparisons are read-only.
- Up to eight kept alternatives and 100 undo actions are retained in memory. Image pixel/Blob assets are immutable and shared between history entries, not recopied on every slider movement.
- The latest design is saved locally through IndexedDB after edits. Reloading offers **Recover session**; it never silently replaces the current design. This is device/browser-local recovery, not cloud backup. Storage failures are reported and do not block editing.
- Recovery distinguishes pending, saving, and saved states. The recovery offer identifies the source and snapshot date when available; older snapshots remain supported. A completed older write is not presented as proof that a newer edit has been saved.

## Understand a transformation without changing it

**Inspect transformation** shows the source image, selected raw channel signal, actual composite before and after that channel, and final processed height field. White is high; black is low. The first enabled channel establishes the base, and later operations can be nonlinear. These are real intermediate fields, not percentages of attribution.

**Inspect this channel** opens that optional inspection from the selected channel. Its description explains the actual base/muted state, combine operation, influence, inversion, and hue target. Each map can be enlarged in a screen-bounded dialog at its existing working resolution; Escape closes it and restores keyboard focus. This does not resample the export or change the design.

**Compare one setting**, in Surface, shows real height-field variations of smoothing, contrast, or Blob dilation. All other settings stay fixed. **Preview form** temporarily shows a candidate on the model with the same camera and material. **Back to current** leaves authored work unchanged; **Use** adopts one undoable change. Direct **Apply** remains available. An unadopted preview cannot be exported or autosaved over the current design.

Numeric controls accept typed values and expose individual resets where a meaningful default exists, without changing their original ranges or steps. Percent and degree fields convert back to the same underlying units as their sliders. Typed values snap to supported steps; out-of-range entries clamp visibly and blank entries restore the current value.

Presets replace Channels and Surface settings; they do not change the selected geometry mode, material, camera, or render quality. Blob remains optional; rough or spiky forms are not treated as errors.

Photo colors use linear-light interpolation of the source image. **Mesh health** reports components, open boundary edges, and non-manifold connections. An open surface is expected for Raised relief. Switch to Solid relief to compare the topology with a closed back and sides.

## Exporting a view or a loop

Choose **Still** to render one pose as a PNG. **High** supersamples the image. **Final** simulates light transport on shaded surfaces and can take several minutes, depending on your GPU. Wireframe uses High. The render card identifies the captured design, dimensions, stage, and elapsed time.

To export motion, enable **Living Form** and choose **Living loop**. The ZIP contains numbered lossless PNGs and a timing manifest. Import them into a video editor as an image sequence at the same frame rate. The last frame precedes the return to the first pose so the endpoint is played only once.

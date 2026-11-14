# Strata contour layers

Strata is an optional geometry mode in the Image workspace. It turns the complete processed height field into independently closed, stacked contour sheets. The boundaries follow the height values in the picture.

## Use it

1. Choose an image and build its height field using the existing Channels and Surface controls.
2. In Properties → Geometry, choose **Strata**.
3. Set **Layers** (2–24). Raise **Start level** (0–95%) to leave out regions below the first contour. **Thickness** sets the depth of each sheet and **Separation** sets the gap. The image’s longer side is 2 model units.
4. Orbit the model to see through the gaps. The camera fits changing stacks inside the existing viewport; the canvas does not become larger than the screen.
5. Try Surface smoothing or Blob for broader, more organic contours. These remain whole-image controls. There are no brushes or manual masks.

The default is 12 layers with a 0% start level, thickness 0.025 and separation 0.055. The regular relief depth, midpoint, and base-thickness settings are retained when switching modes; they are not applied to Strata. Mesh detail remains available and controls contour precision and the density of sampled Photo colors.

A completely flat height field produces one sheet, not a fabricated stack of identical cards. The layer thresholds span the actual height range in the processed image. A broad, constant-height region can legitimately recur on several lower layers. Holes and disconnected islands follow the height data rather than a semantic interpretation of the picture.

At **0%**, the first sheet covers every sampled pixel, so its outline is rectangular. At **50%**, the first sheet only includes heights from the middle of the sampled range upward. For example, if the field runs from 0.2 to 0.8, the first contour at 50% is 0.5. The remaining layers divide the interval from that starting height toward the maximum.

## Motion

In Living Form, choose **Expand**, enable kinetic form, and press Play. The gaps close and reopen in a seamless loop while every sheet stays rigid and aligned. Full intensity closes the gaps completely at the middle of the loop; lower intensity leaves some space. Phase zero is the configured open stack. Thickness stays constant.

Breathe, Ripple, Flow, and Melt remain available when intentional deformation is wanted. Expand is offered only for Strata. The existing lossless PNG-sequence export captures the same procedural motion and visible appearance.

## Render the stack

Choose **Export → Still** and use an angled **Current view** to show the air between sheets. A straight-on image projects the contours onto each other and emphasizes their footprints. Pick **Transparent** to isolate the form or **Current** to include the studio backdrop. Both High and Final shaded stills support a long edge up to 2,048 pixels.

For movement, enable **Living Form**, choose **Expand**, and select **Export → Living loop**. This downloads a ZIP of High-quality PNG frames and a timing manifest. For example, a one-second loop at 12 fps contains 12 distinct phases.

To share the field itself, use **Height PNG**. It stores the processed grayscale values before the contour layers are built.

## How the contours are made

Rasterform samples the height field as a triangle mesh. At each threshold it keeps the portions of triangles that meet the level, creates top and bottom faces, and joins the boundaries with side walls. An island may be detached from the rest of its sheet. Interior vertices carry sampled image colors in Photo view. Changing thickness or separation can reuse the contour shapes.

See [the contour builder](../src/lib/strata.ts), [animation of the layer positions](../src/lib/strata-frame.ts), and [the topology inspector](../src/lib/topology.ts).

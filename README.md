# Rasterform

**Turn color, light, and texture into dimensional form.**

Rasterform is a browser-based relief studio for artists and designers. Bring in a PNG, JPEG, or WebP, choose which parts of the image should rise or recede, then shape, light, and export the result as a finished image or 3D object.

It is a focused **2.5D tool**: more tactile than an image editor, more immediate than building a displacement setup in Blender, and honest about what it creates. Rasterform interprets the image you can see; it does not invent hidden depth.

## A visual workflow

1. **Read the image** — use brightness, hue, saturation, color channels, transparency, or edges as height.
2. **Compose the surface** — layer signals, carve details, soften transitions, quantize steps, and control depth.
3. **Find the material** — explore original color, height gradients, clay finishes, or wireframe structure.
4. **Light and export** — work quickly in the HDR studio preview, switch to a progressive Final Render, or continue in other tools.

Right-click the 3D viewport to choose a white, dark-gray, or black background, or use the `W`, `G`, and `B` shortcuts. The background is always a flat color—no floor or grid geometry is added to the viewport or image exports.

Rasterform can export transparent 4K/8K PNGs, height maps, reusable recipes, GLB geometry for Blender, and watertight STL files when the topology is ready to fabricate.

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

## Rendering credits

Progressive rendering uses [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). Studio lighting uses **Studio Small 08** by Sergej Majboroda from [Poly Haven](https://polyhaven.com/a/studio_small_08), provided under CC0.

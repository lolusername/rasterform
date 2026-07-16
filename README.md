# Rasterform

**Rasterform turns image channels into editable, exportable 3D reliefs.**

Rasterform is a local creative tool for the space between a 2D image editor and Blender. Open a PNG, JPEG, or WebP; stack the image properties that should become height; tune the surface; then export baked geometry instead of rebuilding a displacement setup by hand.

It is deliberately a deterministic **2.5D asset maker**, not generative image-to-3D reconstruction. It never claims to infer an unseen back or recover an object's true depth.

## What is implemented

- A built-in original chromatic study, processed through the same pipeline as uploaded images
- Height from linear-light luminance, circular hue distance, saturation, value, red, green, blue, alpha, or Sobel edges
- A non-destructive five-channel stack: reorder signals, mute them, invert them, set their influence, and combine them with Mix, Raise, Carve, Multiply, Screen, Peak, or Valley modes
- Tonal Detail, Chroma Strata, and Ink Emboss starting points that demonstrate useful multi-channel recipes without changing the image or geometry settings
- Smoothing, contrast, quantization, inversion, depth, midpoint, thickness, and mesh-resolution controls
- Raised plane, signed/centered plane, and watertight solid-tile geometry
- Orbitable Three.js preview with image-color, height-color, clay, and wireframe views
- Transparent 4K or 8K viewport PNG export from the current camera in every view, with no background or reference grid and 300-PPI metadata
- A three-stop height gradient with editable low, midpoint, and high colors plus a movable midpoint
- Custom clay color with matte, glossy, and metallic finishes
- Source and computed height-map previews
- Mesh checks for vertices, faces, components, boundary loops, non-manifold edges, degeneracy, Euler characteristic, and watertightness
- GLB export with baked indexed geometry and vertex colors
- STL export only when topology checks prove the mesh is watertight
- Height-map PNG and versioned recipe JSON exports that preserve the complete ordered channel stack and appearance settings
- No account, server, upload, analytics, or remote inference

## Run

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
npm run build
```

Tests cover circular hue behavior across the red seam, perceptual channel math, stack order and blend semantics, per-channel inversion, strength interpolation, custom gradients, clay finishes, 4K/8K aspect preservation, tiled render coverage, guide exclusion, 300-PPI PNG metadata, signed displacement, valid indices, boundary topology, Euler characteristic, and the watertight solid tile.

## Why this product exists

The researched gap is narrower and more useful than “image to 3D” marketing:

- Illustrator extrudes or revolves vector artwork, but does not turn arbitrary raster channels into a baked relief mesh.
- Substance Sampler generates material channels from images; displacement still requires an existing tessellated object.
- Blender can do this through subdivision, texture configuration, displacement, solidification, validation, and export. Rasterform makes that repeatable experiment one direct workspace.

The implementation follows the behavior documented by [Blender's Displace modifier](https://docs.blender.org/manual/en/5.0/modeling/modifiers/deform/displace.html), [Blender displacement guidance](https://docs.blender.org/manual/en/5.0/render/shader_nodes/vector/displacement.html), [Adobe Substance displacement](https://helpx.adobe.com/substance-3d-stager/desktop/features/material-displacement.html), [Three.js BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html), [Three.js GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html), and [Three.js STLExporter](https://threejs.org/docs/pages/STLExporter.html).

## Quiet mathematical structure

The product UI uses ordinary studio language, but mathematics improves the tool:

- Hue is circular, so the anchor uses circular distance rather than creating a false cliff at red.
- Scalar fields compose in a deliberate order, turning familiar layer operations into predictable geometry while keeping every intermediate result bounded.
- A displaced grid preserves its connectivity unless the tool explicitly creates a solid boundary.
- Edge incidence, components, boundary loops, and Euler characteristic keep “watertight” an audited result rather than a visual guess.

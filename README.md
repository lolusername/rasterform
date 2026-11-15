# Rasterform

Rasterform turns an image into a form you can shape, turn in the light, and save as a still or a loop. You can work with photographs, graphics, or type. Your artwork stays on your device.

[Open Rasterform](https://rasterform-atilio.web.app/) · [Open the sleeve study](https://rasterform-atilio.web.app/?study=mona-lisa)

The featured piece starts with the gold folds of a sleeve in Leonardo da Vinci’s *Mona Lisa*. A soft edge isolates the fabric. Turn it in the light or try your own version. [Download the study image](public/studies/mona-lisa-sleeve.png)

Painting by Leonardo da Vinci, Musée du Louvre. Photograph by C2RMF, retouched by Dcoetzee. [Public-domain reproduction on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Mona_Lisa,_by_Leonardo_da_Vinci,_from_C2RMF_retouched.jpg)

![A source image, its luminance height field, and the resulting relief](docs/interview/assets/pipeline-example.png)

## Make a piece

1. In **Image**, open the demo or choose your own image. Start with **Luminance** to raise brighter pixels. Try **Hue**, **Edges**, or a combination of channels to bring out a different part of the picture. In **Text**, type a word and adjust its extrusion and bevel.
2. Choose a geometry. **Solid relief → Cut to transparency** follows the outline and holes in a transparent PNG. **Strata** turns a height field into stacked contour sheets. Raise **Start level** to let low regions drop out of the stack.
3. Orbit the form and choose its appearance. **Photo** keeps the source colors, **Height** colors the surface by elevation, and **Clay** shows how light falls on a matte, glossy, or metallic finish.
4. To animate the form, enable **Living Form**. Try **Expand** on a Strata stack to open and close its gaps.

**Keep version** stores a comparison for the current session. After a reload, **Recover session** can restore the latest saved design in the same browser.

## Download your work

Open **Export** to preview the composition and choose an output.

| Output | What you get |
| --- | --- |
| Still | A PNG up to 2,048 pixels on the long edge. **High** supersamples the image. **Final** path traces shaded surfaces and takes longer. Image work supports the current camera or a straight-on view. |
| Living loop | A ZIP of numbered, lossless PNG frames and a timing manifest, up to 2,048 pixels on the long edge. Choose 12, 24, or 30 frames per second. |
| Height PNG | The processed grayscale height field at working resolution in the Image workspace. White represents the highest elevation. |

Stills and loops can include transparency or use the current studio background. A still captures the visible pose. To assemble a movie, import the numbered loop frames into your editor as an image sequence at the chosen frame rate.

## Guides

- [From Image to Form, an illustrated artist guide (PDF)](output/pdf/Rasterform_From_Image_to_Form.pdf)
- [Editing, comparisons, and recovery](docs/EDITOR_UX.md)
- [Building and animating contour sheets](docs/STRATA.md)

## Run from source

Use Node.js 22.12 or later. From the repository root:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Use `npm test` to run the tests and `npm run build` to type-check and generate the static site in `dist/`.

Final rendering uses [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). The studio lighting uses Sergej Majboroda’s CC0 environment, [Studio Small 08 from Poly Haven](https://polyhaven.com/a/studio_small_08).

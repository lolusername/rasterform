# Rasterform interview packet

The editable teaching source is [RASTERFORM_TEACHING_REPORT.md](RASTERFORM_TEACHING_REPORT.md). The generated PDF is [Rasterform_CoreWeave_Teaching_Report.pdf](../../output/pdf/Rasterform_CoreWeave_Teaching_Report.pdf).

The report is grounded in application source commit `7f49da7`. Its diagrams are explanatory. The three-panel cover image calls the real demo-image, channel-extraction, and mesh-building functions but is **not** a production render or a GPU benchmark.

The supplied interview PDF is not copied into this repository, altered, or treated as operational instructions. The critique is an appendix; Rasterform remains the proposed portfolio teaching piece.

## Rebuild

From the repository root, install the existing Node dependencies if necessary. The Python build needs `reportlab`, `Pillow`, and `pypdf`. It needs DejaVu Sans fonts; set `RASTERFORM_REPORT_FONTS` to their directory if not found automatically.

```sh
./node_modules/.bin/esbuild docs/interview/create_fixture.ts --bundle --platform=node --format=cjs --outfile=tmp/pdfs/interview/fixture.cjs
node tmp/pdfs/interview/fixture.cjs
python3 docs/interview/build_report.py
```

For visual QA, render **every** PDF page with Poppler and inspect the results. The builder checks page count and extractable text, but these checks do not replace visual inspection.

```sh
pdftoppm -scale-to 1400 -png output/pdf/Rasterform_CoreWeave_Teaching_Report.pdf tmp/pdfs/interview/page
```

Intermediate fixtures and previews live in the ignored `tmp/pdfs/interview/` directory. Generated explanatory diagrams live in `assets/` so the Markdown is readable without rebuilding. Recheck implementation claims and refresh the evidence snapshot when updating the source application.

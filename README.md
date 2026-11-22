# FileViewer

Browse scientific data files in VS Code as sortable tables with statistics. Everything runs in plain JavaScript, so there's no Python, numpy or ROOT to install.

| Format | What you see |
|---|---|
| `.npz` / `.npy` | Each array as a table. 2-D arrays show their columns; N-D arrays are flattened to rows × rest. Supports numeric, bool, unicode/bytes strings and datetime64 dtypes, in C or Fortran order, compressed or not. |
| `.parquet` | All fields, with snappy, gzip, brotli, zstd or lz4 compression. Nested values appear as lists or objects. |
| `.csv` / `.tsv` | Typed columns. This is opt-in: right-click the file → **Open With… → FileViewer**. |
| `.root` | TTrees (including jagged branches), RNTuples and TH1 histograms, including those inside subdirectories. Uses [JSROOT](https://root.cern/js/). |

## Features

- **Left panel**: arrays, trees and fields. Click one to show it, or to show its stats.
- **Table**: click a header to sort (ascending → descending → off). Click a cell to show that column's stats.
- **Windowing**: set the rows per window and the start row, or use the ⏮ ◀ ▶ ⏭ buttons.
- **Decimals**: auto, or 0–10 fixed places. Applies to float columns and to the stats.
- **Font**: monospace (your editor font) or the default UI font.
- **Stats panel**: count, missing, NaN, Inf, min, max, mean, std and a labeled histogram for numbers, or the most frequent values for text.

Your display settings are remembered across files.

## Development

```sh
npm install
npm run build      # bundle to dist/extension.js
npm run check      # type-check
npm run package    # build a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

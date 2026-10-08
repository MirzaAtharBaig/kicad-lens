# KiCad Lens

View KiCad schematics and PCBs inside VS Code, and diff them across git revisions the way you diff code: visually, as an overlay, and as a list of semantic changes.

## Features

- **Viewer** for `.kicad_sch` and `.kicad_pcb`. Pan and zoom, browse the whole sheet hierarchy (opening any sub-sheet renders the full project), double-click a sheet frame to enter it, toggle and colour PCB layers, flip the board, and search by reference or value.
- **Visual diff** in four modes:
  - **Overlay**: removed in red, added in green, unchanged in grey.
  - **Side by side**: pan and zoom stay in sync.
  - **Blend**: cross-fade between revisions.
  - **Swipe**: drag a divider between revisions.
- **Semantic change list** that zooms to each change when you click it. Step through changes with <kbd>F7</kbd> / <kbd>Shift+F7</kbd>.
  - Schematics: components added, removed, moved or edited (value, footprint, fields, DNP/BOM flags), net connectivity changes and renames, labels, wiring and sheets.
  - PCBs: footprints added, removed, moved, flipped or edited, pad nets, routing per net (segments, vias, length), zones and board outline.
- **Git integration**: Compare with HEAD, with any revision, or with a branch or tag. Compare two selected files in the Explorer, compare a commit with its parent from the Timeline view, or open staged and unstaged diffs from Source Control. When VS Code's own diff opens two viewers side by side, their pan and zoom stay in sync.
- **Fast after the first render**: renders are cached by content hash, so each git revision is rendered only once. Modified files can be pre-rendered at HEAD in the background.

## Requirements

- **KiCad 7 or newer.** KiCad Lens uses the `kicad-cli` that ships with KiCad, so drawings look exactly like KiCad's plots. It searches `PATH` and the standard install locations; if it can't find `kicad-cli`, run **KiCad Lens: Set kicad-cli Path…**.
- The built-in Git extension, for revision comparisons.

## Usage

| What | How |
| --- | --- |
| Open the viewer | Click a `.kicad_sch` / `.kicad_pcb` file. To get the text, use **Reopen Editor With… → Text Editor**, or the `{ }` button. |
| Diff against HEAD | Editor title button, or **KiCad Lens: Compare with HEAD** |
| Diff against any commit | **KiCad Lens: Compare with Revision…** |
| Diff a commit with its parent | Timeline view → right-click a commit → **Compare with KiCad Lens** |
| Diff staged / unstaged changes | Source Control → circuit-board icon on a KiCad file |
| Diff two files | Select both in the Explorer → **Compare Selected (KiCad Lens)** |

### Keyboard (in the viewer)

| Key | Action |
| --- | --- |
| <kbd>F</kbd> | Fit to page |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in / out |
| <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | Previous / next sheet |
| <kbd>B</kbd> | Flip the board (PCB) |
| <kbd>1</kbd>–<kbd>4</kbd> | Overlay / side by side / blend / swipe |
| <kbd>F7</kbd> / <kbd>Shift+F7</kbd> | Next / previous change |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kicadLens.kicadCliPath` | `""` | Path to `kicad-cli`; empty means auto-detect. Workspace values are ignored in untrusted workspaces. |
| `kicadLens.cacheSizeMB` | `1024` | Size limit of the SVG render cache. |
| `kicadLens.defaultDiffMode` | `overlay` | `overlay`, `sideBySide`, `blend` or `swipe`. |
| `kicadLens.showDrawingSheet` | `true` | Render the frame and title block. |
| `kicadLens.backgroundPrerender` | `true` | Pre-render HEAD for modified files. |
| `kicadLens.syncStockDiff` | `true` | Sync pan/zoom in VS Code's built-in side-by-side diff. |

## How it works

`kicad-cli` exports each sheet, or each PCB layer, to SVG. Schematics are exported twice: in colour for viewing, and in black and white to use as overlay masks. A revision is assembled from git (`git show <rev>:<path>`) together with every sub-sheet and the `.kicad_pro` file, so the whole hierarchy renders as it was at that commit. Semantic diffs come from KiCad Lens's own parser for KiCad files, plus `kicad-cli`'s netlist export for connectivity.

## License

MIT

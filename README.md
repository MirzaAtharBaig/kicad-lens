# KiCad Lens

A VS Code extension for viewing KiCad schematics and PCBs and diffing them across git revisions. It shows a visual overlay and a semantic change list, much like diffing code.

See [packages/extension/README.md](packages/extension/README.md) for features and usage.

## Repository layout

| Package | What |
| --- | --- |
| `packages/core` | KiCad file parser, schematic and PCB models, `kicad-cli` rendering and cache, semantic diff. No VS Code dependency. |
| `packages/webview` | Viewer and diff UI that runs inside the webview. |
| `packages/extension` | VS Code integration: custom editor, diff panel, git commands. |

## Development

```sh
npm install
npm run build      # bundle webview + extension
npm test           # unit tests
npm run typecheck
npm run lint
npm run package    # produces kicad-lens.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Tests against a real project

The unit tests use small synthetic KiCad documents. To also test against a real project with git history (it is never copied into this repository):

```sh
KICAD_LENS_FIXTURE_REPO=/path/to/project-dir \
KICAD_LENS_FIXTURE_FROM=<older-rev> KICAD_LENS_FIXTURE_TO=<newer-rev> \
KICAD_LENS_RENDER_TESTS=1 npm test
```

`KICAD_LENS_RENDER_TESTS=1` also runs `kicad-cli`. Set `KICAD_CLI` if it is not on `PATH`.

## License

MIT

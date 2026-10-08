// Smoke test executed inside VS Code (no test framework needed).
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

function manifests() {
  const root = path.join(process.env.KICAD_LENS_USER_DATA, 'User', 'globalStorage', 'mirzaatharbaig.kicad-lens', 'renders');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'manifest.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(root, d, 'manifest.json'), 'utf8')));
}

const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);

function step(msg) {
  fs.appendFileSync(path.join(process.env.KICAD_LENS_USER_DATA, "smoke.log"), `${new Date().toISOString()} ${msg}
`);
}

exports.run = async function run() {
  try {
    await smoke();
    step("PASS");
  } catch (e) {
    step(`FAIL ${e && e.stack}`);
    throw e;
  }
}

async function smoke() {
  const ext = vscode.extensions.getExtension('MirzaAtharBaig.kicad-lens');
  assert.ok(ext, 'extension present');
  await ext.activate();
  step('activated');

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['kicadLens.compareWithHead', 'kicadLens.compareSelected', 'kicadLens.openScmDiff', 'kicadLens.compareTimeline'])
    assert.ok(cmds.includes(c), `command ${c} registered`);

  const dir = vscode.workspace.workspaceFolders[0].uri;
  const sch = vscode.Uri.joinPath(dir, 'demo.kicad_sch');
  const sub = vscode.Uri.joinPath(dir, 'power.kicad_sch');
  const pcb = vscode.Uri.joinPath(dir, 'demo.kicad_pcb');

  // Clicking a KiCad file opens the custom editor by default.
  await vscode.commands.executeCommand('vscode.openWith', sch, 'kicadLens.viewer', { preview: false });
  await waitFor('schematic viewer tab', () =>
    tabs().some((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'kicadLens.viewer' && t.input.uri.fsPath === sch.fsPath),
  );
  step('schematic tab open');
  const schManifest = await waitFor('schematic render', () => manifests().find((m) => m.kind === 'sch'));
  assert.strictEqual(schManifest.sheets.length, 2, 'root + sub-sheet rendered');
  assert.ok(schManifest.sheets.every((s) => s.svg && s.mask), 'colour and mask SVGs for every sheet');
  assert.strictEqual(schManifest.netlist, 'netlist.net');

  step('schematic rendered');
  await vscode.commands.executeCommand('vscode.openWith', pcb, 'kicadLens.viewer', { preview: false });
  const pcbManifest = await waitFor('pcb render', () => manifests().find((m) => m.kind === 'pcb'));
  for (const l of ['F.Cu', 'B.Cu', 'Edge.Cuts']) assert.ok(pcbManifest.layers.find((x) => x.name === l && x.svg), `layer ${l} rendered`);

  // Opening a sub-sheet renders the same hierarchy (no new schematic render).
  const before = manifests().length;
  await vscode.commands.executeCommand('vscode.openWith', sub, 'kicadLens.viewer', { preview: false });
  await sleep(3000);
  assert.strictEqual(manifests().filter((m) => m.kind === 'sch').length, 1, 'sub-sheet reuses the root render');
  assert.strictEqual(manifests().length, before);

  step('pcb + sub-sheet ok');
  // Diff panel between two working-tree files.
  await vscode.commands.executeCommand('kicadLens.compareSelected', sch, [sch, sub]);
  await waitFor('diff panel', () => tabs().some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('kicadLens.diff')));

  // Mismatched kinds are rejected without opening a panel.
  const panels = tabs().length;
  await vscode.commands.executeCommand('kicadLens.compareSelected', sch, [sch, pcb]);
  assert.strictEqual(tabs().length, panels);

  step('all checks passed');
}

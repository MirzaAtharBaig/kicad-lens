/** Renders the committed demo project with kicad-cli (KICAD_LENS_RENDER_TESTS=1). */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliRunner, RenderCache, fsSource, locateKicadCli, semanticDiff, takeSnapshot } from '../src';

const demo = path.resolve(__dirname, '../../../test/fixtures/demo');

describe.skipIf(!process.env.KICAD_LENS_RENDER_TESTS)('kicad-cli rendering', () => {
  let tmp = '';
  afterAll(() => tmp && rm(tmp, { recursive: true, force: true }));

  it('renders the demo schematic hierarchy, netlist and board layers', async () => {
    const cli = await locateKicadCli(process.env.KICAD_CLI);
    tmp = await mkdtemp(path.join(os.tmpdir(), 'kicad-lens-render-'));
    const cache = new RenderCache(tmp, new CliRunner(cli));

    const sch = await takeSnapshot('demo.kicad_sch', fsSource(demo));
    const m = await cache.render(sch, { showDrawingSheet: true });
    expect(m.warnings).toEqual([]);
    expect(m.sheets!.map((s) => [s.namePath, !!s.svg, !!s.mask])).toEqual([
      ['/', true, true],
      ['/Power/', true, true],
    ]);
    expect(m.netlist).toBe('netlist.net');

    const pcb = await takeSnapshot('demo.kicad_pcb', fsSource(demo));
    const pm = await cache.render(pcb, { showDrawingSheet: false });
    expect(pm.warnings).toEqual([]);
    for (const l of ['F.Cu', 'B.Cu', 'Edge.Cuts']) expect(pm.layers!.find((x) => x.name === l)?.svg, l).toBeTruthy();

    // Second render is a cache hit; identical snapshots have no semantic changes.
    expect((await cache.render(sch, { showDrawingSheet: true })).dir).toBe(m.dir);
    expect((await semanticDiff(sch, sch, { before: m, after: m })).changes).toEqual([]);
  }, 300_000);
});

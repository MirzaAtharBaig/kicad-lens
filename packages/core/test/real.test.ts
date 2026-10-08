/**
 * Tests against a real KiCad project with git history.
 *
 *   KICAD_LENS_FIXTURE_REPO=<path to a dir with .kicad_pro> npm test
 *
 * Optional: KICAD_LENS_FIXTURE_FROM / _TO (revisions), KICAD_LENS_RENDER_TESTS=1
 * to also run kicad-cli. The project is never copied into this repository.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CliRunner,
  RenderCache,
  diffSchematic,
  fsSource,
  gitSource,
  locateKicadCli,
  parsePcb,
  parseSExpr,
  semanticDiff,
  takeSnapshot,
} from '../src';

const dir = process.env.KICAD_LENS_FIXTURE_REPO;
const from = process.env.KICAD_LENS_FIXTURE_FROM ?? 'HEAD~1';
const to = process.env.KICAD_LENS_FIXTURE_TO ?? 'HEAD';
const proj =
  dir && existsSync(dir)
    ? (process.env.KICAD_LENS_FIXTURE_PROJECT ??
      readdirSync(dir).find(
        (f) =>
          f.endsWith('.kicad_pro') &&
          existsSync(path.join(dir, f.replace('.kicad_pro', '.kicad_sch'))) &&
          existsSync(path.join(dir, f.replace('.kicad_pro', '.kicad_pcb'))),
      ))
    : undefined;
const root = proj?.replace('.kicad_pro', '.kicad_sch');
const board = proj?.replace('.kicad_pro', '.kicad_pcb');

describe.skipIf(!proj)('real project', () => {
  it('parses every KiCad file', () => {
    for (const f of readdirSync(dir!).filter((f) => /\.kicad_(sch|pcb|sym|mod)$/.test(f))) {
      expect(() => parseSExpr(readFileSync(path.join(dir!, f), 'utf8')), f).not.toThrow();
    }
  });

  it('loads the full hierarchy and the board', async () => {
    const snap = await takeSnapshot(root!, fsSource(dir!));
    expect(snap.schematic!.sheets.length).toBeGreaterThan(1);
    for (const s of snap.schematic!.sheets) expect(s.symbols.every((x) => !x.reference.endsWith('?'))).toBe(true);
    const pcb = parsePcb(readFileSync(path.join(dir!, board!), 'utf8'));
    expect(pcb.footprints.length).toBeGreaterThan(0);
  });

  it(`diffs ${from} → ${to}`, async () => {
    const [a, b] = await Promise.all([takeSnapshot(root!, gitSource(dir!, from)), takeSnapshot(root!, gitSource(dir!, to))]);
    const t0 = Date.now();
    const res = diffSchematic({ before: a.schematic!, after: b.schematic! });
    const counts: Record<string, number> = {};
    for (const c of res.changes) counts[`${c.category}:${c.kind}`] = (counts[`${c.category}:${c.kind}`] ?? 0) + 1;
    console.log(`schematic diff in ${Date.now() - t0} ms`, counts, res.changedSheets);
    console.log(res.changes.filter((c) => c.category === 'component').slice(0, 15).map((c) => `${c.kind} ${c.title}: ${c.summary}`).join('\n'));
    expect(res.changes.length).toBeGreaterThan(0);

    const [pa, pb] = await Promise.all([takeSnapshot(board!, gitSource(dir!, from)), takeSnapshot(board!, gitSource(dir!, to))]);
    const t1 = Date.now();
    const pres = await semanticDiff(pa, pb);
    console.log(`pcb diff in ${Date.now() - t1} ms: ${pres.changes.length} changes`);
  });

  describe.skipIf(!process.env.KICAD_LENS_RENDER_TESTS)('rendering', () => {
    let tmp = '';
    afterAll(() => tmp && rm(tmp, { recursive: true, force: true }));

    it('renders schematic + board and reuses the cache', async () => {
      const cli = await locateKicadCli(process.env.KICAD_CLI);
      tmp = await mkdtemp(path.join(os.tmpdir(), 'kicad-lens-'));
      const cache = new RenderCache(tmp, new CliRunner(cli));
      const snap = await takeSnapshot(root!, fsSource(dir!));
      const m = await cache.render(snap, { showDrawingSheet: true });
      expect(m.warnings).toEqual([]);
      expect(m.sheets!.every((s) => s.svg)).toBe(true);
      expect(m.netlist).toBe('netlist.net');

      const t0 = Date.now();
      await cache.render(snap, { showDrawingSheet: true });
      expect(Date.now() - t0).toBeLessThan(500);

      const pm = await cache.render(await takeSnapshot(board!, fsSource(dir!)), { showDrawingSheet: false });
      expect(pm.layers!.filter((l) => l.svg).length).toBeGreaterThan(3);
      expect(pm.warnings).toEqual([]);

      const res = await semanticDiff(snap, snap, { before: m, after: m });
      expect(res.changes).toEqual([]);
    }, 600_000);
  });
});

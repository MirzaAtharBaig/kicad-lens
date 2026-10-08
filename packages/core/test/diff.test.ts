import { describe, expect, it } from 'vitest';
import { diffPcb, diffSchematic, loadSchematic, parseNetlist, parsePcb, parseSheet, sheetSvgName } from '../src';
import { pcb, schematic, subSheet } from './fixtures';

const load = (files: Record<string, string>) => loadSchematic('demo.kicad_sch', async (p) => files[p]);

describe('schematic model', () => {
  it('resolves the hierarchy and per-instance references', async () => {
    const sch = await load({
      'demo.kicad_sch': schematic({
        symbols: [{ uuid: 's1', ref: 'R1', value: '10k', x: 50, y: 50 }],
        sheets: [{ uuid: 'sub-uuid', name: 'Power', file: 'power.kicad_sch' }],
      }),
      'power.kicad_sch': subSheet([{ uuid: 's2', ref: 'R2', value: '1k', x: 60, y: 60 }]),
    });
    expect(sch.sheets.map((s) => [s.namePath, s.page])).toEqual([
      ['/', '1'],
      ['/Power/', '2'],
    ]);
    expect(sch.sheets[1]!.symbols[0]!.reference).toBe('R2');
    expect(sch.files).toEqual(['demo.kicad_sch', 'power.kicad_sch']);
  });

  it('computes symbol bounding boxes from the library graphics', () => {
    const { sheet } = parseSheet(schematic({ symbols: [{ uuid: 's1', ref: 'R1', value: '1k', x: 100, y: 100, rot: 90 }] }), '/root-uuid', '/', 'demo.kicad_sch', 'demo');
    const b = sheet.symbols[0]!.bbox;
    // Rotated 90°: the 7.62 mm long resistor lies horizontally.
    expect(b.maxX - b.minX).toBeGreaterThan(b.maxY - b.minY);
    expect(b.minX).toBeLessThan(100);
    expect(b.maxX).toBeGreaterThan(100);
  });

  it('names sheet SVGs like kicad-cli', () => {
    expect(sheetSvgName('cm4', '/')).toBe('cm4.svg');
    expect(sheetSvgName('cm4', '/USBtoEthernet/LAN9500AI/')).toBe('cm4-USBtoEthernet-LAN9500AI.svg');
  });
});

describe('diffSchematic', () => {
  it('reports added, removed, modified and moved components', async () => {
    const before = await load({
      'demo.kicad_sch': schematic({
        symbols: [
          { uuid: 'a', ref: 'R1', value: '10k', x: 50, y: 50 },
          { uuid: 'b', ref: 'R2', value: '1k', x: 70, y: 50 },
          { uuid: 'c', ref: 'R3', value: '1k', x: 90, y: 50 },
        ],
        wires: [[50, 40, 70, 40]],
        labels: [{ text: 'SDA', x: 50, y: 40 }],
      }),
    });
    const after = await load({
      'demo.kicad_sch': schematic({
        symbols: [
          { uuid: 'a', ref: 'R1', value: '4k7', x: 50, y: 50 },
          { uuid: 'b', ref: 'R2', value: '1k', x: 75, y: 50 },
          { uuid: 'd', ref: 'R4', value: '100', x: 110, y: 50, dnp: true },
        ],
        wires: [[50, 40, 80, 40]],
        labels: [{ text: 'SDA0', x: 50, y: 40 }],
      }),
    });
    const { changes, changedSheets } = diffSchematic({ before, after });
    const byTitle = Object.fromEntries(changes.filter((c) => c.category === 'component').map((c) => [c.title, c]));
    expect(byTitle['R1']).toMatchObject({ kind: 'modified', summary: 'Value 10k → 4k7' });
    expect(byTitle['R2']).toMatchObject({ kind: 'modified', summary: 'Moved' });
    expect(byTitle['R3']).toMatchObject({ kind: 'removed' });
    expect(byTitle['R4']).toMatchObject({ kind: 'added' });
    expect(changes.find((c) => c.category === 'label')).toMatchObject({ kind: 'modified', summary: 'Renamed SDA → SDA0' });
    expect(changes.filter((c) => c.category === 'wiring')).toHaveLength(1);
    expect(changedSheets).toEqual(['/']);
    for (const c of changes) expect(c.locations[0]?.bbox).toBeDefined();
  });

  it('diffs connectivity and detects renamed nets', async () => {
    const sch = await load({ 'demo.kicad_sch': schematic({ symbols: [{ uuid: 'a', ref: 'R1', value: '1k', x: 50, y: 50 }] }) });
    const nl = (nets: Record<string, string[]>) =>
      parseNetlist(
        `(export (version "E") (nets ${Object.entries(nets)
          .map(([n, pins]) => `(net (code "1") (name "${n}") ${pins.map((p) => `(node (ref "${p.split('.')[0]}") (pin "${p.split('.')[1]}"))`).join(' ')})`)
          .join(' ')}))`,
      );
    const { changes } = diffSchematic({
      before: sch,
      after: sch,
      netlistBefore: nl({ GND: ['R1.2', 'C1.2'], 'Net-(R1-Pad1)': ['R1.1', 'U1.3'], VCC: ['U1.1'] }),
      netlistAfter: nl({ GND: ['R1.2', 'C1.2', 'C2.2'], SDA: ['R1.1', 'U1.3'], '+3V3': ['U1.1'] }),
    });
    const nets = changes.filter((c) => c.category === 'net');
    expect(nets.find((c) => c.title === 'SDA')?.summary).toBe('Net renamed Net-(R1-Pad1) → SDA');
    expect(nets.find((c) => c.title === 'GND')?.summary).toContain('+C2.2');
    // VCC → +3V3 with identical pins is a rename as well.
    expect(nets.find((c) => c.title === '+3V3')?.kind).toBe('modified');
    expect(nets.find((c) => c.title === 'SDA')!.locations[0]!.sheet).toBe('/');
  });
});

describe('diffPcb', () => {
  const base = {
    footprints: [
      { uuid: 'f1', ref: 'R1', value: '10k', x: 10, y: 10 },
      { uuid: 'f2', ref: 'R2', value: '1k', x: 20, y: 10 },
    ],
    tracks: [{ x1: 10, y1: 10, x2: 20, y2: 10, net: 1 }],
    vias: [{ x: 15, y: 12, net: 1 }],
  };

  it('parses layers, nets and used layers', () => {
    const p = parsePcb(pcb(base));
    expect(p.layers.find((l) => l.name === 'F.SilkS')?.userName).toBe('F.Silkscreen');
    expect(p.tracks[0]!.net).toBe('GND');
    expect(p.usedLayers).toEqual(expect.arrayContaining(['F.Cu', 'B.Cu', 'Edge.Cuts', 'F.SilkS']));
    expect(p.boardBox).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 40 });
  });

  it('reports footprint, routing and outline changes', () => {
    const before = parsePcb(pcb(base));
    const after = parsePcb(
      pcb({
        footprints: [
          { uuid: 'f1', ref: 'R1', value: '10k', x: 12, y: 10, rot: 90 },
          { uuid: 'f2', ref: 'R2', value: '1k', x: 20, y: 10, side: 'B' },
          { uuid: 'f3', ref: 'R3', value: '0R', x: 30, y: 10, nets: ['SIG', 'GND'] },
        ],
        tracks: [
          { x1: 10, y1: 10, x2: 15, y2: 10, net: 1 },
          { x1: 15, y1: 10, x2: 20, y2: 10, net: 1 },
        ],
        vias: [],
        outline: [0, 0, 60, 40],
      }),
    );
    const { changes, changedLayers } = diffPcb(before, after);
    const t = (title: string) => changes.find((c) => c.title === title);
    expect(t('R1')).toMatchObject({ kind: 'modified', summary: 'Moved' });
    expect(t('R2')?.summary).toBe('Flipped to back');
    expect(t('R3')).toMatchObject({ kind: 'added' });
    expect(t('GND')).toMatchObject({ category: 'routing', summary: 'segments +2/−1, vias +0/−1' });
    expect(t('Board outline')).toMatchObject({ category: 'board', kind: 'modified' });
    expect(changedLayers).toEqual(expect.arrayContaining(['F.Cu', 'B.Cu', 'Edge.Cuts']));
  });

  it('reports nothing for identical boards', () => {
    expect(diffPcb(parsePcb(pcb(base)), parsePcb(pcb(base))).changes).toEqual([]);
  });
});

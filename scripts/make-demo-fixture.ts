/**
 * Writes test/fixtures/demo: a tiny two-sheet project plus board, generated
 * from the synthetic test documents (no proprietary designs in this repo).
 * Run: npx esbuild scripts/make-demo-fixture.ts --bundle --platform=node | node
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pcb, schematic, subSheet } from '../packages/core/test/fixtures';

const dir = path.resolve('test/fixtures/demo');
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'demo.kicad_sch'),
  schematic({
    symbols: [
      { uuid: '7a0c1a52-0000-4000-8000-000000000001', ref: 'R1', value: '10k', x: 50.8, y: 50.8 },
      { uuid: '7a0c1a52-0000-4000-8000-000000000002', ref: 'R2', value: '4k7', x: 76.2, y: 50.8 },
    ],
    wires: [[50.8, 46.99, 76.2, 46.99]],
    labels: [{ text: 'SDA', x: 50.8, y: 46.99 }],
    sheets: [{ uuid: 'sub-uuid', name: 'Power', file: 'power.kicad_sch' }],
  }),
);
writeFileSync(path.join(dir, 'power.kicad_sch'), subSheet([{ uuid: '7a0c1a52-0000-4000-8000-000000000003', ref: 'R3', value: '0R', x: 60.96, y: 60.96 }]));
writeFileSync(
  path.join(dir, 'demo.kicad_pcb'),
  pcb({
    footprints: [
      { uuid: '7a0c1a52-0000-4000-8000-0000000000f1', ref: 'R1', value: '10k', x: 110, y: 90 },
      { uuid: '7a0c1a52-0000-4000-8000-0000000000f2', ref: 'R2', value: '4k7', x: 120, y: 90 },
    ],
    tracks: [{ x1: 110.8, y1: 90, x2: 119.2, y2: 90, net: 2 }],
    vias: [{ x: 115, y: 93, net: 1 }],
    outline: [100, 80, 140, 105],
  }),
);
writeFileSync(path.join(dir, 'demo.kicad_pro'), JSON.stringify({ meta: { filename: 'demo.kicad_pro', version: 1 } }, null, 2));
console.log(`wrote ${dir}`);

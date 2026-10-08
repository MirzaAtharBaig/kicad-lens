import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RenderManifest } from '../cli/render';
import { type Netlist, parseNetlist } from '../model/netlist';
import { parsePcb } from '../model/pcb';
import { type Snapshot, decode } from '../snapshot/snapshot';
import { diffPcb } from './pcb';
import { diffSchematic } from './schematic';
import type { DiffResult } from './types';

async function loadNetlist(m?: RenderManifest): Promise<Netlist | undefined> {
  if (!m?.netlist) return undefined;
  try {
    return parseNetlist(await readFile(path.join(m.dir, m.netlist), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Semantic diff of two snapshots of the same document. Render manifests supply netlists. */
export async function semanticDiff(
  before: Snapshot,
  after: Snapshot,
  renders?: { before?: RenderManifest; after?: RenderManifest },
): Promise<DiffResult> {
  if (before.kind !== after.kind) throw new Error('Cannot compare a schematic with a PCB');
  if (before.kind === 'pcb') {
    return diffPcb(parsePcb(decode(before.files.get(before.entry)!)), parsePcb(decode(after.files.get(after.entry)!)));
  }
  return diffSchematic({
    before: before.schematic!,
    after: after.schematic!,
    netlistBefore: await loadNetlist(renders?.before),
    netlistAfter: await loadNetlist(renders?.after),
  });
}

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type Schematic, loadSchematic } from '../model/schematic';

/**
 * Reads files of one project revision (working tree, a git commit, …).
 * Paths are relative to the directory containing the opened file, using `/`.
 */
export interface RevisionSource {
  /** Human label, e.g. `HEAD`, `a1b2c3d`, `Working tree`. */
  label: string;
  read(relPath: string): Promise<Uint8Array | undefined>;
}

export interface Snapshot {
  kind: 'sch' | 'pcb';
  /** Entry file name, e.g. `board.kicad_pcb`. */
  entry: string;
  /** All files of the snapshot (relative path → content). */
  files: Map<string, Uint8Array>;
  /** sha256 over all file names + contents; identifies the snapshot. */
  hash: string;
  schematic?: Schematic;
}

const decoder = new TextDecoder('utf-8');
export const decode = (b: Uint8Array) => decoder.decode(b);

function hashFiles(files: Map<string, Uint8Array>): string {
  const h = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    h.update(name);
    h.update('\0');
    h.update(files.get(name)!);
    h.update('\0');
  }
  return h.digest('hex');
}

function projectFile(entry: string): string {
  return entry.replace(/\.kicad_(sch|pcb)$/, '.kicad_pro');
}

/**
 * Find the root sheet for a schematic: the `.kicad_sch` named after the project
 * when it exists, otherwise the file itself.
 */
export async function findRootSheet(entry: string, src: RevisionSource, projectNames: string[]): Promise<string> {
  for (const pro of projectNames) {
    const root = pro.replace(/\.kicad_pro$/, '.kicad_sch');
    if (root !== entry && (await src.read(root))) return root;
  }
  return entry;
}

/** Collect everything kicad-cli needs to render `entry` at one revision. */
export async function takeSnapshot(entry: string, src: RevisionSource): Promise<Snapshot> {
  const files = new Map<string, Uint8Array>();
  const kind = entry.endsWith('.kicad_pcb') ? 'pcb' : 'sch';
  let schematic: Schematic | undefined;

  if (kind === 'sch') {
    const texts = new Map<string, Uint8Array>();
    schematic = await loadSchematic(entry, async (p) => {
      const b = await src.read(p);
      if (b) texts.set(p, b);
      return b ? decode(b) : undefined;
    });
    for (const [k, v] of texts) files.set(k, v);
  } else {
    const b = await src.read(entry);
    if (!b) throw new Error(`${entry} does not exist in ${src.label}`);
    files.set(entry, b);
  }

  // The project file carries text variables, net classes and drawing settings.
  const pro = projectFile(schematic?.rootFile ?? entry);
  const proData = await src.read(pro);
  if (proData) files.set(pro, proData);

  return { kind, entry: schematic?.rootFile ?? entry, files, hash: hashFiles(files), schematic };
}

/** Write a snapshot into `dir`, mirroring relative paths. */
export async function writeSnapshot(snap: Snapshot, dir: string): Promise<void> {
  for (const [rel, data] of snap.files) {
    const root = path.resolve(dir);
    const target = path.resolve(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside snapshot dir: ${rel}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

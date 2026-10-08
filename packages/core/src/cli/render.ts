import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type Pcb, layerSvgName, parsePcb } from '../model/pcb';
import { sheetSvgName } from '../model/schematic';
import { type Snapshot, decode, writeSnapshot } from '../snapshot/snapshot';
import type { CliRunner } from './kicadCli';

export interface SheetRender {
  path: string;
  namePath: string;
  name: string;
  page: string;
  file: string;
  /** SVG file name inside the render directory (absent if kicad-cli produced none). */
  svg?: string;
  /** Black-and-white variant used as an alpha mask in overlay diffs. */
  mask?: string;
  width: number;
  height: number;
}

export interface LayerRender {
  name: string;
  userName: string;
  type: string;
  svg?: string;
}

export interface RenderManifest {
  version: 1;
  kind: 'sch' | 'pcb';
  snapshotHash: string;
  kicadVersion: string;
  /** Absolute directory holding the SVGs and this manifest. */
  dir: string;
  sheets?: SheetRender[];
  layers?: LayerRender[];
  /** Page size in mm (all SVGs share this coordinate system). */
  page: { width: number; height: number };
  /** Netlist file name (schematics only). */
  netlist?: string;
  warnings: string[];
}

export interface RenderOptions {
  showDrawingSheet: boolean;
  signal?: AbortSignal;
}

const MANIFEST = 'manifest.json';

async function dirSize(dir: string): Promise<number> {
  let size = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    size += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return size;
}
const RENDER_VERSION = 3; // bump when output layout changes

export class RenderCache {
  private readonly inflight = new Map<string, Promise<RenderManifest>>();

  constructor(readonly root: string, readonly runner: CliRunner, private readonly maxBytes = 1024 * 1024 * 1024) {}

  key(snap: Snapshot, opts: RenderOptions): string {
    return createHash('sha256')
      .update(`${RENDER_VERSION}|${snap.hash}|${this.runner.cli.version}|${opts.showDrawingSheet}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** Render (or fetch from cache) a snapshot. Concurrent requests share one job. */
  render(snap: Snapshot, opts: RenderOptions): Promise<RenderManifest> {
    const key = this.key(snap, opts);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.renderUncached(key, snap, opts).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async renderUncached(key: string, snap: Snapshot, opts: RenderOptions): Promise<RenderManifest> {
    const dir = path.join(this.root, key);
    const manifestPath = path.join(dir, MANIFEST);
    if (existsSync(manifestPath)) {
      const now = new Date();
      await utimes(dir, now, now).catch(() => undefined); // LRU touch
      const m = JSON.parse(await readFile(manifestPath, 'utf8')) as RenderManifest;
      return { ...m, dir };
    }

    const work = `${dir}.tmp-${process.pid}-${Date.now()}`;
    const src = path.join(work, 'src');
    const out = path.join(work, 'out');
    await mkdir(out, { recursive: true });
    try {
      await writeSnapshot(snap, src);
      const manifest = snap.kind === 'sch' ? await this.renderSch(snap, src, out, opts) : await this.renderPcb(snap, src, out, opts);
      await writeFile(path.join(out, MANIFEST), JSON.stringify({ ...manifest, dir: '' }, null, 1));
      await rm(dir, { recursive: true, force: true });
      await rename(out, dir);
      void this.evict();
      return { ...manifest, dir };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async renderSch(snap: Snapshot, src: string, out: string, opts: RenderOptions): Promise<RenderManifest> {
    const sch = snap.schematic!;
    const entry = path.join(src, ...snap.entry.split('/'));
    const svgArgs = (dir: string, bw: boolean) => [
      'sch', 'export', 'svg', '-o', dir + path.sep, '--no-background-color',
      ...(bw ? ['--black-and-white'] : []),
      ...(opts.showDrawingSheet ? [] : ['--exclude-drawing-sheet']),
      entry,
    ];
    const warnings: string[] = [];
    // Colour SVGs for viewing; black-and-white ones (no body fills) as diff masks.
    const bwDir = path.join(out, 'bw');
    await mkdir(bwDir);
    await Promise.all([
      this.runner.exec(svgArgs(out, false), { cwd: src, signal: opts.signal, timeoutMs: 300_000 }),
      this.runner.exec(svgArgs(bwDir, true), { cwd: src, signal: opts.signal, timeoutMs: 300_000 }),
    ]);

    let netlist: string | undefined;
    try {
      await this.runner.exec(['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', path.join(out, 'netlist.net'), entry], {
        cwd: src,
        signal: opts.signal,
      });
      netlist = 'netlist.net';
    } catch (e) {
      warnings.push(`Netlist export failed: ${(e as Error).message}`);
    }

    const produced = new Set(await readdir(out));
    const producedBw = new Set(await readdir(bwDir));
    const sheets: SheetRender[] = sch.sheets.map((s) => {
      const svg = sheetSvgName(sch.projectName, s.namePath);
      if (!produced.has(svg)) warnings.push(`No SVG for sheet ${s.namePath}`);
      return {
        mask: producedBw.has(svg) ? `bw/${svg}` : undefined,
        path: s.path,
        namePath: s.namePath,
        name: s.namePath === '/' ? sch.projectName : s.namePath.replace(/\/$/, '').replace(/^.*\//, ''),
        page: s.page,
        file: s.file,
        svg: produced.has(svg) ? svg : undefined,
        width: s.paper.width,
        height: s.paper.height,
      };
    });
    const first = sch.sheets[0]!;
    return {
      version: 1, kind: 'sch', snapshotHash: snap.hash, kicadVersion: this.runner.cli.version, dir: '',
      sheets, page: first.paper, netlist, warnings,
    };
  }

  private async renderPcb(snap: Snapshot, src: string, out: string, opts: RenderOptions): Promise<RenderManifest> {
    const pcb: Pcb = parsePcb(decode(snap.files.get(snap.entry)!));
    const entry = path.join(src, ...snap.entry.split('/'));
    const boardName = path.basename(snap.entry, '.kicad_pcb');
    const layers = pcb.layers.filter((l) => pcb.usedLayers.includes(l.name));
    const warnings: string[] = [];
    const base = ['pcb', 'export', 'svg', '--black-and-white', '--page-size-mode', '0'];
    if (!opts.showDrawingSheet) base.push('--exclude-drawing-sheet');

    const result: LayerRender[] = layers.map((l) => ({ name: l.name, userName: l.userName, type: l.type }));
    if (this.runner.cli.major >= 9) {
      await this.runner.exec([...base, '--mode-multi', '-o', out + path.sep, '--layers', layers.map((l) => l.name).join(','), entry], {
        cwd: src, signal: opts.signal, timeoutMs: 600_000,
      });
      const produced = new Set(await readdir(out));
      for (const [i, l] of layers.entries()) {
        const svg = layerSvgName(boardName, l);
        if (produced.has(svg)) result[i]!.svg = svg;
        else warnings.push(`No SVG for layer ${l.name}`);
      }
    } else {
      // KiCad 7/8: one invocation per layer.
      await Promise.all(
        layers.map(async (l, i) => {
          const svg = `layer-${l.name.replace(/\./g, '_')}.svg`;
          try {
            await this.runner.exec([...base, '-o', path.join(out, svg), '--layers', l.name, entry], { cwd: src, signal: opts.signal, timeoutMs: 300_000 });
            result[i]!.svg = svg;
          } catch (e) {
            warnings.push(`Layer ${l.name}: ${(e as Error).message}`);
          }
        }),
      );
    }
    return {
      version: 1, kind: 'pcb', snapshotHash: snap.hash, kicadVersion: this.runner.cli.version, dir: '',
      layers: result, page: pcb.paper, warnings,
    };
  }

  /** Remove least-recently-used renders until the cache fits in `maxBytes`. */
  async evict(): Promise<void> {
    let entries: { dir: string; size: number; time: number }[] = [];
    try {
      for (const name of await readdir(this.root)) {
        if (name.includes('.tmp-')) continue;
        const dir = path.join(this.root, name);
        const st = await stat(dir);
        entries.push({ dir, size: await dirSize(dir), time: st.mtimeMs });
      }
    } catch {
      return;
    }
    let total = entries.reduce((s, e) => s + e.size, 0);
    entries = entries.sort((a, b) => a.time - b.time);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      await rm(e.dir, { recursive: true, force: true }).catch(() => undefined);
      total -= e.size;
    }
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

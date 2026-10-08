import {
  CliRunner,
  type DiffResult,
  type ItemView,
  type KicadCli,
  KicadCliError,
  type RenderManifest,
  RenderCache,
  type RevisionSource,
  type RevisionView,
  type Snapshot,
  findRootSheet,
  fsSource,
  gitSource,
  locateKicadCli,
  parsePcb,
  decode,
  semanticDiff,
  takeSnapshot,
} from '@kicad-lens/core';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getGit } from './git';

/** A document at one revision. `ref` undefined = working tree, '' = index. */
export interface RevisionSpec {
  /** Absolute path of the document in the work tree. */
  fsPath: string;
  ref?: string;
  label: string;
}

export interface LoadedRevision {
  spec: RevisionSpec;
  snapshot: Snapshot;
  manifest: RenderManifest;
  /** Sheet (namePath) of the opened file inside the hierarchy. */
  focusSheet?: string;
}

export class RenderService implements vscode.Disposable {
  private cliPromise?: Promise<KicadCli>;
  private cache?: RenderCache;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly log: vscode.OutputChannel,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.status.command = 'kicadLens.showLog';
    this.disposables.push(
      this.status,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kicadLens.kicadCliPath') || e.affectsConfiguration('kicadLens.cacheSizeMB')) this.reset();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.reset()),
    );
  }

  get cacheRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'renders');
  }

  reset(): void {
    this.cliPromise = undefined;
    this.cache = undefined;
  }

  /** Configured kicad-cli path; workspace values are ignored in untrusted workspaces. */
  private configuredCliPath(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('kicadLens').inspect<string>('kicadCliPath');
    const value = vscode.workspace.isTrusted
      ? (cfg?.workspaceFolderValue ?? cfg?.workspaceValue ?? cfg?.globalValue)
      : cfg?.globalValue;
    return value?.trim() || undefined;
  }

  cli(): Promise<KicadCli> {
    if (!this.cliPromise) {
      this.cliPromise = locateKicadCli(this.configuredCliPath()).then(
        (cli) => {
          this.log.appendLine(`Using kicad-cli ${cli.version} at ${cli.path}`);
          this.status.text = `$(circuit-board) KiCad ${cli.version}`;
          this.status.tooltip = `KiCad Lens: ${cli.path}`;
          this.status.show();
          return cli;
        },
        (e: unknown) => {
          this.cliPromise = undefined;
          throw e;
        },
      );
    }
    return this.cliPromise;
  }

  private async renderCache(): Promise<RenderCache> {
    if (!this.cache) {
      const cli = await this.cli();
      const mb = vscode.workspace.getConfiguration('kicadLens').get<number>('cacheSizeMB', 1024);
      this.cache = new RenderCache(this.cacheRoot.fsPath, new CliRunner(cli, undefined, (l) => this.log.appendLine(l)), mb * 1024 * 1024);
    }
    return this.cache;
  }

  async clearCache(): Promise<void> {
    await (await this.renderCache()).clear();
  }

  private async source(spec: RevisionSpec): Promise<RevisionSource> {
    const dir = path.dirname(spec.fsPath);
    if (spec.ref === undefined) return fsSource(dir, spec.label);
    const git = await getGit();
    return gitSource(dir, spec.ref, spec.label, git?.git.path ?? 'git');
  }

  /** Snapshot + render of a document at one revision. */
  async load(spec: RevisionSpec, signal?: AbortSignal): Promise<LoadedRevision> {
    this.setBusy(1);
    try {
      const src = await this.source(spec);
      const dir = path.dirname(spec.fsPath);
      let entry = path.basename(spec.fsPath);
      if (entry.endsWith('.kicad_sch')) {
        const projects = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.kicad_pro'));
        // Prefer the project named like the file, then any other project in the folder.
        projects.sort((a, b) => Number(b === entry.replace('.kicad_sch', '.kicad_pro')) - Number(a === entry.replace('.kicad_sch', '.kicad_pro')));
        entry = await findRootSheet(entry, src, projects);
        // A root sheet that does not include the opened file is the wrong project.
        const snapshot = await takeSnapshot(entry, src);
        const opened = path.basename(spec.fsPath);
        const focus = snapshot.schematic?.sheets.find((s) => s.file === opened);
        const finalSnap = focus ? snapshot : await takeSnapshot(opened, src);
        const manifest = await (await this.renderCache()).render(finalSnap, { showDrawingSheet: this.showDrawingSheet(), signal });
        return { spec, snapshot: finalSnap, manifest, focusSheet: (focus ?? finalSnap.schematic?.sheets[0])?.namePath };
      }
      const snapshot = await takeSnapshot(entry, src);
      const manifest = await (await this.renderCache()).render(snapshot, { showDrawingSheet: this.showDrawingSheet(), signal });
      return { spec, snapshot, manifest };
    } finally {
      this.setBusy(-1);
    }
  }

  async diff(before: LoadedRevision, after: LoadedRevision): Promise<DiffResult> {
    return semanticDiff(before.snapshot, after.snapshot, { before: before.manifest, after: after.manifest });
  }

  private showDrawingSheet(): boolean {
    return vscode.workspace.getConfiguration('kicadLens').get<boolean>('showDrawingSheet', true);
  }

  private setBusy(delta: number): void {
    this.busy += delta;
    if (this.busy > 0) {
      this.status.text = '$(sync~spin) KiCad Lens: rendering…';
      this.status.show();
    } else if (this.cliPromise) {
      void this.cliPromise.then((c) => (this.status.text = `$(circuit-board) KiCad ${c.version}`)).catch(() => undefined);
    }
  }

  /** Convert a loaded revision into what the webview needs, mapping files to webview URLs. */
  toView(rev: LoadedRevision, webview: vscode.Webview, urlMap: Map<string, string>): RevisionView {
    const url = (file?: string) => {
      if (!file) return undefined;
      const fsPath = path.join(rev.manifest.dir, ...file.split('/'));
      const u = webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
      urlMap.set(u, fsPath);
      return u;
    };
    const m = rev.manifest;
    const items: ItemView[] = [];
    if (m.kind === 'sch') {
      const sch = rev.snapshot.schematic!;
      for (const s of sch.sheets)
        for (const sym of s.symbols)
          if (!sym.reference.startsWith('#')) items.push({ ref: sym.reference, value: sym.properties['Value'] ?? '', sheet: s.namePath, bbox: sym.bbox });
      return {
        label: rev.spec.label,
        kind: 'sch',
        page: m.page,
        sheets: (m.sheets ?? []).map((s) => {
          const inst = sch.sheets.find((x) => x.namePath === s.namePath);
          return {
            id: s.namePath,
            name: s.name,
            page: s.page,
            file: s.file,
            svgUrl: url(s.svg),
            maskUrl: url(s.mask),
            width: s.width,
            height: s.height,
            links: (inst?.sheetFrames ?? []).map((f) => ({ bbox: f.bbox, target: `${s.namePath}${f.name}/` })),
          };
        }),
        items,
        warnings: m.warnings,
      };
    }
    const pcb = parsePcb(decode(rev.snapshot.files.get(rev.snapshot.entry)!));
    for (const f of pcb.footprints) items.push({ ref: f.reference, value: f.value, layer: f.side === 'back' ? 'B.Cu' : 'F.Cu', bbox: f.bbox });
    return {
      label: rev.spec.label,
      kind: 'pcb',
      page: m.page,
      layers: (m.layers ?? []).map((l) => ({ name: l.name, userName: l.userName, type: l.type, svgUrl: url(l.svg) })),
      contentBox: pcb.boardBox,
      items,
      warnings: m.warnings,
    };
  }

  describeError(e: unknown): { message: string; actions: { label: string; command: string }[] } {
    const message = e instanceof KicadCliError && e.stderr ? `${e.message}\n\n${e.stderr}` : e instanceof Error ? e.message : String(e);
    const actions = [{ label: 'Show log', command: 'showLog' }];
    if (/kicad-cli/.test(message)) actions.unshift({ label: 'Set kicad-cli path…', command: 'setCliPath' });
    return { message, actions };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Short human label for a git ref. */
export function refLabel(ref: string | undefined): string {
  if (ref === undefined) return 'Working tree';
  if (ref === '') return 'Index';
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

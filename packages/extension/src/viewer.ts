import type { Change, HostMessage } from '@kicad-lens/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffPanels } from './diffPanel';
import { getGit, normalizeRef, parseGitUri } from './git';
import { LensWebview } from './lensWebview';
import { type LoadedRevision, type RenderService, type RevisionSpec, refLabel } from './service';

export function specFromUri(uri: vscode.Uri): RevisionSpec {
  const g = parseGitUri(uri);
  if (g) {
    const ref = normalizeRef(g.ref);
    return { fsPath: g.path, ref, label: refLabel(ref) };
  }
  return { fsPath: uri.fsPath, ref: undefined, label: 'Working tree' };
}

interface Entry {
  uri: vscode.Uri;
  spec: RevisionSpec;
  lens: LensWebview;
  panel: vscode.WebviewPanel;
  rev?: LoadedRevision;
  peer?: Entry;
  side?: 'left' | 'right';
  /** Bumped on every (re)load so stale pair diffs are dropped. */
  generation: number;
}

/** Older revisions go on the left: HEAD/commit < index < working tree. */
function age(spec: RevisionSpec): number {
  return spec.ref === undefined ? 2 : spec.ref === '' ? 1 : 0;
}

/** Read-only custom editor for .kicad_sch / .kicad_pcb. */
export class ViewerProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'kicadLens.viewer';
  private readonly entries = new Set<Entry>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: RenderService,
    private readonly diffs: DiffPanels,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const lens = new LensWebview(panel.webview, this.context, this.service);
    const entry: Entry = { uri: doc.uri, spec: specFromUri(doc.uri), lens, panel, generation: 0 };
    const t0 = Date.now();
    this.service.log.appendLine(`Resolving viewer for ${doc.uri.toString()}`);
    this.entries.add(entry);
    const abort = new AbortController();
    const disposables: vscode.Disposable[] = [lens];

    lens.onCommand = (cmd) => {
      if (cmd === 'openAsText') void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
      if (cmd === 'openFullDiff' && entry.peer) {
        const [l, r] = entry.side === 'left' ? [entry, entry.peer] : [entry.peer, entry];
        void this.diffs.open(l.spec, r.spec);
      }
    };
    lens.onViewport = (m) => entry.peer?.lens.post({ type: 'viewport', viewport: m.viewport, sheet: m.sheet, flipped: m.flipped });

    disposables.push(
      panel.onDidChangeViewState(() => {
        if (panel.active) void vscode.commands.executeCommand('setContext', 'kicadLens.activeKicadFile', true);
        if (panel.visible) this.tryPair(entry);
      }),
    );

    const load = async () => {
      const gen = ++entry.generation;
      lens.post({ type: 'loading', message: `Rendering ${path.basename(entry.spec.fsPath)} (${entry.spec.label})…` });
      try {
        const rev = await this.service.load(entry.spec, abort.signal);
        if (gen !== entry.generation) return;
        entry.rev = rev;
        this.service.log.appendLine(`Loaded ${entry.spec.label} of ${entry.spec.fsPath} (${doc.uri.scheme}, ${Date.now() - t0} ms, visible=${panel.visible}, column=${panel.viewColumn}, viewers=${this.entries.size})`);
        if (entry.peer) await this.showPair(entry, entry.peer);
        else {
          this.showSingle(entry);
          this.tryPair(entry);
        }
        if (entry.spec.ref === undefined) void this.prerenderHead(entry.spec);
      } catch (e) {
        if (abort.signal.aborted) return;
        const { message, actions } = this.service.describeError(e);
        this.service.log.appendLine(`Render failed for ${entry.spec.fsPath}: ${message}`);
        lens.post({ type: 'error', message, actions });
      }
    };

    if (doc.uri.scheme === 'file') {
      // Re-render when KiCad saves the file or any sheet/project file next to it.
      const dir = vscode.Uri.file(path.dirname(doc.uri.fsPath));
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.{kicad_sch,kicad_pcb,kicad_pro}'));
      let timer: NodeJS.Timeout | undefined;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 800);
      };
      disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), { dispose: () => clearTimeout(timer) });
    }

    panel.onDidDispose(() => {
      abort.abort();
      this.entries.delete(entry);
      const peer = entry.peer;
      if (peer) {
        peer.peer = undefined;
        peer.side = undefined;
        this.showSingle(peer);
      }
      disposables.forEach((d) => d.dispose());
    });

    await load();
  }

  private showSingle(entry: Entry): void {
    if (!entry.rev) return;
    entry.lens.urls.clear();
    const msg: HostMessage = {
      type: 'show',
      mode: 'view',
      title: `${path.basename(entry.spec.fsPath)} — ${entry.spec.label}`,
      after: this.service.toView(entry.rev, entry.panel.webview, entry.lens.urls),
      diffMode: 'overlay',
      initialSheet: entry.rev.focusSheet,
    };
    entry.lens.post(msg);
  }

  /**
   * Each side of VS Code's built-in diff gets both revisions: the left side
   * highlights what was removed, the right side what was added.
   */
  private async showPair(a: Entry, b: Entry): Promise<void> {
    if (!a.rev || !b.rev) return;
    const [left, right] = a.side === 'left' ? [a, b] : [b, a];
    const gens = [left.generation, right.generation];
    let changes: Change[];
    try {
      changes = (await this.service.diff(left.rev!, right.rev!)).changes;
    } catch (e) {
      this.service.log.appendLine(`Diff failed: ${String(e)}`);
      changes = [];
    }
    if (left.generation !== gens[0] || right.generation !== gens[1] || left.peer !== right) return;
    this.service.log.appendLine(`Side-by-side diff ${left.spec.label} ↔ ${right.spec.label}: ${changes.length} changes`);
    for (const e of [left, right]) {
      e.lens.urls.clear();
      e.lens.post({
        type: 'show',
        mode: 'diff',
        title: `${path.basename(e.spec.fsPath)} — ${e.spec.label}`,
        before: this.service.toView(left.rev!, e.panel.webview, e.lens.urls),
        after: this.service.toView(right.rev!, e.panel.webview, e.lens.urls),
        changes,
        diffMode: 'overlay',
        initialSheet: changes.find((c) => c.locations[0]?.sheet)?.locations[0]?.sheet ?? e.rev!.focusSheet,
        pairedWith: e.side,
      });
    }
  }

  /**
   * VS Code's built-in diff shows two instances of this editor side by side.
   * Find the counterpart and link them: synced pan/zoom plus highlighted changes.
   */
  private tryPair(entry: Entry): void {
    if (entry.peer || !vscode.workspace.getConfiguration('kicadLens').get<boolean>('syncStockDiff', true)) return;
    const peer = this.findPeerFromTabs(entry) ?? this.findPeerByLayout(entry);
    if (!peer) {
      const others = [...this.entries].filter((e) => e !== entry && e.spec.fsPath === entry.spec.fsPath);
      if (others.length)
        this.service.log.appendLine(
          `No pair for ${entry.spec.label} (visible=${entry.panel.visible}, column=${entry.panel.viewColumn}); candidates: ${others
            .map((e) => `${e.spec.label} visible=${e.panel.visible} column=${e.panel.viewColumn} peer=${!!e.peer}`)
            .join('; ')}; active tab input keys: ${Object.keys(vscode.window.tabGroups.activeTabGroup.activeTab?.input ?? {}).join(',')}`,
        );
      return;
    }
    entry.peer = peer;
    peer.peer = entry;
    const entryLeft = age(entry.spec) < age(peer.spec) || (age(entry.spec) === age(peer.spec) && entry.uri.scheme === 'git');
    entry.side = entryLeft ? 'left' : 'right';
    peer.side = entryLeft ? 'right' : 'left';
    this.service.log.appendLine(`Paired ${entry.spec.label} ↔ ${peer.spec.label} for ${path.basename(entry.spec.fsPath)}`);
    void this.showPair(entry, peer);
  }

  /** Diff tabs that expose original/modified URIs. */
  private findPeerFromTabs(entry: Entry): Entry | undefined {
    const key = entry.uri.toString();
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs) {
        const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
        if (!input?.original || !input.modified) continue;
        const o = input.original.toString();
        const m = input.modified.toString();
        if (o !== key && m !== key) continue;
        const other = o === key ? m : o;
        const peer = [...this.entries].find((e) => e !== entry && !e.peer && e.uri.toString() === other);
        if (peer) return peer;
      }
    return undefined;
  }

  /**
   * Custom-editor diffs often don't appear as diff tabs in the tab API. Fall back to:
   * another visible viewer of the same file at a different revision in the same column.
   */
  private findPeerByLayout(entry: Entry): Entry | undefined {
    if (!entry.panel.visible) return undefined;
    return [...this.entries].find(
      (e) =>
        e !== entry &&
        !e.peer &&
        e.panel.visible &&
        e.panel.viewColumn === entry.panel.viewColumn &&
        e.spec.fsPath === entry.spec.fsPath &&
        e.spec.ref !== entry.spec.ref,
    );
  }

  /** Render HEAD in the background for modified files so a diff opens instantly. */
  private async prerenderHead(spec: RevisionSpec): Promise<void> {
    if (!vscode.workspace.getConfiguration('kicadLens').get<boolean>('backgroundPrerender', true)) return;
    const repo = (await getGit())?.getRepository(vscode.Uri.file(spec.fsPath));
    if (!repo) return;
    const changed = [...repo.state.workingTreeChanges, ...repo.state.indexChanges].some((c) => c.uri.fsPath === spec.fsPath);
    if (!changed) return;
    this.service.load({ fsPath: spec.fsPath, ref: 'HEAD', label: 'HEAD' }).catch((e: unknown) => this.service.log.appendLine(`Prerender of HEAD failed: ${String(e)}`));
  }
}

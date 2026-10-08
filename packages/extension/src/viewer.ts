import type { HostMessage } from '@kicad-lens/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffPanels } from './diffPanel';
import { getGit, normalizeRef, parseGitUri } from './git';
import { LensWebview } from './lensWebview';
import { type RenderService, type RevisionSpec, refLabel } from './service';

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
  lens: LensWebview;
  panel: vscode.WebviewPanel;
  lastShow?: Extract<HostMessage, { type: 'show' }>;
  peer?: Entry;
  side?: 'left' | 'right';
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
    const entry: Entry = { uri: doc.uri, lens, panel };
    this.entries.add(entry);
    const abort = new AbortController();
    const disposables: vscode.Disposable[] = [lens];

    lens.onCommand = (cmd) => {
      if (cmd === 'openAsText') void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
      if (cmd === 'openFullDiff' && entry.peer) {
        const [l, r] = entry.side === 'left' ? [entry, entry.peer] : [entry.peer, entry];
        void this.diffs.open(specFromUri(l.uri), specFromUri(r.uri));
      }
    };
    lens.onViewport = (m) => entry.peer?.lens.post({ type: 'viewport', viewport: m.viewport, sheet: m.sheet, flipped: m.flipped });

    const updateContext = () => {
      if (panel.active) void vscode.commands.executeCommand('setContext', 'kicadLens.activeKicadFile', true);
    };
    disposables.push(panel.onDidChangeViewState(updateContext));
    updateContext();

    const load = async () => {
      const spec = specFromUri(doc.uri);
      lens.post({ type: 'loading', message: `Rendering ${path.basename(spec.fsPath)} (${spec.label})…` });
      try {
        const rev = await this.service.load(spec, abort.signal);
        lens.urls.clear();
        entry.lastShow = {
          type: 'show',
          mode: 'view',
          title: `${path.basename(spec.fsPath)} — ${spec.label}`,
          after: this.service.toView(rev, panel.webview, lens.urls),
          diffMode: 'overlay',
          initialSheet: rev.focusSheet,
          pairedWith: entry.side,
        };
        lens.post(entry.lastShow);
        this.tryPair(entry);
        if (spec.ref === undefined) void this.prerenderHead(spec);
      } catch (e) {
        if (abort.signal.aborted) return;
        const { message, actions } = this.service.describeError(e);
        this.service.log.appendLine(`Render failed for ${spec.fsPath}: ${message}`);
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
      if (entry.peer) entry.peer.peer = undefined;
      disposables.forEach((d) => d.dispose());
    });

    await load();
  }

  /**
   * VS Code's built-in diff shows two instances of this editor side by side.
   * Find the counterpart through the tab model and link them for synced pan/zoom.
   */
  private tryPair(entry: Entry): void {
    if (!vscode.workspace.getConfiguration('kicadLens').get<boolean>('syncStockDiff', true) || entry.peer) return;
    const key = entry.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
        if (!input?.original || !input.modified) continue;
        const isLeft = input.original.toString() === key;
        const isRight = input.modified.toString() === key;
        if (!isLeft && !isRight) continue;
        const other = (isLeft ? input.modified : input.original).toString();
        const peer = [...this.entries].find((e) => e !== entry && !e.peer && e.uri.toString() === other);
        if (!peer) continue;
        entry.peer = peer;
        peer.peer = entry;
        entry.side = isLeft ? 'left' : 'right';
        peer.side = isLeft ? 'right' : 'left';
        for (const e of [entry, peer])
          if (e.lastShow) {
            e.lastShow = { ...e.lastShow, pairedWith: e.side };
            e.lens.post(e.lastShow);
          }
        return;
      }
    }
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

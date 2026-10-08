import type { DiffMode } from '@kicad-lens/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LensWebview } from './lensWebview';
import type { RenderService, RevisionSpec } from './service';

const key = (a: RevisionSpec, b: RevisionSpec) => JSON.stringify([a.fsPath, a.ref, b.fsPath, b.ref]);

/** "KiCad Diff" webview panels: overlay / side-by-side / blend / swipe + change list. */
export class DiffPanels implements vscode.Disposable {
  private readonly open_ = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: RenderService,
  ) {}

  async open(before: RevisionSpec, after: RevisionSpec): Promise<void> {
    const k = key(before, after);
    const existing = this.open_.get(k);
    if (existing) return existing.reveal();

    const name = path.basename(after.fsPath);
    const sameFile = before.fsPath === after.fsPath;
    const title = sameFile ? `${name} (${before.label} ↔ ${after.label})` : `${path.basename(before.fsPath)} ↔ ${name}`;
    const panel = vscode.window.createWebviewPanel('kicadLens.diff', title, vscode.ViewColumn.Active, { retainContextWhenHidden: true, enableFindWidget: false });
    this.open_.set(k, panel);

    const lens = new LensWebview(panel.webview, this.context, this.service);
    const abort = new AbortController();
    const disposables: vscode.Disposable[] = [lens];
    lens.onCommand = (cmd) => {
      // vscode.diff would pick this extension's custom editor again, so open the newer side as text.
      if (cmd === 'openAsText') void vscode.commands.executeCommand('vscode.openWith', this.textUri(after), 'default');
    };

    const load = async () => {
      lens.post({ type: 'loading', message: `Rendering ${before.label} and ${after.label}…` });
      try {
        const [b, a] = await Promise.all([this.service.load(before, abort.signal), this.service.load(after, abort.signal)]);
        lens.post({ type: 'loading', message: 'Comparing…' });
        const diff = await this.service.diff(b, a);
        lens.urls.clear();
        lens.post({
          type: 'show',
          mode: 'diff',
          title,
          before: this.service.toView(b, panel.webview, lens.urls),
          after: this.service.toView(a, panel.webview, lens.urls),
          changes: diff.changes,
          diffMode: vscode.workspace.getConfiguration('kicadLens').get<DiffMode>('defaultDiffMode', 'overlay'),
          initialSheet: diff.changedSheets[0] ?? a.focusSheet,
        });
      } catch (e) {
        if (abort.signal.aborted) return;
        const { message, actions } = this.service.describeError(e);
        this.service.log.appendLine(`Diff failed: ${message}`);
        lens.post({ type: 'error', message, actions });
      }
    };

    // Keep working-tree sides live.
    for (const spec of [before, after].filter((s) => s.ref === undefined)) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(spec.fsPath)), '*.{kicad_sch,kicad_pcb,kicad_pro}'));
      let timer: NodeJS.Timeout | undefined;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 800);
      };
      disposables.push(watcher, watcher.onDidChange(reload), { dispose: () => clearTimeout(timer) });
    }

    panel.onDidDispose(() => {
      abort.abort();
      this.open_.delete(k);
      disposables.forEach((d) => d.dispose());
    });
    await load();
  }

  /** URI VS Code's text diff can open for a revision. */
  private textUri(spec: RevisionSpec): vscode.Uri {
    const file = vscode.Uri.file(spec.fsPath);
    if (spec.ref === undefined) return file;
    return file.with({ scheme: 'git', query: JSON.stringify({ path: spec.fsPath, ref: spec.ref === '' ? '~' : spec.ref }) });
  }

  dispose(): void {
    for (const p of this.open_.values()) p.dispose();
  }
}

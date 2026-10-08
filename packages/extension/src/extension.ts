import { probe } from '@kicad-lens/core';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiffPanels } from './diffPanel';
import { type Repository, getGit, normalizeRef } from './git';
import { RenderService, type RevisionSpec, refLabel } from './service';
import { ViewerProvider, specFromUri } from './viewer';

const KICAD_RE = /\.kicad_(sch|pcb)$/;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('KiCad Lens');
  const service = new RenderService(context, log);
  const diffs = new DiffPanels(context, service);
  const viewer = new ViewerProvider(context, service, diffs);

  context.subscriptions.push(
    log,
    service,
    diffs,
    vscode.window.registerCustomEditorProvider(ViewerProvider.viewType, viewer, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const working = (uri: vscode.Uri): RevisionSpec => ({ fsPath: uri.fsPath, ref: undefined, label: 'Working tree' });
  const at = (uri: vscode.Uri, ref: string | undefined, label?: string): RevisionSpec => ({ fsPath: uri.fsPath, ref, label: label ?? refLabel(ref) });

  /** The KiCad file a command applies to: explicit argument, else the active editor. */
  const target = (arg?: unknown): vscode.Uri | undefined => {
    const fromArg = arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri } | undefined)?.resourceUri;
    let uri = fromArg;
    if (!uri) {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) uri = input.uri;
    }
    if (uri?.scheme === 'git') uri = vscode.Uri.file(specFromUri(uri).fsPath);
    if (!uri || !KICAD_RE.test(uri.fsPath)) {
      void vscode.window.showWarningMessage('KiCad Lens: open or select a .kicad_sch or .kicad_pcb file first.');
      return undefined;
    }
    return uri;
  };

  const repoFor = async (uri: vscode.Uri): Promise<Repository | undefined> => {
    const repo = (await getGit())?.getRepository(uri) ?? undefined;
    if (!repo) void vscode.window.showWarningMessage(`KiCad Lens: ${path.basename(uri.fsPath)} is not inside a git repository.`);
    return repo;
  };

  const command = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command('kicadLens.compareWithHead', async (arg?: unknown) => {
    const uri = target(arg);
    if (uri && (await repoFor(uri))) await diffs.open(at(uri, 'HEAD'), working(uri));
  });

  command('kicadLens.compareWithRevision', async (arg?: unknown) => {
    const uri = target(arg);
    const repo = uri && (await repoFor(uri));
    if (!uri || !repo) return;
    const commits = await repo.log({ path: uri.fsPath, maxEntries: 300 });
    if (!commits.length) return void vscode.window.showInformationMessage('KiCad Lens: no commits touch this file.');
    const pick = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: `$(git-commit) ${c.hash.slice(0, 8)}`,
        description: c.message.split('\n')[0],
        detail: [c.authorName, c.authorDate?.toLocaleString()].filter(Boolean).join(' · '),
        hash: c.hash,
      })),
      { title: `Compare ${path.basename(uri.fsPath)} with…`, matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await diffs.open(at(uri, pick.hash, pick.hash.slice(0, 8)), working(uri));
  });

  command('kicadLens.compareWithBranch', async (arg?: unknown) => {
    const uri = target(arg);
    const repo = uri && (await repoFor(uri));
    if (!uri || !repo) return;
    const refs = (await repo.getRefs?.({ sort: 'committerdate' })) ?? repo.state.refs ?? [];
    const kinds = ['$(git-branch)', '$(cloud)', '$(tag)'];
    const pick = await vscode.window.showQuickPick(
      refs
        .filter((r) => r.name)
        .map((r) => ({ label: `${kinds[r.type] ?? ''} ${r.remote && !r.name!.startsWith(r.remote) ? `${r.remote}/` : ''}${r.name}`, description: r.commit?.slice(0, 8), ref: r.remote && !r.name!.startsWith(r.remote) ? `${r.remote}/${r.name}` : r.name! })),
      { title: `Compare ${path.basename(uri.fsPath)} with branch or tag…` },
    );
    if (pick) await diffs.open(at(uri, pick.ref, pick.ref), working(uri));
  });

  command('kicadLens.compareSelected', async (arg?: vscode.Uri, all?: vscode.Uri[]) => {
    const uris = (all ?? (arg ? [arg] : [])).filter((u) => KICAD_RE.test(u.fsPath));
    if (uris.length !== 2) return void vscode.window.showWarningMessage('KiCad Lens: select exactly two KiCad files of the same type.');
    const [a, b] = uris as [vscode.Uri, vscode.Uri];
    if (path.extname(a.fsPath) !== path.extname(b.fsPath)) return void vscode.window.showWarningMessage('KiCad Lens: cannot compare a schematic with a PCB.');
    await diffs.open({ ...working(a), label: path.basename(path.dirname(a.fsPath)) + '/' + path.basename(a.fsPath) }, { ...working(b), label: path.basename(path.dirname(b.fsPath)) + '/' + path.basename(b.fsPath) });
  });

  // Timeline: compare a commit with its parent.
  command('kicadLens.compareTimeline', async (item?: { id?: string; ref?: string; previousRef?: string }, uri?: vscode.Uri) => {
    const file = target(uri);
    if (!file || !item) return;
    const ref = normalizeRef(item.ref ?? item.id ?? '');
    const prev = item.previousRef !== undefined ? normalizeRef(item.previousRef) : ref ? `${ref}~1` : 'HEAD';
    await diffs.open(at(file, prev), at(file, ref));
  });

  // Source Control: index vs working tree, or HEAD vs index for staged files.
  command('kicadLens.openScmDiff', async (state?: vscode.SourceControlResourceState & { resourceGroupType?: number }) => {
    const uri = target(state);
    if (!uri) return;
    switch (state?.resourceGroupType) {
      case 1: // staged
        return diffs.open(at(uri, 'HEAD'), at(uri, ''));
      case 2: // unstaged changes
        return diffs.open(at(uri, ''), working(uri));
      case 3: // untracked: nothing to compare against
        return vscode.commands.executeCommand('vscode.openWith', uri, ViewerProvider.viewType);
      default:
        return diffs.open(at(uri, 'HEAD'), working(uri));
    }
  });

  command('kicadLens.openAsText', async (arg?: unknown) => {
    const uri = target(arg);
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  });

  command('kicadLens.locateKicadCli', async () => {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select kicad-cli',
      canSelectMany: false,
      openLabel: 'Use this kicad-cli',
      filters: process.platform === 'win32' ? { 'kicad-cli': ['exe'] } : undefined,
    });
    if (!picked?.[0]) return;
    try {
      const cli = await probe(picked[0].fsPath);
      await vscode.workspace.getConfiguration('kicadLens').update('kicadCliPath', cli.path, vscode.ConfigurationTarget.Global);
      service.reset();
      void vscode.window.showInformationMessage(`KiCad Lens: using kicad-cli ${cli.version}. Reopen KiCad files to render them.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`KiCad Lens: ${picked[0].fsPath} is not a working kicad-cli (${(e as Error).message}).`);
    }
  });

  command('kicadLens.clearCache', async () => {
    await service.clearCache();
    void vscode.window.showInformationMessage('KiCad Lens: render cache cleared.');
  });

  command('kicadLens.showLog', () => log.show(true));

  const updateActive = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
    void vscode.commands.executeCommand('setContext', 'kicadLens.activeKicadFile', !!uri && KICAD_RE.test(uri.fsPath));
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(updateActive), vscode.window.tabGroups.onDidChangeTabGroups(updateActive));
  updateActive();

  // Locate kicad-cli early so the status bar shows the version; errors surface when a file opens.
  service.cli().catch((e: unknown) => log.appendLine(String((e as Error).message ?? e)));
}

export function deactivate(): void {}

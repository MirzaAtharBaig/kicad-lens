import type { HostMessage, WebviewMessage } from '@kicad-lens/core';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { RenderService } from './service';

/** Wraps one viewer webview (custom editor or diff panel). */
export class LensWebview implements vscode.Disposable {
  /** Webview URL → file path, for the fetch fallback. */
  readonly urls = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  private lastShow?: HostMessage;
  onViewport?: (m: Extract<WebviewMessage, { type: 'viewport' }>) => void;
  onCommand?: (command: string) => void;

  constructor(
    readonly webview: vscode.Webview,
    private readonly context: vscode.ExtensionContext,
    private readonly service: RenderService,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), service.cacheRoot],
    };
    webview.html = this.html();
    this.disposables.push(webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)));
  }

  post(m: HostMessage): void {
    if (m.type === 'show') this.lastShow = m;
    void this.ready.then(() => this.webview.postMessage(m));
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.readyResolve();
        // A webview that was hidden and restored reloads: resend the last view.
        if (this.lastShow) void this.webview.postMessage(this.lastShow);
        return;
      case 'viewport':
        this.onViewport?.(m);
        return;
      case 'focus':
        void vscode.commands.executeCommand('setContext', 'kicadLens.diffFocused', m.focused);
        return;
      case 'fetch': {
        const file = this.urls.get(m.url);
        if (!file) return void this.webview.postMessage({ type: 'fetchResult', id: m.id, error: 'Unknown resource' } satisfies HostMessage);
        try {
          const text = await readFile(file, 'utf8');
          void this.webview.postMessage({ type: 'fetchResult', id: m.id, text } satisfies HostMessage);
        } catch (e) {
          void this.webview.postMessage({ type: 'fetchResult', id: m.id, error: String(e) } satisfies HostMessage);
        }
        return;
      }
      case 'command':
        if (m.command === 'showLog') this.service.log.show(true);
        else if (m.command === 'setCliPath') void vscode.commands.executeCommand('kicadLens.locateKicadCli');
        else this.onCommand?.(m.command);
        return;
    }
  }

  private html(): string {
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const js = this.webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
    const css = this.webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.css'));
    const nonce = randomBytes(16).toString('base64');
    const src = this.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} blob: data:; style-src ${src} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${src}; font-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>KiCad Lens</title>
</head>
<body>
<div class="status-screen"><div class="spinner"></div><div>Loading…</div></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

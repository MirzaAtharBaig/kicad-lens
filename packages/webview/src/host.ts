import type { HostMessage, WebviewMessage } from '@kicad-lens/protocol';

interface VsCodeApi {
  postMessage(m: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
export const post = (m: WebviewMessage) => vscode.postMessage(m);

const blobs = new Map<string, Promise<string>>();
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
let nextId = 1;

export function handleFetchResult(m: Extract<HostMessage, { type: 'fetchResult' }>): void {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.text !== undefined) p.resolve(m.text);
  else p.reject(new Error(m.error ?? 'fetch failed'));
}

function viaHost(url: string): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'fetch', id, url });
  });
}

/**
 * Same-origin blob: URL for an SVG resource. CSS masks need same-origin (or
 * CORS-enabled) images, so we never point masks at the resource URL directly.
 */
export function svgBlobUrl(url: string): Promise<string> {
  let p = blobs.get(url);
  if (!p) {
    p = (async () => {
      let text: string;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        text = await res.text();
      } catch {
        text = await viaHost(url);
      }
      return URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    })();
    p.catch(() => blobs.delete(url));
    blobs.set(url, p);
  }
  return p;
}

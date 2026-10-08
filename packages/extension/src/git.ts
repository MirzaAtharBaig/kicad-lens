/** Minimal typings for the built-in `vscode.git` extension API (v1). */
import * as vscode from 'vscode';

export interface Commit {
  hash: string;
  message: string;
  authorName?: string;
  authorDate?: Date;
}

export interface Ref {
  type: 0 | 1 | 2; // Head, RemoteHead, Tag
  name?: string;
  commit?: string;
  remote?: string;
}

export interface Change {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
}

export interface Repository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; commit?: string };
    workingTreeChanges: Change[];
    indexChanges: Change[];
    refs?: Ref[];
    onDidChange: vscode.Event<void>;
  };
  log(options?: { maxEntries?: number; path?: string }): Promise<Commit[]>;
  getRefs?(query?: { pattern?: string; count?: number; sort?: 'alphabetically' | 'committerdate' }): Promise<Ref[]>;
}

export interface GitAPI {
  git: { path: string };
  repositories: Repository[];
  getRepository(uri: vscode.Uri): Repository | null;
}

let api: GitAPI | undefined;

export async function getGit(): Promise<GitAPI | undefined> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  api = exports.getAPI(1);
  return api;
}

/** Parse a `git:` URI produced by the git extension: query is `{ path, ref }`. */
export function parseGitUri(uri: vscode.Uri): { path: string; ref: string } | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    const q = JSON.parse(uri.query) as { path?: string; ref?: string };
    return { path: q.path ?? uri.fsPath, ref: q.ref ?? 'HEAD' };
  } catch {
    return { path: uri.fsPath, ref: 'HEAD' };
  }
}

/** git extension refs: `~` = index, '' = working tree. Returns our ref convention. */
export function normalizeRef(ref: string): string | undefined {
  if (ref === '~' || ref === ':0') return ''; // index
  if (ref === '') return undefined; // working tree
  return ref;
}

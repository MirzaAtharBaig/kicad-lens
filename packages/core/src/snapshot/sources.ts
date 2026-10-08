import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RevisionSource } from './snapshot';

/** Files on disk, relative to `dir`. */
export function fsSource(dir: string, label = 'Working tree'): RevisionSource {
  return {
    label,
    async read(rel) {
      try {
        return await readFile(path.join(dir, ...rel.split('/')));
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Files of a git revision via `git show <rev>:<path>`.
 * `dir` is the document's directory inside the work tree; an empty `rev`
 * reads from the index (staged content).
 */
export function gitSource(dir: string, rev: string, label = rev || 'Index', gitPath = 'git'): RevisionSource {
  const cache = new Map<string, Promise<Uint8Array | undefined>>();
  return {
    label,
    read(rel) {
      let p = cache.get(rel);
      if (!p) {
        p = new Promise((resolve) => {
          // `./` makes the path relative to cwd instead of the repository root.
          execFile(gitPath, ['show', `${rev}:./${rel}`], { cwd: dir, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
            resolve(err ? undefined : new Uint8Array(stdout)),
          );
        });
        cache.set(rel, p);
      }
      return p;
    },
  };
}

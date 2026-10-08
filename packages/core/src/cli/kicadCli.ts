import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface KicadCli {
  path: string;
  /** e.g. `9.0.2` */
  version: string;
  major: number;
}

export class KicadCliError extends Error {
  constructor(message: string, readonly stderr = '') {
    super(message);
  }
}

function versionDirs(base: string): string[] {
  try {
    return readdirSync(base)
      .filter((d) => /^\d+(\.\d+)*$/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(base, d, 'bin'));
  } catch {
    return [];
  }
}

/** Candidate kicad-cli locations, most preferred first. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const exe = platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli';
  const dirs: string[] = [];
  for (const p of (env.PATH ?? env.Path ?? '').split(path.delimiter)) if (p) dirs.push(p);
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (base) dirs.push(...versionDirs(path.join(base, 'KiCad')));
    if (env.LOCALAPPDATA) dirs.push(...versionDirs(path.join(env.LOCALAPPDATA, 'Programs', 'KiCad')));
  } else if (platform === 'darwin') {
    dirs.push('/Applications/KiCad/KiCad.app/Contents/MacOS', path.join(os.homedir(), 'Applications/KiCad/KiCad.app/Contents/MacOS'));
  } else {
    dirs.push('/usr/bin', '/usr/local/bin', '/var/lib/flatpak/exports/bin', path.join(os.homedir(), '.local/share/flatpak/exports/bin'));
  }
  return dirs.map((d) => path.join(d, exe));
}

function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, signal: opts.signal, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = opts.signal?.aborted ? 'Cancelled' : `kicad-cli failed: ${err.message}`;
          reject(new KicadCliError(msg, String(stderr)));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

export async function probe(file: string): Promise<KicadCli> {
  const out = (await run(file, ['version'], { timeoutMs: 20_000 })).trim();
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  if (!m) throw new KicadCliError(`Unexpected kicad-cli version output: ${out}`);
  return { path: file, version: m[0], major: Number(m[1]) };
}

/** Find a working kicad-cli: explicit setting first, then PATH and install locations. */
export async function locateKicadCli(configured?: string): Promise<KicadCli> {
  const tried: string[] = [];
  const candidates = configured ? [configured] : candidatePaths();
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    tried.push(c);
    try {
      const cli = await probe(c);
      if (cli.major < 7) throw new KicadCliError(`KiCad ${cli.version} is too old; KiCad 7 or newer is required`);
      return cli;
    } catch (e) {
      if (configured) throw e;
    }
  }
  throw new KicadCliError(
    configured
      ? `kicad-cli not found at ${configured}`
      : `kicad-cli was not found. Install KiCad 7+ or set "kicadLens.kicadCliPath".${tried.length ? ` Tried: ${tried.join(', ')}` : ''}`,
  );
}

/** Runs kicad-cli jobs with bounded concurrency. */
export class CliRunner {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly cli: KicadCli, private readonly concurrency = Math.max(1, Math.min(4, os.cpus().length - 1)), private readonly log?: (line: string) => void) {}

  async exec(args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      if (opts.signal?.aborted) throw new KicadCliError('Cancelled');
      this.log?.(`$ kicad-cli ${args.join(' ')}`);
      const t0 = Date.now();
      const out = await run(this.cli.path, args, opts);
      this.log?.(`  done in ${Date.now() - t0} ms`);
      return out;
    } catch (e) {
      this.log?.(`  ${(e as Error).message}\n${(e as KicadCliError).stderr ?? ''}`);
      throw e;
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

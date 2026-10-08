// Launches a real VS Code with the extension and runs test/suite.cjs inside it.
// Requires kicad-cli (KiCad 7+) and git to be installed.
import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('../../../test/fixtures/demo', import.meta.url));
const userData = mkdtempSync(path.join(os.tmpdir(), 'kicad-lens-vscode-'));

// The workspace is a throwaway git repo: the demo project committed, then R1's
// value changed in the working tree, so there is a real diff to show.
const workspace = mkdtempSync(path.join(os.tmpdir(), 'kicad-lens-ws-'));
cpSync(fixture, workspace, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
git('init', '-q');
git('add', '.');
git('-c', 'user.name=KiCad Lens Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'demo');
const sch = path.join(workspace, 'demo.kicad_sch');
writeFileSync(sch, readFileSync(sch, 'utf8').replace('(property "Value" "10k"', '(property "Value" "22k"'));

// When launched from inside VS Code, this would make Electron run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(ext, 'test', 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${userData}`],
    extensionTestsEnv: { KICAD_LENS_USER_DATA: userData },
  });
} finally {
  const log = path.join(userData, 'smoke.log');
  if (existsSync(log)) process.stdout.write(readFileSync(log, 'utf8'));
}

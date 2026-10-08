// Launches a real VS Code with the extension and runs test/suite.cjs inside it.
// Requires kicad-cli (KiCad 7+) to be installed.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('..', import.meta.url));
const workspace = fileURLToPath(new URL('../../../test/fixtures/demo', import.meta.url));
const userData = mkdtempSync(path.join(os.tmpdir(), 'kicad-lens-vscode-'));

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

// Launches the installed VS Code with this extension and runs scripts/integration-test.cjs in it.
//   npm run test:integration -- [file to explain, relative to the project]
// Uses a throwaway profile so it can run while your normal VS Code is open.
// Set VSCODE_EXE if VS Code is not in the default location.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.VSCODE_EXE,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
];
const executable = candidates.find((candidate) => candidate && existsSync(candidate));
if (!executable) {
  console.error('VS Code executable not found; set VSCODE_EXE.');
  process.exit(1);
}

const profile = await mkdtemp(path.join(tmpdir(), 'code-reader-vscode-'));
const output = path.join(profile, 'state.json');

const child = spawn(
  executable,
  [
    root,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'scripts', 'integration-test.cjs')}`,
    `--user-data-dir=${path.join(profile, 'user-data')}`,
    `--extensions-dir=${path.join(profile, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODE_READER_TEST_OUTPUT: output,
      CODE_READER_TEST_FILE: process.argv[2] ?? '',
      // Set when launched from a VS Code terminal; it would make Code.exe run as plain Node.
      ELECTRON_RUN_AS_NODE: undefined,
    },
  },
);

const code = await new Promise((resolve) => child.on('close', resolve));
if (existsSync(output)) {
  console.log(await readFile(output, 'utf8'));
}
await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(code === 0 ? 'integration test passed' : `integration test failed (exit code ${code})`);
process.exit(code ?? 1);

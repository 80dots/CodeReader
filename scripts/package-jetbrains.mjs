// Builds the JetBrains plugin zip and copies it next to the VS Code .vsix.
//   npm run package:jetbrains
// The panel UI must be built first (the npm script does that).
import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'jetbrains');
const windows = process.platform === 'win32';

const gradlew = path.join(pluginDir, windows ? 'gradlew.bat' : 'gradlew');
const result = spawnSync(`"${gradlew}" buildPlugin --console=plain -q`, {
  cwd: pluginDir,
  stdio: 'inherit',
  // .bat files only start through a shell; the quotes keep paths with spaces in one piece.
  shell: true,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const distributions = path.join(pluginDir, 'build', 'distributions');
for (const file of readdirSync(distributions).filter((name) => name.endsWith('.zip'))) {
  copyFileSync(path.join(distributions, file), path.join(root, file));
  console.log(`Packaged: ${path.join(root, file)}`);
}

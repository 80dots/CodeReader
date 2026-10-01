// Runs the headless AI CLI on one file, outside VS Code, and prints the answer.
//   npm run try-provider -- <file> [claude|codex] [model]
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const [file, providerId = 'claude', model = providerId === 'claude' ? 'sonnet' : ''] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run try-provider -- <file> [claude|codex] [model]');
  process.exit(1);
}

const workDir = await mkdtemp(path.join(tmpdir(), 'code-reader-try-'));
const bundle = path.join(workDir, 'ai.cjs');
await esbuild.build({
  stdin: {
    contents: `
      export * from './src/ai/claudeCli';
      export * from './src/ai/codexCli';
      export * from './src/ai/prompts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  logLevel: 'warning',
});
const ai = createRequire(import.meta.url)(bundle);

const options = { command: providerId, model, cwd: workDir, timeoutMs: 180_000 };
const provider = providerId === 'codex' ? new ai.CodexCliProvider(options) : new ai.ClaudeCliProvider(options);

const started = Date.now();
const answer = await provider.run({
  system: ai.systemPrompt('한국어'),
  prompt: ai.storyPrompt({
    displayPath: path.basename(file),
    languageId: path.extname(file).slice(1),
    source: await readFile(file, 'utf8'),
    truncated: false,
    parts: ['summary', 'methods'],
    methods: [],
  }),
  schema: ai.storySchema(['summary', 'methods']),
  signal: new AbortController().signal,
});

console.log(JSON.stringify(ai.readStoryResult(answer), null, 2));
console.error(`\n${providerId} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);

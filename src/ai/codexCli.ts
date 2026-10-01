import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AiError, type AiProvider, type AiRequest, type ProviderOptions } from './provider';
import { parseLooseJson, runCli } from './runCli';

/**
 * Runs Codex in headless mode (`codex exec`).
 *
 * NOTE: written from the Codex CLI documentation and not yet run against a real
 * installation. Check the flags with `codex exec --help` once Codex is installed.
 */
export class CodexCliProvider implements AiProvider {
  constructor(private readonly options: ProviderOptions) {}

  async run(request: AiRequest): Promise<unknown> {
    const id = randomUUID();
    const schemaFile = path.join(os.tmpdir(), `code-reader-${id}.schema.json`);
    const outputFile = path.join(os.tmpdir(), `code-reader-${id}.out.json`);
    await fs.writeFile(schemaFile, JSON.stringify(request.schema), 'utf8');

    const args = [
      'exec',
      // Read-only sandbox: Codex may look but can never change files.
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-schema',
      schemaFile,
      '--output-last-message',
      outputFile,
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    // "-" makes Codex read the prompt from stdin.
    args.push('-');

    try {
      const { stdout, stderr, code } = await runCli({
        label: 'Codex',
        command: this.options.command,
        args,
        stdin: `${request.system}\n\n${request.prompt}`,
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs,
        signal: request.signal,
      });

      const answer = await fs.readFile(outputFile, 'utf8').catch(() => '');
      if (code !== 0 || !answer.trim()) {
        throw new AiError(
          'failed',
          'Codex가 대답을 돌려주지 않았어요. 터미널에서 codex를 실행해 로그인되어 있는지 확인해 주세요.',
          (stderr || stdout).trim().slice(0, 2000) || `exit code ${code}`,
        );
      }
      try {
        return parseLooseJson(answer);
      } catch {
        throw new AiError('failed', 'Codex의 대답을 읽지 못했어요.', answer.slice(0, 2000));
      }
    } finally {
      await Promise.all([fs.rm(schemaFile, { force: true }), fs.rm(outputFile, { force: true })]);
    }
  }
}

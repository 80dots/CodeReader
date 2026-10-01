import { AiError, type AiProvider, type AiRequest, type ProviderOptions } from './provider';
import { parseLooseJson, runCli } from './runCli';

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

/** Runs Claude Code in headless mode (`claude -p`). */
export class ClaudeCliProvider implements AiProvider {
  constructor(private readonly options: ProviderOptions) {}

  async run(request: AiRequest): Promise<unknown> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.schema),
      '--system-prompt',
      request.system,
      // No tools: the CLI only writes text and can never touch files or run commands.
      '--tools',
      '',
      // Keeps the user's CLAUDE.md, hooks, plugins and MCP servers out of the answer.
      '--safe-mode',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    const { stdout, stderr, code } = await runCli({
      label: 'Claude',
      command: this.options.command,
      args,
      stdin: request.prompt,
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs,
      signal: request.signal,
    });

    let output: ClaudeResult;
    try {
      output = JSON.parse(stdout) as ClaudeResult;
    } catch {
      throw new AiError(
        'failed',
        'Claude가 대답을 돌려주지 않았어요. 터미널에서 claude를 실행해 로그인되어 있는지 확인해 주세요.',
        (stderr || stdout).trim().slice(0, 2000) || `exit code ${code}`,
      );
    }
    if (output.is_error) {
      throw new AiError('failed', 'Claude가 설명을 만들다가 문제가 생겼어요.', output.result);
    }
    if (output.structured_output !== undefined && output.structured_output !== null) {
      return output.structured_output;
    }
    try {
      return parseLooseJson(output.result ?? '');
    } catch {
      throw new AiError('failed', 'Claude의 대답을 읽지 못했어요.', output.result?.slice(0, 2000));
    }
  }
}

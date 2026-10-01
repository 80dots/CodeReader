import { execFile, type ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { AiError } from './provider';

export interface CliRun {
  /** Name shown in error messages, e.g. "Claude". */
  label: string;
  command: string;
  args: string[];
  /** Sent on stdin so long prompts never hit command-line limits or quoting problems. */
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runCli(run: CliRun): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (run.signal.aborted) {
      reject(new AiError('aborted', '취소되었어요.'));
      return;
    }

    const child = spawn(run.command, run.args, { cwd: run.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      killTree(child);
      settle(() => reject(new AiError('aborted', '취소되었어요.')));
    };
    const timer = setTimeout(() => {
      killTree(child);
      settle(() =>
        reject(new AiError('timeout', `${run.label}의 대답이 너무 오래 걸려서 기다리기를 멈췄어요.`)),
      );
    }, run.timeoutMs);
    run.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === 'ENOENT'
            ? new AiError(
                'cli-not-found',
                `${run.label} CLI를 찾지 못했어요. 설치되어 있는지, 설정의 실행 파일 경로가 맞는지 확인해 주세요.`,
                `${run.command}: ${error.message}`,
              )
            : new AiError('failed', `${run.label} CLI를 실행하지 못했어요.`, error.message),
        ),
      );
    });
    child.on('close', (code) => settle(() => resolve({ stdout, stderr, code })));

    // The process may exit before reading everything; that surfaces through 'close'.
    child.stdin?.on('error', () => {});
    child.stdin?.end(run.stdin, 'utf8');
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // A .cmd shim runs under cmd.exe; kill() alone would leave the real CLI running.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGTERM');
  }
}

/** Parses JSON that may be wrapped in a Markdown code fence. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

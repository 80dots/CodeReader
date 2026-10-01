import type { ErrorKind } from '../shared/protocol';

export interface AiRequest {
  system: string;
  prompt: string;
  /** JSON Schema the answer must follow. */
  schema: object;
  signal: AbortSignal;
}

export interface AiProvider {
  /** Runs one headless request and returns the parsed JSON answer. */
  run(request: AiRequest): Promise<unknown>;
}

export interface ProviderOptions {
  /** Executable path or command name. */
  command: string;
  model: string;
  /** Working directory for the CLI; kept away from the user's workspace. */
  cwd: string;
  timeoutMs: number;
}

export class AiError extends Error {
  constructor(
    readonly kind: ErrorKind | 'aborted',
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

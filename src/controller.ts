import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeCliProvider } from './ai/claudeCli';
import { CodexCliProvider } from './ai/codexCli';
import { AiError, type AiProvider } from './ai/provider';
import { analyze, emptyAnalysis, type Analysis } from './analysis/analyzer';
import type { FileInfo, LineRange, PanelState, ProviderId } from './shared/protocol';

const AUTO_DELAY_MS = 800;

// Editors that show something other than code the user opened.
const IGNORED_SCHEMES = new Set(['output', 'debug', 'comment', 'vscode', 'vscode-settings', 'vscode-userdata']);

interface CacheEntry {
  /** Identifies the file content and the settings the explanation was written with. */
  fingerprint: string;
  analysis: Analysis;
}

interface Settings {
  provider: ProviderId;
  mode: 'manual' | 'auto';
  language: string;
  maxUsagesPerMethod: number;
  timeoutMs: number;
  command: string;
  model: string;
}

/** Owns what the panel shows: follows the active editor and runs explanations. */
export class Controller implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PanelState>();
  readonly onDidChangeState = this.emitter.event;

  private readonly cache = new Map<string, CacheEntry>();
  /** Marks the code that the explanation under the pointer is about. */
  private readonly highlightDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly disposables: vscode.Disposable[] = [this.emitter, this.highlightDecoration];
  private document?: vscode.TextDocument;
  private running?: AbortController;
  private autoTimer?: NodeJS.Timeout;
  private current: PanelState;

  constructor(private readonly storageDir: string) {
    const settings = readSettings();
    this.current = { ...idleState(), provider: settings.provider, mode: settings.mode };

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.document && event.contentChanges.length > 0) {
          this.markStale();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codeReader')) {
          const changed = readSettings();
          this.setState({ provider: changed.provider, mode: changed.mode });
        }
      }),
    );
    this.follow(vscode.window.activeTextEditor);
  }

  get state(): PanelState {
    return this.current;
  }

  /** Explains the current file. With `force`, a cached explanation is written again. */
  async explain(force: boolean): Promise<void> {
    const document = this.document;
    if (!document) {
      return;
    }
    const settings = readSettings();
    const key = document.uri.toString();
    const fingerprint = fingerprintOf(document, settings);
    const cached = this.cache.get(key);
    if (!force && cached?.fingerprint === fingerprint) {
      this.showCached(cached, false);
      return;
    }

    this.stop();
    const abort = new AbortController();
    this.running = abort;
    const isCurrent = () => this.running === abort;
    const file = fileInfo(document);
    this.setState({ ...idleState(), file, status: 'running', stage: 'symbols' });

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.storageDir));
      const analysis = await analyze({
        document,
        displayPath: file.displayPath,
        provider: createProvider(settings, this.storageDir),
        language: settings.language,
        maxUsagesPerMethod: settings.maxUsagesPerMethod,
        signal: abort.signal,
        onUpdate: (partial) => {
          if (isCurrent()) {
            this.setState(viewOf(partial));
          }
        },
      });
      this.cache.set(key, { fingerprint, analysis });
      if (isCurrent()) {
        this.running = undefined;
        this.setState({
          ...viewOf(analysis),
          status: 'done',
          stale: fingerprintOf(document, settings) !== fingerprint,
        });
      }
    } catch (error) {
      // Stops the sibling request that may still be running.
      abort.abort();
      if (!isCurrent()) {
        return;
      }
      this.running = undefined;
      if (error instanceof AiError && error.kind === 'aborted') {
        this.showFile(document);
      } else if (error instanceof AiError) {
        this.setState({
          ...idleState(),
          file,
          status: 'error',
          error: { kind: error.kind as Exclude<AiError['kind'], 'aborted'>, message: error.message, detail: error.detail },
        });
      } else {
        this.setState({
          ...idleState(),
          file,
          status: 'error',
          error: {
            kind: 'failed',
            message: '설명을 만들다가 문제가 생겼어요.',
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /** Stops the explanation in progress and returns to what was shown before. */
  cancel(): void {
    if (this.running) {
      this.stop();
      if (this.document) {
        this.showFile(this.document);
      }
    }
  }

  async reveal(uri: string, line: number, character: number): Promise<void> {
    const position = new vscode.Position(line, character);
    await vscode.window.showTextDocument(vscode.Uri.parse(uri), {
      selection: new vscode.Range(position, position),
      preview: true,
    });
  }

  /** Highlights lines of a file in every editor showing it, scrolling them into view if needed. */
  highlight(uri: string, range: LineRange): void {
    this.clearHighlight();
    // After an edit the remembered line numbers may point at the wrong code.
    if (this.current.stale && uri === this.current.file?.uri) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri) {
        continue;
      }
      const lastLine = Math.min(range.endLine, editor.document.lineCount - 1);
      if (range.startLine > lastLine) {
        continue;
      }
      const lines = new vscode.Range(range.startLine, 0, lastLine, editor.document.lineAt(lastLine).text.length);
      editor.setDecorations(this.highlightDecoration, [lines]);
      editor.revealRange(lines, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  clearHighlight(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.highlightDecoration, []);
    }
  }

  dispose(): void {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
  }

  private follow(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      // Focus moving to a non-code tab keeps the explanation; closing every editor clears it.
      if (vscode.window.visibleTextEditors.length === 0 && this.document) {
        this.stop();
        this.document = undefined;
        this.setState({ ...idleState(), file: undefined });
      }
      return;
    }
    if (IGNORED_SCHEMES.has(editor.document.uri.scheme) || editor.document === this.document) {
      return;
    }
    this.stop();
    this.document = editor.document;
    this.showFile(editor.document);
    if (readSettings().mode === 'auto' && this.current.status === 'idle') {
      this.autoTimer = setTimeout(() => void this.explain(false), AUTO_DELAY_MS);
    }
  }

  private showFile(document: vscode.TextDocument): void {
    const cached = this.cache.get(document.uri.toString());
    if (cached) {
      this.showCached(cached, cached.fingerprint !== fingerprintOf(document, readSettings()));
    } else {
      this.setState({ ...idleState(), file: fileInfo(document) });
    }
  }

  private showCached(entry: CacheEntry, stale: boolean): void {
    this.setState({
      ...viewOf(entry.analysis),
      file: this.document && fileInfo(this.document),
      status: 'done',
      stale,
      error: undefined,
    });
  }

  private markStale(): void {
    if (this.current.status === 'done' && !this.current.stale) {
      this.setState({ stale: true });
    }
  }

  private stop(): void {
    this.clearHighlight();
    clearTimeout(this.autoTimer);
    this.running?.abort();
    this.running = undefined;
  }

  private setState(patch: Partial<PanelState>): void {
    this.current = { ...this.current, ...patch };
    this.emitter.fire(this.current);
  }
}

function idleState(): Omit<PanelState, 'provider' | 'mode' | 'file'> {
  return { ...viewOf(emptyAnalysis()), status: 'idle', stale: false, error: undefined };
}

function viewOf(analysis: Analysis) {
  return {
    stage: analysis.stage,
    truncated: analysis.truncated,
    summary: analysis.summary,
    // Copied so the webview always receives a fresh snapshot of in-progress data.
    methods: analysis.methods.map((method) => ({ ...method, usages: [...method.usages] })),
    storyPending: analysis.storyPending,
    usageSearchPending: analysis.usageSearchPending,
    purposePending: analysis.purposePending,
    usageError: analysis.usageError,
  };
}

function fileInfo(document: vscode.TextDocument): FileInfo {
  const displayPath = document.isUntitled
    ? document.uri.path
    : vscode.workspace.asRelativePath(document.uri, false);
  return {
    uri: document.uri.toString(),
    displayPath,
    fileName: path.posix.basename(displayPath.replace(/\\/g, '/')),
    languageId: document.languageId,
  };
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('codeReader');
  const provider: ProviderId = config.get('provider') === 'codex' ? 'codex' : 'claude';
  return {
    provider,
    mode: config.get('mode') === 'auto' ? 'auto' : 'manual',
    language: config.get<string>('language')?.trim() || '한국어',
    maxUsagesPerMethod: config.get<number>('maxUsagesPerMethod') ?? 8,
    timeoutMs: (config.get<number>('timeoutSeconds') ?? 180) * 1000,
    command: config.get<string>(`${provider}.path`)?.trim() || provider,
    model: config.get<string>(`${provider}.model`)?.trim() ?? '',
  };
}

function createProvider(settings: Settings, cwd: string): AiProvider {
  const options = { command: settings.command, model: settings.model, cwd, timeoutMs: settings.timeoutMs };
  return settings.provider === 'codex' ? new CodexCliProvider(options) : new ClaudeCliProvider(options);
}

function fingerprintOf(document: vscode.TextDocument, settings: Settings): string {
  return createHash('sha1')
    .update([settings.provider, settings.model, settings.language, settings.maxUsagesPerMethod].join('\n'))
    .update('\n')
    .update(document.getText())
    .digest('hex');
}

// Types shared by the extension host and the webview UI.

export interface FileInfo {
  uri: string;
  /** Path shown to the user (workspace-relative when possible). */
  displayPath: string;
  fileName: string;
  languageId: string;
}

export interface Summary {
  oneLine: string;
  story: string;
  keyPoints: string[];
}

/** A run of whole lines in a file; both ends are 0-based and included. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface Step {
  text: string;
  /** The lines of code this step describes, when the AI could point at them. */
  range?: LineRange;
}

export interface MethodExplanation {
  role: string;
  story: string;
  steps: Step[];
}

export interface UsageItem {
  id: string;
  uri: string;
  displayPath: string;
  /** 0-based position of the reference. */
  line: number;
  character: number;
  /** Name of the function that contains the reference, if any. */
  caller?: string;
  /** The source line where the method is used. */
  preview: string;
  purpose?: string;
}

export interface MethodView {
  id: string;
  name: string;
  /** Owning class or object, if any. */
  container?: string;
  /** 0-based position of the method name; absent when the AI found the method itself. */
  line?: number;
  character?: number;
  /** The whole method, body included. */
  range?: LineRange;
  explanation?: MethodExplanation;
  usages: UsageItem[];
  /** How many usages exist in total (may exceed usages.length). */
  usageTotal: number;
}

export type Stage = 'symbols' | 'writing';

export type ErrorKind = 'cli-not-found' | 'timeout' | 'failed';

export interface PanelError {
  kind: ErrorKind;
  message: string;
  detail?: string;
}

export type ProviderId = 'claude' | 'codex';

export interface PanelState {
  /** The file the panel is about; undefined when no code editor is open. */
  file?: FileInfo;
  status: 'idle' | 'running' | 'done' | 'error';
  stage?: Stage;
  /** The file changed after the explanation was written. */
  stale: boolean;
  /** Only the first part of a very long file was read. */
  truncated: boolean;
  summary?: Summary;
  methods: MethodView[];
  /** Summary and method stories are still being written. */
  storyPending: boolean;
  /** Usages are still being searched. */
  usageSearchPending: boolean;
  /** Usage purposes are still being written. */
  purposePending: boolean;
  error?: PanelError;
  /** Finding usage purposes failed; stories are still shown. */
  usageError?: string;
  /**
   * Usages come from a search by method name rather than from language analysis,
   * so some may be missing or wrong (the JetBrains plugin, where the IDE offers no reference search).
   */
  usageApproximate?: boolean;
  provider: ProviderId;
  mode: 'manual' | 'auto';
}

export type HostMessage = { type: 'state'; state: PanelState };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'explain' }
  | { type: 'cancel' }
  | { type: 'reveal'; uri: string; line: number; character: number }
  /** The pointer rests on an explanation: mark the code it is about in the editor. */
  | { type: 'highlight'; uri: string; range: LineRange }
  | { type: 'clearHighlight' }
  | { type: 'openSettings' };

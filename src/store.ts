import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ClassView, MethodView, Summary, VariableView } from './shared/protocol';

/**
 * Explanations are kept as one JSON file per explained source file, under the
 * user's home directory, so they survive restarts and are shared by every editor
 * that has Code Reader (the JetBrains plugin reads and writes the same files).
 *
 * Because editors spell file URIs differently, the stored copy holds plain file
 * paths: every `uri` field of the panel data is written as `path`.
 */
const SCHEMA_VERSION = 1;

export interface SavedExplanation {
  /** SHA-1 of the file's text when it was explained, with line endings read as "\n". */
  contentHash: string;
  /** ISO time the explanation was written. */
  savedAt: string;
  provider: string;
  language: string;
  usageApproximate: boolean;
  truncated: boolean;
  summary?: Summary;
  classes: ClassView[];
  variables: VariableView[];
  methods: MethodView[];
}

export function contentHashOf(text: string): string {
  return createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export function storeDirectory(): string {
  return path.join(os.homedir(), '.code-reader', 'explanations');
}

/** Only files on disk have a stable identity to save an explanation under. */
export function canSave(uri: vscode.Uri): boolean {
  return uri.scheme === 'file';
}

export async function saveExplanation(uri: vscode.Uri, explanation: SavedExplanation): Promise<void> {
  const record = { schemaVersion: SCHEMA_VERSION, path: slashed(uri.fsPath), ...(urisToPaths(explanation) as object) };
  await fs.mkdir(storeDirectory(), { recursive: true });
  await fs.writeFile(recordFile(uri), JSON.stringify(record, null, 2), 'utf8');
}

export async function loadExplanation(uri: vscode.Uri): Promise<SavedExplanation | undefined> {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(await fs.readFile(recordFile(uri), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined; // Never saved, or not readable: the same to the panel.
  }
  if (record.schemaVersion !== SCHEMA_VERSION || typeof record.contentHash !== 'string') {
    return undefined;
  }
  const loaded = pathsToUris(record) as Partial<SavedExplanation>;
  // The file may have been written by another editor or edited by hand; fill what the panel relies on.
  return {
    contentHash: record.contentHash,
    savedAt: typeof loaded.savedAt === 'string' ? loaded.savedAt : '',
    provider: typeof loaded.provider === 'string' ? loaded.provider : '',
    language: typeof loaded.language === 'string' ? loaded.language : '',
    usageApproximate: loaded.usageApproximate === true,
    truncated: loaded.truncated === true,
    summary: loaded.summary && {
      oneLine: String(loaded.summary.oneLine ?? ''),
      story: String(loaded.summary.story ?? ''),
      keyPoints: list(loaded.summary.keyPoints),
    },
    classes: list<ClassView>(loaded.classes).map((item) => ({ ...item, parents: list(item.parents) })),
    variables: list<VariableView>(loaded.variables),
    methods: list<MethodView>(loaded.methods).map((method) => ({
      ...method,
      usages: list(method.usages),
      usageTotal: typeof method.usageTotal === 'number' ? method.usageTotal : list(method.usages).length,
      explanation: method.explanation && { ...method.explanation, steps: list(method.explanation.steps) },
    })),
  };
}

function recordFile(uri: vscode.Uri): string {
  // Windows paths differ only in case between editors; one file must still map to one record.
  const identity = process.platform === 'win32' ? slashed(uri.fsPath).toLowerCase() : slashed(uri.fsPath);
  return path.join(storeDirectory(), `${createHash('sha1').update(identity).digest('hex')}.json`);
}

function slashed(fsPath: string): string {
  return fsPath.replace(/\\/g, '/');
}

function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function urisToPaths(value: unknown): unknown {
  return mapKeys(value, 'uri', 'path', (uri) => slashed(vscode.Uri.parse(uri).fsPath));
}

function pathsToUris(value: unknown): unknown {
  return mapKeys(value, 'path', 'uri', (fsPath) => vscode.Uri.file(fsPath).toString());
}

/** Copies a JSON value, renaming one key wherever it holds a string and converting that string. */
function mapKeys(value: unknown, from: string, to: string, convert: (text: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapKeys(item, from, to, convert));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key === from && typeof item === 'string' ? [to, convert(item)] : [key, mapKeys(item, from, to, convert)],
    ),
  );
}

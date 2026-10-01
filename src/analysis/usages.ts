import * as vscode from 'vscode';
import type { PurposePromptItem } from '../ai/prompts';
import type { UsageItem } from '../shared/protocol';
import { enclosingName, loadDocumentSymbols, type MethodSymbol } from './symbols';

export interface MethodUsages {
  items: UsageItem[];
  /** All usages found, including the ones beyond the display limit. */
  total: number;
}

export interface CollectedUsages {
  /** One entry per method, in the same order as the input. */
  perMethod: MethodUsages[];
  /** What the AI needs to explain each usage. */
  promptItems: PurposePromptItem[];
}

const CONTEXT_LINES = 3;
const MAX_LINE_LENGTH = 200;
const CONCURRENCY = 4;

// Lines that only bring a name into a file are not real uses of it.
const IMPORT_LINE = /^\s*(?:import\b|export\b[^=(]*\bfrom\b|from\s+\S+\s+import\b|using\s|#include\b)|\brequire\s*\(/;

/** Finds where each method is used, through the editor's "find references" support. */
export async function collectUsages(
  document: vscode.TextDocument,
  methods: MethodSymbol[],
  maxPerMethod: number,
  signal: AbortSignal,
): Promise<CollectedUsages> {
  const documents = new Map<string, Promise<FileContext | undefined>>();
  documents.set(document.uri.toString(), loadFile(document.uri));
  const fileOf = (uri: vscode.Uri) => {
    const key = uri.toString();
    let file = documents.get(key);
    if (!file) {
      file = loadFile(uri);
      documents.set(key, file);
    }
    return file;
  };

  const perMethod: MethodUsages[] = methods.map(() => ({ items: [], total: 0 }));
  const snippets = new Map<UsageItem, string>();

  let next = 0;
  const worker = async () => {
    while (next < methods.length && !signal.aborted) {
      const index = next++;
      perMethod[index] = await usagesOf(document, methods[index], maxPerMethod, fileOf, snippets);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Ids are handed out afterwards so they follow the order methods appear in the file.
  const promptItems: PurposePromptItem[] = [];
  let counter = 0;
  perMethod.forEach((usages, index) => {
    const method = methods[index];
    for (const item of usages.items) {
      item.id = `u${++counter}`;
      promptItems.push({
        id: item.id,
        method: method.container ? `${method.container}.${method.name}` : method.name,
        declaration: clip(document.lineAt(method.selectionRange.start.line).text.trim()),
        displayPath: item.displayPath,
        caller: item.caller,
        snippet: snippets.get(item) ?? item.preview,
      });
    }
  });
  return { perMethod, promptItems };
}

interface FileContext {
  document: vscode.TextDocument;
  symbols: vscode.DocumentSymbol[];
}

async function loadFile(uri: vscode.Uri): Promise<FileContext | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return { document, symbols: await loadDocumentSymbols(uri) };
  } catch {
    return undefined;
  }
}

async function usagesOf(
  document: vscode.TextDocument,
  method: MethodSymbol,
  maxPerMethod: number,
  fileOf: (uri: vscode.Uri) => Promise<FileContext | undefined>,
  snippets: Map<UsageItem, string>,
): Promise<MethodUsages> {
  const locations =
    (await vscode.commands.executeCommand<vscode.Location[] | undefined>(
      'vscode.executeReferenceProvider',
      document.uri,
      method.selectionRange.start,
    )) ?? [];

  const self = document.uri.toString();
  const seen = new Set<string>();
  const usages: MethodUsages = { items: [], total: 0 };

  for (const location of locations) {
    const uri = location.uri.toString();
    const line = location.range.start.line;
    const isDeclaration = uri === self && location.range.intersection(method.selectionRange) !== undefined;
    const key = `${uri}#${line}`;
    if (isDeclaration || seen.has(key) || /[\\/]node_modules[\\/]/.test(location.uri.path)) {
      continue;
    }
    seen.add(key);

    const file = await fileOf(location.uri);
    if (!file || line >= file.document.lineCount) {
      continue;
    }
    const text = file.document.lineAt(line).text;
    if (IMPORT_LINE.test(text)) {
      continue;
    }

    usages.total++;
    if (usages.items.length >= maxPerMethod) {
      continue;
    }
    const item: UsageItem = {
      id: '',
      uri,
      displayPath: vscode.workspace.asRelativePath(location.uri, false),
      line,
      character: location.range.start.character,
      caller: enclosingName(file.symbols, file.document, location.range.start),
      preview: clip(text.trim()),
    };
    usages.items.push(item);
    snippets.set(item, snippetAround(file.document, line));
  }
  return usages;
}

function snippetAround(document: vscode.TextDocument, line: number): string {
  const first = Math.max(0, line - CONTEXT_LINES);
  const last = Math.min(document.lineCount - 1, line + CONTEXT_LINES);
  const lines: string[] = [];
  for (let i = first; i <= last; i++) {
    lines.push(`${i === line ? '>>' : '  '} ${clip(document.lineAt(i).text)}`);
  }
  return lines.join('\n');
}

function clip(text: string): string {
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;
}

import * as vscode from 'vscode';
import {
  MAX_METHODS,
  PURPOSE_SCHEMA,
  purposePrompt,
  readPurposeResult,
  readStoryResult,
  storyPrompt,
  storySchema,
  systemPrompt,
  type StoryPart,
  type ToldStep,
} from '../ai/prompts';
import { AiError, type AiProvider } from '../ai/provider';
import type { LineRange, MethodView, Stage, Step, Summary } from '../shared/protocol';
import { findMethods, type MethodSymbol } from './symbols';
import { collectUsages } from './usages';

/** Longer files are cut here so one request stays a reasonable size. */
const MAX_SOURCE_CHARS = 80_000;

const METHODS_PER_REQUEST = 6;
/** Story requests running at once (the usage request runs beside them). */
const STORY_CONCURRENCY = 3;

/** Everything learned about a file so far; filled in step by step while the analysis runs. */
export interface Analysis {
  stage?: Stage;
  truncated: boolean;
  summary?: Summary;
  methods: MethodView[];
  storyPending: boolean;
  usageSearchPending: boolean;
  purposePending: boolean;
  usageError?: string;
}

export function emptyAnalysis(): Analysis {
  return {
    truncated: false,
    methods: [],
    storyPending: false,
    usageSearchPending: false,
    purposePending: false,
  };
}

export interface AnalyzeOptions {
  document: vscode.TextDocument;
  displayPath: string;
  provider: AiProvider;
  language: string;
  maxUsagesPerMethod: number;
  signal: AbortSignal;
  /** Called whenever `analysis` gained something new to show. */
  onUpdate: (analysis: Analysis) => void;
}

/**
 * Explains a document. Rejects when the summary and method stories cannot be
 * written; a failure while explaining usages only sets `usageError`.
 */
export async function analyze(options: AnalyzeOptions): Promise<Analysis> {
  const { document, provider, signal } = options;
  const analysis = emptyAnalysis();
  const update = () => {
    if (!signal.aborted) {
      options.onUpdate(analysis);
    }
  };

  analysis.stage = 'symbols';
  update();

  const text = document.getText();
  analysis.truncated = text.length > MAX_SOURCE_CHARS;
  const source = analysis.truncated ? text.slice(0, MAX_SOURCE_CHARS) : text;
  const symbols = (await findMethods(document)).slice(0, MAX_METHODS);
  throwIfAborted(signal);

  analysis.methods = symbols.map((symbol, index) => toMethodView(symbol, `m${index + 1}`));
  analysis.stage = 'writing';
  analysis.storyPending = true;
  analysis.usageSearchPending = symbols.length > 0;
  update();

  const system = systemPrompt(options.language);

  const tell = async (parts: StoryPart[], methods: MethodView[]) =>
    readStoryResult(
      await provider.run({
        system,
        prompt: storyPrompt({
          displayPath: options.displayPath,
          languageId: document.languageId,
          source,
          truncated: analysis.truncated,
          parts,
          methods,
        }),
        schema: storySchema(parts),
        signal,
      }),
    );

  const writeStory = async () => {
    if (symbols.length === 0) {
      // No language support for this file: the AI lists the methods itself.
      const answer = await tell(['summary', 'methods'], []);
      analysis.summary = answer.summary;
      analysis.methods = answer.methods.slice(0, MAX_METHODS).map((told, index) => ({
        id: `m${index + 1}`,
        name: told.name,
        ...locate(document, told.name),
        explanation: { role: told.role, story: told.story, steps: toSteps(told.steps, undefined, document.lineCount) },
        usages: [],
        usageTotal: 0,
      }));
    } else {
      // Small requests side by side: the summary shows up early and the method
      // stories fill in batch by batch instead of after one long wait.
      await runLimited(STORY_CONCURRENCY, [
        async () => {
          analysis.summary = (await tell(['summary'], [])).summary;
          update();
        },
        ...chunk(analysis.methods, METHODS_PER_REQUEST).map((batch) => async () => {
          const answer = await tell(['methods'], batch);
          for (const method of batch) {
            const told = answer.methods.find((m) => m.id === method.id);
            if (told) {
              method.explanation = {
                role: told.role,
                story: told.story,
                steps: toSteps(told.steps, method.range, document.lineCount),
              };
            }
          }
          update();
        }),
      ]);
    }
    analysis.storyPending = false;
    update();
  };

  const explainUsages = async () => {
    if (symbols.length === 0) {
      return;
    }
    try {
      const collected = await collectUsages(document, symbols, options.maxUsagesPerMethod, signal);
      throwIfAborted(signal);
      collected.perMethod.forEach((usages, index) => {
        analysis.methods[index].usages = usages.items;
        analysis.methods[index].usageTotal = usages.total;
      });
      analysis.usageSearchPending = false;
      if (collected.promptItems.length === 0) {
        update();
        return;
      }
      analysis.purposePending = true;
      update();

      const purposes = readPurposeResult(
        await provider.run({
          system,
          prompt: purposePrompt(options.displayPath, collected.promptItems),
          schema: PURPOSE_SCHEMA,
          signal,
        }),
      );
      for (const method of analysis.methods) {
        for (const usage of method.usages) {
          usage.purpose = purposes.get(usage.id);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      analysis.usageError = error instanceof Error ? error.message : String(error);
    } finally {
      analysis.usageSearchPending = false;
      analysis.purposePending = false;
    }
    update();
  };

  await Promise.all([writeStory(), explainUsages()]);
  analysis.stage = undefined;
  return analysis;
}

function toMethodView(symbol: MethodSymbol, id: string): MethodView {
  return {
    id,
    name: symbol.name,
    container: symbol.container,
    line: symbol.selectionRange.start.line,
    character: symbol.selectionRange.start.character,
    range: { startLine: symbol.range.start.line, endLine: symbol.range.end.line },
    usages: [],
    usageTotal: 0,
  };
}

/**
 * Turns the AI's 1-based line numbers into ranges, dropping any that fall outside
 * the method (or the file): a wrong highlight is worse than none.
 */
function toSteps(told: ToldStep[], bounds: LineRange | undefined, lineCount: number): Step[] {
  const first = bounds?.startLine ?? 0;
  const last = bounds?.endLine ?? lineCount - 1;
  return told.map((step) => {
    if (step.startLine === undefined || step.endLine === undefined) {
      return { text: step.text };
    }
    const startLine = step.startLine - 1;
    const endLine = step.endLine - 1;
    const valid = startLine <= endLine && startLine >= first && endLine <= last;
    return valid ? { text: step.text, range: { startLine, endLine } } : { text: step.text };
  });
}

/** Best-effort position of a method the AI named, so it can still be revealed in the editor. */
function locate(document: vscode.TextDocument, name: string): { line?: number; character?: number } {
  const plain = name.split('.').pop() ?? name;
  if (!/^[\w$]+$/.test(plain)) {
    return {};
  }
  const match = new RegExp(`\\b${plain.replace(/\$/g, '\\$')}\\b`).exec(document.getText());
  if (!match) {
    return {};
  }
  const position = document.positionAt(match.index);
  return { line: position.line, character: position.character };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** Runs the jobs with at most `limit` in flight; rejects as soon as one fails. */
async function runLimited(limit: number, jobs: (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      await jobs[next++]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AiError('aborted', '취소되었어요.');
  }
}

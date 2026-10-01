import * as vscode from 'vscode';
import {
  MAX_METHODS,
  MAX_VARIABLES,
  PURPOSE_SCHEMA,
  purposePrompt,
  readPurposeResult,
  readStoryResult,
  storyPrompt,
  storySchema,
  systemPrompt,
  type StoryClassInput,
  type StoryPart,
  type StoryPromptInput,
  type ToldStep,
} from '../ai/prompts';
import { AiError, type AiProvider } from '../ai/provider';
import type {
  ClassView,
  LineRange,
  MethodView,
  Stage,
  Step,
  Summary,
  VariableView,
} from '../shared/protocol';
import { resolveParent } from './parents';
import { findOutline, type MethodSymbol, type VariableSymbol } from './symbols';
import { collectUsages } from './usages';

/** Longer files are cut here so one request stays a reasonable size. */
const MAX_SOURCE_CHARS = 80_000;

const METHODS_PER_REQUEST = 6;
const VARIABLES_PER_REQUEST = 15;
/** Story requests running at once (the usage request runs beside them). */
const STORY_CONCURRENCY = 3;

/** Everything learned about a file so far; filled in step by step while the analysis runs. */
export interface Analysis {
  stage?: Stage;
  truncated: boolean;
  summary?: Summary;
  classes: ClassView[];
  variables: VariableView[];
  methods: MethodView[];
  storyPending: boolean;
  usageSearchPending: boolean;
  purposePending: boolean;
  usageError?: string;
}

export function emptyAnalysis(): Analysis {
  return {
    truncated: false,
    classes: [],
    variables: [],
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
 * Explains a document. Rejects when the summary and the stories cannot be
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
  const outline = await findOutline(document);
  throwIfAborted(signal);

  const symbols = outline.methods.slice(0, MAX_METHODS);
  // Only classes that inherit from something have a story to tell here.
  const classSymbols = outline.classes.filter((c) => c.parents.length > 0);
  // An editor without support for this language reports nothing at all; the AI then finds everything itself.
  const selfDiscovery = outline.methods.length + outline.variables.length + outline.classes.length === 0;

  analysis.methods = symbols.map((symbol, index) => toMethodView(symbol, `m${index + 1}`));
  analysis.variables = outline.variables
    .slice(0, MAX_VARIABLES)
    .map((symbol, index) => toVariableView(symbol, `v${index + 1}`));
  analysis.classes = classSymbols.map((symbol, index) => ({
    id: `c${index + 1}`,
    name: symbol.name,
    line: symbol.selectionRange.start.line,
    character: symbol.selectionRange.start.character,
    parents: symbol.parents.map((parent) => ({ name: parent.name })),
  }));
  analysis.stage = 'writing';
  analysis.storyPending = true;
  analysis.usageSearchPending = symbols.length > 0;
  update();

  const system = systemPrompt(options.language);

  const tell = async (parts: StoryPart[], subjects: Pick<StoryPromptInput, 'methods' | 'variables' | 'classes'>) =>
    readStoryResult(
      await provider.run({
        system,
        prompt: storyPrompt({
          displayPath: options.displayPath,
          languageId: document.languageId,
          source,
          truncated: analysis.truncated,
          parts,
          ...subjects,
        }),
        schema: storySchema(parts),
        signal,
      }),
    );

  const explainClasses = async () => {
    // The parents' own source lets the AI explain what is really inherited instead of guessing from a name.
    const inputs: StoryClassInput[] = [];
    for (const [index, symbol] of classSymbols.entries()) {
      const view = analysis.classes[index];
      const resolved = await Promise.all(symbol.parents.map((parent) => resolveParent(document, parent)));
      view.parents = resolved.map(({ name, uri, line, character }) => ({ name, uri, line, character }));
      inputs.push({ id: view.id, name: view.name, line: view.line, parents: resolved });
    }
    throwIfAborted(signal);
    update();

    const answer = await tell(['classes'], { classes: inputs });
    for (const view of analysis.classes) {
      const told = answer.classes.find((c) => c.id === view.id);
      if (!told) {
        continue;
      }
      view.role = told.role;
      for (const parent of view.parents) {
        parent.explanation = told.parents.find((p) => p.name === parent.name)?.explanation;
      }
    }
    update();
  };

  const writeStory = async () => {
    if (selfDiscovery) {
      const answer = await tell(['summary', 'classes', 'variables', 'methods'], {});
      analysis.summary = answer.summary;
      analysis.classes = answer.classes
        .filter((told) => told.parents.length > 0)
        .map((told, index) => ({
          id: `c${index + 1}`,
          name: told.name,
          ...locate(document, told.name),
          role: told.role,
          parents: told.parents,
        }));
      analysis.variables = answer.variables.slice(0, MAX_VARIABLES).map((told, index) => ({
        id: `v${index + 1}`,
        name: told.name,
        ...locate(document, told.name),
        explanation: { role: told.role, story: told.story },
      }));
      analysis.methods = answer.methods.slice(0, MAX_METHODS).map((told, index) => ({
        id: `m${index + 1}`,
        name: told.name,
        ...locate(document, told.name),
        explanation: { role: told.role, story: told.story, steps: toSteps(told.steps, undefined, document.lineCount) },
        usages: [],
        usageTotal: 0,
      }));
    } else {
      // Small requests side by side: the summary shows up early and the stories
      // fill in batch by batch instead of after one long wait.
      await runLimited(STORY_CONCURRENCY, [
        async () => {
          analysis.summary = (await tell(['summary'], {})).summary;
          update();
        },
        ...(analysis.classes.length > 0 ? [explainClasses] : []),
        ...chunk(analysis.methods, METHODS_PER_REQUEST).map((batch) => async () => {
          const answer = await tell(['methods'], { methods: batch });
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
        ...chunk(analysis.variables, VARIABLES_PER_REQUEST).map((batch) => async () => {
          const answer = await tell(['variables'], { variables: batch });
          for (const variable of batch) {
            const told = answer.variables.find((v) => v.id === variable.id);
            if (told) {
              variable.explanation = { role: told.role, story: told.story };
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

function lineRange(range: vscode.Range): LineRange {
  return { startLine: range.start.line, endLine: range.end.line };
}

function toMethodView(symbol: MethodSymbol, id: string): MethodView {
  return {
    id,
    name: symbol.name,
    container: symbol.container,
    line: symbol.selectionRange.start.line,
    character: symbol.selectionRange.start.character,
    range: lineRange(symbol.range),
    usages: [],
    usageTotal: 0,
  };
}

function toVariableView(symbol: VariableSymbol, id: string): VariableView {
  return {
    id,
    name: symbol.name,
    container: symbol.container,
    line: symbol.selectionRange.start.line,
    character: symbol.selectionRange.start.character,
    range: lineRange(symbol.range),
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

/** Best-effort position of something the AI named, so it can still be revealed in the editor. */
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

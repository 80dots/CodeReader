import * as vscode from 'vscode';

export interface MethodSymbol {
  name: string;
  /** Owning class or object, if any. */
  container?: string;
  /** Whole method, including its body. */
  range: vscode.Range;
  /** Just the method name. */
  selectionRange: vscode.Range;
}

/** A variable defined outside any method: a global, a constant, or a field of a class. */
export interface VariableSymbol {
  name: string;
  container?: string;
  /** Whole declaration. */
  range: vscode.Range;
  selectionRange: vscode.Range;
}

export interface ParentRef {
  name: string;
  /** Where the parent's name is written in the class header; used to look up its definition. */
  position: vscode.Position;
}

export interface ClassSymbol {
  name: string;
  selectionRange: vscode.Range;
  /** The classes it extends and the interfaces it implements. */
  parents: ParentRef[];
}

export interface Outline {
  classes: ClassSymbol[];
  variables: VariableSymbol[];
  methods: MethodSymbol[];
}

const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const VALUE_KINDS = new Set([
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
]);

const TYPE_KINDS = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct]);

// `name = (a, b) => ...`, `name = async function ...`, `name: Type = x => ...`
const FUNCTION_VALUE = /^\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>)/;

// Words in a class header that are not names of parents.
const HEADER_KEYWORDS = new Set([
  'public', 'private', 'protected', 'internal', 'virtual', 'open', 'final', 'sealed', 'abstract',
  'static', 'partial', 'class', 'struct', 'interface', 'record', 'object', 'by', 'with',
]);

/** Asks the language support installed in VS Code for the symbols of a document. */
export async function loadDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  const symbols = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri);
  // Older providers return flat SymbolInformation without ranges for names; skip those.
  return (symbols ?? []).filter((s): s is vscode.DocumentSymbol => 'selectionRange' in s);
}

/** Lists what a document defines: its methods, its variables and its classes, each in source order. */
export async function findOutline(document: vscode.TextDocument): Promise<Outline> {
  let symbols = await loadDocumentSymbols(document.uri);
  // A language server that is still starting answers with nothing; give it a moment.
  for (let attempt = 0; attempt < 2 && symbols.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    symbols = await loadDocumentSymbols(document.uri);
  }

  const outline: Outline = { classes: [], variables: [], methods: [] };
  const visit = (symbol: vscode.DocumentSymbol, container: string | undefined, insideValue: boolean) => {
    if (isFunctionLike(symbol, document)) {
      // Helpers and variables nested inside a method are part of that method's story.
      outline.methods.push({
        name: symbol.name,
        container,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
      });
      return;
    }
    if (VALUE_KINDS.has(symbol.kind)) {
      // The parts of a value (the entries of an object written out in place) are not
      // variables of their own, but methods written inside it still count as methods.
      if (!insideValue && !isTypeAlias(symbol, document)) {
        outline.variables.push({
          name: symbol.name,
          container,
          range: symbol.range,
          selectionRange: symbol.selectionRange,
        });
      }
      symbol.children.forEach((child) => visit(child, symbol.name, true));
      return;
    }
    if (TYPE_KINDS.has(symbol.kind)) {
      outline.classes.push({
        name: symbol.name,
        selectionRange: symbol.selectionRange,
        parents: parseParents(document, symbol),
      });
    }
    symbol.children.forEach((child) => visit(child, symbol.name, false));
  };
  symbols.forEach((symbol) => visit(symbol, undefined, false));

  const inOrder = (a: { range: vscode.Range }, b: { range: vscode.Range }) => a.range.start.compareTo(b.range.start);
  outline.methods.sort(inOrder);
  outline.variables.sort(inOrder);
  outline.classes.sort((a, b) => a.selectionRange.start.compareTo(b.selectionRange.start));
  return outline;
}

export function isFunctionLike(symbol: vscode.DocumentSymbol, document: vscode.TextDocument): boolean {
  if (FUNCTION_KINDS.has(symbol.kind)) {
    return true;
  }
  if (!VALUE_KINDS.has(symbol.kind)) {
    return false;
  }
  const afterName = document.getText(new vscode.Range(symbol.selectionRange.end, symbol.range.end));
  return FUNCTION_VALUE.test(afterName.slice(0, 300));
}

/** TypeScript reports `type Name = ...` with the same kind as a variable. */
function isTypeAlias(symbol: vscode.DocumentSymbol, document: vscode.TextDocument): boolean {
  const beforeName = document.lineAt(symbol.selectionRange.start.line).text.slice(0, symbol.selectionRange.start.character);
  return /\btype\s+$/.test(beforeName);
}

/**
 * Reads the names a class inherits from out of its header: the text between the
 * class name and its body. Editors do not report these, so this works from the
 * shapes shared by the common languages:
 *   `class A extends B implements C, D {`   (TypeScript, Java, PHP)
 *   `class A : B, IC where T : new() {`     (C#, Kotlin, Swift, C++)
 *   `class A(B, C):`                        (Python)
 */
export function parseParents(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): ParentRef[] {
  const headerStart = document.offsetAt(symbol.selectionRange.end);
  const header = document.getText(new vscode.Range(symbol.selectionRange.end, symbol.range.end)).slice(0, 800);
  const python = document.languageId === 'python';
  const identifier = /[A-Za-z_$][\w$]*/y;
  const parents: ParentRef[] = [];

  let angles = 0;
  let parens = 0;
  // True once the header has reached the part that lists parents.
  let listing = false;
  // Python: the value of a keyword argument such as `metaclass=ABCMeta` is not a parent.
  let keywordValue = false;

  for (let i = 0; i < header.length; ) {
    const char = header[i];
    if (char === '{' || (python && char === ':' && parens === 0)) {
      break;
    }
    if (/[A-Za-z_$]/.test(char)) {
      identifier.lastIndex = i;
      const first = identifier.exec(header)![0];
      // A qualified name such as `vscode.Disposable`: the last part is the one to look up.
      let end = i + first.length;
      let lastPartStart = i;
      while (header[end] === '.' && /[A-Za-z_$]/.test(header[end + 1] ?? '')) {
        identifier.lastIndex = end + 1;
        lastPartStart = end + 1;
        end = lastPartStart + identifier.exec(header)![0].length;
      }
      if (angles === 0) {
        if (!python && parens === 0 && (first === 'extends' || first === 'implements')) {
          listing = true;
        } else if (!python && parens === 0 && first === 'where') {
          break; // C# generic constraints follow; the parents are over.
        } else if (listing && !keywordValue && !HEADER_KEYWORDS.has(first) && parens === (python ? 1 : 0)) {
          const isKeywordName = python && /^\s*=/.test(header.slice(end));
          if (!isKeywordName) {
            parents.push({ name: header.slice(i, end), position: document.positionAt(headerStart + lastPartStart) });
          }
        }
      }
      i = end;
      continue;
    }
    if (char === '<') {
      angles++;
    } else if (char === '>') {
      angles = Math.max(0, angles - 1);
    } else if (char === '(') {
      parens++;
      listing ||= python;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
    } else if (char === ':' && !python && angles === 0 && parens === 0) {
      listing = true;
    } else if (char === '=') {
      keywordValue = python;
    } else if (char === ',') {
      keywordValue = false;
    }
    i++;
  }

  const seen = new Set<string>();
  return parents.filter((parent) => !seen.has(parent.name) && seen.add(parent.name));
}

/** Finds the innermost function (or, failing that, class or object) containing a position. */
export function enclosingName(
  symbols: vscode.DocumentSymbol[],
  document: vscode.TextDocument,
  position: vscode.Position,
): string | undefined {
  let name: string | undefined;
  let level = symbols;
  for (;;) {
    const hit = level.find((symbol) => symbol.range.contains(position));
    if (!hit) {
      return name;
    }
    name = hit.name;
    if (isFunctionLike(hit, document)) {
      return name;
    }
    level = hit.children;
  }
}

/** Finds the innermost class, interface or struct whose declaration contains a position. */
export function enclosingType(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
): vscode.DocumentSymbol | undefined {
  let found: vscode.DocumentSymbol | undefined;
  let level = symbols;
  for (;;) {
    const hit = level.find((symbol) => symbol.range.contains(position));
    if (!hit) {
      return found;
    }
    if (TYPE_KINDS.has(hit.kind)) {
      found = hit;
    }
    level = hit.children;
  }
}

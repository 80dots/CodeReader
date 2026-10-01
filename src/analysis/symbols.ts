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

// `name = (a, b) => ...`, `name = async function ...`, `name: Type = x => ...`
const FUNCTION_VALUE = /^\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>)/;

/** Asks the language support installed in VS Code for the symbols of a document. */
export async function loadDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  const symbols = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri);
  // Older providers return flat SymbolInformation without ranges for names; skip those.
  return (symbols ?? []).filter((s): s is vscode.DocumentSymbol => 'selectionRange' in s);
}

/** Lists the functions and methods defined in a document, in source order. */
export async function findMethods(document: vscode.TextDocument): Promise<MethodSymbol[]> {
  let symbols = await loadDocumentSymbols(document.uri);
  // A language server that is still starting answers with nothing; give it a moment.
  for (let attempt = 0; attempt < 2 && symbols.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    symbols = await loadDocumentSymbols(document.uri);
  }

  const methods: MethodSymbol[] = [];
  const visit = (symbol: vscode.DocumentSymbol, container?: string) => {
    if (isFunctionLike(symbol, document)) {
      // Helpers nested inside a method are part of that method's story.
      methods.push({
        name: symbol.name,
        container,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
      });
      return;
    }
    for (const child of symbol.children) {
      visit(child, symbol.name);
    }
  };
  symbols.forEach((symbol) => visit(symbol));
  return methods.sort((a, b) => a.range.start.compareTo(b.range.start));
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

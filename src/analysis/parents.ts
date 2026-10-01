import * as vscode from 'vscode';
import { numberLines } from '../ai/prompts';
import { enclosingType, loadDocumentSymbols, type ParentRef } from './symbols';

/** Enough of a parent to see what it offers without sending whole libraries to the AI. */
const MAX_PARENT_LINES = 60;

export interface ResolvedParent {
  name: string;
  /** Where the parent is defined; set only when that is a file of the project. */
  uri?: string;
  line?: number;
  character?: number;
  displayPath?: string;
  /** The parent's own source, when it is defined in another file. */
  source?: string;
}

/** Looks up where a class's parent is defined, through the editor's "go to definition" support. */
export async function resolveParent(document: vscode.TextDocument, parent: ParentRef): Promise<ResolvedParent> {
  try {
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
      'vscode.executeDefinitionProvider',
      document.uri,
      parent.position,
    );
    const first = found?.[0];
    if (!first) {
      return { name: parent.name };
    }
    const uri = 'targetUri' in first ? first.targetUri : first.uri;
    const at = ('targetUri' in first ? (first.targetSelectionRange ?? first.targetRange) : first.range).start;
    const inProject =
      vscode.workspace.getWorkspaceFolder(uri) !== undefined && !/[\\/]node_modules[\\/]/.test(uri.path);
    const location = inProject ? { uri: uri.toString(), line: at.line, character: at.character } : {};
    const displayPath = vscode.workspace.asRelativePath(uri, false);

    if (uri.toString() === document.uri.toString()) {
      // Defined in the file being explained: the AI already has its source.
      return { name: parent.name, displayPath, ...location };
    }
    const target = await vscode.workspace.openTextDocument(uri);
    const declaration = enclosingType(await loadDocumentSymbols(uri), at);
    const firstLine = declaration?.range.start.line ?? at.line;
    const lastLine = Math.min(declaration?.range.end.line ?? firstLine + MAX_PARENT_LINES, firstLine + MAX_PARENT_LINES - 1, target.lineCount - 1);
    const source = target.getText(new vscode.Range(firstLine, 0, lastLine, target.lineAt(lastLine).text.length));
    return { name: parent.name, displayPath, source: numberLines(source, firstLine + 1), ...location };
  } catch {
    return { name: parent.name };
  }
}

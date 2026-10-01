import * as vscode from 'vscode';
import { Controller } from './controller';
import { CodeReaderViewProvider } from './panel/CodeReaderViewProvider';

export function activate(context: vscode.ExtensionContext): {
  controller: Controller;
  provider: CodeReaderViewProvider;
} {
  const controller = new Controller(context.globalStorageUri.fsPath);
  const provider = new CodeReaderViewProvider(context.extensionUri, controller);

  const explain = async (force: boolean) => {
    await vscode.commands.executeCommand(`${CodeReaderViewProvider.viewId}.focus`);
    await controller.explain(force);
  };

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(CodeReaderViewProvider.viewId, provider, {
      // Keeps opened method cards and scroll position while the sidebar is hidden.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codeReader.explain', () => explain(false)),
    vscode.commands.registerCommand('codeReader.refresh', () => explain(true)),
    vscode.commands.registerCommand('codeReader.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
  );

  // Exposed for scripts/integration-test.cjs.
  return { controller, provider };
}

export function deactivate(): void {}

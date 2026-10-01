import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import type { HostMessage, WebviewMessage } from '../shared/protocol';

export class CodeReaderViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'codeReader.panel';

  private view?: vscode.WebviewView;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller,
  ) {
    controller.onDidChangeState(() => this.postState());
  }

  /** True once the panel's script has started and asked for its first state. */
  get isWebviewReady(): boolean {
    return this.ready;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.html(view.webview, root);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          this.postState();
          break;
        case 'explain':
          void this.controller.explain(true);
          break;
        case 'cancel':
          this.controller.cancel();
          break;
        case 'reveal':
          void this.controller.reveal(message.uri, message.line, message.character);
          break;
        case 'highlight':
          this.controller.highlight(message.uri, message.range);
          break;
        case 'clearHighlight':
          this.controller.clearHighlight();
          break;
        case 'openSettings':
          void vscode.commands.executeCommand('codeReader.openSettings');
          break;
      }
    });
    view.onDidChangeVisibility(() => {
      // A hidden panel never reports the pointer leaving, so the mark would stay.
      if (!view.visible) {
        this.controller.clearHighlight();
      }
      this.postState();
    });
    view.onDidDispose(() => {
      this.controller.clearHighlight();
      this.view = undefined;
      this.ready = false;
    });
  }

  private postState(): void {
    if (this.view?.visible) {
      const message: HostMessage = { type: 'state', state: this.controller.state };
      void this.view.webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.css'));
    const nonce = randomBytes(16).toString('base64');
    // Inline styles are needed for the style attributes React and Radix set on elements.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Code Reader</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }
}

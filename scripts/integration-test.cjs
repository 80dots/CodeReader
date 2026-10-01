// Runs inside a real VS Code extension host (see scripts/run-integration-test.mjs):
// opens a file of this project, asks the extension to explain it with the real AI CLI,
// and writes the resulting panel state to CODE_READER_TEST_OUTPUT.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const root = path.resolve(__dirname, '..');
  const target = process.env.CODE_READER_TEST_FILE || 'src/analysis/symbols.ts';
  const output = process.env.CODE_READER_TEST_OUTPUT;

  const extension = vscode.extensions.getExtension('codereader-dev.code-reader');
  if (!extension) {
    throw new Error('extension not found');
  }
  const { controller, provider } = await extension.activate();

  const document = await vscode.workspace.openTextDocument(path.join(root, target));
  await vscode.window.showTextDocument(document);

  // A freshly started language server needs a moment before it can list symbols.
  for (let waited = 0; waited < 60_000; waited += 1000) {
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    if (symbols && symbols.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  let summarySeconds;
  const subscription = controller.onDidChangeState((partial) => {
    if (partial.summary && summarySeconds === undefined) {
      summarySeconds = elapsed();
    }
  });
  await vscode.commands.executeCommand('codeReader.explain');
  subscription.dispose();
  const state = controller.state;
  const seconds = elapsed();

  // The panel's script only reports in when it loaded and ran under the webview's security policy.
  for (let waited = 0; waited < 10_000 && !provider.isWebviewReady; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (output) {
    fs.writeFileSync(output, JSON.stringify({ seconds, summarySeconds, webviewReady: provider.isWebviewReady, state }, null, 2));
  }
  if (!provider.isWebviewReady) {
    throw new Error('the panel webview never reported ready');
  }
  if (state.status !== 'done') {
    throw new Error(`explanation ended with status "${state.status}": ${JSON.stringify(state.error)}`);
  }
};

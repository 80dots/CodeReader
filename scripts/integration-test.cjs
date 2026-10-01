// Runs inside a real VS Code extension host (see scripts/run-integration-test.mjs):
// opens a file of this project, asks the extension to explain it with the real AI CLI,
// and writes the resulting panel state to CODE_READER_TEST_OUTPUT.
// With CODE_READER_TEST_MODE=saved it instead checks that the explanation saved by an
// earlier run shows up by itself, without asking the AI again.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const root = path.resolve(__dirname, '..');
  const target = process.env.CODE_READER_TEST_FILE || 'src/analysis/symbols.ts';
  const output = process.env.CODE_READER_TEST_OUTPUT;
  const expectSaved = process.env.CODE_READER_TEST_MODE === 'saved';

  const extension = vscode.extensions.getExtension('codereader-dev.code-reader');
  if (!extension) {
    throw new Error('extension not found');
  }
  const { controller, provider } = await extension.activate();

  const document = await vscode.workspace.openTextDocument(path.resolve(root, target));
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
  if (expectSaved) {
    // Opening the file is all it should take.
    for (let waited = 0; waited < 5000 && controller.state.status !== 'done'; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await vscode.commands.executeCommand('codeReader.panel.focus');
  } else {
    // "refresh" writes a new explanation even when one is saved already.
    await vscode.commands.executeCommand('codeReader.refresh');
  }
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
  if (expectSaved && !state.savedAt) {
    throw new Error(`expected a saved explanation, found status "${state.status}"`);
  }
  if (state.status !== 'done') {
    throw new Error(`explanation ended with status "${state.status}": ${JSON.stringify(state.error)}`);
  }
};

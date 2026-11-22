import * as vscode from 'vscode';
import { basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { open, Table } from './readers';
import { cell, isFloat, sortOrder, stats } from './table';

interface ViewRequest { table: number; col: number | null; sort: number | null; desc: boolean; offset: number; size: number }

export function activate(context: vscode.ExtensionContext) {
  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: uri => ({ uri, dispose() {} }),
    resolveCustomEditor: (document, panel) => serve(context, document.uri, panel),
  };
  const options = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('fileViewer.data', provider, options),
    vscode.window.registerCustomEditorProvider('fileViewer.text', provider, options),
  );
}

function serve(context: vscode.ExtensionContext, uri: vscode.Uri, panel: vscode.WebviewPanel) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
  panel.webview.html = html(panel.webview, media);

  const openTables = async (path: string) => (await open(path)).map(t => ({ ...t, file: basename(path) }));
  const meta = (list: Table[]) => list.map(({ load, ...t }) => t);
  const tables = openTables(uri.fsPath), cache = new Map<string, any>();
  const memo = <T>(key: string, compute: () => T): T => cache.get(key) ?? cache.set(key, compute()).get(key);

  async function view({ table, col, sort, desc, offset, size }: ViewRequest) {
    const columns = await memo(`load ${table}`, async () => (await tables)[table].load());
    const total = columns[0]?.values.length ?? 0, start = Math.max(0, Math.min(offset, total - 1));
    const order = sort === null ? null : memo(`sort ${table} ${sort} ${desc}`, () => sortOrder(columns[sort].values, desc));
    const rows = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => {
      const r = order ? order[start + i] : start + i;
      return [r, ...columns.map(c => cell(c.values[r], c.dtype))];
    });
    return {
      table, total, offset: start, rows,
      columns: columns.map(({ name, dtype }) => ({ name, dtype, float: isFloat(dtype) })),
      stats: memo(`stats ${table} ${col}`, () => stats(col === null ? columns : [columns[col]])),
    };
  }

  panel.webview.onDidReceiveMessage(async message => {
    const post = (reply: object) => panel.webview.postMessage(reply);
    try {
      if (message.type === 'ready') post({ type: 'init', name: basename(uri.fsPath), prefs: context.globalState.get('prefs'), tables: meta(await tables) });
      if (message.type === 'prefs') context.globalState.update('prefs', message.prefs);
      if (message.type === 'open') {
        const added = await openTables(resolve(dirname(uri.fsPath), message.path.replace(/^~(?=[/\\]|$)/, homedir())));
        (await tables).push(...added);
        post({ type: 'add', tables: meta(added) });
      }
      if (message.type === 'view') post({ type: 'view', id: message.id, ...await view(message) });
    } catch (e: any) {
      const error = e?.message ?? String(e);
      message.type === 'open' ? vscode.window.showErrorMessage(error) : post({ type: 'error', id: message.id, message: error });
    }
  });
}

function html(webview: vscode.Webview, media: vscode.Uri) {
  const src = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
  const nonce = crypto.randomUUID();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${src('main.css')}">
</head>
<body class="mono">
  <header>
    <span id="title"></span>
    <label>Open <input id="path" placeholder="relative or absolute path"></label>
    <label>Decimals <select id="decimals"><option value="">auto</option>${[...Array(11).keys()].map(d => `<option>${d}</option>`).join('')}</select></label>
    <label>Font <select id="font"><option value="mono">Monospace</option><option value="default">Default</option></select></label>
    <label>Rows / window <input id="size" type="number" min="1" step="50"></label>
    <span class="nav">
      <button id="first" title="First window">⏮</button><button id="prev" title="Previous window">◀</button>
      <label>Start row <input id="start" type="number" min="1"></label><span id="range"></span>
      <button id="next" title="Next window">▶</button><button id="last" title="Last window">⏭</button>
    </span>
  </header>
  <main>
    <nav id="tree"></nav><div class="sash" data-pane="left"></div>
    <div id="panes"></div>
    <div class="sash" data-pane="right"></div><aside id="stats"></aside>
  </main>
  <template id="pane-template"><section class="pane"><div class="tab"><span></span><button class="close" title="Close">×</button></div><div class="grid"><table><thead></thead><tbody></tbody></table><div class="status"></div></div></section></template>
  <script nonce="${nonce}" src="${src('main.js')}"></script>
</body>
</html>`;
}

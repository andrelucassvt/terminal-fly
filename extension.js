// Terminal Fly — terminais livres num canvas infinito (estilo Freeform).
// O painel de terminal nativo do VS Code não permite layout livre, então a
// extensão abre um Webview com xterm.js e liga cada cartão a um shell real
// via node-pty (o mesmo que o VS Code usa internamente).
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const VIEW_TYPE = 'terminalFly';
const LAYOUT_KEY = 'terminalFly.layout';

/** @type {CanvasPanel | undefined} */
let current;

// ---------------------------------------------------------------------------
// node-pty: usa a cópia que já vem dentro do VS Code (evita compilar módulo
// nativo para a versão do Electron).
// ---------------------------------------------------------------------------
let ptyModule;
function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  const root = vscode.env.appRoot;
  const candidates = [
    path.join(root, 'node_modules', 'node-pty'),
    path.join(root, 'node_modules.asar.unpacked', 'node-pty'),
    path.join(root, 'node_modules.asar', 'node-pty'),
    'node-pty',
  ];
  for (const c of candidates) {
    try {
      ptyModule = require(c);
      return ptyModule;
    } catch (_) { /* tenta o próximo */ }
  }
  ptyModule = null;
  return ptyModule;
}

function getShell() {
  return vscode.env.shell || process.env.SHELL ||
    (process.platform === 'win32' ? (process.env.COMSPEC || 'powershell.exe') : '/bin/zsh');
}

function getCwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : os.homedir();
}

class Session {
  constructor(id, cols, rows, onData, onExit) {
    this.id = id;
    const shell = getShell();
    const args = process.platform === 'win32' ? [] : ['-l'];
    const cwd = getCwd();
    const env = Object.assign({}, process.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'vscode',
    });
    const pty = loadPty();
    if (pty) {
      this.kind = 'pty';
      this.proc = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
      this.proc.onData(onData);
      this.proc.onExit((e) => onExit(e.exitCode));
    } else {
      // Fallback sem node-pty: script(1) cria um TTY de verdade (sem resize).
      this.kind = 'pipe';
      let cmd = shell;
      let cargs = [];
      if (process.platform === 'darwin') { cmd = 'script'; cargs = ['-q', '/dev/null', shell, ...args]; }
      else if (process.platform === 'linux') { cmd = 'script'; cargs = ['-qfc', [shell, ...args].join(' '), '/dev/null']; }
      this.proc = cp.spawn(cmd, cargs, { cwd, env: Object.assign(env, { COLUMNS: String(cols), LINES: String(rows) }) });
      this.proc.stdout.on('data', (d) => onData(d.toString('utf8')));
      this.proc.stderr.on('data', (d) => onData(d.toString('utf8')));
      this.proc.on('exit', (code) => onExit(code));
    }
  }
  write(data) {
    try {
      if (this.kind === 'pty') this.proc.write(data);
      else this.proc.stdin.write(data);
    } catch (_) { /* processo já saiu */ }
  }
  resize(cols, rows) {
    if (this.kind !== 'pty' || !cols || !rows) return;
    try { this.proc.resize(cols, rows); } catch (_) { /* ignore */ }
  }
  kill() {
    try { this.proc.kill(); } catch (_) { /* ignore */ }
  }
}

class CanvasPanel {
  /**
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.ExtensionContext} context
   */
  constructor(panel, context) {
    this.panel = panel;
    this.context = context;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.outBuf = new Map();
    this.flushTimer = null;
    this.ready = false;
    this.queue = [];
    this.disposables = [];

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const modules = vscode.Uri.joinPath(context.extensionUri, 'node_modules');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, modules] };
    panel.iconPath = new vscode.ThemeIcon('terminal');
    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily') ||
          e.affectsConfiguration('terminalFly')) {
        this.post({ type: 'config', config: this.config() });
      }
    }, null, this.disposables);
  }

  config() {
    const t = vscode.workspace.getConfiguration('terminal.integrated');
    const ed = vscode.workspace.getConfiguration('editor');
    const c = vscode.workspace.getConfiguration('terminalFly');
    return {
      fontFamily: t.get('fontFamily') || ed.get('fontFamily') || 'Menlo, Monaco, monospace',
      fontSize: t.get('fontSize') || 12,
      lineHeight: t.get('lineHeight') || 1,
      cursorBlink: t.get('cursorBlinking') ?? true,
      macOptionIsMeta: t.get('macOptionIsMeta') ?? false,
      scrollback: t.get('scrollback') || 5000,
      defaultWidth: c.get('defaultWidth') || 680,
      defaultHeight: c.get('defaultHeight') || 400,
      ptyAvailable: !!loadPty(),
    };
  }

  post(msg) {
    if (!this.ready) { this.queue.push(msg); return; }
    this.panel.webview.postMessage(msg);
  }

  // Junta pedaços pequenos de saída (node-pty emite muitos) antes de enviar.
  pushOutput(id, data) {
    this.outBuf.set(id, (this.outBuf.get(id) || '') + data);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        for (const [sid, d] of this.outBuf) this.post({ type: 'data', id: sid, data: d });
        this.outBuf.clear();
      }, 5);
    }
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const restore = vscode.workspace.getConfiguration('terminalFly').get('restoreLayout', true);
        const layout = restore ? this.context.workspaceState.get(LAYOUT_KEY) : undefined;
        this.panel.webview.postMessage({ type: 'init', config: this.config(), layout: layout || null });
        for (const q of this.queue) this.panel.webview.postMessage(q);
        this.queue = [];
        break;
      }
      case 'create': {
        if (this.sessions.has(m.id)) break;
        try {
          const s = new Session(m.id, m.cols || 80, m.rows || 24,
            (d) => this.pushOutput(m.id, d),
            (code) => {
              this.sessions.delete(m.id);
              this.post({ type: 'exit', id: m.id, code });
            });
          this.sessions.set(m.id, s);
          if (s.kind !== 'pty' && !this.warnedPty) {
            this.warnedPty = true;
            vscode.window.showWarningMessage(vscode.l10n.t('Terminal Fly: node-pty not found; using simplified mode (the shell will not be resized).'));
          }
        } catch (err) {
          this.post({ type: 'data', id: m.id, data: `\r\n\x1b[31m${vscode.l10n.t('Failed to start the shell: {0}', String(err && err.message))}\x1b[0m\r\n` });
        }
        break;
      }
      case 'input': {
        const s = this.sessions.get(m.id);
        if (s) s.write(m.data);
        break;
      }
      case 'resize': {
        const s = this.sessions.get(m.id);
        if (s) s.resize(m.cols, m.rows);
        break;
      }
      case 'kill': {
        const s = this.sessions.get(m.id);
        if (s) { s.kill(); this.sessions.delete(m.id); }
        break;
      }
      case 'layout':
        this.context.workspaceState.update(LAYOUT_KEY, m.layout);
        break;
      case 'openLink':
        if (m.uri) vscode.env.openExternal(vscode.Uri.parse(m.uri));
        break;
    }
  }

  command(name) {
    this.panel.reveal();
    this.post({ type: 'command', name });
  }

  dispose() {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
    for (const d of this.disposables) { try { d.dispose(); } catch (_) { /* ignore */ } }
    if (current === this) current = undefined;
  }

  html() {
    const w = this.panel.webview;
    const ext = this.context.extensionUri;
    const u = (...p) => w.asWebviewUri(vscode.Uri.joinPath(ext, ...p));
    const t = (...a) => vscode.l10n.t(...a);
    const esc = (x) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const strings = {
      changeColor: t('Change color'),
      rename: t('Double-click to rename'),
      close: t('Close terminal'),
    };
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; img-src ${w.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${u('node_modules', '@xterm', 'xterm', 'css', 'xterm.css')}">
<link rel="stylesheet" href="${u('media', 'canvas.css')}">
<title>Terminal Fly</title>
</head>
<body>
<script nonce="${nonce}">window.TF_STRINGS = ${JSON.stringify(strings).replace(/</g, '\\u003c')};</script>
<div id="viewport"><div id="world"></div></div>

<div class="pill top" id="toolbar">
  <button id="btn-new" title="${esc(t('New terminal (or double-click the canvas)'))}">
    <svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" /></svg><span>Terminal</span>
  </button>
  <div class="sep"></div>
  <button id="btn-tile" title="${esc(t('Arrange in grid'))}">
    <svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
  </button>
  <button id="btn-fit" title="${esc(t('Fit all to screen'))}">
    <svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>
  </button>
</div>

<div class="pill bottom-left">
  <button id="btn-zoom-out" title="${esc(t('Zoom out'))}"><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
  <button id="zoom-label" class="label" title="${esc(t('Reset to 100%'))}">100%</button>
  <button id="btn-zoom-in" title="${esc(t('Zoom in'))}"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
</div>

<div class="hint" id="hint">${esc(t('Drag the background to pan · ⌘/Ctrl + scroll or pinch to zoom · double-click for a new terminal'))}</div>

<script nonce="${nonce}" src="${u('node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')}"></script>
<script nonce="${nonce}" src="${u('node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')}"></script>
<script nonce="${nonce}" src="${u('node_modules', '@xterm', 'addon-web-links', 'lib', 'addon-web-links.js')}"></script>
<script nonce="${nonce}" src="${u('media', 'canvas.js')}"></script>
</body>
</html>`;
  }
}

function openPanel(context) {
  if (current) { current.panel.reveal(); return current; }
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Terminal Fly', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  current = new CanvasPanel(panel, context);
  return current;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalFly.open', () => openPanel(context)),
    vscode.commands.registerCommand('terminalFly.newTerminal', () => {
      const existed = !!current;
      const p = openPanel(context);
      if (existed) p.command('new');
    }),
    vscode.commands.registerCommand('terminalFly.fitAll', () => openPanel(context).command('fitAll')),
    vscode.commands.registerCommand('terminalFly.tile', () => openPanel(context).command('tile')),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        current = new CanvasPanel(panel, context);
      },
    })
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '$(layout) Terminal Fly';
  item.tooltip = vscode.l10n.t('Open Terminal Fly');
  item.command = 'terminalFly.open';
  item.show();
  context.subscriptions.push(item);
}

function deactivate() {
  if (current) current.dispose();
}

module.exports = { activate, deactivate };

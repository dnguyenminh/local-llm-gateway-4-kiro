/**
 * LLM Gateway Extension — Entry Point
 */
import * as vscode from 'vscode';
import { ServerLifecycleManager } from './lifecycle/server-lifecycle-manager';
import { ProcessManager } from './process/process-manager';
import { HealthChecker } from './health/health-checker';
import { COMMANDS, DEFAULTS } from './lifecycle/constants';
import { LifecycleConfig, StateChangeEvent, ServerState } from './lifecycle/types';

let lifecycleManager: ServerLifecycleManager | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('LLM Gateway');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = COMMANDS.SHOW_STATUS;
  statusBarItem.show();

  const config = readConfig();
  const processManager = new ProcessManager();
  const healthChecker = new HealthChecker();

  lifecycleManager = new ServerLifecycleManager(config, processManager, healthChecker, context.globalState);

  // Status bar updates
  lifecycleManager.on('state-changed', (event: StateChangeEvent) => {
    updateStatusBar(event.current);
    log(`State: ${event.previous} -> ${event.current} (${event.reason || 'n/a'})`);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.START, async () => {
      if (lifecycleManager?.getStatus().state === ServerState.Running) {
        vscode.window.showInformationMessage(`LLM Gateway is already running on port ${config.port}`);
        return;
      }
      await lifecycleManager?.start();
      vscode.window.showInformationMessage(`LLM Gateway started on port ${config.port}`);
    }),
    vscode.commands.registerCommand(COMMANDS.STOP, async () => {
      if (lifecycleManager?.getStatus().state === ServerState.Stopped) {
        vscode.window.showInformationMessage('LLM Gateway is not running');
        return;
      }
      await lifecycleManager?.stop();
      vscode.window.showInformationMessage('LLM Gateway stopped');
    }),
    vscode.commands.registerCommand(COMMANDS.RESTART, async () => {
      await lifecycleManager?.restart();
      vscode.window.showInformationMessage(`LLM Gateway restarted on port ${config.port}`);
    }),
    vscode.commands.registerCommand(COMMANDS.SHOW_STATUS, async () => {
      const status = lifecycleManager?.getStatus();
      if (!status) return;
      const cfg = readConfig();
      const key = await getGatewayKey(cfg.port);
      openGatewayInfoPanel(context, cfg.port, status, key);
    }),
    statusBarItem,
    outputChannel,
    vscode.commands.registerCommand('kiroGateway.copyApiKey', async () => {
      const cfg = readConfig();
      const key = await getGatewayKey(cfg.port);
      if (key) {
        await vscode.env.clipboard.writeText(key);
        vscode.window.showInformationMessage('Gateway API Key copied to clipboard');
      } else {
        vscode.window.showWarningMessage('Gateway API Key not available');
      }
    }),
  );

  // Config change watcher
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kiroGateway')) {
        const newConfig = readConfig();
        lifecycleManager?.handleConfigChange(newConfig);
        if (e.affectsConfiguration('kiroGateway.port') || e.affectsConfiguration('kiroGateway.serverPath')) {
          vscode.window.showInformationMessage('LLM Gateway: Restart server to apply port/path changes', 'Restart').then((choice) => {
            if (choice === 'Restart') lifecycleManager?.restart();
          });
        }
      }
    })
  );

  updateStatusBar(ServerState.Stopped);

  // Initialize async (non-blocking)
  lifecycleManager.initialize().catch((err) => {
    log(`ERROR: ${err.message}`);
  });
}

export async function deactivate(): Promise<void> {
  if (lifecycleManager) {
    await lifecycleManager.dispose();
  }
}

function readConfig(): LifecycleConfig {
  const path = require('path');
  const cfg = vscode.workspace.getConfiguration('kiroGateway');
  let serverPath = cfg.get<string>('serverPath', '');

  if (!serverPath) {
    // Default: bundled server inside extension directory
    serverPath = path.join(__dirname, '..', 'server', 'index.js');
  } else if (!path.isAbsolute(serverPath)) {
    // User-configured relative path: resolve from workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      serverPath = path.resolve(workspaceFolder, serverPath);
    }
  }

  return {
    port: cfg.get<number>('port', DEFAULTS.PORT),
    autoStart: cfg.get<boolean>('autoStart', DEFAULTS.AUTO_START),
    serverPath,
    healthCheckInterval: cfg.get<number>('healthCheckInterval', DEFAULTS.HEALTH_CHECK_INTERVAL),
  };
}

function updateStatusBar(state: ServerState): void {
  const icons: Record<ServerState, string> = {
    [ServerState.Running]: '$(pass-filled)',
    [ServerState.Stopped]: '$(circle-slash)',
    [ServerState.Starting]: '$(loading~spin)',
    [ServerState.Stopping]: '$(loading~spin)',
    [ServerState.Restarting]: '$(sync~spin)',
    [ServerState.Error]: '$(warning)',
  };
  statusBarItem.text = `${icons[state] || '$(question)'} Kiro Gateway`;
  statusBarItem.tooltip = `Kiro Gateway: ${state}`;
}

function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function maskKey(key: string): string {
  if (key.length <= 16) return '****';
  return `${key.substring(0, 8)}...${key.substring(key.length - 4)}`;
}

async function getGatewayKey(port: number): Promise<string | null> {
  // Try HTTP
  try {
    const http = require('http');
    return await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/v1/gateway-key`, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data).gateway_key); } catch { reject(new Error('parse')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch { /* fall through */ }
  // Fallback: read from file
  try {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const keyPath = path.join(os.homedir(), '.local-llm-gateway', 'gateway-key');
    if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf-8').trim();
  } catch { /* ignore */ }
  return null;
}

// --- WebviewPanel: Gateway Info ---
let gatewayInfoPanel: vscode.WebviewPanel | undefined;

function openGatewayInfoPanel(
  context: vscode.ExtensionContext,
  port: number,
  status: any,
  gatewayKey: string | null
): void {
  if (gatewayInfoPanel) {
    gatewayInfoPanel.reveal(vscode.ViewColumn.One);
    gatewayInfoPanel.webview.html = getGatewayInfoHtml(port, status, gatewayKey);
    return;
  }

  gatewayInfoPanel = vscode.window.createWebviewPanel(
    'kiroGatewayInfo',
    'Kiro Gateway',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  gatewayInfoPanel.webview.html = getGatewayInfoHtml(port, status, gatewayKey);

  // Handle messages from webview
  gatewayInfoPanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'copyEndpoint':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Gateway endpoint copied to clipboard');
          break;
        case 'copyKey':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Gateway API key copied to clipboard');
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  gatewayInfoPanel.onDidDispose(() => {
    gatewayInfoPanel = undefined;
  }, null, context.subscriptions);
}

function getGatewayInfoHtml(port: number, status: any, gatewayKey: string | null): string {
  const endpoint = `http://127.0.0.1:${port}/anthropic`;
  const key = gatewayKey || '(unavailable)';
  const stateColor = status.state === 'running' ? '#3fb950' : status.state === 'error' ? '#f85149' : '#8b949e';
  const stateIcon = status.state === 'running' ? '✅' : status.state === 'error' ? '❌' : '⏸️';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Kiro Gateway</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0d1117);
    --card: var(--vscode-editorWidget-background, #161b22);
    --field: var(--vscode-input-background, #0d1117);
    --border: var(--vscode-editorWidget-border, #30363d);
    --text: var(--vscode-editor-foreground, #e6edf3);
    --muted: var(--vscode-descriptionForeground, #8b949e);
    --green: #3fb950;
    --blue: #2f81f7;
    --red: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }
  .section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 1.1em;
    font-weight: 600;
  }
  .subtitle {
    color: var(--muted);
    font-size: 0.85em;
    margin: 0 0 18px;
    line-height: 1.5;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    padding: 4px 10px;
    border-radius: 12px;
    background: color-mix(in srgb, ${stateColor} 15%, transparent);
    color: ${stateColor};
    font-weight: 500;
    margin-bottom: 16px;
  }
  label {
    display: block;
    font-size: 0.8em;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 6px;
    margin-top: 14px;
  }
  .field {
    display: flex;
    align-items: center;
    background: var(--field);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .field input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 0.9em;
    padding: 10px 12px;
    outline: none;
    min-width: 0;
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0 12px;
    height: 40px;
    display: flex;
    align-items: center;
    font-size: 1em;
    transition: color 0.15s;
  }
  .icon-btn:hover { color: var(--text); }
  .toast {
    display: none;
    align-items: center;
    gap: 6px;
    color: var(--green);
    font-size: 0.8em;
    margin-top: 12px;
  }
  .toast.show { display: flex; }
  .toast .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 3px;
    background: var(--green);
    color: #0d1117;
    font-size: 0.65em;
    font-weight: 700;
  }
  .info-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 16px;
    font-size: 0.85em;
    margin-top: 12px;
  }
  .info-grid dt { color: var(--muted); }
  .info-grid dd { margin: 0; }
</style>
</head>
<body>
  <div class="section">
    <h2>🔌 Gateway Info (Anthropic-compatible)</h2>
    <p class="subtitle">
      No API key needed — gateway uses Kiro IDE credentials. Copy endpoint + key below
      to configure external agents (Cline/Cursor/...).
    </p>

    <div class="status-badge">${stateIcon} ${status.state}</div>

    <label for="endpoint">Gateway Endpoint</label>
    <div class="field">
      <input id="endpoint" type="text" readonly value="${endpoint}">
      <button class="icon-btn" id="copy-endpoint" title="Copy endpoint">📋</button>
    </div>

    <label for="apikey">Gateway API Key</label>
    <div class="field">
      <input id="apikey" type="password" readonly value="${key}">
      <button class="icon-btn" id="toggle-key" title="Show/hide key">👁️</button>
      <button class="icon-btn" id="copy-key" title="Copy key">📋</button>
    </div>

    <div class="toast" id="toast"><span class="check">✓</span><span id="toast-msg"></span></div>
  </div>

  <div class="section">
    <h2>ℹ️ Server Status</h2>
    <dl class="info-grid">
      <dt>State</dt><dd style="color:${stateColor}">${status.state}</dd>
      <dt>Port</dt><dd>${status.port}</dd>
      <dt>PID</dt><dd>${status.pid || 'N/A'}</dd>
      <dt>Uptime</dt><dd>${status.uptime || 'N/A'}</dd>
      <dt>Manager</dt><dd>${status.isManager ? 'Yes' : 'No'}</dd>
      <dt>Last Error</dt><dd>${status.lastError || 'None'}</dd>
    </dl>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toast-msg');
      let timer = null;

      function showToast(msg) {
        toastMsg.textContent = msg;
        toast.classList.add('show');
        if (timer) clearTimeout(timer);
        timer = setTimeout(function() { toast.classList.remove('show'); }, 2500);
      }

      document.getElementById('copy-endpoint').addEventListener('click', function() {
        const val = document.getElementById('endpoint').value;
        vscode.postMessage({ command: 'copyEndpoint', text: val });
        showToast('Gateway endpoint copied to clipboard');
      });

      document.getElementById('copy-key').addEventListener('click', function() {
        const val = document.getElementById('apikey').value;
        vscode.postMessage({ command: 'copyKey', text: val });
        showToast('Gateway API key copied to clipboard');
      });

      document.getElementById('toggle-key').addEventListener('click', function() {
        const el = document.getElementById('apikey');
        el.type = el.type === 'password' ? 'text' : 'password';
      });
    })();
  </script>
</body>
</html>`;
}

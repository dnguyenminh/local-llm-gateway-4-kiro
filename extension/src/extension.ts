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
      outputChannel.clear();
      outputChannel.appendLine('=== LLM Gateway Status ===');
      outputChannel.appendLine(`State:    ${status.state}`);
      outputChannel.appendLine(`Port:     ${status.port}`);
      outputChannel.appendLine(`PID:      ${status.pid || 'N/A'}`);
      outputChannel.appendLine(`Uptime:   ${status.uptime || 'N/A'}`);
      outputChannel.appendLine(`Manager:  ${status.isManager ? 'Yes' : 'No'}`);
      outputChannel.appendLine(`Error:    ${status.lastError || 'None'}`);
      outputChannel.appendLine('');
      // Always show connection info
      outputChannel.appendLine('=== Connection Info ===');
      outputChannel.appendLine(`Base URL: http://127.0.0.1:${status.port}/anthropic`);
      const key = await getGatewayKey(status.port);
      outputChannel.appendLine(`API Key:  ${key ? maskKey(key) : '(not available)'}`);
      outputChannel.appendLine('');
      outputChannel.appendLine('💡 Use "LLM Gateway: Copy API Key" command to copy full key to clipboard');
      outputChannel.show();
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
  const cfg = vscode.workspace.getConfiguration('kiroGateway');
  let serverPath = cfg.get<string>('serverPath', DEFAULTS.SERVER_PATH);

  // Resolve relative serverPath from workspace folder
  if (serverPath && !require('path').isAbsolute(serverPath)) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      serverPath = require('path').resolve(workspaceFolder, serverPath);
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
  statusBarItem.text = `${icons[state] || '$(question)'} LLM Gateway`;
  statusBarItem.tooltip = `LLM Gateway: ${state}`;
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

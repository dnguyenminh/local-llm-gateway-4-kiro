/**
 * Process Manager — Spawn and kill server processes cross-platform
 */
import { spawn, ChildProcess } from 'child_process';
import { TIMEOUTS } from '../lifecycle/constants';

export class ProcessManager {
  private childProcess: ChildProcess | null = null;
  private exitCallback: ((code: number | null, signal: string | null) => void) | null = null;

  async spawn(serverPath: string, port: number): Promise<number> {
    const path = require('path');
    const args = ['--port', port.toString()];
    const isWin = process.platform === 'win32';
    const cwd = path.dirname(path.resolve(serverPath));
    this.childProcess = spawn('node', [serverPath, ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
      cwd,
      env: { ...process.env, KIRO_GATEWAY_PORT: port.toString() },
    });
    if (!this.childProcess.pid) throw new Error('Failed to spawn server process');
    this.childProcess.on('exit', (code, signal) => {
      if (this.exitCallback) this.exitCallback(code, signal);
    });
    this.childProcess.unref();
    return this.childProcess.pid;
  }

  async kill(pid: number, gracefulTimeoutMs: number = TIMEOUTS.GRACEFUL_SHUTDOWN_MS): Promise<void> {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pid.toString(), '/t'], { shell: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (err: any) {
      if (err.code === 'ESRCH') return;
      throw err;
    }
    const exited = await this.waitForExit(pid, gracefulTimeoutMs);
    if (!exited) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', pid.toString(), '/f', '/t'], { shell: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch { /* dead */ }
    }
  }

  isRunning(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  onExit(callback: (code: number | null, signal: string | null) => void): void {
    this.exitCallback = callback;
  }

  private waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!this.isRunning(pid)) { clearInterval(interval); clearTimeout(timeout); resolve(true); }
      }, 200);
      const timeout = setTimeout(() => { clearInterval(interval); resolve(false); }, timeoutMs);
    });
  }
}

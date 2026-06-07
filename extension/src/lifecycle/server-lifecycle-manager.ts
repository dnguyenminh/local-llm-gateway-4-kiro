/**
 * Server Lifecycle Manager — Core orchestrator and state machine
 */
import { EventEmitter } from 'events';
import { ServerState, ServerStatus, LifecycleConfig, VALID_TRANSITIONS, StateChangeEvent } from './types';
import { TIMEOUTS, RESTART, GLOBAL_STATE_KEYS } from './constants';
import { ProcessManager } from '../process/process-manager';
import { HealthChecker } from '../health/health-checker';
import { PortChecker } from '../process/port-checker';

interface GlobalState {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

export class ServerLifecycleManager extends EventEmitter {
  private state: ServerState = ServerState.Stopped;
  private config: LifecycleConfig;
  private processManager: ProcessManager;
  private healthChecker: HealthChecker;
  private globalState: GlobalState;
  private isManager: boolean = false;
  private serverPid: number | null = null;
  private startedAt: Date | null = null;
  private lastError: string | null = null;
  private windowId: string;

  constructor(config: LifecycleConfig, processManager: ProcessManager, healthChecker: HealthChecker, globalState: GlobalState) {
    super();
    this.config = config;
    this.processManager = processManager;
    this.healthChecker = healthChecker;
    this.globalState = globalState;
    this.windowId = Math.random().toString(36).substring(2);

    this.healthChecker.on('restart-needed', () => this.handleAutoRestart());
    this.processManager.onExit((code) => {
      if (this.state === ServerState.Running && code !== 0) {
        this.handleAutoRestart();
      }
    });
  }

  async initialize(): Promise<void> {
    const activeWindows = (this.globalState.get<number>(GLOBAL_STATE_KEYS.ACTIVE_WINDOWS) || 0) + 1;
    await this.globalState.update(GLOBAL_STATE_KEYS.ACTIVE_WINDOWS, activeWindows);

    const existingPid = this.globalState.get<number>(GLOBAL_STATE_KEYS.SERVER_PID);
    if (existingPid && this.processManager.isRunning(existingPid)) {
      this.serverPid = existingPid;
      this.isManager = false;
      this.setState(ServerState.Running, 'Connected to existing server');
      this.healthChecker.start(this.config.port, this.config.healthCheckInterval);
      return;
    }

    const portFree = await PortChecker.isPortFree(this.config.port);
    if (!portFree) {
      const isKiro = await PortChecker.isKiroServer(this.config.port);
      if (isKiro) {
        this.isManager = false;
        this.setState(ServerState.Running, 'Connected to existing Kiro server');
        this.healthChecker.start(this.config.port, this.config.healthCheckInterval);
        return;
      }
      this.lastError = `Port ${this.config.port} is in use by another application`;
      this.setState(ServerState.Error, this.lastError);
      return;
    }

    this.isManager = true;
    await this.globalState.update(GLOBAL_STATE_KEYS.MANAGER_WINDOW_ID, this.windowId);

    if (this.config.autoStart) {
      await this.start();
    }
  }

  async start(): Promise<void> {
    if (this.state === ServerState.Running) return;
    if (!VALID_TRANSITIONS[this.state].includes(ServerState.Starting)) return;

    this.setState(ServerState.Starting, 'Starting server');
    try {
      this.serverPid = await this.processManager.spawn(this.config.serverPath, this.config.port);
      await this.globalState.update(GLOBAL_STATE_KEYS.SERVER_PID, this.serverPid);
      this.isManager = true;

      await this.waitForHealth(TIMEOUTS.STARTUP_MS);
      this.startedAt = new Date();
      this.setState(ServerState.Running, 'Server started');
      this.healthChecker.start(this.config.port, this.config.healthCheckInterval);
    } catch (err: any) {
      this.lastError = err.message;
      this.setState(ServerState.Error, err.message);
      if (this.serverPid) {
        try { await this.processManager.kill(this.serverPid, 2000); } catch {}
        this.serverPid = null;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.state === ServerState.Stopped) return;
    if (!VALID_TRANSITIONS[this.state].includes(ServerState.Stopping)) return;

    this.setState(ServerState.Stopping, 'Stopping server');
    this.healthChecker.stop();

    if (this.serverPid && this.isManager) {
      await this.processManager.kill(this.serverPid, TIMEOUTS.GRACEFUL_SHUTDOWN_MS);
    }
    this.serverPid = null;
    this.startedAt = null;
    this.setState(ServerState.Stopped, 'Server stopped');
  }

  async restart(): Promise<void> {
    if (this.state === ServerState.Running) {
      await this.stop();
    }
    await this.start();
  }

  getStatus(): ServerStatus {
    let uptime: string | null = null;
    if (this.startedAt) {
      const ms = Date.now() - this.startedAt.getTime();
      const hours = Math.floor(ms / 3600000);
      const mins = Math.floor((ms % 3600000) / 60000);
      uptime = `${hours}h ${mins}m`;
    }
    return {
      state: this.state,
      port: this.config.port,
      pid: this.serverPid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      uptime,
      isManager: this.isManager,
    };
  }

  handleConfigChange(newConfig: Partial<LifecycleConfig>): void {
    if (newConfig.healthCheckInterval && newConfig.healthCheckInterval !== this.config.healthCheckInterval) {
      this.config.healthCheckInterval = newConfig.healthCheckInterval;
      if (this.state === ServerState.Running) {
        this.healthChecker.updateInterval(this.config.port, this.config.healthCheckInterval);
      }
    }
    if (newConfig.port) this.config.port = newConfig.port;
    if (newConfig.serverPath) this.config.serverPath = newConfig.serverPath;
    if (newConfig.autoStart !== undefined) this.config.autoStart = newConfig.autoStart;
  }

  async dispose(): Promise<void> {
    this.healthChecker.stop();
    const activeWindows = Math.max(0, (this.globalState.get<number>(GLOBAL_STATE_KEYS.ACTIVE_WINDOWS) || 1) - 1);
    await this.globalState.update(GLOBAL_STATE_KEYS.ACTIVE_WINDOWS, activeWindows);

    if (activeWindows === 0 && this.isManager && this.serverPid) {
      await this.processManager.kill(this.serverPid, TIMEOUTS.GRACEFUL_SHUTDOWN_MS);
      await this.globalState.update(GLOBAL_STATE_KEYS.SERVER_PID, undefined);
    }
  }

  private setState(newState: ServerState, reason?: string): void {
    if (!VALID_TRANSITIONS[this.state]?.includes(newState) && this.state !== newState) {
      return;
    }
    const previous = this.state;
    this.state = newState;
    const event: StateChangeEvent = { previous, current: newState, timestamp: new Date(), reason };
    this.emit('state-changed', event);
  }

  private async handleAutoRestart(): Promise<void> {
    if (this.state !== ServerState.Running && this.state !== ServerState.Restarting) return;
    this.setState(ServerState.Restarting, 'Auto-restart triggered');

    for (let attempt = 0; attempt < RESTART.MAX_ATTEMPTS; attempt++) {
      await this.sleep(RESTART.BACKOFF_DELAYS_MS[attempt]);
      try {
        if (this.serverPid) {
          try { await this.processManager.kill(this.serverPid, 2000); } catch {}
        }
        this.serverPid = await this.processManager.spawn(this.config.serverPath, this.config.port);
        await this.globalState.update(GLOBAL_STATE_KEYS.SERVER_PID, this.serverPid);
        await this.waitForHealth(TIMEOUTS.STARTUP_MS);
        this.startedAt = new Date();
        this.setState(ServerState.Running, `Restart successful (attempt ${attempt + 1})`);
        this.healthChecker.reset();
        this.healthChecker.start(this.config.port, this.config.healthCheckInterval);
        return;
      } catch {
        if (this.serverPid) {
          try { await this.processManager.kill(this.serverPid, 2000); } catch {}
        }
      }
    }

    this.lastError = 'All restart attempts failed';
    this.setState(ServerState.Error, this.lastError);
  }

  private waitForHealth(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = async () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server failed to start within ${timeoutMs / 1000}s`));
          return;
        }
        const result = await this.healthChecker.probe(this.config.port);
        if (result.healthy) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

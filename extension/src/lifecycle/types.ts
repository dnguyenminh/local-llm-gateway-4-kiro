/**
 * Server Lifecycle Manager — Type definitions
 */

export enum ServerState {
  Stopped = 'stopped',
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Restarting = 'restarting',
  Error = 'error'
}

export interface ServerStatus {
  state: ServerState;
  port: number;
  pid: number | null;
  startedAt: Date | null;
  lastError: string | null;
  uptime: string | null;
  isManager: boolean;
}

export interface LifecycleConfig {
  port: number;
  autoStart: boolean;
  serverPath: string;
  healthCheckInterval: number;
}

export interface HealthResult {
  healthy: boolean;
  statusCode?: number;
  body?: any;
  error?: string;
  latencyMs: number;
}

export interface StateChangeEvent {
  previous: ServerState;
  current: ServerState;
  timestamp: Date;
  reason?: string;
}

export const VALID_TRANSITIONS: Record<ServerState, ServerState[]> = {
  [ServerState.Stopped]: [ServerState.Starting],
  [ServerState.Starting]: [ServerState.Running, ServerState.Error],
  [ServerState.Running]: [ServerState.Stopping, ServerState.Restarting],
  [ServerState.Stopping]: [ServerState.Stopped],
  [ServerState.Restarting]: [ServerState.Running, ServerState.Error],
  [ServerState.Error]: [ServerState.Starting],
};

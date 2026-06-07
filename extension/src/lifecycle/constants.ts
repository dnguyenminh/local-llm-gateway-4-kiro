/**
 * Server Lifecycle Manager — Constants
 */

export const DEFAULTS = {
  PORT: 8990,
  AUTO_START: true,
  SERVER_PATH: './dist/index.js',
  HEALTH_CHECK_INTERVAL: 30,
} as const;

export const TIMEOUTS = {
  STARTUP_MS: 10_000,
  GRACEFUL_SHUTDOWN_MS: 5_000,
  HEALTH_PROBE_MS: 5_000,
  PORT_CHECK_MS: 2_000,
  KIRO_DETECT_MS: 3_000,
} as const;

export const RESTART = {
  MAX_ATTEMPTS: 3,
  MAX_HEALTH_FAILURES: 3,
  BACKOFF_DELAYS_MS: [1_000, 2_000, 4_000],
} as const;

export const GLOBAL_STATE_KEYS = {
  ACTIVE_WINDOWS: 'kiroGateway.activeWindows',
  MANAGER_WINDOW_ID: 'kiroGateway.managerWindowId',
  SERVER_PID: 'kiroGateway.serverPid',
} as const;

export const COMMANDS = {
  START: 'kiroGateway.startServer',
  STOP: 'kiroGateway.stopServer',
  RESTART: 'kiroGateway.restartServer',
  SHOW_STATUS: 'kiroGateway.showStatus',
} as const;

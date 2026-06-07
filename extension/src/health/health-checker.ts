/**
 * Health Checker — Periodic HTTP health probes
 */
import * as http from 'http';
import { EventEmitter } from 'events';
import { TIMEOUTS, RESTART } from '../lifecycle/constants';

export class HealthChecker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;

  start(port: number, intervalSeconds: number): void {
    this.stop();
    this.consecutiveFailures = 0;
    this.timer = setInterval(() => this.check(port), intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }

  updateInterval(port: number, newIntervalSeconds: number): void {
    this.stop();
    this.start(port, newIntervalSeconds);
  }

  async check(port: number): Promise<void> {
    const result = await this.probe(port);
    if (result.healthy) {
      this.consecutiveFailures = 0;
      this.emit('healthy', result);
    } else {
      this.consecutiveFailures++;
      this.emit('unhealthy', result, this.consecutiveFailures);
      if (this.consecutiveFailures >= RESTART.MAX_HEALTH_FAILURES) {
        this.stop();
        this.emit('restart-needed');
      }
    }
  }

  probe(port: number): Promise<{ healthy: boolean; statusCode?: number; error?: string; latencyMs: number }> {
    const start = Date.now();
    return new Promise((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/v1/health', timeout: TIMEOUTS.HEALTH_PROBE_MS },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const latencyMs = Date.now() - start;
            if (res.statusCode === 200) {
              resolve({ healthy: true, statusCode: 200, latencyMs });
            } else {
              resolve({ healthy: false, statusCode: res.statusCode, error: `HTTP ${res.statusCode}`, latencyMs });
            }
          });
        }
      );
      req.on('error', (err) => {
        resolve({ healthy: false, error: err.message, latencyMs: Date.now() - start });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ healthy: false, error: 'Timeout', latencyMs: Date.now() - start });
      });
    });
  }
}

/**
 * Port Checker — TCP port availability and Kiro server detection
 */
import * as net from 'net';
import * as http from 'http';
import { TIMEOUTS } from '../lifecycle/constants';

export class PortChecker {
  static isPortFree(port: number, timeoutMs: number = TIMEOUTS.PORT_CHECK_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(true); });
      socket.connect(port, '127.0.0.1');
    });
  }

  static isKiroServer(port: number, timeoutMs: number = TIMEOUTS.KIRO_DETECT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/v1/health', timeout: timeoutMs },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const body = JSON.parse(data);
              resolve(!!body.status && !!body.credentials && !!body.api_connectivity);
            } catch { resolve(false); }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }
}

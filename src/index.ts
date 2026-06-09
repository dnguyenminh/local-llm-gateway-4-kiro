/**
 * kiro-gateway — CLI Entry Point
 * Anthropic-compatible API gateway powered by Kiro/AWS SSO credentials.
 */
import { parseConfig } from './config';
import { createServer } from './server';
import { getGatewayApiKey } from './auth/gateway-key';
import { hasValidCredentials } from './auth/credential-discovery-ext';

const config = parseConfig(process.argv.slice(2));
const server = createServer(config);

server.listen(config.port, '127.0.0.1', () => {
  const gatewayKey = getGatewayApiKey();
  const hasKiro = hasValidCredentials();
  const maskedKey = gatewayKey.length > 16
    ? `${gatewayKey.substring(0, 8)}...${gatewayKey.substring(gatewayKey.length - 5)}`
    : gatewayKey;

  console.log('');
  console.log(`\u{1F680} Kiro Gateway running at http://127.0.0.1:${config.port}`);
  console.log(`\u{1F4CB} Base URL (for agents):  http://127.0.0.1:${config.port}/anthropic`);
  console.log(`\u{1F511} Gateway API Key:        ${maskedKey}`);
  console.log(`\u{1F4A1} Configure your agent:   Base URL = http://127.0.0.1:${config.port}/anthropic, API Key = ${maskedKey}`);
  console.log(`\u{2705} Kiro SSO credentials:  ${hasKiro ? 'Active' : 'Not found (will use passthrough mode)'}`);
  console.log('');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

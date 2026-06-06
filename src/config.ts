/**
 * Config — gateway configuration, port, env overrides.
 */
export interface GatewayConfig {
  port: number;
  region?: string;
}

export function parseConfig(args: string[]): GatewayConfig {
  const config: GatewayConfig = {
    port: parseInt(process.env.KIRO_GATEWAY_PORT || '8990', 10),
    region: process.env.KIRO_API_REGION || undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === '--region' && i + 1 < args.length) {
      config.region = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
    console.error('Error: port must be between 1 and 65535');
    process.exit(1);
  }

  return config;
}

function printHelp(): void {
  console.log(`
kiro-gateway — Anthropic-compatible API gateway powered by Kiro SSO

Usage:
  kiro-gateway [options]

Options:
  --port, -p <number>   Port to listen on (default: 8990, env: KIRO_GATEWAY_PORT)
  --region <string>     AWS region for CodeWhisperer API (env: KIRO_API_REGION)
  --help, -h            Show this help

Environment Variables:
  KIRO_GATEWAY_PORT     Port (default 8990)
  KIRO_GATEWAY_API_KEY  Override the stable gateway API key
  KIRO_API_REGION       Force a specific API region
  KIRO_AUTH_TOKEN_PATH  Explicit path to Kiro SSO token file
`);
}

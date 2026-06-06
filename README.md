# kiro-gateway

Anthropic-compatible API gateway that uses your Kiro IDE login (AWS SSO) to call Claude models through CodeWhisperer — no Anthropic API key needed.

## Quick Start

```bash
# 1. Install
npm install -g kiro-gateway
# or: npx kiro-gateway

# 2. Login to Kiro IDE (it writes SSO credentials to ~/.aws/sso/cache/)

# 3. Run
kiro-gateway
```

## Configuration

| CLI Flag | Env Variable | Default | Description |
|----------|-------------|---------|-------------|
| `--port`, `-p` | `KIRO_GATEWAY_PORT` | `8990` | Port to listen on |
| `--region` | `KIRO_API_REGION` | auto-detect | AWS region for CodeWhisperer API |
| — | `KIRO_GATEWAY_API_KEY` | auto-generated | Override the stable gateway key |
| — | `KIRO_AUTH_TOKEN_PATH` | auto-discover | Explicit path to Kiro SSO token |

## Usage with Agents

| Agent | Base URL | API Key |
|-------|----------|---------|
| Cline | `http://127.0.0.1:8990/anthropic` | gateway key (from startup output) |
| Cursor | `http://127.0.0.1:8990/anthropic` | gateway key |
| Roo Code | `http://127.0.0.1:8990/anthropic` | gateway key |
| Claude Code | `http://127.0.0.1:8990/anthropic` | gateway key |

## API Reference

All endpoints support an optional `/anthropic` prefix.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Anthropic Messages API (stream + non-stream) |
| GET | `/v1/models` | List available models |
| GET | `/v1/health` | Health check with connectivity diagnostics |
| GET | `/v1/gateway-key` | Get the stable gateway API key |

## How It Works

The gateway reads Kiro SSO credentials from `~/.aws/sso/cache/`, auto-refreshes tokens when they expire, converts Anthropic Messages API requests to CodeWhisperer `generateAssistantResponse` format, parses the AWS Event Stream binary response, and returns standard Anthropic SSE or JSON. If no Kiro credentials exist, it falls back to direct Anthropic passthrough (bring your own `sk-ant-` key).

## Development

```bash
git clone <repo>
cd kiro-gateway
npm install
npm run build
node dist/index.js --port 9185
```

## License

MIT

# Local LLM Gateway for Kiro

Provides an interoperability layer between Anthropic-compatible clients and Kiro-supported models. Runs locally on your machine, using your own credentials.

## Features

- **Dual-mode routing** — Kiro SSO (auto-detected) or Anthropic passthrough (bring your own key)
- **Streaming support** — Full SSE streaming compatible with Anthropic Messages API
- **Auto token refresh** — Transparently refreshes expired SSO tokens
- **Gateway key auth** — Stable `sk-kiro-*` key persisted across restarts
- **Health endpoint** — Connectivity diagnostics for monitoring
- **Zero runtime deps** — Pure Node.js, no external packages

## Installation

```bash
npm install
npm run build
npm link    # Makes 'llm-gateway' command available globally
```

Requires Node.js >= 18.

## Usage

```bash
# Start with defaults (port 8990)
npm start

# Or use the CLI directly
llm-gateway
llm-gateway --port 9000
llm-gateway --api-region us-east-1
llm-gateway --help
```

### CLI Options

| Flag | Description |
|------|-------------|
| `--port`, `-p` | Port to listen on (default: 8990) |
| `--api-region` | AWS region for API endpoint |
| `--help`, `-h` | Show help |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `KIRO_GATEWAY_PORT` | `8990` | Server port |
| `KIRO_GATEWAY_API_KEY` | auto-generated | Override the stable gateway key |
| `KIRO_API_REGION` | auto-detect | Force a specific AWS region |
| `KIRO_AUTH_TOKEN_PATH` | auto-discover | Explicit path to Kiro SSO token file |

## API Endpoints

All endpoints are also available under the `/anthropic` prefix (e.g., `/anthropic/v1/messages`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming + non-streaming) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/health` | Health check with connectivity diagnostics |
| `GET` | `/v1/gateway-key` | Retrieve the stable gateway API key |

### Example: Send a message

```bash
curl http://127.0.0.1:8990/v1/messages \
  -H "x-api-key: sk-kiro-..." \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Agent Configuration

Configure any Anthropic-compatible client to use the local gateway:

| Setting | Value |
|---------|-------|
| Base URL | `http://127.0.0.1:8990/anthropic` |
| API Key | Gateway key from `/v1/gateway-key` |

Compatible with tools that implement the Anthropic Messages API.

## Architecture

```
src/
├── index.ts              # CLI entry point
├── config.ts             # Config parsing (args + env)
├── server.ts             # HTTP server + routing
├── chat-handler.ts       # /v1/messages handler
├── conversation-store.ts # Conversation context
├── adapters/             # Backend adapters
│   ├── kiro-adapter.ts       # Kiro SSO → CodeWhisperer
│   └── anthropic-passthrough.ts  # Direct Anthropic forwarding
├── auth/                 # Authentication
│   ├── credential-discovery.ts   # Find SSO tokens
│   ├── token-refresh.ts          # Auto-refresh expired tokens
│   └── gateway-key.ts            # Stable sk-kiro-* key management
├── protocol/             # Wire format
│   ├── kiro-converter.ts    # Anthropic ↔ Kiro format conversion
│   ├── kiro-stream.ts       # AWS Event Stream parsing
│   └── event-stream-parser.ts
├── models/               # /v1/models handler
└── health/               # /v1/health handler
```

## Gateway Key

On first run, a stable API key (`sk-kiro-*`) is generated and persisted to:

```
~/.local-llm-gateway/gateway-key
```

This key remains the same across restarts. Override it with `KIRO_GATEWAY_API_KEY`.

## Development

```bash
npm run dev        # Run with ts-node (hot reload not included)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled output
```

## Acknowledgments

This project was inspired by [kiro.rs](https://github.com/hank9999/kiro.rs) — a Rust-based Kiro API proxy. While kiro.rs focuses on multi-user server deployment, this project takes a different approach as a lightweight, developer-local CLI tool with automatic lifecycle management via an IDE extension.

## License

MIT

---

## Usage Restrictions

This project is intended for **personal use only** on your local machine.

Do not use it to:
- Share access with others or provide hosted access
- Resell or redistribute access to AI models
- Bypass subscription or usage limits
- Use in production environments serving multiple users

You are responsible for complying with the terms of service of any AI provider you access through this gateway.

---

## Trademarks

- Kiro is a trademark of Amazon.com, Inc.
- Claude is a trademark of Anthropic PBC.
- All other product names, trademarks, and registered trademarks are property of their respective owners.

---

## Disclaimer

This is an independent open-source project and is not affiliated with, authorized, or endorsed by Kiro, Amazon, or Anthropic. The software is provided "as is", without warranty of any kind. Use at your own risk.

# LLM Gateway Manager for Kiro

VS Code / Kiro extension that manages the local LLM gateway server lifecycle automatically.

## Features

- **Auto-start** — Server launches when the editor opens (configurable)
- **Singleton guarantee** — Only one server instance across all editor windows
- **Health monitoring** — Periodic health checks detect crashes
- **Auto-restart** — Exponential backoff restart on unexpected exits (max 3 attempts)
- **Status bar** — Live server state indicator with click-to-show-status
- **Cross-platform** — Windows, macOS, Linux
- **Graceful shutdown** — Server stops when the last editor window closes

## Installation

### From VSIX

```bash
code --install-extension llm-gateway-extension-1.0.0.vsix
```

### Build from source

```bash
cd extension
npm install
npm run compile
# Package with vsce if needed
```

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and type "LLM Gateway":

| Command | Description |
|---------|-------------|
| `LLM Gateway: Start Server` | Start the gateway server |
| `LLM Gateway: Stop Server` | Stop the gateway server |
| `LLM Gateway: Restart Server` | Restart the server |
| `LLM Gateway: Show Status` | Show server state, PID, uptime, connection info |

## Configuration

Settings under `kiroGateway.*` in VS Code settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `kiroGateway.port` | number | `8990` | Server port (1–65535) |
| `kiroGateway.autoStart` | boolean | `true` | Start server on editor launch |
| `kiroGateway.serverPath` | string | `./dist/index.js` | Path to the gateway server script (resolved from workspace root; leave default if gateway is in same project) |
| `kiroGateway.healthCheckInterval` | number | `30` | Health check interval in seconds (5–300) |

### Example `settings.json`

```json
{
  "kiroGateway.port": 8990,
  "kiroGateway.autoStart": true,
  "kiroGateway.healthCheckInterval": 30
}
```

## How It Works

```
Editor opens
    │
    ▼
Check if server already running (globalState PID + port probe)
    │
    ├── Running → attach as observer (no spawn)
    │
    └── Not running → check port free?
            │
            ├── Port in use by Kiro → attach as observer
            ├── Port in use by other app → Error state
            │
            └── Port free → spawn server (becomes manager)
                    │
                    ▼
              Wait for /v1/health → Running
                    │
                    ▼
              Health loop (every N seconds)
                    │
                    ├── Healthy → continue
                    └── Unhealthy → auto-restart (backoff: 2s, 4s, 8s)
                            │
                            ├── Restart OK → Running
                            └── All attempts fail → Error state
```

### Singleton Model

Multiple editor windows share a single server process:

- First window to start becomes the **manager** (owns the process)
- Subsequent windows detect the running server and attach as **observers**
- Server only stops when the last window (the manager) closes
- If the manager window closes but observers remain, ownership transfers on next health check

### State Machine

States: `Stopped` → `Starting` → `Running` → `Stopping` → `Stopped`

Additional states: `Restarting`, `Error`

## Status Bar

The status bar shows the current server state:

| Icon | State |
|------|-------|
| ✅ | Running |
| ⊘ | Stopped |
| ⟳ | Starting / Restarting |
| ⚠️ | Error |

Click the status bar item to run "Show Status" and see connection info (the gateway API key is partially masked for security — use "LLM Gateway: Copy API Key" command to copy the full key).

## Output Channel

All lifecycle events are logged to the "LLM Gateway" output channel (`View → Output → LLM Gateway`).

## Requirements

- VS Code >= 1.85.0 or Kiro IDE
- Node.js >= 18 (for the gateway server)
- llm-gateway built (`npm run build` in root)

## Changelog

### v1.1.0

- **[KG-8] Full lifecycle management implementation**
  - Auto-start server on editor launch
  - Singleton model — multiple windows share one server process
  - Health monitoring with configurable interval
  - Auto-restart with exponential backoff (2s → 4s → 8s, max 3 attempts)
  - Status bar with live state indicator
  - Commands: Start, Stop, Restart, Show Status, Copy API Key
  - Cross-platform process management (Windows, macOS, Linux)
  - Graceful shutdown and ownership transfer

### v1.0.0

- Initial extension scaffold

## License

MIT

---

## Usage Restrictions

This extension and the gateway server it manages are intended for **personal use only**.

---

## Trademarks

- Kiro is a trademark of Amazon.com, Inc.
- Claude is a trademark of Anthropic PBC.

---

## Disclaimer

This is an independent open-source project and is not affiliated with, authorized, or endorsed by Kiro, Amazon, or Anthropic. The software is provided "as is", without warranty of any kind. Use at your own risk.

/**
 * Gateway Info UI — self-contained HTML page.
 * Served at GET / (and /ui). Lets the user copy the Anthropic-compatible
 * endpoint and the gateway API key. Localhost-only, so the key is injected
 * directly into the page (same trust boundary as GET /v1/gateway-key).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderGatewayInfoPage(port: number, gatewayKey: string): string {
  const endpoint = `http://127.0.0.1:${port}/anthropic`;
  const safeEndpoint = escapeHtml(endpoint);
  const safeKey = escapeHtml(gatewayKey);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiro Gateway</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --field: #0d1117;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #2f81f7;
    --accent-sel: #1f6feb55;
    --green: #3fb950;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    justify-content: center;
    padding: 40px 16px;
  }
  .card {
    width: 100%;
    max-width: 640px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 28px 28px;
  }
  h1 {
    font-size: 1.15rem;
    font-weight: 600;
    margin: 0 0 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .subtitle {
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0 0 22px;
  }
  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 8px;
    margin-top: 18px;
  }
  .field {
    position: relative;
    display: flex;
    align-items: center;
    background: var(--field);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .field input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9rem;
    padding: 12px 14px;
    outline: none;
  }
  .field input::selection { background: var(--accent-sel); }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0 14px;
    height: 44px;
    display: flex;
    align-items: center;
    font-size: 1.05rem;
    transition: color 0.15s;
  }
  .icon-btn:hover { color: var(--text); }
  .toast {
    display: none;
    align-items: center;
    gap: 8px;
    color: var(--green);
    font-size: 0.82rem;
    margin-top: 14px;
  }
  .toast.show { display: flex; }
  .toast .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: var(--green);
    color: #0d1117;
    font-size: 0.7rem;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>🔌 Gateway Info (Anthropic-compatible)</h1>
    <p class="subtitle">
      No API key needed — gateway uses Kiro IDE credentials. Copy endpoint + key
      below to configure external agents (Cline/Cursor/...).
    </p>

    <label for="endpoint">Gateway Endpoint</label>
    <div class="field">
      <input id="endpoint" type="text" readonly value="${safeEndpoint}">
      <button class="icon-btn" id="copy-endpoint" title="Copy endpoint" aria-label="Copy endpoint">📋</button>
    </div>

    <label for="apikey">Gateway API Key</label>
    <div class="field">
      <input id="apikey" type="password" readonly value="${safeKey}">
      <button class="icon-btn" id="toggle-key" title="Show/hide key" aria-label="Show or hide key">👁️</button>
      <button class="icon-btn" id="copy-key" title="Copy API key" aria-label="Copy API key">📋</button>
    </div>

    <div class="toast" id="toast"><span class="check">✓</span><span id="toast-msg"></span></div>
  </div>

  <script>
    (function () {
      var toast = document.getElementById('toast');
      var toastMsg = document.getElementById('toast-msg');
      var toastTimer = null;

      function showToast(msg) {
        toastMsg.textContent = msg;
        toast.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2500);
      }

      function copy(text, msg) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { showToast(msg); }, fallback);
        } else {
          fallback();
        }
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); showToast(msg); } catch (e) {}
          document.body.removeChild(ta);
        }
      }

      var endpointEl = document.getElementById('endpoint');
      var keyEl = document.getElementById('apikey');

      document.getElementById('copy-endpoint').addEventListener('click', function () {
        endpointEl.focus(); endpointEl.select();
        copy(endpointEl.value, 'Gateway endpoint copied to clipboard');
      });

      document.getElementById('copy-key').addEventListener('click', function () {
        copy(keyEl.value, 'Gateway API key copied to clipboard');
      });

      document.getElementById('toggle-key').addEventListener('click', function () {
        keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
      });
    })();
  </script>
</body>
</html>`;
}

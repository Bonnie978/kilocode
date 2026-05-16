# kilo-web runbook

> Living — updated as M1.x stories pass.

## First-time setup

1. **Install bun** (project is bun-only)
   ```bash
   brew install oven-sh/bun/bun
   # or
   curl -fsSL https://bun.sh/install | bash
   ```
2. **Install dependencies** (one-time, ~30s for 4070 packages on a warm cache)
   ```bash
   cd ~/Desktop/kilocode
   bun install
   ```
   - `postinstall` runs `fix-node-pty` automatically — succeeds silently on macOS.
3. **Configure an AI provider** — write to `~/.config/kilo/kilo.json`

   ⚠️ **GOTCHA**: opencode is rebranded as "kilo" — config path is `~/.config/kilo/`, **not** `~/.config/opencode/`. Files in the old path are silently ignored. (Source: `packages/core/src/global.ts:13` — `const app = "kilo"`.)

   Example (OpenAI-compatible upstream like newapi, openrouter, ollama, vllm):
   ```json
   {
     "provider": {
       "my-provider": {
         "name": "My Provider",
         "npm": "@ai-sdk/openai-compatible",
         "options": {
           "baseURL": "https://your-host/v1",
           "apiKey": "sk-..."
         },
         "models": {
           "model-id": {
             "id": "model-id",
             "name": "Display Name",
             "tool_call": true,
             "limit": { "context": 128000, "output": 16384 }
           }
         }
       }
     },
     "permission": { "bash": "allow" }
   }
   ```

   First load auto-adds `"$schema": "https://app.kilo.ai/config.json"`.

## Daily commands

```bash
bun run serve     # start opencode local server (port 8787)
bun run web       # start kilo-web dev (port 5173)
```

Open http://127.0.0.1:5173.

## Verifying setup

```bash
# server alive
curl http://127.0.0.1:8787/session

# SSE handshake
curl -N http://127.0.0.1:8787/event   # should keep streaming heartbeats
```

## Verified protocol facts (M1)

- **CORS**: localhost:* allowed by default. Preflight returns 204 with `Access-Control-Allow-Origin: <origin>` (echoed).
- **SSE**: first event is `data: {"type":"server.connected","properties":{}}` (not `heartbeat`); heartbeats follow periodically (~10s).
- **Session create**: `POST /session?directory=<cwd>` body `{}` returns `{id, slug, projectID, directory, time:{created,updated}}`.
- **Send message**: `POST /session/{id}/message?directory=<cwd>` body:
  ```json
  {
    "model": { "providerID": "<provider>", "modelID": "<model>" },
    "parts": [{ "type": "text", "text": "..." }]
  }
  ```
  Response: `{ info: AssistantMessage, parts: [step-start, text..., step-finish] }`. Non-streaming for now (returns full message at end).
- **Directory header**: query param `?directory=` works. SDK also accepts `directory` in config — auto-injects on GET as query; for non-GET, sent as `x-kilo-directory` header that server middleware translates.

## Troubleshooting

- **Provider config silently ignored**: you put it in `~/.config/opencode/*` instead of `~/.config/kilo/*`. Fix path.
- **bun -e fails in non-login shells**: `export PATH="$HOME/.bun/bin:$PATH"` first.
- **`timeout` command missing on macOS**: use `curl --max-time` or `gtimeout` (`brew install coreutils`).
- **Port 8787 stuck after process exit**: `lsof -ti tcp:8787 | xargs kill -9`.

## Useful paths

| Path | Purpose |
|---|---|
| `~/Desktop/kilocode` | repo root |
| `packages/kilo-web/` | the browser SPA |
| `packages/opencode/` | the agent server |
| `docs/user-stories/` | feature acceptance criteria |
| `scripts/ralph/log.md` | progress log |

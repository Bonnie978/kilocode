# kilo-web

Standalone browser app that gives you the kilocode chat & agent-workbench UX **without VSCode**. Same agent core, same UI components, just running in your browser pointing at a local `opencode serve` process.

## Architecture (mode A — local backend)

```
┌──────────────────────────────────────────────┐
│  Browser SPA — http://127.0.0.1:5173         │
│  (packages/kilo-web)                         │
│                                              │
│  • KiloClawApp (chat)        from kiloclaw/  │
│  • AgentManagerApp (workbench) from agent-manager/ │
│  • kilo-ui components                        │
│  • WebClawProvider replaces VSCode bridge    │
└─────────────────┬────────────────────────────┘
                  │ HTTPS + SSE + WebSocket
┌─────────────────▼────────────────────────────┐
│  opencode serve — http://127.0.0.1:8787      │
│  (packages/opencode)                         │
│                                              │
│  REST: /session, /provider, /find, /permission│
│  SSE:  /event (stream all bus events)        │
│  WS:   /pty/{id}/connect (terminal)          │
│  (M4)  /worktree/diff, /worktree/apply       │
└──────────────────────────────────────────────┘
```

The browser SPA is just a UI shell — the agent loop, tools, file ops, terminals all run inside the local `opencode` process and operate on **your actual filesystem**.

## Project layout

```
packages/kilo-web/                 # new — Vite SPA
  package.json
  vite.config.ts                   # aliases @kiloclaw, @agent-manager
  index.html
  src/
    main.tsx                       # mount KiloClawApp
    App.tsx                        # phase placeholder, will hold layout
    claw/WebClawProvider.tsx       # (M2) replaces ClawProvider
    agent/WebAgentManagerProvider.tsx  # (M4)
    sdk/client.ts                  # createKiloClient wrapper

packages/kilo-vscode/webview-ui/   # UPSTREAM — do not modify
  kiloclaw/                        # reused via @kiloclaw alias
  agent-manager/                   # reused via @agent-manager alias

packages/opencode/                 # UPSTREAM — minor additions only
  src/server/routes/instance/
    worktree.ts                    # (M4) new file

docs/
  user-stories/m{1..4}-*.json      # canonical work queue
  kilo-web/README.md               # this file
  kilo-web/runbook.md              # (M1.7) how to run everything
  kilo-web/sdk-cheatsheet.md       # (M1.6) SDK call reference

scripts/
  ralph/{prompt.md,log.md,runner.ts}
  verify-user-stories.ts
```

## How to run (when ready)

Prereqs:
- bun installed (`brew install oven-sh/bun/bun`)
- An AI provider key (e.g. `ANTHROPIC_API_KEY`)

```bash
# 1. Install dependencies (once)
bun install

# 2. In one terminal — start the agent server
bun run serve

# 3. In another terminal — start the web UI
bun run web
# Open http://127.0.0.1:5173
```

## Dev workflow

```bash
# Check user story status
bun run user-stories:verify

# Iterate via Ralph loop (autonomous agent loop)
bun run ralph

# Type check the whole monorepo
bun run typecheck
```

## Drop list (intentionally not implemented)

- Inline autocomplete / ghost text — requires editor host
- Editor decorations / inline diff in editor — requires VSCode editor
- VSCode command palette / keybindings — N/A in browser
- legacy-migration — moves old VSCode settings, irrelevant
- continuedev autocomplete harness — coupled to VSCodeIde.ts

All "agent in chat does things to your filesystem" capability is fully preserved.

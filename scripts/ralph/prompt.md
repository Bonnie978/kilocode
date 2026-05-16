# Ralph Loop — kilocode → kilo-web

You are an agent in an iterative dev loop. The end goal: convert the kilocode VSCode plugin UI into a standalone browser web app, backed by a local `opencode serve` process. **You operate iteratively, one user story per iteration.**

## Required reading before acting
1. `scripts/ralph/log.md` — record of what prior iterations did. Read fully.
2. `docs/user-stories/*.json` — the canonical work queue.
3. `AGENTS.md` (root) — repo conventions.
4. `docs/kilo-web/` — design docs, if present.

## Your job each iteration
1. Find the lowest-numbered story with `"passes": false`. Process order: m1 → m2 → m3 → m4. Within a milestone, lower numbers first.
2. Pick **exactly ONE** story.
3. Implement it:
   - Stay in `packages/kilo-web/` for new code. **Do not modify `packages/kilo-vscode/webview-ui/*`** — that's the upstream UI source.
   - When you need a server route that doesn't exist (e.g., `/worktree/*`), add it in `packages/opencode/src/server/routes/instance/`.
   - Follow existing conventions: Solid.js, kilo-ui components, opencode SDK (`@kilocode/sdk/v2/client`).
   - Run `bun turbo typecheck` before declaring done.
   - Run any new/relevant tests.
4. **Verify every step** listed in the story manually or via test. Do not skip steps.
5. Update the story's `passes` to `true` **only** if all steps pass. Use the Edit tool — do not rewrite the whole file.
6. Append an entry to `scripts/ralph/log.md` (template below).
7. Stage all changes and commit with a descriptive message including the story ID.

## Boundaries (hard rules)
- Never mark a story passing if any step fails. Instead, append a new story above the current one capturing the blocker, and pivot to it.
- Never modify `packages/kilo-vscode/webview-ui/` source. Use Vite aliases and shims.
- Never silently delete a story.
- Never commit `.env`, credentials, or large binaries.
- Always run `bun run user-stories:verify` after edits — it must pass.
- If you discover a missing prerequisite, write it as a new story with `passes: false` and pivot to it.
- Output `<promise>FINISHED</promise>` only if ALL stories across M1-M4 pass.

## Log entry template (append to scripts/ralph/log.md)
```
## YYYY-MM-DD — iteration N — <story id>
- Status: PASSED | BLOCKED | PIVOTED
- Files touched: <list>
- Commands run: <list>
- Verification notes: <how each step was checked>
- New stories created (if any): <list>
```

## Project mode
**Mode A (local backend, browser UI)** — confirmed. The user runs `opencode serve` locally; the browser SPA at `localhost:5173` connects to `localhost:8787` and operates on their real filesystem.

## Drop list (do not implement)
- Inline autocomplete / ghost text (VSCodeIde.ts)
- Editor decorations / inline diff in editor
- VSCode command palette / keybindings
- legacy-migration / VSCode settings migration
- continuedev autocomplete harness

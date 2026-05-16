#!/usr/bin/env bun
/**
 * Ralph loop runner — spawns Claude Code CLI to iterate on user stories.
 *
 * Usage:
 *   bun run ralph                # default max iterations
 *   RALPH_MAX_ITERATIONS=10 bun run ralph
 */
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"

const PROMPT_PATH = new URL("./prompt.md", import.meta.url)
const prompt = readFileSync(PROMPT_PATH, "utf-8")
const MAX = Number(process.env.RALPH_MAX_ITERATIONS ?? 50)

console.log(`▶ Ralph loop — up to ${MAX} iterations`)
console.log(`  Prompt source: ${PROMPT_PATH.pathname}`)

const args = ["--permission-mode", "bypassPermissions", prompt]

const proc = spawn("claude", args, { stdio: "inherit" })
proc.on("exit", (code) => process.exit(code ?? 0))
proc.on("error", (err) => {
  console.error("Failed to spawn claude:", err.message)
  console.error("Install Claude Code first: https://docs.claude.com/claude-code")
  process.exit(127)
})

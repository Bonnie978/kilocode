#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

type Story = {
  description: string
  steps: string[]
  passes: boolean
}

const STORIES_DIR = "docs/user-stories"

function isStory(s: unknown): s is Story {
  if (typeof s !== "object" || s === null) return false
  const o = s as Record<string, unknown>
  return (
    typeof o.description === "string" &&
    o.description.length > 0 &&
    Array.isArray(o.steps) &&
    o.steps.length > 0 &&
    o.steps.every((step) => typeof step === "string" && step.length > 0) &&
    typeof o.passes === "boolean"
  )
}

try {
  statSync(STORIES_DIR)
} catch {
  console.error(`✗ ${STORIES_DIR}/ does not exist`)
  process.exit(1)
}

let total = 0
let passing = 0
const pending: string[] = []
let invalid = 0

const files = readdirSync(STORIES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()

for (const file of files) {
  const path = join(STORIES_DIR, file)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    console.error(`✗ ${path}: invalid JSON — ${(err as Error).message}`)
    invalid++
    continue
  }
  if (!Array.isArray(parsed)) {
    console.error(`✗ ${path}: top-level must be an array`)
    invalid++
    continue
  }
  for (const [i, story] of parsed.entries()) {
    if (!isStory(story)) {
      console.error(`✗ ${path}[${i}]: missing/invalid description, steps, or passes`)
      invalid++
      continue
    }
    total++
    if (story.passes) passing++
    else pending.push(`${file} — ${story.description}`)
  }
}

console.log(`\nStories: ${passing}/${total} passing (${invalid} invalid)`)
if (pending.length) {
  console.log(`\nPending:`)
  for (const p of pending) console.log(`  · ${p}`)
}

process.exit(invalid > 0 ? 1 : 0)

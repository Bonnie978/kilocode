/**
 * opencode SDK + workspace state for kilo-web.
 *
 * WORKSPACE_DIR is now a reactive Solid signal so the TopBar's
 * WorkspacePicker can flip it at runtime. All SDK callers should read
 * `workspaceDir()` (the accessor) when building requests so the next
 * call automatically targets the freshly picked folder.
 */
import { createSignal } from "solid-js"
import { createKiloClient } from "@kilocode/sdk/v2/client"

export const SERVER_URL = "http://127.0.0.1:8787"

const STORAGE_KEY = "kilo-web.workspace"
const DEFAULT_WORKSPACE = "/Users/magic/Desktop/kilocode"

function initialWorkspace(): string {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
    if (saved && saved.startsWith("/")) return saved
  } catch {
    // localStorage may throw in some browser modes — fall back to default
  }
  return DEFAULT_WORKSPACE
}

const [workspaceDirSignal, setWorkspaceDirSignal] = createSignal<string>(initialWorkspace())

export const workspaceDir = workspaceDirSignal

export function setWorkspaceDir(path: string) {
  const normalized = path.replace(/\/+$/, "")
  if (!normalized.startsWith("/")) {
    // eslint-disable-next-line no-console
    console.warn("[sdk] refusing non-absolute workspace path:", path)
    return
  }
  if (normalized === workspaceDirSignal()) return
  setWorkspaceDirSignal(normalized)
  try {
    localStorage.setItem(STORAGE_KEY, normalized)
  } catch {}
  // Broadcast to any listener — WebVSCodeProvider re-emits ready/sessionsLoaded
  // + restarts the SSE so the UI flips to the new project's data.
  try {
    window.dispatchEvent(new CustomEvent("kilo-web:workspace-changed", { detail: { path: normalized } }))
  } catch {}
}

// Legacy export — kept so existing imports don't break, but it returns a
// snapshot. Reactive callers should use workspaceDir().
export const WORKSPACE_DIR = workspaceDirSignal()

export const DEFAULT_MODEL = { providerID: "newapi", modelID: "glm-5.1" }

// One client instance — the SDK's `directory` config is a fallback only
// (the rewrite path only applies to GET requests); every call still passes
// `directory: workspaceDir()` explicitly so it always sees the latest value.
export const client = createKiloClient({
  baseUrl: SERVER_URL,
  directory: workspaceDirSignal(),
})

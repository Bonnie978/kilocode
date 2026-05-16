/**
 * TopBar — mimics the VS Code panel header that wraps the kilocode webview.
 * VSCode would normally render this chrome itself; in the browser we add it
 * ourselves so the layout matches the real plugin screenshot.
 *
 * Buttons dispatch the same window 'message' events App.tsx listens for so
 * the existing handleViewAction switch in the upstream UI just works —
 * webview-ui/src remains unmodified.
 */
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { setWorkspaceDir, workspaceDir } from "../web-runtime/sdk"

function fireAction(action: string) {
  window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action } }))
}

/** Tail of a path, e.g. /Users/me/Desktop/proj → proj */
function shortPath(p: string): string {
  if (!p) return "-"
  const parts = p.split("/").filter(Boolean)
  if (parts.length === 0) return "/"
  return parts[parts.length - 1]
}

function WorkspacePicker() {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function pick() {
    if (busy()) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch("/api/pick-workspace")
      if (res.status === 204) return // user cancelled the Finder dialog
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { path?: string }
      if (data.path) setWorkspaceDir(data.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setTimeout(() => setError(null), 5000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      title={`当前项目：${workspaceDir()}\n点击选择新文件夹`}
      onClick={pick}
      disabled={busy()}
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "5px",
        height: "24px",
        padding: "0 8px",
        border: "1px solid var(--vscode-panel-border)",
        "border-radius": "4px",
        background: "transparent",
        color: error() ? "var(--vscode-errorForeground)" : "var(--vscode-foreground)",
        cursor: busy() ? "progress" : "pointer",
        "font-size": "11px",
        "max-width": "180px",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        "white-space": "nowrap",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" style={{ "flex-shrink": "0" }}>
        <path d="M1.5 4l1.5-1.5h3.5L8 4h6.5v8.5h-13z" />
      </svg>
      <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>
        {error() ? `❌ ${error()!.slice(0, 30)}` : busy() ? "选择中..." : shortPath(workspaceDir())}
      </span>
    </button>
  )
}

const ICON_BTN_STYLE: any = {
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  width: "26px",
  height: "26px",
  border: "none",
  background: "transparent",
  color: "var(--vscode-foreground)",
  cursor: "pointer",
  "border-radius": "4px",
}

function IconButton(props: { title: string; onClick: () => void; children: any }) {
  const [hover, setHover] = createSignal(false)
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ICON_BTN_STYLE,
        background: hover() ? "var(--vscode-toolbar-hoverBackground)" : "transparent",
      }}
    >
      {props.children}
    </button>
  )
}

// Minimal stroked icons (inline SVG) — close to VS Code Codicon proportions.
const I = {
  plus: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  history: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  ),
  team: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <circle cx="5.5" cy="5.5" r="2" />
      <path d="M2 13c.5-2.4 2-3.5 3.5-3.5" />
      <circle cx="10.5" cy="6" r="1.75" />
      <path d="M8 13c.4-2 1.5-3 2.5-3s2 1 2.5 3" />
    </svg>
  ),
  feedback: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <path d="M2.5 3.5h11v7H6L3 13v-2.5H2.5v-7z" />
    </svg>
  ),
  marketplace: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <path d="M2.5 5.5h11v8h-11z" />
      <path d="M5 5.5v-2h6v2" />
      <path d="M2.5 8.5h11" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </svg>
  ),
  user: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <circle cx="8" cy="6" r="2.5" />
      <path d="M3 13c.5-2.5 2.5-3.5 5-3.5s4.5 1 5 3.5" />
    </svg>
  ),
  chevron: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
      <path d="M4 10l4-4 4 4" />
    </svg>
  ),
}

export function TopBar() {
  const iconsBase = (window as any).ICONS_BASE_URI || "/icons"
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "4px",
        padding: "6px 8px",
        "border-bottom": "1px solid var(--vscode-panel-border)",
        background: "var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background))",
        "min-height": "32px",
        "user-select": "none",
      }}
    >
      <img
        src={`${iconsBase}/kilo-dark.svg`}
        alt=""
        style={{ width: "16px", height: "16px", "margin-right": "4px" }}
      />
      <span
        style={{
          "font-size": "11px",
          "font-weight": "600",
          "letter-spacing": "0.5px",
          color: "var(--vscode-foreground)",
          "text-transform": "uppercase",
        }}
      >
        KILO CODE
      </span>
      <WorkspacePicker />
      <div style={{ "margin-left": "auto" }} />
      <IconButton title="新建任务" onClick={() => fireAction("plusButtonClicked")}>{I.plus}</IconButton>
      <IconButton title="历史" onClick={() => fireAction("historyButtonClicked")}>{I.history}</IconButton>
      <IconButton title="插件市场" onClick={() => fireAction("marketplaceButtonClicked")}>{I.marketplace}</IconButton>
      <IconButton title="设置" onClick={() => fireAction("settingsButtonClicked")}>{I.settings}</IconButton>
      <IconButton title="折叠" onClick={() => {}}>{I.chevron}</IconButton>
    </div>
  )
}

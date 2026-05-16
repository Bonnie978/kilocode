/**
 * WebVSCodeProvider — drop-in replacement for webview-ui/src/context/vscode.tsx.
 *
 * Replaces the postMessage bridge with direct opencode SDK + SSE wiring so the
 * real Kilo Code plugin UI can run in a browser tab pointed at a local server.
 *
 * Surface kept identical to the original module:
 *   - VSCodeProvider (component)
 *   - useVSCode (hook)
 *   - getVSCodeAPI (factory)
 *
 * Outbound (webview → extension) WebviewMessage values are routed to SDK calls.
 * Inbound (extension → webview) ExtensionMessage values are synthesized from
 *   - SSE events on /event,
 *   - SDK responses to commands.
 * Both delivery paths are used:
 *   - context handlers added via onMessage (session.tsx, server.tsx, …),
 *   - window.dispatchEvent("message") because App.tsx + a handful of other
 *     components subscribe directly to window 'message' events instead of
 *     going through useVSCode().onMessage.
 */
import { createContext, onCleanup, onMount, useContext, type ParentComponent } from "solid-js"
import type {
  ExtensionMessage,
  VSCodeAPI,
  WebviewMessage,
} from "@kilo-app/types/messages"
import { client, DEFAULT_MODEL, SERVER_URL, workspaceDir } from "../web-runtime/sdk"
import { eventBus, type ServerEvent } from "../web-runtime/event-bus"

interface VSCodeContextValue {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
  getState: <T>() => T | undefined
  setState: <T>(state: T) => void
}

const VSCodeContext = createContext<VSCodeContextValue>()

// Module-level so getVSCodeAPI() can also broadcast (e.g. tests, code paths
// that call the factory directly). Provider also registers via onMessage.
const handlers = new Set<(message: ExtensionMessage) => void>()

// Auto-approve toggle — webview-local preference. When on, the permission.asked
// SSE handler auto-acks the request via /permission/respond.
let autoApproveActive = (() => {
  try {
    return localStorage.getItem("kilo-web.autoApprove") === "true"
  } catch {
    return false
  }
})()

function emit(msg: ExtensionMessage) {
  for (const h of handlers) {
    try {
      h(msg)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[web-vscode] context handler threw", e)
    }
  }
  try {
    window.dispatchEvent(new MessageEvent("message", { data: msg }))
  } catch {}
}

// ────────────────────────────────────────────────────────────
// Mappers: opencode shapes → webview-ui message shapes
// ────────────────────────────────────────────────────────────

function isoTime(ms?: number) {
  return new Date(ms ?? Date.now()).toISOString()
}

function sessionToInfo(s: any) {
  return {
    id: s?.id,
    parentID: s?.parentID ?? null,
    title: s?.title ?? s?.slug ?? "New session",
    createdAt: isoTime(s?.time?.created),
    updatedAt: isoTime(s?.time?.updated ?? s?.time?.created),
    revert: null,
    summary: null,
  }
}

function messageFromInfo(info: any) {
  return {
    id: info?.id,
    sessionID: info?.sessionID,
    role: info?.role ?? "assistant",
    createdAt: isoTime(info?.time?.created),
    time: info?.time,
    agent: info?.agent,
    modelID: info?.modelID,
    providerID: info?.providerID,
    mode: info?.mode,
    parentID: info?.parentID,
    path: info?.path,
    cost: info?.cost,
    tokens: info?.tokens,
    finish: info?.finish,
    error: info?.error,
    // parts intentionally omitted here — they arrive via PartUpdate / PartBatch
    // stream events (see partsBridge below) so the session store keeps them
    // separate from message metadata.
  }
}

// ────────────────────────────────────────────────────────────
// SSE → ExtensionMessage
// ────────────────────────────────────────────────────────────

function handleSSE(evt: ServerEvent) {
  const p = evt.properties as any
  switch (evt.type) {
    case "session.updated": {
      const info = p?.info
      if (!info?.id) return
      emit({ type: "sessionUpdated", session: sessionToInfo(info) } as ExtensionMessage)
      return
    }
    case "session.deleted": {
      if (!p?.sessionID) return
      emit({ type: "sessionDeleted", sessionID: p.sessionID } as ExtensionMessage)
      return
    }
    case "session.status": {
      if (!p?.sessionID || !p?.status) return
      const status = (p.status?.type ?? "idle") as "busy" | "idle" | "retry" | "offline"
      emit({
        type: "sessionStatus",
        sessionID: p.sessionID,
        status,
        attempt: p.status?.attempt,
        message: p.status?.message,
        next: p.status?.next,
      } as ExtensionMessage)
      return
    }
    case "session.idle":
    case "session.turn.close": {
      if (!p?.sessionID) return
      emit({ type: "sessionStatus", sessionID: p.sessionID, status: "idle" } as ExtensionMessage)
      return
    }
    case "message.updated": {
      const info = p?.info
      if (!info?.id) return
      emit({ type: "messageCreated", message: messageFromInfo(info) } as ExtensionMessage)
      return
    }
    case "message.part.updated": {
      const part = p?.part
      if (!part?.sessionID || !part?.messageID || !part?.id) return
      // session.tsx.handleStreamMessage routes "partUpdated" → handlePartUpdated.
      // delta is optional (used for streaming text deltas via "message.part.delta").
      emit({
        type: "partUpdated",
        sessionID: part.sessionID,
        messageID: part.messageID,
        part,
      } as unknown as ExtensionMessage)
      return
    }
    case "message.part.delta": {
      // Streaming text delta: { sessionID, messageID, partID, field, delta }.
      // The webview still wants a part object — synthesize a stub. The full
      // part will arrive in a subsequent message.part.updated.
      if (!p?.sessionID || !p?.messageID || !p?.partID) return
      const part = {
        id: p.partID,
        sessionID: p.sessionID,
        messageID: p.messageID,
        type: "text",
        text: typeof p.delta === "string" ? p.delta : "",
      }
      emit({
        type: "partUpdated",
        sessionID: p.sessionID,
        messageID: p.messageID,
        part,
        delta: { field: p.field, value: p.delta },
      } as unknown as ExtensionMessage)
      return
    }
    case "permission.asked": {
      if (!p?.id || !p?.sessionID) return
      // If user has enabled auto-approve, accept silently and skip emitting
      // the permissionRequest event so the inline approval bubble never
      // shows up.
      if (autoApproveActive) {
        void maybeAutoApprovePermission({ id: p.id, sessionID: p.sessionID })
        return
      }
      emit({
        type: "permissionRequest",
        permission: {
          id: p.id,
          sessionID: p.sessionID,
          permission: p.permission,
          patterns: p.patterns ?? [],
          metadata: p.metadata ?? {},
          always: p.always ?? [],
          tool: p.tool,
        },
      } as unknown as ExtensionMessage)
      return
    }
    case "permission.replied": {
      const id = p?.requestID ?? p?.id
      if (!id) return
      emit({ type: "permissionResolved", permissionID: id } as ExtensionMessage)
      return
    }
  }
}

// ────────────────────────────────────────────────────────────
// WebviewMessage → SDK
// ────────────────────────────────────────────────────────────

/**
 * Webview message types we intentionally drop in the browser build.
 * Listed EXPLICITLY (no wildcards) so we don't accidentally swallow
 * neighbour messages — e.g. agentManager.openFile is unrelated to
 * worktrees and must still pass through to the default warn (where
 * we can decide later if/how to handle file-open in the browser).
 */
const SILENT_DROP_EXACT = new Set<string>([
  // worktree
  "agentManager.createWorktree",
  "agentManager.requestRepoInfo",
  "continueInWorktree",
  "openAdvancedWorktree",
  // feedback (UI also hidden via override.css)
  "submitFeedback",
  "sendFeedback",
  "feedback",
  // Kilo cloud account / profile — no backing service in the local build
  "refreshProfile",
  "login",
  "logout",
  "cancelLogin",
  "toggleRemote",
  // Legacy migration (kilocode old → new format) — irrelevant for new web users
  "requestLegacyMigrationData",
  "finalizeLegacyMigration",
  "clearLegacyData",
  "skipLegacyMigration",
])

async function routeOutbound(msg: WebviewMessage) {
  const t = (msg as any)?.type as string | undefined
  if (!t) return
  if (SILENT_DROP_EXACT.has(t)) return
  try {
    switch (t) {
      case "loadSessions": {
        const res: any = await client.session.list({ directory: workspaceDir() })
        const list = ((res?.data ?? res) ?? []) as any[]
        emit({ type: "sessionsLoaded", sessions: list.map(sessionToInfo) } as ExtensionMessage)
        return
      }
      case "createSession": {
        const title = (msg as any).title as string | undefined
        const res: any = await client.session.create({
          directory: workspaceDir(),
          ...(title ? { title } : {}),
        } as any)
        const s = (res?.data ?? res) as any
        emit({ type: "sessionCreated", session: sessionToInfo(s) } as ExtensionMessage)
        return
      }
      case "loadMessages": {
        const sid = (msg as any).sessionID as string
        if (!sid) return
        const res: any = await client.session.messages({ sessionID: sid, directory: workspaceDir() })
        const list = ((res?.data ?? res) ?? []) as any[]
        // Carry parts along with the message envelope — handleMessagesLoaded
        // (session.tsx) stashes msg.parts into the store, which is what makes
        // bubbles actually render content on session switch.
        const messages = list.map((m) => ({
          ...messageFromInfo(m?.info ?? m),
          parts: m?.parts ?? [],
        }))
        emit({
          type: "messagesLoaded",
          sessionID: sid,
          messages,
          mode: "replace",
        } as unknown as ExtensionMessage)
        // virtua/solid leaves visibility:hidden on first mount when the
        // initial ResizeObserver callback fires before children paint.
        // Two rAFs + a synthetic resize nudges it to re-measure and show.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              window.dispatchEvent(new Event("resize"))
            } catch {}
          })
        })
        return
      }
      case "deleteSession": {
        const sid = (msg as any).sessionID as string
        if (!sid) return
        await (client.session as any).delete?.({ sessionID: sid, directory: workspaceDir() })
        emit({ type: "sessionDeleted", sessionID: sid } as ExtensionMessage)
        return
      }
      case "renameSession": {
        const sid = (msg as any).sessionID as string
        const title = (msg as any).title as string
        if (!sid) return
        try {
          await (client.session as any).update?.({ sessionID: sid, directory: workspaceDir(), title })
        } finally {
          // Refresh list either way.
          void routeOutbound({ type: "loadSessions" } as WebviewMessage)
        }
        return
      }
      case "sendMessage":
      case "promptSession":
      case "prompt": {
        const m = msg as any
        let sid = m.sessionID as string | undefined
        const text = (m.text ?? m.message ?? "") as string
        const messageID = m.messageID as string | undefined
        const providerID = (m.providerID as string | undefined) ?? DEFAULT_MODEL.providerID
        const modelID = (m.modelID as string | undefined) ?? DEFAULT_MODEL.modelID
        const draftID = m.draftID as string | undefined
        if (!text) return

        // newTask flow: no session yet — create one and let session.tsx
        // navigate to it via the draftID match in handleSessionCreated.
        if (!sid) {
          try {
            const res: any = await client.session.create({ directory: workspaceDir() } as any)
            const s = (res?.data ?? res) as any
            sid = s?.id
            if (s) {
              emit({
                type: "sessionCreated",
                session: sessionToInfo(s),
                draftID,
              } as unknown as ExtensionMessage)
            }
          } catch (err) {
            emit({
              type: "sendMessageFailed",
              error: err instanceof Error ? err.message : String(err),
              text,
              draftID,
              messageID,
            } as ExtensionMessage)
            return
          }
        }
        if (!sid) return

        await client.session.prompt({
          sessionID: sid,
          directory: workspaceDir(),
          ...(messageID ? { messageID } : {}),
          model: { providerID, modelID },
          parts: [{ type: "text", text }],
        } as any)
        return
      }
      case "abort":
      case "abortSession": {
        const sid = (msg as any).sessionID as string
        if (!sid) return
        await (client.session as any).abort?.({ sessionID: sid, directory: workspaceDir() })
        return
      }

      case "forkSession": {
        // webview shape: { sessionId, messageId }
        const m2 = msg as any
        const sid = m2.sessionId as string | undefined
        const mid = m2.messageId as string | undefined
        if (!sid) return
        try {
          const res: any = await (client.session as any).fork?.({
            sessionID: sid,
            directory: workspaceDir(),
            ...(mid ? { messageID: mid } : {}),
          })
          const s = (res?.data ?? res) as any
          if (s?.id) {
            emit({
              type: "sessionForked",
              sessionID: s.id,
            } as unknown as ExtensionMessage)
            // Also surface as sessionCreated so the sidebar refreshes
            // immediately without waiting for the SSE round-trip.
            emit({
              type: "sessionCreated",
              session: sessionToInfo(s),
            } as ExtensionMessage)
          }
        } catch (err) {
          emit({
            type: "error",
            message: `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
          } as ExtensionMessage)
        }
        return
      }

      case "requestFileSearch": {
        // webview shape: { query, requestId, sessionID? }
        const m2 = msg as any
        const query = (m2.query ?? "") as string
        const requestId = (m2.requestId ?? "") as string
        if (!requestId) return
        try {
          const res: any = await (client as any).find?.files?.({
            directory: workspaceDir(),
            query: query || "*",
            limit: 30,
          })
          const data = (res?.data ?? res) as any
          // Server returns either string[] or { paths, items, ... } — normalise.
          const paths: string[] = Array.isArray(data)
            ? data
            : Array.isArray(data?.paths)
              ? data.paths
              : Array.isArray(data?.files)
                ? data.files.map((f: any) => f?.path ?? f)
                : []
          emit({
            type: "fileSearchResult",
            paths,
            items: undefined,
            dir: workspaceDir(),
            requestId,
          } as unknown as ExtensionMessage)
        } catch (err) {
          emit({
            type: "fileSearchResult",
            paths: [],
            dir: workspaceDir(),
            requestId,
          } as unknown as ExtensionMessage)
          // eslint-disable-next-line no-console
          console.error("[web-vscode] file search failed", err)
        }
        return
      }

      case "enhancePrompt": {
        const m2 = msg as any
        const text = (m2.text ?? "") as string
        const requestId = (m2.requestId ?? "") as string
        if (!text || !requestId) return
        try {
          const res: any = await (client as any).enhancePrompt?.enhance?.({
            directory: workspaceDir(),
            text,
          })
          const data = (res?.data ?? res) as any
          const enhanced = (typeof data === "string" ? data : data?.text ?? data?.result ?? "") as string
          if (enhanced) {
            emit({
              type: "enhancePromptResult",
              text: enhanced,
              requestId,
            } as unknown as ExtensionMessage)
          } else {
            emit({
              type: "enhancePromptError",
              error: "Empty enhancement",
              requestId,
            } as unknown as ExtensionMessage)
          }
        } catch (err) {
          emit({
            type: "enhancePromptError",
            error: err instanceof Error ? err.message : String(err),
            requestId,
          } as unknown as ExtensionMessage)
        }
        return
      }

      case "requestAgents": {
        try {
          const res: any = await (client as any).app?.agents?.({ directory: workspaceDir() })
          const data = (res?.data ?? res) as any
          const agents: any[] = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : []
          emit({
            type: "agentsLoaded",
            agents,
            allAgents: agents,
            defaultAgent: agents[0]?.name ?? "code",
          } as unknown as ExtensionMessage)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[web-vscode] agents fetch failed", err)
        }
        return
      }

      case "requestSkills": {
        try {
          const res: any = await (client as any).app?.skills?.({ directory: workspaceDir() })
          const data = (res?.data ?? res) as any
          const skills: any[] = Array.isArray(data) ? data : Array.isArray(data?.skills) ? data.skills : []
          emit({ type: "skillsLoaded", skills } as unknown as ExtensionMessage)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[web-vscode] skills fetch failed", err)
        }
        return
      }

      case "requestMcpStatus": {
        try {
          const res: any = await (client as any).mcp?.status?.({ directory: workspaceDir() })
          const data = (res?.data ?? res) as any
          const status = (data && typeof data === "object" ? data : {}) as Record<string, unknown>
          emit({ type: "mcpStatusLoaded", status } as unknown as ExtensionMessage)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[web-vscode] mcp status failed", err)
        }
        return
      }

      case "connectMcp": {
        const name = (msg as any).name as string | undefined
        if (!name) return
        try {
          await (client as any).mcp?.connect?.({ name, directory: workspaceDir() })
        } finally {
          void routeOutbound({ type: "requestMcpStatus" } as WebviewMessage)
        }
        return
      }

      case "disconnectMcp": {
        const name = (msg as any).name as string | undefined
        if (!name) return
        try {
          await (client as any).mcp?.disconnect?.({ name, directory: workspaceDir() })
        } finally {
          void routeOutbound({ type: "requestMcpStatus" } as WebviewMessage)
        }
        return
      }

      case "authenticateMcp": {
        // OAuth flow needs a real browser callback URL. Web build has no
        // such infra yet — surface a friendly error so UI can stop spinning.
        const name = (msg as any).name as string | undefined
        emit({
          type: "error",
          message: `MCP OAuth not supported in browser build yet (${name ?? "unknown"})`,
        } as ExtensionMessage)
        return
      }

      case "fetchMarketplaceData": {
        // api.kilo.ai/api/marketplace exposes three separate JSON endpoints:
        // /mcps, /modes, /skills. Fetch in parallel via the Vite proxy and
        // merge into a single marketplaceItems array tagged with `type`.
        const fetchOne = async (path: string, kind: "mcp" | "mode" | "skill") => {
          const r = await fetch(`/api/marketplace-proxy?path=${encodeURIComponent(path)}`)
          if (!r.ok) throw new Error(`HTTP ${r.status} (${path})`)
          const data = await r.json()
          const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
          // Stamp each entry with its kind so the UI can group/render correctly.
          return arr.map((it) => ({ ...it, type: it.type ?? kind }))
        }

        const errors: string[] = []
        const results = await Promise.all([
          fetchOne("/mcps", "mcp").catch((e) => {
            errors.push(`mcps: ${e instanceof Error ? e.message : e}`)
            return [] as any[]
          }),
          fetchOne("/modes", "mode").catch((e) => {
            errors.push(`modes: ${e instanceof Error ? e.message : e}`)
            return [] as any[]
          }),
          fetchOne("/skills", "skill").catch((e) => {
            errors.push(`skills: ${e instanceof Error ? e.message : e}`)
            return [] as any[]
          }),
        ])

        emit({
          type: "marketplaceData",
          marketplaceItems: results.flat(),
          marketplaceInstalledMetadata: { project: {}, global: {} },
          ...(errors.length ? { errors } : {}),
        } as unknown as ExtensionMessage)
        return
      }

      case "installMarketplaceItem":
      case "removeInstalledMarketplaceItem": {
        const m2 = msg as any
        const item = m2.mpItem as any
        const options = m2.mpInstallOptions ?? {}
        const endpoint =
          t === "installMarketplaceItem" ? "/api/marketplace-install" : "/api/marketplace-remove"
        const resultType =
          t === "installMarketplaceItem" ? "marketplaceInstallResult" : "marketplaceRemoveResult"
        try {
          const r = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item, options }),
          })
          const data = await r.json().catch(() => ({}))
          emit({
            type: resultType,
            ...data,
          } as unknown as ExtensionMessage)
          // Refresh the marketplace install metadata so the UI's "installed"
          // badge flips correctly.
          void routeOutbound({ type: "fetchMarketplaceData" } as WebviewMessage)
        } catch (err) {
          emit({
            type: resultType,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          } as unknown as ExtensionMessage)
        }
        return
      }

      // ──────────────────────────────────────────────────────────
      // Settings: read/write config via server /config endpoint.
      // ──────────────────────────────────────────────────────────
      case "requestConfig":
      case "requestGlobalConfig": {
        try {
          const res: any = await (client as any).config?.get?.({ directory: workspaceDir() })
          const cfg = (res?.data ?? res) as any
          // configLoaded covers both project + global; for the global-only
          // request the UI still reads the same field.
          if (t === "requestGlobalConfig") {
            emit({ type: "globalConfigLoaded", config: cfg ?? {} } as unknown as ExtensionMessage)
          } else {
            emit({
              type: "configLoaded",
              config: cfg ?? {},
              globalConfig: cfg ?? {},
              features: {},
            } as unknown as ExtensionMessage)
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[web-vscode] config get failed", err)
        }
        return
      }

      case "updateSetting": {
        const m2 = msg as any
        const key = m2.key as string | undefined
        const value = m2.value
        if (!key) return
        await persistSetting(key, value)
        // Always tell the UI the change succeeded — the fallback to
        // localStorage is invisible to the user (it still survives reloads).
        emit({
          type: "configUpdated",
          config: dotPathToObject(key, value),
        } as unknown as ExtensionMessage)
        return
      }

      case "updateConfig": {
        const m2 = msg as any
        const patch = (m2.config ?? {}) as Record<string, unknown>
        try {
          await patchConfig(patch)
        } catch {
          // Some keys may be webview-only — write each top-level key to local
          // as a best-effort fallback so the toggle still persists.
          for (const [k, v] of Object.entries(patch)) localSet(k, v)
        }
        emit({ type: "configUpdated", config: patch } as unknown as ExtensionMessage)
        return
      }

      case "resetAllSettings": {
        try {
          await patchConfig({})
          emit({ type: "configUpdated", config: {} } as unknown as ExtensionMessage)
        } catch (err) {
          emit({
            type: "configUpdateFailed",
            error: err instanceof Error ? err.message : String(err),
          } as unknown as ExtensionMessage)
        }
        return
      }

      case "requestBrowserSettings": {
        const local = (localGet("browser") as any) ?? {}
        emit({
          type: "browserSettingsLoaded",
          settings: {
            enabled: local.enabled ?? false,
            useSystemChrome: local.useSystemChrome ?? true,
            headless: local.headless ?? false,
            ...local,
          },
        } as unknown as ExtensionMessage)
        return
      }

      case "requestNotificationSettings": {
        const local = (localGet("notifications") as any) ?? {}
        emit({
          type: "notificationSettingsLoaded",
          settings: {
            agent: local.agent ?? true,
            permission: local.permission ?? true,
            sound: local.sound ?? "default",
            ...local,
          },
        } as unknown as ExtensionMessage)
        return
      }

      case "requestAutocompleteSettings": {
        const local = (localGet("autocomplete") as any) ?? {}
        emit({
          type: "autocompleteSettingsLoaded",
          settings: { enableAutoTrigger: local.enableAutoTrigger ?? false, ...local },
        } as unknown as ExtensionMessage)
        return
      }

      case "requestClaudeCompatSetting": {
        emit({
          type: "claudeCompatSettingLoaded",
          enabled: (localGet("claudeCodeCompat") as boolean) ?? false,
        } as unknown as ExtensionMessage)
        return
      }

      case "requestTimelineSetting": {
        emit({
          type: "timelineSettingLoaded",
          enabled: (localGet("timeline") as boolean) ?? true,
        } as unknown as ExtensionMessage)
        return
      }

      case "requestIndexingStatus": {
        // Indexing isn't wired through the local server for the browser
        // build yet. Emit a "disabled" state so the toggle has something.
        emit({
          type: "indexingStatusLoaded",
          status: { state: "disabled", indexed: 0, total: 0 },
        } as unknown as ExtensionMessage)
        return
      }

      case "requestRemoteStatus": {
        // Remote is the Kilo cloud sync feature — not relevant locally.
        emit({
          type: "remoteStatus",
          enabled: false,
          connected: false,
        } as unknown as ExtensionMessage)
        return
      }

      case "requestNotifications": {
        // Kilo cloud-pushed notification feed — empty in local-only build.
        emit({
          type: "notificationsLoaded",
          notifications: [],
          dismissedIds: [],
        } as unknown as ExtensionMessage)
        return
      }

      case "requestAutoApproveState": {
        emit({
          type: "autoApproveState",
          active: autoApproveActive,
        } as unknown as ExtensionMessage)
        return
      }

      case "telemetry":
      case "dismissNotification":
      case "settingsTabChanged": {
        // Pure UI-side bookkeeping or telemetry — nothing to forward.
        return
      }

      case "toggleAutoApprove": {
        // Auto-approve is a UI-side preference: when "on", we automatically
        // accept any incoming permission.asked event without showing the
        // dialog. Persist to localStorage so the toggle survives reloads.
        const next = !autoApproveActive
        autoApproveActive = next
        try {
          localStorage.setItem("kilo-web.autoApprove", String(next))
        } catch {}
        emit({
          type: "autoApproveState",
          active: next,
        } as unknown as ExtensionMessage)
        return
      }
      case "permissionResponse":
      case "respondToPermission":
      case "permissionRespond": {
        // session.tsx posts type:"permissionResponse" with permissionId (lowercase d).
        const m2 = msg as any
        const pid = (m2.permissionId ?? m2.permissionID) as string | undefined
        const sid = m2.sessionID as string | undefined
        const response = (m2.response ?? m2.decision) as
          | "once"
          | "always"
          | "reject"
          | undefined
        if (!pid || !response) return
        await (client as any).permission?.respond?.({
          sessionID: sid,
          permissionID: pid,
          directory: workspaceDir(),
          response,
        })
        return
      }
      default:
        // Diagnostic during S2/S3 buildout — unhandled types get logged so we
        // can decide which to wire next.
        // eslint-disable-next-line no-console
        console.warn("[web-vscode] unhandled outbound:", t, msg)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[web-vscode] outbound route failed:", t, err)
    emit({
      type: "error",
      message: `${t} failed: ${err instanceof Error ? err.message : String(err)}`,
    } as ExtensionMessage)
  }
}

// ────────────────────────────────────────────────────────────
// Bootstrap (runs once per page-load)
// ────────────────────────────────────────────────────────────

let booted = false
let teardown: (() => void) | undefined

async function boot() {
  if (booted) return
  booted = true

  emitInitialState()

  eventBus.start()
  const off = eventBus.on(handleSSE)
  const onWorkspaceChange = () => {
    // Workspace switched at runtime — refresh server view of the world.
    eventBus.restart()
    emitInitialState()
  }
  window.addEventListener("kilo-web:workspace-changed", onWorkspaceChange)
  teardown = () => {
    off()
    eventBus.stop()
    window.removeEventListener("kilo-web:workspace-changed", onWorkspaceChange)
  }
}

/**
 * Convert a dot-path (e.g. "browser.enabled") + value into a nested object
 * shape that /config PATCH accepts. Used by updateSetting.
 */
function dotPathToObject(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".")
  const out: Record<string, unknown> = {}
  let cur: Record<string, unknown> = out
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    cur[k] = {} as Record<string, unknown>
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
  return out
}

/** PATCH /config raw — the SDK wraps the body in {config: ...} which the
 * server rejects ("unrecognized key config"). Hand-roll the call. */
async function patchConfig(patch: Record<string, unknown>) {
  const url = `${SERVER_URL}/config?directory=${encodeURIComponent(workspaceDir())}`
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`PATCH /config HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

/** webview-ui-only settings (browser/notification/autocomplete/...) that the
 * server Config schema doesn't accept. Persist them in localStorage so they
 * survive reloads but don't fight the server validator. */
const LOCAL_SETTING_PREFIX = "kilo-web.setting."

function localSet(key: string, value: unknown) {
  try {
    localStorage.setItem(LOCAL_SETTING_PREFIX + key, JSON.stringify(value))
  } catch {}
}
function localGet(key: string): unknown {
  try {
    const v = localStorage.getItem(LOCAL_SETTING_PREFIX + key)
    return v == null ? undefined : JSON.parse(v)
  } catch {
    return undefined
  }
}

/** Try server PATCH first; if the schema rejects it, fall back to localStorage
 * (under the dot-path key). The webview's request* handlers below merge both
 * sources. */
async function persistSetting(key: string, value: unknown) {
  try {
    await patchConfig(dotPathToObject(key, value))
    return { source: "server" as const }
  } catch (err) {
    localSet(key, value)
    return { source: "local" as const, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read the current server-side config, returning {} on failure so callers
 * can still emit something sane to the UI. */
async function getConfigOrEmpty(): Promise<Record<string, unknown>> {
  try {
    const res: any = await (client as any).config?.get?.({ directory: workspaceDir() })
    const cfg = (res?.data ?? res) as any
    return cfg && typeof cfg === "object" ? cfg : {}
  } catch {
    return {}
  }
}

/**
 * If a permission.asked event fires while auto-approve is on, immediately
 * respond once on behalf of the user. Called from handleSSE.
 */
async function maybeAutoApprovePermission(req: { id: string; sessionID: string }) {
  if (!autoApproveActive) return false
  try {
    await (client as any).permission?.respond?.({
      sessionID: req.sessionID,
      permissionID: req.id,
      directory: workspaceDir(),
      response: "once",
    })
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[web-vscode] auto-approve failed", err)
    return false
  }
}

/** Re-fire the events that bring the UI to a "connected, sessions loaded"
 * state for whatever the current workspaceDir() is. */
function emitInitialState() {
  emit({
    type: "ready",
    serverInfo: { port: 8787, version: "web" },
    extensionVersion: "kilo-web@0.0.1",
    vscodeLanguage: "zh-CN",
    workspaceDirectory: workspaceDir(),
    fontSize: 14,
  } as ExtensionMessage)
  emit({ type: "gitStatus", repo: true } as ExtensionMessage)
  emit({
    type: "workspaceDirectoryChanged",
    directory: workspaceDir(),
  } as ExtensionMessage)
  // Surface the persisted auto-approve preference to the UI on each boot
  // so the toggle button shows the right state.
  emit({
    type: "autoApproveState",
    active: autoApproveActive,
  } as unknown as ExtensionMessage)
  void routeOutbound({ type: "loadSessions" } as WebviewMessage)
  void loadAndEmitProviders()
}

/**
 * Pull the provider catalog from the local server, filter down to the
 * user-configured (source: "custom") providers — typically the newapi entry
 * from ~/.config/kilo/kilo.json — and feed them to the UI as
 * `providersLoaded` + `modelSelectionsLoaded`. This makes the chat input's
 * model-picker show the real choice (e.g. "glm-5.1") instead of the disabled
 * fallback "kilo-auto/free".
 */
async function loadAndEmitProviders() {
  try {
    const res: any = await (client as any).provider?.list?.({ directory: workspaceDir() })
    const data = (res?.data ?? res) as any
    const all: any[] = Array.isArray(data?.all) ? data.all : Array.isArray(data) ? data : []
    // Look up our active provider/model (DEFAULT_MODEL.providerID / .modelID)
    // straight from the server's catalog so we get its real display name,
    // limits, capabilities, etc.
    const target = all.find((p) => p?.id === DEFAULT_MODEL.providerID)
    if (!target) {
      // eslint-disable-next-line no-console
      console.warn("[web-vscode] DEFAULT_MODEL.providerID not in /provider", DEFAULT_MODEL.providerID)
      return
    }
    const targetModel = target.models?.[DEFAULT_MODEL.modelID]
    if (!targetModel) {
      // eslint-disable-next-line no-console
      console.warn("[web-vscode] DEFAULT_MODEL.modelID not in provider.models", DEFAULT_MODEL)
      return
    }

    // Lock the picker to a single provider + a single model. The dropdown
    // will only ever expose this entry, effectively pinning everything
    // to GLM 5.1 (or whatever DEFAULT_MODEL is set to).
    const pinnedProvider = {
      id: target.id,
      name: target.name ?? target.id,
      source: "config",
      env: target.env,
      models: { [DEFAULT_MODEL.modelID]: targetModel },
    }
    const providers: Record<string, any> = { [target.id]: pinnedProvider }
    const defaultSelection = { providerID: DEFAULT_MODEL.providerID, modelID: DEFAULT_MODEL.modelID }

    emit({
      type: "providersLoaded",
      providers,
      connected: [target.id],
      defaults: { [target.id]: DEFAULT_MODEL.modelID },
      defaultSelection,
      authMethods: {},
      authStates: {},
    } as unknown as ExtensionMessage)

    emit({
      type: "modelSelectionsLoaded",
      selections: {
        code: defaultSelection,
        ask: defaultSelection,
        architect: defaultSelection,
        debug: defaultSelection,
      },
    } as unknown as ExtensionMessage)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[web-vscode] loadAndEmitProviders failed", e)
  }
}

// ────────────────────────────────────────────────────────────
// getVSCodeAPI — matches original signature so any direct caller still works.
// ────────────────────────────────────────────────────────────

export function getVSCodeAPI(): VSCodeAPI {
  return {
    postMessage: (msg) => {
      void routeOutbound(msg as WebviewMessage)
    },
    getState: () => undefined,
    setState: () => {},
  }
}

export const VSCodeProvider: ParentComponent = (props) => {
  onMount(() => {
    // Defer boot until after every child component's onMount has run.
    // Solid invokes parent onMount before children, but ServerProvider
    // registers its "ready" handler inside its own onMount — if we emit
    // synchronously here it would arrive before that handler exists.
    // A 0ms macrotask is enough to flush the rest of the mount queue.
    const id = setTimeout(() => {
      void boot()
    }, 0)
    onCleanup(() => {
      clearTimeout(id)
      teardown?.()
    })
  })

  const value: VSCodeContextValue = {
    postMessage: (msg) => {
      void routeOutbound(msg)
    },
    onMessage: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    getState: <T,>() => undefined as T | undefined,
    setState: <T,>(_state: T) => {},
  }

  return <VSCodeContext.Provider value={value}>{props.children}</VSCodeContext.Provider>
}

export function useVSCode(): VSCodeContextValue {
  const ctx = useContext(VSCodeContext)
  if (!ctx) throw new Error("useVSCode must be used within a VSCodeProvider")
  return ctx
}

/**
 * SSE subscription to opencode's /event stream.
 *
 * We keep a single EventSource for the page and let consumers register
 * listeners by event type. Server events arrive as `data: <JSON>` lines.
 * Each event has a `type` field (e.g. "message.updated", "message.part.updated",
 * "permission.requested"). Wrappers can subscribe to a subset.
 */
import { SERVER_URL, workspaceDir } from "./sdk"

export type ServerEvent = {
  type: string
  properties: Record<string, unknown>
}

type Listener = (event: ServerEvent) => void

class EventBus {
  private es: EventSource | null = null
  private listeners = new Set<Listener>()
  private connected = false
  private connectedListeners = new Set<(state: boolean) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  start() {
    if (this.es) return
    this.open()
  }

  /** Close the current connection and open a fresh one. Used after a
   * workspace switch — opencode scopes events by ?directory=. */
  restart() {
    if (this.es) {
      this.es.close()
      this.es = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.setConnected(false)
    this.open()
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.es) {
      this.es.close()
      this.es = null
    }
    this.setConnected(false)
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConnectionChange(listener: (state: boolean) => void): () => void {
    this.connectedListeners.add(listener)
    listener(this.connected)
    return () => this.connectedListeners.delete(listener)
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return
    this.connected = v
    for (const l of this.connectedListeners) l(v)
  }

  private open() {
    const url = `${SERVER_URL}/event?directory=${encodeURIComponent(workspaceDir())}`
    const es = new EventSource(url)
    this.es = es

    es.addEventListener("open", () => this.setConnected(true))

    es.addEventListener("message", (evt) => {
      const data = (evt as MessageEvent).data
      let parsed: ServerEvent
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      for (const l of this.listeners) {
        try {
          l(parsed)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[event-bus] listener threw", err)
        }
      }
    })

    es.addEventListener("error", () => {
      this.setConnected(false)
      // EventSource auto-reconnects on transient errors, but if it closed
      // permanently, restart it ourselves after a short backoff.
      if (es.readyState === EventSource.CLOSED) {
        this.es = null
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, 2_000)
  }
}

export const eventBus = new EventBus()

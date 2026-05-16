import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { resolve, join } from "node:path"
import { execFile } from "node:child_process"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { promises as fsp } from "node:fs"
import { homedir } from "node:os"

const root = resolve(__dirname)
const kilocodeRoot = resolve(root, "..", "..")
const webviewUiSrc = resolve(kilocodeRoot, "packages/kilo-vscode/webview-ui/src")
const webVSCodeProvider = resolve(root, "src/web-vscode/provider.tsx")

/**
 * Marketplace install / remove for the browser build.
 *
 * VSCode's installer.ts has the canonical 400-line implementation; this is
 * a slimmer version that handles the common paths:
 *   MCP   — append/remove entry in kilo.json mcp block
 *   Mode  — append/remove entry in kilo.json mode block
 *   Skill — download SKILL.md (rawUrl) into ~/.config/kilo/.kilo/skills/{id}/
 *
 * Scope: only "global" is implemented (writes to ~/.config/kilo/kilo.json).
 * Project-scope skipped for now — the browser build is a single-workspace tool.
 */
function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8")
        resolve(text ? JSON.parse(text) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "kilo", "kilo.json")
}

function globalSkillDir(id: string): string {
  return join(homedir(), ".kilo", "skills", id)
}

async function readJsonOrEmpty(file: string): Promise<Record<string, any>> {
  try {
    const text = await fsp.readFile(file, "utf-8")
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function writeJsonPretty(file: string, data: any): Promise<void> {
  await fsp.mkdir(join(file, ".."), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

function marketplaceInstallMiddleware(): Plugin {
  return {
    name: "kilo-web-marketplace-install",
    configureServer(server) {
      server.middlewares.use("/api/marketplace-install", async (req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.method !== "POST") {
          res.statusCode = 405
          res.end(JSON.stringify({ success: false, error: "POST only" }))
          return
        }
        try {
          const body = await readBody(req)
          const item = body.item as any
          const opts = body.options ?? {}
          if (!item?.id || !item?.type) {
            res.statusCode = 400
            res.end(JSON.stringify({ success: false, error: "Missing item.id/type" }))
            return
          }
          const configPath = globalConfigPath()
          const config = await readJsonOrEmpty(configPath)

          if (item.type === "mcp") {
            config.mcp = config.mcp ?? {}
            if (config.mcp[item.id]) {
              res.statusCode = 409
              res.end(JSON.stringify({ success: false, error: "MCP server already installed" }))
              return
            }
            // Resolve content: prefer explicit installation method, else first available
            const methods = item.installationMethods ?? item.content ?? []
            const chosen = opts.methodIndex != null ? methods[opts.methodIndex] : methods[0]
            const contentStr = typeof chosen === "string" ? chosen : (chosen?.content ?? "")
            if (!contentStr) {
              res.statusCode = 400
              res.end(JSON.stringify({ success: false, error: "No installation content for MCP" }))
              return
            }
            const parsed =
              contentStr.trim().startsWith("{") ? JSON.parse(contentStr) : parseYaml(contentStr)
            // Marketplace format wraps each MCP under {mcpServers:{<id>:{...}}}; unwrap.
            const entry = parsed?.mcpServers?.[item.id] ?? parsed?.mcp?.[item.id] ?? parsed
            config.mcp[item.id] = entry
            await writeJsonPretty(configPath, config)
            res.end(JSON.stringify({ success: true, slug: item.id }))
            return
          }

          if (item.type === "mode") {
            config.mode = config.mode ?? {}
            if (config.mode[item.id]) {
              res.statusCode = 409
              res.end(JSON.stringify({ success: false, error: "Mode already installed" }))
              return
            }
            // Marketplace mode item carries either `content` (yaml) or fields directly
            const contentStr = typeof item.content === "string" ? item.content : ""
            const parsed = contentStr
              ? contentStr.trim().startsWith("{")
                ? JSON.parse(contentStr)
                : parseYaml(contentStr)
              : { ...item }
            delete (parsed as any).id
            delete (parsed as any).type
            config.mode[item.id] = parsed
            await writeJsonPretty(configPath, config)
            res.end(JSON.stringify({ success: true, slug: item.id }))
            return
          }

          if (item.type === "skill") {
            const dir = globalSkillDir(item.id)
            await fsp.mkdir(dir, { recursive: true })
            // Download the raw SKILL.md (most skills are a single-file definition).
            // Full tar.gz support could come later if needed.
            const rawUrl = item.rawUrl as string | undefined
            if (!rawUrl) {
              res.statusCode = 400
              res.end(JSON.stringify({ success: false, error: "Skill has no rawUrl" }))
              return
            }
            const r = await fetch(rawUrl)
            if (!r.ok) throw new Error(`Download HTTP ${r.status}`)
            const text = await r.text()
            await fsp.writeFile(join(dir, "SKILL.md"), text, "utf-8")
            res.end(JSON.stringify({ success: true, slug: item.id, dir }))
            return
          }

          res.statusCode = 400
          res.end(JSON.stringify({ success: false, error: `Unknown item type: ${item.type}` }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })

      server.middlewares.use("/api/marketplace-remove", async (req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.method !== "POST") {
          res.statusCode = 405
          res.end(JSON.stringify({ success: false, error: "POST only" }))
          return
        }
        try {
          const body = await readBody(req)
          const item = body.item as any
          if (!item?.id || !item?.type) {
            res.statusCode = 400
            res.end(JSON.stringify({ success: false, error: "Missing item.id/type" }))
            return
          }
          if (item.type === "skill") {
            await fsp.rm(globalSkillDir(item.id), { recursive: true, force: true })
            res.end(JSON.stringify({ success: true, slug: item.id }))
            return
          }
          // mcp / mode → remove from kilo.json
          const configPath = globalConfigPath()
          const config = await readJsonOrEmpty(configPath)
          const bucket = item.type === "mcp" ? "mcp" : "mode"
          if (config[bucket]?.[item.id]) {
            delete config[bucket][item.id]
            await writeJsonPretty(configPath, config)
          }
          res.end(JSON.stringify({ success: true, slug: item.id }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

/**
 * Bridge to the OS folder picker — browsers can't expose absolute paths,
 * but Vite's dev server runs in Node and CAN. The TopBar's WorkspacePicker
 * hits /api/pick-workspace; we shell out to osascript (macOS) and return
 * the absolute path the user chose. Linux/Windows fallbacks TBD.
 */
/**
 * Proxy api.kilo.ai for the marketplace list. The browser can't fetch
 * api.kilo.ai directly because of CORS; Vite runs in Node and faces no such
 * restriction. The webview calls /api/marketplace-proxy?path=/v1/items and
 * we forward to https://api.kilo.ai/api/marketplace<path>.
 */
function marketplaceProxyMiddleware(): Plugin {
  return {
    name: "kilo-web-marketplace-proxy",
    configureServer(server) {
      server.middlewares.use("/api/marketplace-proxy", async (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost")
        const path = url.searchParams.get("path") ?? "/skills"
        const upstream = `https://api.kilo.ai/api/marketplace${path}`
        try {
          const r = await fetch(upstream, { headers: { Accept: "*/*" } })
          const text = await r.text()
          res.statusCode = r.status
          res.setHeader("Content-Type", "application/json")
          // The upstream endpoints serve YAML (parseResponse in the
          // VSCode marketplace api.ts tries JSON first, falls back to YAML).
          // Normalize to JSON so the browser side stays simple.
          if (r.ok) {
            try {
              const parsed = JSON.parse(text)
              res.end(JSON.stringify(parsed))
              return
            } catch {
              try {
                const parsed = parseYaml(text)
                res.end(JSON.stringify(parsed))
                return
              } catch (parseErr) {
                res.statusCode = 502
                res.end(JSON.stringify({ error: `Upstream not JSON/YAML: ${(parseErr as Error).message}` }))
                return
              }
            }
          }
          res.end(text)
        } catch (err) {
          res.statusCode = 502
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

function pickWorkspaceMiddleware(): Plugin {
  return {
    name: "kilo-web-pick-workspace",
    configureServer(server) {
      server.middlewares.use("/api/pick-workspace", (_req, res) => {
        if (process.platform !== "darwin") {
          res.statusCode = 501
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Folder picker only implemented on macOS for now." }))
          return
        }
        const script = `
          try
            tell application "System Events" to activate
            set f to choose folder with prompt "Select a workspace folder for Kilo Code"
            return POSIX path of f
          on error errMsg number errNum
            if errNum is -128 then
              return "__CANCELLED__"
            else
              return "__ERROR__:" & errMsg
            end if
          end try
        `
        execFile("osascript", ["-e", script], { timeout: 5 * 60 * 1000 }, (err, stdout) => {
          res.setHeader("Content-Type", "application/json")
          if (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
            return
          }
          const out = stdout.trim()
          if (out === "__CANCELLED__") {
            res.statusCode = 204
            res.end()
            return
          }
          if (out.startsWith("__ERROR__:")) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: out.slice(10) }))
            return
          }
          // osascript adds a trailing slash; strip it for consistency.
          const path = out.replace(/\/+$/, "")
          res.end(JSON.stringify({ path }))
        })
      })
    },
  }
}

/**
 * Redirect every webview-ui/src/context/vscode import to our WebVSCodeProvider.
 * Same trick as the kiloclaw shim — keeps upstream UI source unmodified.
 */
function kiloAppVSCodeShim(): Plugin {
  return {
    name: "kilo-app-vscode-shim",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!importer) return null
      if (!importer.startsWith(webviewUiSrc)) return null
      if (importer === webVSCodeProvider) return null

      const stripped = id.replace(/\.(tsx?|jsx?)$/, "")
      if (
        stripped === "./vscode" || // from inside context/
        stripped === "./context/vscode" || // from webview-ui/src/ root (App.tsx)
        stripped === "../context/vscode" || // 1-level deep
        stripped === "../../context/vscode" || // 2-level deep
        stripped === "../../../context/vscode" || // 3-level deep (just in case)
        stripped.endsWith("/webview-ui/src/context/vscode") // absolute
      ) {
        return webVSCodeProvider
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [
    pickWorkspaceMiddleware(),
    marketplaceProxyMiddleware(),
    marketplaceInstallMiddleware(),
    kiloAppVSCodeShim(),
    solid(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@kilo-app": webviewUiSrc, // the real Kilo Code UI (~64k LOC)
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
})

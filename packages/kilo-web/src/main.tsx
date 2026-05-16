import { render } from "solid-js/web"
import "@kilocode/kilo-ui/styles"
import "./web-vscode/override.css"
import App from "./App"

// kilocode webview-ui resolves bundled SVG icons via window.ICONS_BASE_URI.
// In VS Code this is set by KiloProvider; in the browser we point it at
// kilo-web/public/icons (copied from packages/kilo-vscode/assets/icons).
;(window as any).ICONS_BASE_URI = "/icons"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root element")
render(() => <App />, root)

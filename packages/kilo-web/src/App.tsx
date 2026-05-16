import KiloApp from "@kilo-app/App"
import { TopBar } from "./web-vscode/TopBar"

export default function App() {
  return (
    <>
      <TopBar />
      <div style={{ flex: "1 1 auto", "min-height": "0", display: "flex", "flex-direction": "column" }}>
        <KiloApp />
      </div>
    </>
  )
}

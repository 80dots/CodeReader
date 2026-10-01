import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

if (import.meta.env.DEV) {
  // Outside VS Code (vite dev server) a mock plays the extension host.
  await import("./dev/mock")
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

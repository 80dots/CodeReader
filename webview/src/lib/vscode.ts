import { useEffect, useState } from "react"
import type { HostMessage, PanelState, WebviewMessage } from "@shared/protocol"

interface VsCodeApi {
  postMessage(message: WebviewMessage): void
}

declare function acquireVsCodeApi(): VsCodeApi

/** Event the dev mock listens to when the page runs in a plain browser. */
export const DEV_MESSAGE_EVENT = "code-reader:message"

const api: VsCodeApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : {
        postMessage: (message) =>
          window.dispatchEvent(new CustomEvent(DEV_MESSAGE_EVENT, { detail: message })),
      }

export function send(message: WebviewMessage): void {
  api.postMessage(message)
}

/** The panel state pushed by the extension host; undefined until the first message arrives. */
export function usePanelState(): PanelState | undefined {
  const [state, setState] = useState<PanelState>()

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      if (event.data?.type === "state") {
        setState(event.data.state)
      }
    }
    window.addEventListener("message", onMessage)
    send({ type: "ready" })
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return state
}

import { useEffect, useState } from "react"
import type { HostMessage, LineRange, PanelState, WebviewMessage } from "@shared/protocol"

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

// Long enough that sweeping the pointer across the panel does not make the editor jump around.
const HOVER_DELAY_MS = 120
let pendingHighlight: number | undefined

/**
 * Props for an element that explains some code: while the pointer (or keyboard focus)
 * rests on it, those lines are highlighted in the editor. Do not nest such elements;
 * leaving the inner one would clear the outer one's highlight.
 */
export function highlightOnHover(uri: string | undefined, range: LineRange | undefined) {
  if (!uri || !range) {
    return {}
  }
  const show = () => {
    window.clearTimeout(pendingHighlight)
    pendingHighlight = window.setTimeout(() => send({ type: "highlight", uri, range }), HOVER_DELAY_MS)
  }
  const hide = () => {
    window.clearTimeout(pendingHighlight)
    send({ type: "clearHighlight" })
  }
  return { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide }
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

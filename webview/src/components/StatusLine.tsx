import { LoaderCircleIcon } from "lucide-react"
import { useEffect, useState } from "react"
import type { PanelState } from "@shared/protocol"

function statusText(state: PanelState): string {
  if (state.stage === "symbols") {
    return "메서드를 찾고 있어요"
  }
  if (state.storyPending) {
    return state.usageSearchPending ? "이야기를 쓰면서, 쓰이는 곳도 찾고 있어요" : "이야기를 쓰고 있어요"
  }
  return "어디서 왜 쓰이는지 알아보고 있어요"
}

export function StatusLine({ state }: { state: PanelState }) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <LoaderCircleIcon className="size-3.5 animate-spin" />
      <span>{statusText(state)}…</span>
      <span className="tabular-nums opacity-70">{seconds}초</span>
    </p>
  )
}

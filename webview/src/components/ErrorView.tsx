import { RefreshCwIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react"
import type { PanelError } from "@shared/protocol"
import { Button } from "@/components/ui/button"
import { send } from "@/lib/vscode"

export function ErrorView({ error }: { error: PanelError }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-destructive/40" role="alert">
      <div className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <p className="text-sm leading-relaxed">{error.message}</p>
      </div>
      {error.detail && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">자세한 내용</summary>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono break-all whitespace-pre-wrap">
            {error.detail}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => send({ type: "explain" })}>
          <RefreshCwIcon />
          다시 시도
        </Button>
        {error.kind === "cli-not-found" && (
          <Button size="sm" variant="outline" onClick={() => send({ type: "openSettings" })}>
            <SettingsIcon />
            설정 열기
          </Button>
        )}
      </div>
    </div>
  )
}

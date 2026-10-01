import { ArrowDownIcon } from "lucide-react"
import type { MethodView, PanelState, UsageItem } from "@shared/protocol"
import { Skeleton } from "@/components/ui/skeleton"
import { highlightOnHover, send } from "@/lib/vscode"

/**
 * A table drawn as a small diagram: every row is a place that calls the method,
 * and the rail on the left gathers them into the method at the bottom.
 */
export function UsageDiagram({ method, state }: { method: MethodView; state: PanelState }) {
  if (method.usages.length === 0) {
    return state.usageSearchPending ? (
      <Skeleton className="mt-2 h-10 w-full" />
    ) : (
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
        이 메서드를 부르는 곳은 찾지 못했어요.
      </p>
    )
  }

  const hidden = method.usageTotal - method.usages.length

  return (
    <div className="mt-2 rounded-lg border bg-background/50 p-2.5">
      <div className="mb-1 hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 pr-2 pl-7 text-[11px] text-muted-foreground @sm:grid">
        <span>부르는 곳</span>
        <span>부르는 이유</span>
      </div>

      <ol className="ml-2 border-l border-foreground/25">
        {method.usages.map((usage) => (
          <UsageRow key={usage.id} usage={usage} pending={state.purposePending} />
        ))}
        {hidden > 0 && (
          <li className="relative py-1.5 pl-5 text-xs text-muted-foreground">
            <RailDot muted />이 밖에 {hidden}곳에서 더 불러요.
          </li>
        )}
      </ol>

      <div className="flex items-center gap-1.5">
        <ArrowDownIcon className="-mt-1 size-4 shrink-0 text-foreground/50" />
        <span className="truncate rounded-full bg-primary px-2.5 py-0.5 font-mono text-xs text-primary-foreground">
          {method.name}
        </span>
      </div>
    </div>
  )
}

function UsageRow({ usage, pending }: { usage: UsageItem; pending: boolean }) {
  const where = `${usage.displayPath}:${usage.line + 1}`
  return (
    <li className="relative pb-1 pl-3">
      <RailDot />
      <button
        type="button"
        title={`${where}\n${usage.preview}`}
        className="grid w-full cursor-pointer gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring @sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
        onClick={() => send({ type: "reveal", uri: usage.uri, line: usage.line, character: usage.character })}
        {...highlightOnHover(usage.uri, { startLine: usage.line, endLine: usage.line })}
      >
        <span className="min-w-0">
          <span className="block truncate font-mono text-[12.5px] font-medium">
            {usage.caller ?? "파일의 맨 바깥"}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{where}</span>
        </span>
        {usage.purpose ? (
          <span className="text-[13px] leading-relaxed">{usage.purpose}</span>
        ) : pending ? (
          <Skeleton className="h-4 w-full" />
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground">{usage.preview}</span>
        )}
      </button>
    </li>
  )
}

function RailDot({ muted = false }: { muted?: boolean }) {
  return (
    <span
      className={`absolute top-[0.9rem] -left-[4.5px] size-2 rounded-full ${muted ? "bg-foreground/30" : "bg-link"}`}
    />
  )
}

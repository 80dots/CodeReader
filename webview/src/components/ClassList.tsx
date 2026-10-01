import { CornerDownRightIcon } from "lucide-react"
import type { ClassView, ParentView, PanelState } from "@shared/protocol"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { highlightOnHover, send } from "@/lib/vscode"

/** Classes that inherit from something, each with a plain-words account of what it inherits. */
export function ClassList({ state }: { state: PanelState }) {
  if (state.classes.length === 0) {
    return null
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        물려받은 것
        <Badge variant="secondary">{state.classes.length}</Badge>
      </h2>
      {state.classes.map((item) => (
        <ClassCard key={item.id} item={item} state={state} />
      ))}
    </section>
  )
}

function ClassCard({ item, state }: { item: ClassView; state: PanelState }) {
  const uri = state.file?.uri
  const line = item.line
  const located = uri !== undefined && line !== undefined

  return (
    <div className="rounded-xl bg-card p-3.5 ring-1 ring-foreground/10">
      <button
        type="button"
        disabled={!located}
        className="max-w-full truncate rounded-sm font-mono text-[13px] font-semibold text-link outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:underline"
        onClick={() => located && send({ type: "reveal", uri, line, character: item.character ?? 0 })}
        {...highlightOnHover(uri, line !== undefined ? { startLine: line, endLine: line } : undefined)}
      >
        {item.name}
      </button>
      {item.role ? (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.role}</p>
      ) : (
        state.storyPending && <Skeleton className="mt-2 h-3.5 w-4/5" />
      )}

      <ul className="mt-3 space-y-2.5">
        {item.parents.map((parent) => (
          <ParentRow key={parent.name} parent={parent} pending={state.storyPending} />
        ))}
      </ul>
    </div>
  )
}

function ParentRow({ parent, pending }: { parent: ParentView; pending: boolean }) {
  const { uri, line } = parent
  const located = uri !== undefined && line !== undefined

  return (
    <li className="flex gap-2">
      <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-foreground/50" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={!located}
          title={located ? "어디에 적혀 있는지 보기" : undefined}
          className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:bg-accent"
          onClick={() => located && send({ type: "reveal", uri, line, character: parent.character ?? 0 })}
        >
          {parent.name}
        </button>
        {parent.explanation ? (
          <p className="mt-1 text-[13px] leading-relaxed">{parent.explanation}</p>
        ) : pending ? (
          <Skeleton className="mt-2 h-3.5 w-full" />
        ) : (
          <p className="mt-1 text-[13px] text-muted-foreground">이 부분의 설명은 받아 오지 못했어요.</p>
        )}
      </div>
    </li>
  )
}

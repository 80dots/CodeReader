import { useState } from "react"
import type { PanelState, VariableView } from "@shared/protocol"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { highlightOnHover, send } from "@/lib/vscode"

/** Files with many fields would push the method stories far down; the rest opens on request. */
const SHOWN_AT_FIRST = 6

/** The variables a file defines outside its methods: globals, constants and fields of classes. */
export function VariableList({ state }: { state: PanelState }) {
  // Keyed by file below, so every file starts collapsed again.
  const [expanded, setExpanded] = useState(false)
  const { variables } = state
  if (variables.length === 0) {
    return null
  }
  const shown = expanded ? variables : variables.slice(0, SHOWN_AT_FIRST)
  const hidden = variables.length - shown.length

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        변수 이야기
        <Badge variant="secondary">{variables.length}</Badge>
      </h2>
      <ul className="divide-y rounded-xl bg-card px-1.5 py-1 ring-1 ring-foreground/10">
        {shown.map((variable) => (
          <VariableRow key={variable.id} variable={variable} state={state} />
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)}>
          나머지 {hidden}개 더 보기
        </Button>
      )}
    </section>
  )
}

function VariableRow({ variable, state }: { variable: VariableView; state: PanelState }) {
  const uri = state.file?.uri
  const { line, explanation } = variable
  const located = uri !== undefined && line !== undefined
  const range = variable.range ?? (line !== undefined ? { startLine: line, endLine: line } : undefined)

  return (
    <li>
      <button
        type="button"
        disabled={!located}
        className="my-0.5 block w-full rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:bg-accent"
        onClick={() => located && send({ type: "reveal", uri, line, character: variable.character ?? 0 })}
        {...highlightOnHover(uri, range)}
      >
        <span className="flex items-baseline gap-1.5 font-mono">
          <span className="truncate text-[13px] font-semibold text-link">{variable.name}</span>
          {variable.container && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{variable.container}</span>
          )}
        </span>
        {explanation ? (
          <>
            <span className="mt-1 block text-[13px] leading-relaxed">{explanation.role}</span>
            {explanation.story && (
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{explanation.story}</span>
            )}
          </>
        ) : state.storyPending ? (
          <Skeleton className="mt-2 h-3.5 w-4/5" />
        ) : (
          <span className="mt-1 block text-xs text-muted-foreground">이 변수의 설명은 받아 오지 못했어요.</span>
        )}
      </button>
    </li>
  )
}

import { BookOpenIcon, RefreshCwIcon, SquareIcon } from "lucide-react"
import type { PanelState } from "@shared/protocol"
import { ClassList } from "@/components/ClassList"
import { ErrorView } from "@/components/ErrorView"
import { IdleView } from "@/components/IdleView"
import { MethodList } from "@/components/MethodList"
import { StatusLine } from "@/components/StatusLine"
import { SummaryCard } from "@/components/SummaryCard"
import { VariableList } from "@/components/VariableList"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { send, usePanelState } from "@/lib/vscode"

export default function App() {
  const state = usePanelState()
  if (!state) {
    return null
  }
  if (!state.file) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <BookOpenIcon className="size-8 opacity-60" />
        <p className="text-sm leading-relaxed">코드 파일을 열면 여기에서 쉬운 말로 설명해 드려요.</p>
      </div>
    )
  }

  const showsExplanation = state.status === "running" || state.status === "done"

  return (
    <div className="@container flex min-h-screen flex-col">
      <Header state={state} />
      <main className="flex flex-col gap-4 px-3 pt-3 pb-8">
        {state.status === "idle" && <IdleView provider={state.provider} mode={state.mode} />}
        {state.status === "error" && state.error && <ErrorView error={state.error} />}
        {showsExplanation && <Explanation state={state} />}
      </main>
    </div>
  )
}

function Header({ state }: { state: PanelState }) {
  const file = state.file!
  return (
    <header className="sticky top-0 z-10 border-b bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={file.displayPath}>
          {file.fileName}
        </span>
        <Badge variant="outline" className="font-mono text-[11px]">
          {file.languageId}
        </Badge>
        <div className="ml-auto flex shrink-0">
          {state.status === "running" && (
            <Button variant="ghost" size="sm" onClick={() => send({ type: "cancel" })}>
              <SquareIcon />
              멈추기
            </Button>
          )}
          {state.status === "done" && (
            <Button variant="ghost" size="sm" onClick={() => send({ type: "explain" })}>
              <RefreshCwIcon />
              다시 설명
            </Button>
          )}
        </div>
      </div>
      {state.status === "running" && <StatusLine state={state} />}
    </header>
  )
}

function Explanation({ state }: { state: PanelState }) {
  return (
    <>
      {state.stale && (
        <Notice>
          코드가 바뀌었어요. 아래 설명은 바뀌기 전 코드 이야기예요.
          <Button variant="link" size="xs" className="h-auto px-1" onClick={() => send({ type: "explain" })}>
            다시 설명하기
          </Button>
        </Notice>
      )}
      {state.truncated && <Notice>파일이 아주 길어서 앞부분만 읽고 설명했어요.</Notice>}
      {state.savedAt && state.status === "done" && (
        <p className="px-1 text-xs text-muted-foreground">{savedNote(state.savedAt)}</p>
      )}
      <SummaryCard summary={state.summary} />
      <ClassList state={state} />
      <VariableList key={state.file?.uri} state={state} />
      <MethodList state={state} />
    </>
  )
}

/** "10월 2일 오전 9:12에 만들어 저장해 둔 설명이에요." */
function savedNote(savedAt: string): string {
  const when = new Date(savedAt)
  if (Number.isNaN(when.getTime())) {
    return "저장해 둔 설명이에요."
  }
  const date = when.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
  const time = when.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })
  return `${date} ${time}에 만들어 저장해 둔 설명이에요.`
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

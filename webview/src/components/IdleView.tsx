import { BookOpenIcon, SettingsIcon, SparklesIcon } from "lucide-react"
import type { PanelState } from "@shared/protocol"
import { Button } from "@/components/ui/button"
import { send } from "@/lib/vscode"

const PROVIDER_NAMES: Record<PanelState["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
}

export function IdleView({ provider, mode }: Pick<PanelState, "provider" | "mode">) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-4 py-8 text-center ring-1 ring-foreground/10">
      <BookOpenIcon className="size-8 text-link" />
      <div className="space-y-1.5">
        <h2 className="text-base font-medium">이 코드, 이야기로 들려드릴까요?</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          무슨 일을 하는 코드인지, 메서드마다 어떤 일을 맡는지, 어디서 왜 쓰이는지 쉬운 말로 설명해 드려요.
        </p>
      </div>
      <Button onClick={() => send({ type: "explain" })}>
        <SparklesIcon />
        이 코드 설명하기
      </Button>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {PROVIDER_NAMES[provider]}가 설명해요 · {mode === "auto" ? "파일을 열면 자동으로 설명" : "버튼을 누를 때만 설명"}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="설정 열기"
          title="설정 열기"
          onClick={() => send({ type: "openSettings" })}
        >
          <SettingsIcon />
        </Button>
      </p>
    </div>
  )
}

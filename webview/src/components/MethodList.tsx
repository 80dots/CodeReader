import { CodeXmlIcon } from "lucide-react"
import type { MethodView, PanelState } from "@shared/protocol"
import { UsageDiagram } from "@/components/UsageDiagram"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { send } from "@/lib/vscode"

export function MethodList({ state }: { state: PanelState }) {
  const { methods } = state
  // Without language support the methods are only known once the stories arrive.
  const discovering = methods.length === 0 && (state.storyPending || state.stage === "symbols")

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        메서드 이야기
        {methods.length > 0 && <Badge variant="secondary">{methods.length}</Badge>}
      </h2>

      {discovering && <Skeleton className="h-16 w-full rounded-xl" />}
      {!discovering && methods.length === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">이 파일에는 따로 설명할 메서드가 없어요.</p>
      )}
      {state.usageApproximate && methods.length > 0 && (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          쓰이는 곳은 이름으로 찾아본 결과라서, 빠지거나 다른 것이 섞여 있을 수 있어요.
        </p>
      )}
      {state.usageError && (
        <p className="px-1 text-xs text-muted-foreground">쓰이는 이유는 알아내지 못했어요. ({state.usageError})</p>
      )}

      {methods.length > 0 && (
        // Keyed by file so the first method opens again whenever another file is explained.
        <Accordion
          key={state.file?.uri}
          type="multiple"
          defaultValue={[methods[0].id]}
          className="gap-2"
        >
          {methods.map((method) => (
            <MethodCard key={method.id} method={method} state={state} />
          ))}
        </Accordion>
      )}
    </section>
  )
}

function MethodCard({ method, state }: { method: MethodView; state: PanelState }) {
  const { explanation } = method
  const canReveal = method.line !== undefined && state.file !== undefined

  return (
    <AccordionItem
      value={method.id}
      className="rounded-xl bg-card px-3.5 ring-1 ring-foreground/10 not-last:border-b-0"
    >
      <AccordionTrigger className="gap-2 py-3 hover:no-underline">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="truncate text-[13px] font-semibold text-link">{method.name}</span>
            {method.container && (
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{method.container}</span>
            )}
          </div>
          {explanation ? (
            <p className="mt-1 text-[13px] leading-relaxed font-normal text-muted-foreground">{explanation.role}</p>
          ) : (
            <Skeleton className="mt-2 h-3.5 w-4/5" />
          )}
        </div>
      </AccordionTrigger>

      <AccordionContent className="flex flex-col gap-4 pb-3.5 [&_p:not(:last-child)]:mb-0">
        {explanation ? (
          <>
            <p className="text-sm leading-relaxed">{explanation.story}</p>
            {explanation.steps.length > 0 && (
              <div>
                <SectionTitle>이렇게 움직여요</SectionTitle>
                <ol className="mt-2 space-y-2">
                  {explanation.steps.map((step, index) => (
                    <li key={index} className="flex gap-2.5 text-[13px] leading-relaxed">
                      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums">
                        {index + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        ) : state.storyPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">이 메서드의 이야기는 받아 오지 못했어요.</p>
        )}

        <div>
          <SectionTitle>어디서 쓰이나요?</SectionTitle>
          <UsageDiagram method={method} state={state} />
        </div>

        {canReveal && (
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            onClick={() =>
              send({ type: "reveal", uri: state.file!.uri, line: method.line!, character: method.character ?? 0 })
            }
          >
            <CodeXmlIcon />
            코드에서 보기
          </Button>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
}

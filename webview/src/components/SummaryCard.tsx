import type { Summary } from "@shared/protocol"
import { Skeleton } from "@/components/ui/skeleton"

export function SummaryCard({ summary }: { summary?: Summary }) {
  return (
    <section className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 className="text-xs font-medium text-muted-foreground">이 코드는 무슨 일을 하나요?</h2>
      {summary ? (
        <>
          <p className="mt-2 text-base leading-snug font-medium">{summary.oneLine}</p>
          <p className="mt-2 text-sm leading-relaxed">{summary.story}</p>
          {summary.keyPoints.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t pt-3">
              {summary.keyPoints.map((point) => (
                <li key={point} className="flex gap-2 text-[13px] leading-relaxed">
                  <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-link" />
                  {point}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </section>
  )
}

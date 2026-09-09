import { Skeleton } from "@/components/ui/skeleton"

export default function LoginLoading() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Mirrors the showcase panel of page.tsx so the split doesn't reflow on hydration. */}
      <div className="hidden border-r bg-muted/30 lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <Skeleton className="h-9 w-40" />
        <div className="flex max-w-lg flex-col gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="mt-2 h-5 w-full" />
          <div className="mt-8 flex flex-col gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="flex items-center justify-center bg-background p-6 sm:p-10">
        <div className="flex w-full max-w-sm flex-col gap-7 rounded-xl border px-6 py-8 shadow-[var(--elevation-lg)]">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="size-14 rounded-2xl" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="mt-2 h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

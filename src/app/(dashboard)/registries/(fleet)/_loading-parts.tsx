import { Skeleton } from "@/components/ui/skeleton"

// The three shapes every fleet page's skeleton is made of. They exist so a loading state is
// cheap enough to write that no page goes without one — and these pages are exactly the ones
// that need one, since each render reaches every Harbor and the Kubernetes API.

/** Title, one line of description, and an optional action button. */
export function HeaderSkeleton({ action = true }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 px-4 sm:flex-row sm:items-end sm:justify-between lg:px-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {action && <Skeleton className="h-9 w-36" />}
    </div>
  )
}

/** The four-cell metric strip below a page header. */
export function MetricsSkeleton() {
  return (
    <div className="mx-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 lg:mx-6">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center justify-between gap-3 bg-background px-4 py-3.5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-10" />
          </div>
          <Skeleton className="size-4 rounded-sm" />
        </div>
      ))}
    </div>
  )
}

/** A list of bordered rows — jobs, mirrors, sources, rules all render as one. */
export function RowsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3 px-4 lg:px-6">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-lg border px-4 py-3.5 @xl/main:flex-row @xl/main:items-start @xl/main:justify-between"
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-28" />
            </div>
            <Skeleton className="h-3 w-64 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex items-center gap-1 self-end @xl/main:self-auto">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

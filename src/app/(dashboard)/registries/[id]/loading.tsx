import { Skeleton } from "@/components/ui/skeleton"

export default function RegistryDetailLoading() {
  return (
    <>
      <div className="flex flex-col gap-5 px-4 lg:px-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-28" />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full max-w-64" />
            </div>
            <div className="flex w-full shrink-0 gap-2 sm:w-auto">
              <Skeleton className="h-8 flex-1 sm:w-16 sm:flex-none" />
              <Skeleton className="h-8 flex-1 sm:w-20 sm:flex-none" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3 bg-background px-4 py-3.5">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-12" />
              </div>
              <Skeleton className="size-4 rounded-sm" />
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </>
  )
}

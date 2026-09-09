import { Skeleton } from "@/components/ui/skeleton"

export default function RequestsLoading() {
  return (
    <>
      <div className="flex items-center gap-1 border-b px-4 lg:px-6">
        <Skeleton className="mx-3 my-2 h-5 w-16" />
        <Skeleton className="mx-3 my-2 h-5 w-16" />
      </div>

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <div>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-2 h-4 w-full max-w-md" />
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between gap-3 bg-background px-4 py-3.5">
              <div>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-6 w-10" />
              </div>
              <Skeleton className="size-4 rounded-sm" />
            </div>
          ))}
        </div>
      </div>

      <div className="mx-4 divide-y overflow-hidden rounded-lg border lg:mx-6">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-72" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>
        ))}
      </div>
    </>
  )
}

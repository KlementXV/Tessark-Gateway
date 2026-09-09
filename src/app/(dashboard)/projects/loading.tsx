import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectsLoading() {
  return (
    <>
      <div className="flex items-center gap-1 border-b px-4 lg:px-6">
        <Skeleton className="mx-3 my-2 h-5 w-16" />
        <Skeleton className="mx-3 my-2 h-5 w-24" />
      </div>

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Skeleton className="h-6 w-36" />
            <Skeleton className="mt-2 h-4 w-48" />
          </div>
          <Skeleton className="h-9 w-36" />
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bg-background px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-6 w-10" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-4 lg:px-6">
        <div className="flex flex-col gap-3 border-y py-3 @3xl/main:flex-row">
          <Skeleton className="h-9 w-full @3xl/main:max-w-xs" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>
        <div className="divide-y overflow-hidden rounded-lg border">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
              <Skeleton className="size-9 rounded-md" />
              <div>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-2 h-3 w-full max-w-64" />
              </div>
              <Skeleton className="size-4" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

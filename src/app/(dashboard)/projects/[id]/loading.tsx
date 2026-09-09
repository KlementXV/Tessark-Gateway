import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectDetailLoading() {
  return (
    <div className="flex flex-col gap-5 px-4 lg:px-6">
      <header className="flex flex-col gap-4">
        <Skeleton className="h-8 w-36" />
        <div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="mt-2 h-4 w-full max-w-md" />
          <Skeleton className="mt-2 h-3 w-52" />
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bg-background px-4 py-3.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-6 w-10" />
            </div>
          ))}
        </div>
      </header>

      <div className="flex gap-5 overflow-hidden border-b pb-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-5 w-24 shrink-0" />
        ))}
      </div>

      <div className="grid gap-3 border-y py-4 md:grid-cols-[minmax(0,20rem)_10rem_auto] md:items-end">
        <div>
          <Skeleton className="h-3 w-12" />
          <Skeleton className="mt-2 h-9 w-full" />
        </div>
        <div>
          <Skeleton className="h-3 w-12" />
          <Skeleton className="mt-2 h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-full md:w-32" />
      </div>

      <div className="overflow-hidden rounded-lg border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between border-b px-4 py-3 last:border-b-0">
            <div>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-20" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

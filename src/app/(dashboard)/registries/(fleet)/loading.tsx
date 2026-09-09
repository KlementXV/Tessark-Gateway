import { Skeleton } from "@/components/ui/skeleton"

export default function RegistriesLoading() {
  return (
    <>
      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-52" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
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
      </section>

      <div className="flex flex-col gap-6 px-4 lg:px-6">
        <div className="flex flex-col gap-3 border-y py-3 @3xl/main:flex-row @3xl/main:items-center">
          <Skeleton className="h-9 w-full @3xl/main:max-w-xs" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 @xl/main:flex-row @xl/main:items-start @xl/main:justify-between">
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 rounded-md" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
            <div className="flex items-center gap-1 self-end @xl/main:self-auto">
              <Skeleton className="h-8 w-28" />
              <Skeleton className="size-8" />
              <Skeleton className="size-8" />
              <Skeleton className="size-8" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex flex-col overflow-hidden rounded-lg border">
                <div className="flex items-start gap-3 p-4 pb-3">
                  <Skeleton className="size-9 rounded-md" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                </div>
                <div className="mt-auto flex items-center gap-3 border-t bg-muted/25 px-4 py-2.5">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-3 w-14" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}

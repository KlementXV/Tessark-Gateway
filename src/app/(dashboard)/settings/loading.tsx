import { Skeleton } from "@/components/ui/skeleton"

export default function SettingsLoading() {
  return (
    <>
      <div className="flex items-center gap-1 border-b px-4 lg:px-6">
        <Skeleton className="mx-3 my-2 h-5 w-14" />
        <Skeleton className="mx-3 my-2 h-5 w-20" />
      </div>

      <div className="px-4 lg:px-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-4 w-full max-w-xl" />
      </div>

      <div className="grid items-start gap-6 px-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.75fr)] lg:px-6">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[26rem] w-full rounded-2xl" />
          <Skeleton className="h-80 w-full rounded-2xl" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </div>
    </>
  )
}

import { HeaderSkeleton, MetricsSkeleton, RowsSkeleton } from "../_loading-parts"

// Reading this page asks every transport for its run history — a Harbor call per policy, a
// Kubernetes call per CronJob — so it is never instant and must never be a blank screen.
export default function MirrorsLoading() {
  return (
    <>
      <HeaderSkeleton />
      <MetricsSkeleton />
      <RowsSkeleton count={3} />
    </>
  )
}

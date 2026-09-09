import { HeaderSkeleton, MetricsSkeleton, RowsSkeleton } from "../../(fleet)/_loading-parts"

// Opening a cluster probes each of its Harbors twice over — once for health, once for what
// the mesh has run — so the page arrives in pieces and says so.
export default function ClusterDetailLoading() {
  return (
    <>
      <HeaderSkeleton />
      <MetricsSkeleton />
      <RowsSkeleton count={3} />
    </>
  )
}

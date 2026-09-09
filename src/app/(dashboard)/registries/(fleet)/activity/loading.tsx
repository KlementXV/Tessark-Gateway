import { HeaderSkeleton, MetricsSkeleton, RowsSkeleton } from "../_loading-parts"

// The slowest page of the section: it reads the Kubernetes API and every Harbor that runs a
// mirror or a mesh policy before it can show a single line.
export default function ActivityLoading() {
  return (
    <>
      <HeaderSkeleton action={false} />
      <MetricsSkeleton />
      <RowsSkeleton count={5} />
    </>
  )
}

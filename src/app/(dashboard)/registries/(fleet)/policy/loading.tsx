import { HeaderSkeleton, RowsSkeleton } from "../_loading-parts"

export default function PolicyLoading() {
  return (
    <>
      <HeaderSkeleton action={false} />
      <HeaderSkeleton />
      <RowsSkeleton count={3} />
    </>
  )
}

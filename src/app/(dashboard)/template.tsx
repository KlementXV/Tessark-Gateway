/**
 * Re-mounted on every navigation (unlike the layout), which is what lets the enter
 * animation replay for each page. It wraps the loading skeleton as well as the resolved
 * page, so the fade happens once per navigation rather than once per Suspense flip.
 */
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-enter flex flex-1 flex-col gap-4 md:gap-6">{children}</div>
}

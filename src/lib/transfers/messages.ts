// User-facing strings shared between server code that can fail a transfer (launch.ts) and the
// client components that pre-emptively disable the action for the same reason — kept in a
// dependency-free module so client components can import it without pulling in
// prisma/k8s-client server code.
export const TRANSFERS_DISABLED_REASON = "Image transfers are disabled on this Gateway instance (K8S_ENABLED=false)."

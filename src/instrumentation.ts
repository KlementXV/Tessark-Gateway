export async function register() {
  // Next's runtime selector is a framework build boundary, not application configuration.
  // eslint-disable-next-line no-restricted-syntax -- Next.js compile-time boundary excludes Node dependencies from Edge bundles.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startReplicationWorker } = await import("./lib/clusters/replication-worker")
    startReplicationWorker()
    const { startBuildWorker } = await import("./lib/builds/worker")
    startBuildWorker()
  }
}

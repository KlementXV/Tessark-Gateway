# Tessark Buildah runner

Build the image in this directory and publish it to a registry reachable by the cluster:

```sh
buildah bud -t registry.example/team/tessark-build-runner:beta deploy/build-runner
buildah push --digestfile=/tmp/tessark-runner.digest registry.example/team/tessark-build-runner:beta
```

Set `BUILDS_RUNNER_IMAGE` / Helm `builds.runnerImage` to that repository with the published
`@sha256:…` digest. The Dockerfile also pins the upstream Buildah base by digest. The package
installation is performed only when building the runner, never during a production image build.

The tested Kubernetes profile uses UID 1000, fsGroup 1000, VFS storage and chroot isolation.
AppArmor and seccomp are Unconfined for the build container; no privileged mode, SYS_ADMIN,
Docker socket or host mount is used. Tested on k3s v1.36.4, Ubuntu 22.04 / kernel 5.15.
A Pod Security `restricted` namespace does not admit this profile. Use a dedicated build
namespace/node pool for administrator-approved Dockerfiles; this is not an untrusted-code sandbox.

The claim init container is UID 0 with all capabilities dropped and RuntimeDefault seccomp.
Only it receives a projected ServiceAccount token. Its Role allows Lease `create/get`, never
Secret reads. The main container receives only the revision's project-scoped push credentials.

A Lease has **no expiry**. Its holder is a pod UID, and the Gateway collector releases it only
when that pod is terminal or absent after a successful list. A Gateway or API outage keeps
subsequent runs skipped instead of allowing concurrent publication. Never force-remove the Lease
while its pod may still execute. Administrative force-deletion of pods on partitioned nodes
requires fencing the node before resuming builds.

The script writes JSON to `/dev/termination-log`. Successful publication includes the digest
reported by Buildah. A build or push failure produces a stage and a bounded error summary.
Logs remain in Kubernetes; the database retains run summaries, not the full log stream.

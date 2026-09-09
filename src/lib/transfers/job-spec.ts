// Pure construction of the skopeo Job's pod spec — no I/O, so it's testable without a cluster
// and without a database. launch.ts is the only caller; it supplies the per-target values
// (images, Secret name, source args) and this module fills in everything that comes from
// config (§3 of CLAUDE.md): resources, placement, security context, lifecycle.
//
// The rule governing a transfer may layer overrides on top of those defaults (see
// skopeo-overrides.ts). An empty override object must produce exactly the spec this module
// built before overrides existed — that identity is what makes the feature safe to add to an
// installation that never uses it.
import { getConfig } from "@/lib/config"
import type { SkopeoOverrides } from "./skopeo-overrides"

export interface SkopeoJobLabelsInput {
  transferTargetId: string
  transferRequestId: string
}

// Named rather than inlined because the executions page reads them back off a Job it found
// by a cluster-wide selector, and a label written in one place and parsed in another is
// exactly the kind of string that drifts.
export const TRANSFER_TARGET_LABEL = "tessark.io/transfer-target-id"
export const TRANSFER_REQUEST_LABEL = "tessark.io/transfer-request-id"

// Applied to both the Job and its Secret so orphans are identifiable and prunable by label
// selector — e.g. `kubectl delete job,secret -l tessark.io/transfer-request-id=<id>`.
export function buildSkopeoJobLabels(input: SkopeoJobLabelsInput): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "tessark-gateway",
    [TRANSFER_TARGET_LABEL]: input.transferTargetId,
    [TRANSFER_REQUEST_LABEL]: input.transferRequestId,
  }
}

export interface BuildSkopeoJobSpecInput {
  secretName: string
  sourceImage: string
  destImage: string
  // Only the flag ("--src-creds=..." / "--src-registry-token=...") — the credential values
  // themselves live in the Secret and reach the container via envFrom, never as a literal here.
  sourceArgs: string
  labels: Record<string, string>
  /**
   * Whether each end is a registry marked `insecureTLS` — a Harbor served over plain HTTP or
   * behind a self-signed certificate.
   *
   * skopeo speaks HTTPS to a registry unless told otherwise, so without this a destination the
   * operator has explicitly declared insecure fails at the first blob with "server gave HTTP
   * response to HTTPS client" — a message that points at the network and not at the checkbox
   * that would have fixed it. The flag was reachable before only by hand, through a rule's
   * extraArgs, which made the registry's own setting true for the Gateway's API calls and
   * false for the Job doing the actual copy.
   *
   * An UpstreamSource is never insecure: it is stored as a bare host with no scheme and is
   * always reached over HTTPS, so only a Registry on either end can set these.
   */
  sourceInsecure?: boolean
  destInsecure?: boolean
  /**
   * The instance's enterprise CA bundle (InstanceSettings.enterpriseCaPem), or null.
   *
   * One bundle for both ends, because that is what it is: the company authority signing the
   * estate. It is projected into a directory per end all the same — skopeo takes a *directory*
   * per side, and giving each its own keeps the two commands independent to read.
   *
   * A side marked insecure gets nothing: that registry was declared unverified on purpose, and
   * pointing skopeo at a trust store for a connection it will not check is noise. Insecure
   * wins per side, so one end can be insecure while the other verifies against the CA.
   */
  caPem?: string | null
  /** From the matching TransferRule. Omitted or empty means "instance defaults, unchanged". */
  overrides?: SkopeoOverrides
}

export function buildSkopeoJobSpec(input: BuildSkopeoJobSpecInput): Record<string, unknown> {
  const config = getConfig()
  const overrides = input.overrides ?? {}

  // A rule may already carry the same flag in its allowlisted extraArgs; skopeo accepts the
  // repetition, but emitting it twice would make the command misleading to read in a pod spec.
  const tlsArgs: string[] = []
  if (input.sourceInsecure) tlsArgs.push("--src-tls-verify=false")
  if (input.destInsecure) tlsArgs.push("--dest-tls-verify=false")
  const args = [
    ...tlsArgs,
    ...(overrides.extraArgs ?? []).filter((arg) => !tlsArgs.includes(arg)),
  ]
  const sourceCa = Boolean(input.caPem) && !input.sourceInsecure
  const destCa = Boolean(input.caPem) && !input.destInsecure
  const certArgs: string[] = []
  if (sourceCa) certArgs.push("--src-cert-dir=/etc/tessark/certs/source", "--src-tls-verify=true")
  if (destCa) certArgs.push("--dest-cert-dir=/etc/tessark/certs/destination", "--dest-tls-verify=true")
  args.push(...certArgs)
  const extraArgs = args.length ? ` ${args.join(" ")}` : ""

  const podSpec: Record<string, unknown> = {
    restartPolicy: "Never",
    containers: [
      {
        name: "skopeo",
        image: overrides.image ?? config.skopeoImage,
        command: [
          "sh",
          "-c",
          // --all copies every manifest of an image index, not just the one matching the
          // Job's own platform. Without it a multi-arch image arrives amputed of every
          // architecture but amd64, which only surfaces when someone pulls it on arm64.
          `skopeo copy --all "docker://$SRC_IMAGE" "docker://$DST_IMAGE" --dest-creds="$DEST_USERNAME:$DEST_PASSWORD"${input.sourceArgs}${extraArgs}`,
        ],
        env: [
          { name: "SRC_IMAGE", value: input.sourceImage },
          { name: "DST_IMAGE", value: input.destImage },
        ],
        envFrom: [{ secretRef: { name: input.secretName } }],
        resources: {
          requests: {
            cpu: overrides.cpuRequest ?? config.skopeoCpuRequest,
            memory: overrides.memoryRequest ?? config.skopeoMemoryRequest,
          },
          limits: {
            cpu: overrides.cpuLimit ?? config.skopeoCpuLimit,
            memory: overrides.memoryLimit ?? config.skopeoMemoryLimit,
          },
        },
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" },
          // Not enabled: skopeo needs a writable workdir for blob staging and no emptyDir is
          // mounted yet to give it one. Revisit once that's validated in recette (lot 10/12).
          readOnlyRootFilesystem: false,
        },
      },
    ],
  }
  const volumes: unknown[] = []
  const mounts: unknown[] = []
  if (sourceCa) {
    volumes.push({ name: "source-ca", secret: { secretName: `${input.secretName}-ca`, items: [{ key: "ca.crt", path: "ca.crt" }] } })
    mounts.push({ name: "source-ca", mountPath: "/etc/tessark/certs/source", readOnly: true })
  }
  if (destCa) {
    volumes.push({ name: "destination-ca", secret: { secretName: `${input.secretName}-ca`, items: [{ key: "ca.crt", path: "ca.crt" }] } })
    mounts.push({ name: "destination-ca", mountPath: "/etc/tessark/certs/destination", readOnly: true })
  }
  if (volumes.length) {
    podSpec.volumes = volumes
    ;(podSpec.containers as Array<Record<string, unknown>>)[0].volumeMounts = mounts
  }

  // Replaced wholesale rather than merged: a rule that names node placement is describing
  // where *this* direction may run, and half of it inherited from the instance default would
  // be a placement nobody wrote down.
  const nodeSelector = overrides.nodeSelector ?? config.skopeoNodeSelector
  if (Object.keys(nodeSelector).length > 0) {
    podSpec.nodeSelector = nodeSelector
  }
  const tolerations = overrides.tolerations ?? config.skopeoTolerations
  if (tolerations.length > 0) {
    podSpec.tolerations = tolerations
  }
  if (config.skopeoImagePullSecrets.length > 0) {
    podSpec.imagePullSecrets = config.skopeoImagePullSecrets.map((name) => ({ name }))
  }
  if (config.skopeoServiceAccount) {
    podSpec.serviceAccountName = config.skopeoServiceAccount
  }

  return {
    backoffLimit: config.skopeoJobBackoffLimit,
    ttlSecondsAfterFinished: config.skopeoJobTtlSeconds,
    activeDeadlineSeconds: overrides.activeDeadlineSeconds ?? config.skopeoJobActiveDeadlineSeconds,
    template: {
      metadata: { labels: input.labels },
      spec: podSpec,
    },
  }
}

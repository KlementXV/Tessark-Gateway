import type { Config } from "@/lib/config"

export const BUILD_LABEL = "tessark.io/build-id"
export const REVISION_LABEL = "tessark.io/build-revision"
export const buildName = (id: string) => `build-${id}`
export const revisionSecret = (id: string) => `build-rev-${id}`
export const labelsFor = (id: string, revision: string) => ({ "app.kubernetes.io/managed-by": "tessark-gateway", [BUILD_LABEL]: id, [REVISION_LABEL]: revision })

export function buildJobSpec(id: string, revision: string, c: Config) {
  if (!c.buildsRunnerImage) throw new Error("BUILDS_RUNNER_IMAGE must name a runner pinned by digest")
  const labels = labelsFor(id, revision)
  return {
    backoffLimit: 0, activeDeadlineSeconds: c.buildsDeadlineSeconds, ttlSecondsAfterFinished: c.buildsJobTtlSeconds,
    template: { metadata: { labels }, spec: {
      restartPolicy: "Never", securityContext: { fsGroup: 1000 }, automountServiceAccountToken: false, serviceAccountName: c.buildsServiceAccount,
      nodeSelector: c.buildsNodeSelector, tolerations: c.buildsTolerations, imagePullSecrets: c.buildsImagePullSecrets,
      initContainers: [{ name: "claim", image: c.buildsRunnerImage, args: ["claim"],
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
        env: [
          { name: "BUILD_LOCK", value: buildName(id) },
          { name: "POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
          { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
        ], volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "kube", mountPath: "/kube", readOnly: true }],
      }],
      containers: [{ name: "build", image: c.buildsRunnerImage,
        securityContext: { runAsUser: 1000, privileged: false, appArmorProfile: { type: "Unconfined" }, seccompProfile: { type: "Unconfined" } },
        env: [{ name: "HOME", value: "/home/build" }],
        resources: { requests: { cpu: c.buildsCpuRequest, memory: c.buildsMemoryRequest, "ephemeral-storage": "1Gi" }, limits: { cpu: c.buildsCpuLimit, memory: c.buildsMemoryLimit, "ephemeral-storage": c.buildsStorageLimit } },
        volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "storage", mountPath: "/home/build/.local/share/containers" }, { name: "config", mountPath: "/config", readOnly: true }],
      }],
      volumes: [
        { name: "work", emptyDir: { sizeLimit: c.buildsStorageLimit } },
        { name: "storage", emptyDir: { sizeLimit: c.buildsStorageLimit } },
        { name: "config", secret: { secretName: revisionSecret(revision), defaultMode: 288 } },
        { name: "kube", projected: { sources: [
          { serviceAccountToken: { path: "token", expirationSeconds: 600 } },
          { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
        ] } },
      ],
    } },
  }
}

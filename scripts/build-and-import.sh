#!/usr/bin/env bash
# Builds the Gateway image locally and imports it into the local k3s node's containerd —
# decision D4 (docs/plan-kubernetes-helm.md): no registry exists yet, so `helm install` with
# imagePullPolicy: IfNotPresent relies on the image already being present on the node.
#
# D4 + D7 (2 replicas) collide: the image only exists on whichever node(s) it was imported
# on. This script only handles the *local* node. On a multi-node cluster, either repeat the
# `docker save | k3s ctr images import` step on every node, or pin the Deployment to this one
# node with `nodeSelector` until a registry exists — see the D4/D7 note in
# docs/plan-kubernetes-helm.md §9. Re-open D4 before any real multi-node or off-box install.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
APP_VERSION="$(node -p 'require("./package.json").version')"
TAG="${1:-${APP_VERSION}-${REV}}"
IMAGE="tessark-gateway:${TAG}"

# Never "latest": with imagePullPolicy: IfNotPresent, a reused tag doesn't get re-pulled/
# re-imported, and you'd end up debugging the previous build without knowing it.
if [ "${TAG}" = "latest" ]; then
  echo "Refusing to build tag 'latest' — imagePullPolicy: IfNotPresent would never see an update." >&2
  exit 1
fi

echo "==> Building ${IMAGE}"
docker buildx build --builder tessark-builder --load \
  --build-arg GIT_REVISION="${REV}" \
  --build-arg IMAGE_VERSION="${TAG}" \
  -t "${IMAGE}" .

echo "==> Importing ${IMAGE} into the local k3s node"
docker save "${IMAGE}" | sudo k3s ctr images import -

cat <<EOF

Image ${IMAGE} is now available to this k3s node.

Point the chart at it:
  helm upgrade --install tessark-gateway deploy/helm/tessark-gateway \\
    --set image.repository=tessark-gateway \\
    --set image.tag=${TAG} \\
    ...

Multi-node cluster: repeat 'docker save tessark-gateway:${TAG} | sudo k3s ctr images import -'
on every other node, or set a nodeSelector pinning the Deployment to this one — see D4/D7 in
docs/plan-kubernetes-helm.md.
EOF

#!/usr/bin/env bash
# Render all supported database modes and verify build activation guards without a cluster.
set -euo pipefail
chart=deploy/helm/tessark-gateway
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT

helm lint "$chart" --strict
for mode in embedded cnpg external; do
  helm template tessark-ci "$chart" --namespace tessark-ci \
    --api-versions postgresql.cnpg.io/v1/Cluster \
    --set "database.mode=$mode" \
    --set database.external.host=postgres.example.test \
    --set database.external.password=ci-password \
    --set auth.adminPassword=ci-bootstrap-password > "$output/$mode.yaml"
  test -s "$output/$mode.yaml"
done

digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
helm template tessark-ci "$chart" --namespace tessark-ci \
  --set builds.enabled=true \
  --set builds.namespace=tessark-ci-builds \
  --set "builds.runnerImage=example.test/runner@sha256:$digest" > "$output/builds.yaml"

if helm template tessark-ci "$chart" --set builds.enabled=true > "$output/invalid.yaml" 2>&1; then
  echo 'Chart accepted builds without a pinned runner.' >&2
  exit 1
fi
if helm template tessark-ci "$chart" --set builds.enabled=true --set config.k8sEnabled=false \
  --set "builds.runnerImage=example.test/runner@sha256:$digest" > "$output/invalid.yaml" 2>&1; then
  echo 'Chart accepted builds without Kubernetes.' >&2
  exit 1
fi
if helm template tessark-ci "$chart" --set builds.enabled=true \
  --set builds.runnerImage=example.test/runner:latest > "$output/invalid.yaml" 2>&1; then
  echo 'Chart accepted a runner tag instead of a digest.' >&2
  exit 1
fi

echo 'Helm passed: embedded, CNPG, external, builds and invalid activation guards.'

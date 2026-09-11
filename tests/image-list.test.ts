import assert from "node:assert/strict"
import test from "node:test"

import { parseImageList, type ImageListSource } from "@/lib/transfers/image-list"

const HUB: ImageListSource = { key: "upstream:hub", host: "docker.io" }
const QUAY: ImageListSource = { key: "upstream:quay", host: "quay.io" }
const DMZ: ImageListSource = {
  key: "registry:dmz",
  host: "harbor-dmz.local:8443",
  projects: ["k8s", "apps"],
}
const CATALOG = [HUB, QUAY, DMZ]

// Most lines still carry no host: the picked source is what they come from.
const onHub = { sources: CATALOG, defaultSourceKey: HUB.key }

test("one line is one image, with latest as the implied tag", () => {
  const { images, invalid, duplicates } = parseImageList("library/nginx:1.27\nlibrary/redis\n", onHub)
  assert.deepEqual(
    images.map((image) => `${image.repo}:${image.tag}@${image.line}`),
    ["library/nginx:1.27@1", "library/redis:latest@2"],
  )
  assert.deepEqual(invalid, [])
  assert.deepEqual(duplicates, [])
})

test("blank lines and comments are skipped without shifting the line numbers", () => {
  const { images } = parseImageList("\n# from the wiki page\n\nlibrary/nginx\n", onHub)
  assert.equal(images.length, 1)
  assert.equal(images[0].line, 4)
})

test("a repeated image is reported against the line it first appeared on", () => {
  // "nginx" and "nginx:latest" are the same image, so they are the one duplicate they look like.
  const { images, duplicates } = parseImageList(
    "library/nginx\nlibrary/redis:7\nlibrary/nginx:latest",
    onHub,
  )
  assert.equal(images.length, 2)
  assert.deepEqual(duplicates, [{ line: 3, text: "library/nginx:latest", firstLine: 1 }])
})

test("a line that is not a usable reference is named, and does not become an image", () => {
  const { images, invalid } = parseImageList("library/nginx\nnot a repo!\nUPPER/case", onHub)
  // Case is folded rather than refused — registries are lowercase and pasting a capital is not
  // a different image.
  assert.deepEqual(images.map((image) => image.repo), ["library/nginx", "upper/case"])
  assert.deepEqual(invalid, [{ line: 2, text: "not a repo!", reason: "syntax", detail: undefined }])
})

test("the short Docker Hub form is expanded, so the preview and the allowlist agree", () => {
  const { images } = parseImageList("nginx:1.27", onHub)
  assert.equal(images[0].repo, "library/nginx")
})

test("a host on the line names the source, and the picked one is left alone", () => {
  const { images, invalid } = parseImageList("library/nginx\nquay.io/prometheus/node-exporter:v1.8", onHub)
  assert.deepEqual(invalid, [])
  assert.deepEqual(
    images.map((image) => [image.sourceKey, image.repo, image.detected]),
    [
      ["upstream:hub", "library/nginx", false],
      ["upstream:quay", "prometheus/node-exporter", true],
    ],
  )
})

test("Docker Hub's other names resolve to the one source it is", () => {
  const { images } = parseImageList("index.docker.io/library/redis:7", { sources: CATALOG })
  assert.deepEqual(
    images.map((image) => [image.sourceKey, image.repo]),
    [["upstream:hub", "library/redis"]],
  )
})

test("a host nobody approved refuses the line rather than becoming a source", () => {
  const { images, invalid } = parseImageList("evil.example.test/team/app:1", onHub)
  assert.deepEqual(images, [])
  assert.deepEqual(invalid, [
    { line: 1, text: "evil.example.test/team/app:1", reason: "unknownHost", detail: "evil.example.test" },
  ])
})

test("a Harbor source is addressed project-first, and an unknown project is refused", () => {
  const { images, invalid } = parseImageList(
    "harbor-dmz.local:8443/k8s/etcd:3.5\nharbor-dmz.local:8443/secret/etcd:3.5\nharbor-dmz.local:8443/etcd",
    onHub,
  )
  assert.deepEqual(
    images.map((image) => [image.sourceKey, image.sourceProject, image.repo, image.tag]),
    [["registry:dmz", "k8s", "etcd", "3.5"]],
  )
  assert.deepEqual(
    invalid.map((entry) => [entry.line, entry.reason, entry.detail]),
    [
      [2, "unknownProject", "secret"],
      // The third line stops at the repository, so nothing says which project holds it.
      [3, "missingProject", undefined],
    ],
  )
})

test("a bare line inherits the picked Harbor's project, and refuses when none is picked", () => {
  const withProject = parseImageList("etcd:3.5", {
    sources: CATALOG,
    defaultSourceKey: DMZ.key,
    defaultSourceProject: "k8s",
  })
  assert.deepEqual(
    withProject.images.map((image) => [image.sourceProject, image.repo]),
    [["k8s", "etcd"]],
  )

  const without = parseImageList("etcd:3.5", { sources: CATALOG, defaultSourceKey: DMZ.key })
  assert.deepEqual(without.images, [])
  assert.equal(without.invalid[0].reason, "missingProject")
})

test("with no host and no source picked, a line says so rather than guessing", () => {
  const { images, invalid } = parseImageList("library/nginx", { sources: CATALOG })
  assert.deepEqual(images, [])
  assert.equal(invalid[0].reason, "noSource")
})

test("the same repository from two sources is two images, not a duplicate", () => {
  const { images, duplicates, sourceKeys } = parseImageList(
    "library/nginx:1.27\nquay.io/library/nginx:1.27",
    onHub,
  )
  assert.equal(images.length, 2)
  assert.deepEqual(duplicates, [])
  assert.deepEqual(sourceKeys, ["upstream:hub", "upstream:quay"])
})

test("a port in a host is not read as a tag", () => {
  // The colon belongs to the registry address, and splitting on it would invent a repository
  // "harbor-dmz.local" with the tag "8443/k8s/etcd".
  const { images } = parseImageList("harbor-dmz.local:8443/k8s/etcd", onHub)
  assert.deepEqual(
    images.map((image) => [image.repo, image.tag]),
    [["etcd", "latest"]],
  )
})

test("OCI Helm chart references retain version case and normalize build metadata", () => {
  const parsed = parseImageList("oci://harbor-dmz.local:8443/apps/mychart:1.2.3-rc.1+Build.7", onHub)
  assert.deepEqual(parsed.invalid, [])
  assert.equal(parsed.images[0].sourceKey, DMZ.key)
  assert.equal(parsed.images[0].sourceProject, "apps")
  assert.equal(parsed.images[0].repo, "mychart")
  assert.equal(parsed.images[0].tag, "1.2.3-rc.1_Build.7")
})

test("OCI charts need a version and still enforce approved hosts and projects", () => {
  const parsed = parseImageList([
    "oci://harbor-dmz.local:8443/apps/mychart",
    "oci://harbor-dmz.local:8443/apps/mychart:latest",
    "oci://evil.example/charts/mychart:1.0.0",
    "oci://harbor-dmz.local:8443/private/mychart:1.0.0",
  ].join("\n"), onHub)
  assert.deepEqual(parsed.images, [])
  assert.deepEqual(parsed.invalid.map(item => item.reason), ["syntax", "syntax", "unknownHost", "unknownProject"])
})

test("mixed image and chart lists deduplicate equivalent OCI tags and preserve image tag case", () => {
  const parsed = parseImageList([
    "nginx:ReleaseA",
    "oci://harbor-dmz.local:8443/apps/chart:1.0.0+Build",
    "harbor-dmz.local:8443/apps/chart:1.0.0_Build",
  ].join("\n"), onHub)
  assert.equal(parsed.images[0].tag, "ReleaseA")
  assert.equal(parsed.images.length, 2)
  assert.equal(parsed.duplicates.length, 1)
})

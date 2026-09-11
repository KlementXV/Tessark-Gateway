// Protocol-level regression: run the production copy command against an isolated OCI
// registry fixture, then check every transferred byte and read the chart with Helm.
// Requires helm and skopeo on PATH; no external registry or Kubernetes cluster.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { buildSkopeoJobSpec } from "../src/lib/transfers/job-spec"

const exec = promisify(execFile)
const digest = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-chart-copy-"))
  const blobs = new Map<string, Buffer>()
  const uploads = new Map<string, Buffer>()
  let received: Buffer | undefined
  let sourceManifest: Buffer
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost")
      res.setHeader("Docker-Distribution-Api-Version", "registry/2.0")
      if (url.pathname === "/v2/") { res.end("{}"); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const path = url.pathname
      if (path.includes("/blobs/uploads/")) {
        const id = path.split("/").pop() || randomUUID()
        const data = Buffer.concat([uploads.get(id) ?? Buffer.alloc(0), body])
        uploads.set(id, data)
        if (req.method === "PUT") {
          const hash = url.searchParams.get("digest")!
          assert.equal(digest(data), hash)
          blobs.set(`destination/${hash}`, data)
          res.statusCode = 201
          res.setHeader("Docker-Content-Digest", hash)
        } else {
          res.statusCode = 202
          res.setHeader("Location", `/v2/destination/chart/blobs/uploads/${id}`)
          res.setHeader("Range", `0-${Math.max(0, data.length - 1)}`)
        }
        res.end(); return
      }
      if (path.includes("/manifests/")) {
        if (req.method === "PUT") {
          received = body
          res.statusCode = 201
          res.setHeader("Docker-Content-Digest", digest(body))
          res.end(); return
        }
        const manifest = path.includes("/source/") ? sourceManifest : received
        if (manifest) {
          res.setHeader("Content-Type", "application/vnd.oci.image.manifest.v1+json")
          res.setHeader("Docker-Content-Digest", digest(manifest))
          res.end(manifest); return
        }
      }
      if (path.includes("/blobs/")) {
        const data = blobs.get(`${path.includes("/source/") ? "source" : "destination"}/${path.split("/").pop()}`)
        if (data) {
          res.setHeader("Content-Length", data.length)
          res.setHeader("Docker-Content-Digest", digest(data))
          res.end(data); return
        }
      }
      res.statusCode = 404; res.end()
    } catch (error) { res.statusCode = 500; res.end(String(error)) }
  })
  try {
    await exec("helm", ["package", "deploy/helm/tessark-gateway", "--destination", dir])
    const archive = await readFile(join(dir, (await readdir(dir)).find(name => name.endsWith(".tgz"))!))
    const config = Buffer.from(JSON.stringify({ name: "tessark-gateway", version: "0.2.0" }))
    // Opaque provenance is deliberately copied too; verification belongs to the Helm consumer.
    const provenance = Buffer.from("fixture provenance bytes\n")
    const descriptor = (data: Buffer, mediaType: string) => {
      blobs.set(`source/${digest(data)}`, data)
      return { mediaType, digest: digest(data), size: data.length }
    }
    sourceManifest = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: descriptor(config, "application/vnd.cncf.helm.config.v1+json"),
      layers: [
        descriptor(archive, "application/vnd.cncf.helm.chart.content.v1.tar+gzip"),
        descriptor(provenance, "application/vnd.cncf.helm.chart.provenance.v1.prov"),
      ],
    }))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address() as { port: number }
    const host = `127.0.0.1:${address.port}`
    const spec = buildSkopeoJobSpec({
      secretName: "fixture", sourceImage: `${host}/source/chart@${digest(sourceManifest)}`,
      destImage: `${host}/destination/chart:0.2.0`, sourceArgs: "", labels: {},
      sourceInsecure: true, destInsecure: true,
    }) as { template: { spec: { containers: { command: string[]; env: { name: string; value: string }[] }[] } } }
    const container = spec.template.spec.containers[0]
    await exec("env", [
      ...container.env.map(item => `${item.name}=${item.value}`),
      "DEST_USERNAME=fixture", "DEST_PASSWORD=fixture", ...container.command,
    ], { timeout: 30000 })
    assert.deepEqual(received, sourceManifest, "manifest and source digest preserved")
    for (const data of [config, archive, provenance]) assert.deepEqual(blobs.get(`destination/${digest(data)}`), data)
    const copiedChart = join(dir, "copied.tgz")
    await writeFile(copiedChart, blobs.get(`destination/${digest(archive)}`)!)
    const shown = await exec("helm", ["show", "chart", copiedChart])
    assert.match(shown.stdout, /name: tessark-gateway/)
    console.log("Helm OCI transfer passed: manifest, config, chart archive and provenance preserved; Helm reads the copied chart.")
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

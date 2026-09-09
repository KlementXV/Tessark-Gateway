// This process exercises a configured enterprise CA using real TLS handshakes.
// eslint-disable-next-line no-restricted-syntax
process.env.CUSTOM_CA_BETA_ENABLED = "true"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as tls from "node:tls"
import { createServer } from "node:https"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prisma } from "../src/lib/prisma"
import { dispatcherFor } from "../src/lib/registries/http"
import { request, type Dispatcher } from "undici"

test("enterprise CA adds trust while preserving defaults and rejecting unknown certificates", async () => {
  const runtime = tls as typeof tls & { getCACertificates?: (kind: string) => string[]; setDefaultCACertificates?: (certs: readonly string[]) => void }
  assert.ok(runtime.setDefaultCACertificates, "TLS integration test requires Node >=22.19")
  const originalRoots = runtime.getCACertificates!("default")
  const directory = mkdtempSync(join(tmpdir(), "gateway-tls-"))
  const servers: ReturnType<typeof createServer>[] = []
  const originalQuery = prisma.instanceSettings.findUnique
  let dispatcher: Awaited<ReturnType<typeof dispatcherFor>>
  try {
    const certs = ["default", "enterprise", "unknown"].map((name) => {
      const key = join(directory, `${name}.key`)
      const cert = join(directory, `${name}.crt`)
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", `/CN=${name}`, "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" })
      return { key: readFileSync(key), cert: readFileSync(cert, "utf8") }
    })
    runtime.setDefaultCACertificates([...originalRoots, certs[0].cert])
    // A private bundle by itself must not discard the root in the effective default store.
    prisma.instanceSettings.findUnique = (async () => ({ enterpriseCaPem: certs[1].cert, enterpriseCaJobDefault: true })) as unknown as typeof originalQuery
    dispatcher = await dispatcherFor({ insecureTLS: false })
    assert.ok(dispatcher)
    for (let i = 0; i < certs.length; i++) {
      const server = createServer(certs[i], (_req, res) => res.end("trusted"))
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      assert.ok(address && typeof address !== "string")
      const url = `https://127.0.0.1:${address.port}`
      if (i < 2) {
        const response: Dispatcher.ResponseData = await request(url, { dispatcher })
        assert.equal(await response.body.text(), "trusted")
      } else {
        await assert.rejects(request(url, { dispatcher }), /self-signed|certificate/i)
      }
    }
  } finally {
    prisma.instanceSettings.findUnique = originalQuery
    runtime.setDefaultCACertificates(originalRoots)
    await dispatcher?.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    rmSync(directory, { recursive: true, force: true })
  }
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { configIssues } from "../src/lib/config"

// docs/plan-ldap-sso-local.md, lot 5: the SSO wiring mistakes that must stop the pod at boot
// rather than be discovered in acceptance testing.

// The same variables the suite runs with, read from the fixture rather than from the process.
const fixture = Object.fromEntries(
  readFileSync(new URL("./env.fixture", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => [match[1], match[2].replace(/^"(.*)"$/, "$1")])
)

const sso = {
  ...fixture,
  OIDC_ENABLED: "true",
  OIDC_ISSUER: "https://sso.example.test",
  OIDC_CLIENT_ID: "tessark-gateway",
}

test("a role mapping on the groups claim without the groups scope refuses to start", () => {
  const issues = configIssues({ ...sso, OIDC_ROLE_MAPPING: '{"gateway-admins":"ADMIN"}', OIDC_SCOPES: "openid profile email" })
  assert.equal(issues.length, 1)
  assert.match(issues[0], /OIDC_SCOPES: must include "groups"/)
  // The message names the variable, never a value.
  assert.equal(issues[0].includes("gateway-admins"), false)
})

test("the groups scope, an empty mapping or another claim path all start normally", () => {
  assert.deepEqual(configIssues({ ...sso, OIDC_ROLE_MAPPING: '{"gateway-admins":"ADMIN"}', OIDC_SCOPES: "openid profile email groups" }), [])
  assert.deepEqual(configIssues({ ...sso, OIDC_SCOPES: "openid profile email" }), [])
  assert.deepEqual(
    configIssues({ ...sso, OIDC_ROLE_MAPPING: '{"admins":"ADMIN"}', OIDC_ROLE_CLAIM: "realm_access.roles", OIDC_SCOPES: "openid" }),
    [],
  )
})

test("the rule only applies when single sign-on is on", () => {
  assert.deepEqual(configIssues({ ...fixture, OIDC_ENABLED: "false", OIDC_ROLE_MAPPING: '{"g":"ADMIN"}', OIDC_SCOPES: "openid" }), [])
})

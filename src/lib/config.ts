// Single entry point for runtime configuration — see CLAUDE.md §0.1. Nothing outside this
// file should read `process.env` (except NODE_ENV, tolerated everywhere). Parsing is lazy
// and memoized: `next build` must succeed with zero env vars set, so the schema is only
// evaluated the first time getConfig() is called at request time, never at module load.
import { readFileSync } from "node:fs"
import { z } from "zod"

import { Role } from "@/generated/prisma/client"
import { isSafeLogoUrl } from "@/lib/settings/branding"

// Lets Helm mount the Secret as files instead of env vars (avoids leaking values through
// `kubectl describe pod` / environment dumps) — AUTH_SECRET_FILE=/etc/... overrides AUTH_SECRET.
function readEnv(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]
  const raw = file ? readFileSync(file, "utf8").trim() : process.env[name]
  // Helm/Kubernetes commonly renders unset optional values as an empty string rather than
  // omitting the key entirely — treat that the same as "not provided".
  return raw === undefined || raw === "" ? undefined : raw
}

function boolField(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return defaultValue
      const normalized = raw.trim().toLowerCase()
      if (["true", "1", "yes"].includes(normalized)) return true
      if (["false", "0", "no"].includes(normalized)) return false
      ctx.addIssue("must be a boolean (true/false)")
      return z.NEVER
    })
}

function intField(defaultValue: number, min?: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return defaultValue
      const n = Number(raw)
      if (!Number.isInteger(n)) {
        ctx.addIssue("must be an integer")
        return z.NEVER
      }
      if (min !== undefined && n < min) {
        ctx.addIssue(`must be >= ${min}`)
        return z.NEVER
      }
      return n
    })
}

function jsonObjectField(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((raw, ctx) => {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object")
        }
        return parsed as Record<string, string>
      } catch {
        ctx.addIssue("must be a JSON object")
        return z.NEVER
      }
    })
}

function jsonArrayField(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((raw, ctx) => {
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) throw new Error("not an array")
        return parsed as unknown[]
      } catch {
        ctx.addIssue("must be a JSON array")
        return z.NEVER
      }
    })
}

function csvField() {
  return z
    .string()
    .optional()
    .transform((raw) =>
      raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
}

const envSchema = z.object({
  // --- Secret (sensitive) ---
  DATABASE_URL: z.string().min(1, "is required"),
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  GATEWAY_SECRET_KEY: z.string().min(16, "must be at least 16 characters"),
  // Only required by the seed job (prisma/seed.ts) — kept optional here so the web server
  // doesn't fail to boot over credentials it never reads again after bootstrap.
  GATEWAY_ADMIN_USERNAME: z.string().min(1).optional(),
  GATEWAY_ADMIN_PASSWORD: z.string().min(8, "must be at least 8 characters").optional(),
  // Extra users and upstream sources created once at first boot, alongside the superadmin
  // above — also consumed only by prisma/seed.ts, never re-read afterwards. Shape validated
  // there against userCreateInputSchema / sourceInputSchema, not here: this module only
  // needs to know "JSON array", the domain schemas own the per-field rules.
  GATEWAY_SEED_USERS: jsonArrayField("[]"),
  GATEWAY_SEED_SOURCES: jsonArrayField("[]"),

  // --- ConfigMap (non-sensitive, all defaulted) ---
  AUTH_URL: z.string().url("must be a valid URL").optional(),
  AUTH_TRUST_HOST: boolField(true),
  K8S_ENABLED: boolField(true),
  K8S_NAMESPACE: z.string().min(1).optional(),
  K8S_HTTP_TIMEOUT_MS: intField(10_000, 1000),
  SKOPEO_IMAGE: z.string().min(1).default("quay.io/skopeo/stable:latest"),
  SKOPEO_JOB_TTL_SECONDS: intField(3600, 0),
  SKOPEO_JOB_BACKOFF_LIMIT: intField(1, 0),
  SKOPEO_JOB_ACTIVE_DEADLINE_SECONDS: intField(1800, 1),
  SKOPEO_CPU_REQUEST: z.string().min(1).default("100m"),
  SKOPEO_CPU_LIMIT: z.string().min(1).default("1"),
  SKOPEO_MEMORY_REQUEST: z.string().min(1).default("128Mi"),
  SKOPEO_MEMORY_LIMIT: z.string().min(1).default("512Mi"),
  SKOPEO_NODE_SELECTOR: jsonObjectField("{}"),
  SKOPEO_TOLERATIONS: jsonArrayField("[]"),
  SKOPEO_IMAGE_PULL_SECRETS: csvField(),
  SKOPEO_SERVICE_ACCOUNT: z.string().min(1).optional(),
  // Fallback push credential for the mirror jobs: when a destination project has no robot
  // of its own, Gateway provisions a Harbor *system* robot by this name on the target Harbor
  // and the skopeo Job authenticates with it (src/lib/clusters/system-robot.ts). Turning the
  // flag off restores the previous behaviour — a project without a robot refuses the pull.
  // The Harbor admin password stored on the Registry is never handed to a Job either way.
  REPLICATION_WORKER_ENABLED: boolField(true),
  REPLICATION_POLL_SECONDS: intField(60, 10),
  REPLICATION_VERIFY_SECONDS: intField(300, 30),
  REPLICATION_CATCHUP_SECONDS: intField(3600, 0),
  SYSTEM_ROBOT_ENABLED: boolField(true),
  SYSTEM_ROBOT_NAME: z.string().min(1).default("tessark-gateway"),
  HARBOR_HTTP_TIMEOUT_MS: intField(15_000, 1000),
  REGISTRY_CHECK_TIMEOUT_MS: intField(8000, 1000),
  DEFAULT_BRAND_NAME: z.string().min(1).default("Tessark"),
  DEFAULT_BRAND_TAGLINE: z.string().min(1).default("Gateway"),
  DEFAULT_PRIMARY_COLOR: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #3366ff")
    .optional(),
  DEFAULT_LOGO_URL: z
    .string()
    .min(1)
    .optional()
    .refine((value) => value === undefined || isSafeLogoUrl(value), {
      message: "must be an https:// URL or a path like /logo.svg",
    }),
  LOGO_MAX_BYTES: intField(524_288, 1),
  AVATAR_MAX_BYTES: intField(262_144, 1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // UI language served before a visitor has picked one (src/i18n/locale.ts): the cookie wins,
  // then the browser's Accept-Language, then this. Must be one of SUPPORTED_LOCALES.
  DEFAULT_LOCALE: z.enum(["en", "fr"]).default("en"),

  // --- OIDC / SSO ---
  // Off by default: an install that never sets these keeps exactly the auth surface it has
  // today. Turning it on *adds* a provider — the local credentials form stays available
  // unless OIDC_ALLOW_LOCAL_LOGIN is explicitly turned off. See docs/plan-oidc.md.
  OIDC_ENABLED: boolField(false),
  // Base URL of the provider; everything else (authorization, token, jwks, end_session
  // endpoints) is read from <issuer>/.well-known/openid-configuration at request time. For
  // Dex example: https://sso.example.com.
  OIDC_ISSUER: z.string().url("must be a valid URL").optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().min(1).default("openid profile email"),
  // Shown on the sign-in button, and in place of the raw "oidc" string wherever the UI names
  // the directory an account belongs to.
  OIDC_DISPLAY_NAME: z.string().min(1).default("Single sign-on"),
  // The break-glass path: with the identity provider down, a local SUPERADMIN can still get
  // in. Turning this off is a deliberate policy choice with no way back in if the provider
  // is unreachable — see the warning in the Helm NOTES.
  OIDC_ALLOW_LOCAL_LOGIN: boolField(true),
  // false = only users already present in the database (matched on externalId) may sign in;
  // an unknown subject is refused instead of being provisioned.
  OIDC_ALLOW_SIGNUP: boolField(true),
  // Whether a first-time subject may adopt a pre-existing local account sharing its email.
  // Off by default: emails are mutable and not always verified by the provider, so matching
  // on one turns a compromised mailbox into account takeover. When on, `email_verified` is
  // still required. Meant to be switched on for the duration of a migration, then off again.
  OIDC_LINK_BY_EMAIL: boolField(false),
  // Claim carrying the group/role memberships, as a dotted path into the token claims —
  // "groups" for Dex; upstream claim mapping belongs in the Dex connector.
  OIDC_ROLE_CLAIM: z.string().min(1).default("groups"),
  // { "<claim value>": "<Role>" }. Highest matching role wins. A value that is not a Role
  // fails startup rather than silently degrading to OIDC_DEFAULT_ROLE.
  OIDC_ROLE_MAPPING: jsonObjectField("{}").superRefine((mapping, ctx) => {
    for (const [claimValue, role] of Object.entries(mapping)) {
      if (!Object.values(Role).includes(role as Role)) {
        ctx.addIssue(`"${claimValue}" maps to "${role}", which is not one of ${Object.values(Role).join(", ")}`)
      }
    }
  }),
  OIDC_DEFAULT_ROLE: z.enum(Role).default(Role.USER),
  // "local" signs the user out of the Gateway only — their provider session survives, so
  // clicking sign-in again returns them without a prompt. "idp" additionally redirects to the
  // provider's end_session_endpoint, which signs them out of every application in the realm.
  //
  // "idp" also makes the session cookie carry the provider's ID token, to send as
  // `id_token_hint` (measured: ~585 bytes to ~2.1 KB — under the 4 KB at which NextAuth starts
  // splitting the cookie, but not free). The spec calls that hint merely RECOMMENDED and
  // allows `client_id` instead, yet a provider may refuse the post-logout redirect without it
  // — Okta documents only the `id_token_hint` form — so "idp" pays for portability.
  OIDC_LOGOUT_MODE: z.enum(["local", "idp"]).default("local"),
  // How stale a session JWT's cached role/disabled flag may get before it is re-read from the
  // database (src/auth.ts). Applies to local sessions too: without it a demoted or disabled
  // user keeps their access until the JWT expires. 0 = re-read on every request.
  AUTH_SESSION_REFRESH_SECONDS: intField(300, 0),

  // Gates ApiToken (Bearer) authentication on every route — see src/lib/auth/guard.ts. Off
  // by default: a helm install with no override exposes nothing beyond the session cookie.
  API_EXTERNAL_ENABLED: boolField(false),
  // Upper bound offered when creating a token from Settings (src/lib/api-tokens) — does not
  // retroactively expire tokens created under a looser value.
  API_TOKEN_MAX_TTL_DAYS: intField(365, 1),
  // Per-token (or per-IP, before a token resolves) request budget — see
  // src/lib/api-tokens/rate-limit.ts. Never applied to session-cookie requests.
  API_RATE_LIMIT_PER_MINUTE: intField(60, 1),

  // Gates POST /api/mcp entirely (404 when off) — see src/app/api/mcp/route.ts. A separate
  // flag from API_EXTERNAL_ENABLED: an operator may want the REST API open but not hand an
  // LLM tool access, or vice versa.
  MCP_ENABLED: boolField(false),
  // Gates the 3 write tools (create_transfer, approve_transfer, create_project) on
  // top of MCP_ENABLED — an operator can expose the read-only tools to an LLM without letting
  // it act. Never implies MCP_ENABLED on its own.
  MCP_WRITE_TOOLS_ENABLED: boolField(false),

  // --- custom CA (beta) ---
  // Gates the per-connection private CA on registries and upstream sources — see
  // docs/plan-custom-ca-beta.md. Off by default: an install that never sets it behaves
  // exactly as before. Turning it *off* again keeps the CAs already stored but refuses any
  // new run that depends on one, with an explicit error rather than a silent fall back to
  // unverified TLS. Already-installed CronJobs tick on their own and must be suspended
  // first — the chart NOTES say so.
  CUSTOM_CA_BETA_ENABLED: boolField(false),
  BUILDS_BETA_ENABLED: boolField(false),
  BUILDS_RUNNER_IMAGE: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/).optional(),
  BUILDS_NAMESPACE: z.string().optional(),
  BUILDS_SERVICE_ACCOUNT: z.string().default("tessark-build-runner"),
  BUILDS_POLL_SECONDS: intField(15, 5),
  BUILDS_DEADLINE_SECONDS: intField(1800, 30),
  BUILDS_JOB_TTL_SECONDS: intField(604800, 300),
  BUILDS_RETENTION_DAYS: intField(90, 1),
  BUILDS_CPU_REQUEST: z.string().default("500m"),
  BUILDS_CPU_LIMIT: z.string().default("2"),
  BUILDS_MEMORY_REQUEST: z.string().default("512Mi"),
  BUILDS_MEMORY_LIMIT: z.string().default("2Gi"),
  BUILDS_STORAGE_LIMIT: z.string().default("10Gi"),
  BUILDS_NODE_SELECTOR: jsonObjectField("{}"),
  BUILDS_TOLERATIONS: jsonArrayField("[]"),
  BUILDS_IMAGE_PULL_SECRETS: jsonArrayField("[]"),


  // --- notifications ---
  // The in-app centre (header bell) is always on: it costs one indexed table and no outbound
  // traffic. Only the outgoing webhook is opt-in, and an empty URL is what disables it —
  // there is no separate NOTIFICATIONS_ENABLED flag to keep in sync with it.
  NOTIFICATIONS_WEBHOOK_URL: z
    .string()
    .url("must be an http(s) URL")
    .optional(),
  // How the body is shaped. "slack" fits Slack and any Mattermost/Discord endpoint that
  // accepts { text }; "teams" emits a MessageCard; "json" posts the event verbatim, for an
  // operator piping it into something of their own.
  NOTIFICATIONS_WEBHOOK_FORMAT: z.enum(["json", "slack", "teams"]).default("json"),
  // The POST is awaited inside the request handler that triggered it, so this bounds how long
  // an unreachable endpoint can delay an approval — keep it short.
  NOTIFICATIONS_WEBHOOK_TIMEOUT_MS: intField(5000, 500),
  // Read notifications older than this are swept when their owner marks the list read —
  // see markAllRead(). Unread ones are never deleted: nobody has seen them yet.
  NOTIFICATION_RETENTION_DAYS: intField(30, 1),
})

// Cross-field rules, kept off `envSchema` itself so `.shape` stays available to
// CONFIG_ENV_KEYS and source() below. Both catch configurations that parse field by field
// but lock every user out — the kind of mistake that must stop the pod at boot rather than
// surface as an unusable login page (CLAUDE.md §0.5).
const runtimeSchema = envSchema.superRefine((v, ctx) => {
  if (v.OIDC_ENABLED) {
    if (!v.OIDC_ISSUER) {
      ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER"], message: "is required when OIDC_ENABLED is true" })
    }
    if (!v.OIDC_CLIENT_ID) {
      ctx.addIssue({ code: "custom", path: ["OIDC_CLIENT_ID"], message: "is required when OIDC_ENABLED is true" })
    }
    // Failure mode n°1 of a Dex integration (docs/plan-ldap-sso-local.md, lot 5). Dex only puts
    // a `groups` claim in the token when the `groups` scope is requested. Without it nothing
    // fails: every sign-in simply matches no mapping, and since the mapping is re-applied at
    // each sign-in, every user — administrators included — is quietly moved to
    // OIDC_DEFAULT_ROLE. A claim at another path is left alone: which scope carries it is the
    // provider's business, and guessing would refuse valid configurations.
    const scopes = v.OIDC_SCOPES.split(/\s+/).filter(Boolean)
    if (
      Object.keys(v.OIDC_ROLE_MAPPING).length > 0 &&
      v.OIDC_ROLE_CLAIM === "groups" &&
      !scopes.includes("groups")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_SCOPES"],
        message:
          'must include "groups" when OIDC_ROLE_MAPPING is set and OIDC_ROLE_CLAIM is "groups" — without that scope Dex emits no groups claim and every user silently falls back to OIDC_DEFAULT_ROLE',
      })
    }
  } else if (!v.OIDC_ALLOW_LOCAL_LOGIN) {
    ctx.addIssue({
      code: "custom",
      path: ["OIDC_ALLOW_LOCAL_LOGIN"],
      message: "cannot be false while OIDC_ENABLED is false — that would leave no way to sign in",
    })
  }
})

// Documents the exact variable set .env.example must mirror — see scripts/check-env-example.ts.
export const CONFIG_ENV_KEYS = Object.keys(envSchema.shape)

type ParsedEnv = z.infer<typeof envSchema>

function toConfig(v: ParsedEnv) {
  return {
    databaseUrl: v.DATABASE_URL,
    authSecret: v.AUTH_SECRET,
    gatewaySecretKey: v.GATEWAY_SECRET_KEY,
    adminUsername: v.GATEWAY_ADMIN_USERNAME,
    adminPassword: v.GATEWAY_ADMIN_PASSWORD,
    seedUsers: v.GATEWAY_SEED_USERS,
    seedSources: v.GATEWAY_SEED_SOURCES,

    authUrl: v.AUTH_URL,
    authTrustHost: v.AUTH_TRUST_HOST,
    k8sEnabled: v.K8S_ENABLED,
    k8sNamespace: v.K8S_NAMESPACE,
    k8sHttpTimeoutMs: v.K8S_HTTP_TIMEOUT_MS,
    skopeoImage: v.SKOPEO_IMAGE,
    skopeoJobTtlSeconds: v.SKOPEO_JOB_TTL_SECONDS,
    skopeoJobBackoffLimit: v.SKOPEO_JOB_BACKOFF_LIMIT,
    skopeoJobActiveDeadlineSeconds: v.SKOPEO_JOB_ACTIVE_DEADLINE_SECONDS,
    skopeoCpuRequest: v.SKOPEO_CPU_REQUEST,
    skopeoCpuLimit: v.SKOPEO_CPU_LIMIT,
    skopeoMemoryRequest: v.SKOPEO_MEMORY_REQUEST,
    skopeoMemoryLimit: v.SKOPEO_MEMORY_LIMIT,
    skopeoNodeSelector: v.SKOPEO_NODE_SELECTOR,
    skopeoTolerations: v.SKOPEO_TOLERATIONS,
    skopeoImagePullSecrets: v.SKOPEO_IMAGE_PULL_SECRETS,
    skopeoServiceAccount: v.SKOPEO_SERVICE_ACCOUNT,
    replicationWorkerEnabled: v.REPLICATION_WORKER_ENABLED,
    replicationPollSeconds: v.REPLICATION_POLL_SECONDS,
    replicationVerifySeconds: v.REPLICATION_VERIFY_SECONDS,
    replicationCatchupSeconds: v.REPLICATION_CATCHUP_SECONDS,
    systemRobotEnabled: v.SYSTEM_ROBOT_ENABLED,
    systemRobotName: v.SYSTEM_ROBOT_NAME,
    harborHttpTimeoutMs: v.HARBOR_HTTP_TIMEOUT_MS,
    registryCheckTimeoutMs: v.REGISTRY_CHECK_TIMEOUT_MS,
    defaultBrandName: v.DEFAULT_BRAND_NAME,
    defaultBrandTagline: v.DEFAULT_BRAND_TAGLINE,
    defaultPrimaryColor: v.DEFAULT_PRIMARY_COLOR,
    defaultLogoUrl: v.DEFAULT_LOGO_URL,
    logoMaxBytes: v.LOGO_MAX_BYTES,
    avatarMaxBytes: v.AVATAR_MAX_BYTES,
    logLevel: v.LOG_LEVEL,
    defaultLocale: v.DEFAULT_LOCALE,
    oidcEnabled: v.OIDC_ENABLED,
    oidcIssuer: v.OIDC_ISSUER,
    oidcClientId: v.OIDC_CLIENT_ID,
    oidcClientSecret: v.OIDC_CLIENT_SECRET,
    oidcScopes: v.OIDC_SCOPES,
    oidcDisplayName: v.OIDC_DISPLAY_NAME,
    oidcAllowLocalLogin: v.OIDC_ALLOW_LOCAL_LOGIN,
    oidcAllowSignup: v.OIDC_ALLOW_SIGNUP,
    oidcLinkByEmail: v.OIDC_LINK_BY_EMAIL,
    oidcRoleClaim: v.OIDC_ROLE_CLAIM,
    oidcRoleMapping: v.OIDC_ROLE_MAPPING as Record<string, Role>,
    oidcDefaultRole: v.OIDC_DEFAULT_ROLE,
    oidcLogoutMode: v.OIDC_LOGOUT_MODE,
    authSessionRefreshSeconds: v.AUTH_SESSION_REFRESH_SECONDS,
    apiExternalEnabled: v.API_EXTERNAL_ENABLED,
    apiTokenMaxTtlDays: v.API_TOKEN_MAX_TTL_DAYS,
    apiRateLimitPerMinute: v.API_RATE_LIMIT_PER_MINUTE,
    mcpEnabled: v.MCP_ENABLED,
    mcpWriteToolsEnabled: v.MCP_WRITE_TOOLS_ENABLED,
    customCaBetaEnabled: v.CUSTOM_CA_BETA_ENABLED,
    buildsImagePullSecrets: v.BUILDS_IMAGE_PULL_SECRETS,
    buildsTolerations: v.BUILDS_TOLERATIONS,
    buildsNodeSelector: v.BUILDS_NODE_SELECTOR,
    buildsStorageLimit: v.BUILDS_STORAGE_LIMIT,
    buildsMemoryLimit: v.BUILDS_MEMORY_LIMIT,
    buildsMemoryRequest: v.BUILDS_MEMORY_REQUEST,
    buildsCpuLimit: v.BUILDS_CPU_LIMIT,
    buildsCpuRequest: v.BUILDS_CPU_REQUEST,
    buildsRetentionDays: v.BUILDS_RETENTION_DAYS,
    buildsJobTtlSeconds: v.BUILDS_JOB_TTL_SECONDS,
    buildsDeadlineSeconds: v.BUILDS_DEADLINE_SECONDS,
    buildsPollSeconds: v.BUILDS_POLL_SECONDS,
    buildsServiceAccount: v.BUILDS_SERVICE_ACCOUNT,
    buildsNamespace: v.BUILDS_NAMESPACE,
    buildsRunnerImage: v.BUILDS_RUNNER_IMAGE,
    buildsBetaEnabled: v.BUILDS_BETA_ENABLED,
    notificationsWebhookUrl: v.NOTIFICATIONS_WEBHOOK_URL,
    notificationsWebhookFormat: v.NOTIFICATIONS_WEBHOOK_FORMAT,
    notificationsWebhookTimeoutMs: v.NOTIFICATIONS_WEBHOOK_TIMEOUT_MS,
    notificationRetentionDays: v.NOTIFICATION_RETENTION_DAYS,
  }
}

export type Config = ReturnType<typeof toConfig>

function source(): Record<keyof ParsedEnv, string | undefined> {
  const keys = Object.keys(envSchema.shape) as (keyof ParsedEnv)[]
  return Object.fromEntries(keys.map((key) => [key, readEnv(key)])) as Record<
    keyof ParsedEnv,
    string | undefined
  >
}

// One line per faulty variable, naming it — never its value, even for a "too short" secret.
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
}

/**
 * The problems a set of raw variables would stop the pod on, one line per variable and never a
 * value. For tests and tooling: the application itself only ever goes through getConfig().
 */
export function configIssues(values: Partial<Record<string, string | undefined>>): string[] {
  const parsed = runtimeSchema.safeParse(values)
  return parsed.success ? [] : formatIssues(parsed.error).split("\n")
}

let cached: Config | null = null

export function getConfig(): Config {
  if (cached) return cached
  const parsed = runtimeSchema.safeParse(source())
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${formatIssues(parsed.error)}`)
  }
  cached = Object.freeze(toConfig(parsed.data))
  return cached
}

/** Called by the startup readiness check — fails fast and clearly on bad config. */
export function assertRuntimeConfig(): void {
  getConfig()
}

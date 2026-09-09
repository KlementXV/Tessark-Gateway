import { z } from "zod"
import { isValidSchedule } from "@/lib/mirrors/cron"

const path = z.string().min(1).max(255).refine((v) => v === "." || /^(?:[\w.-]+\/)*[\w.-]+$/.test(v) && !v.split("/").some((p) => p === ".." || p === "."), "Expected a relative path inside the context")
const gitUrl = z.string().max(2048).refine((value) => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search } catch { return false }
}, "Expected an HTTPS Git URL without credentials, query or fragment")
export const buildInputSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/),
  description: z.string().max(500).default(""),
  projectId: z.string().min(1),
  targetRepo: z.string().min(1).max(200).regex(/^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/),
  tag: z.string().min(1).max(128).regex(/^[\w][\w.-]*$/).default("latest"),
  sourceKind: z.enum(["inline", "git"]),
  dockerfileContent: z.string().max(65536).default(""),
  gitUrl: z.union([gitUrl, z.literal("")]).default(""),
  gitRef: z.string().max(255).regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9_./-]*)?$/).default(""),
  contextPath: path.default("."),
  dockerfilePath: path.default("Dockerfile"),
  buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(2048)).refine((v) => Object.keys(v).length <= 32).default({}),
  schedule: z.string().max(128).transform((v) => v.trim().replace(/\s+/g, " ")).refine(isValidSchedule, "Expected a valid 5-field cron in UTC"),
  enabled: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (v.sourceKind === "inline" && (!v.dockerfileContent.trim() || v.gitUrl || v.gitRef)) ctx.addIssue({ code: "custom", path: ["dockerfileContent"], message: "Provide only an inline Dockerfile" })
  if (v.sourceKind === "git" && (!v.gitUrl || !v.gitRef || v.dockerfileContent)) ctx.addIssue({ code: "custom", path: ["gitUrl"], message: "Provide a Git URL and ref, without an inline Dockerfile" })
  if (v.gitRef.includes("..") || v.gitRef.endsWith("/") || v.gitRef.includes("//")) ctx.addIssue({ code: "custom", path: ["gitRef"], message: "Invalid Git ref" })
})
export type BuildInput = z.infer<typeof buildInputSchema>
export const buildToggleSchema = z.object({ enabled: z.boolean() }).strict()

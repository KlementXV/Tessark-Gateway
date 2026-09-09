// Declarative source of truth for /api/openapi.json (see document.ts) and, by extension,
// /api/docs. One entry per REST route actually reachable via authenticateRequest — i.e. every
// route under src/app/api/* except /api/auth/[...nextauth] (NextAuth's own catch-all, not part
// of this API's surface) and /api/openapi.json / /api/docs themselves.
//
// requestSchema is intentionally left out for a few routes (registries/check, sources/check,
// clusters/[id]/reconcile, transfers/[id]/sync) whose body schema — where one exists at all — is
// declared inline in the route file rather than exported from a lib/*/schema.ts: documenting
// them precisely isn't worth exporting a schema a route otherwise has no reason to share.
import { buildInputSchema } from "@/lib/builds/schema"
import { z } from "zod"

import { apiTokenCreateInputSchema } from "@/lib/api-tokens/schema"
import {
  clusterIdentityInputSchema,
  clusterInputSchema,
  clusterMemberInputSchema,
} from "@/lib/clusters/schema"
import {
  groupAddInputSchema,
  memberAddInputSchema,
  projectCreateInputSchema,
  projectDeleteRequestInputSchema,
  projectRejectInputSchema,
  quotaRequestInputSchema,
  quotaUpdateInputSchema,
  retentionUpdateInputSchema,
  robotCreateInputSchema,
  robotSecretRotateInputSchema,
} from "@/lib/projects/schema"
import { mirrorCreateInputSchema, mirrorUpdateInputSchema } from "@/lib/mirrors/schema"
import { transferRuleInputSchema, transferRuleUpdateInputSchema } from "@/lib/transfers/rule-schema"
import {
  transferRequestBatchInputSchema,
  transferRequestCreateInputSchema,
} from "@/lib/transfers/schema"
import { registryInputSchema, registryUpdateInputSchema } from "@/lib/registries/schema"
import { instanceSettingsInputSchema, loginContentInputSchema } from "@/lib/settings/schema"
import { sourceInputSchema, sourceUpdateInputSchema } from "@/lib/sources/schema"
import {
  passwordChangeInputSchema,
  profileUpdateInputSchema,
  userCreateInputSchema,
  userUpdateInputSchema,
} from "@/lib/users/schema"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

// "public" = no auth at all; "user"/"admin"/"superadmin" = the Role rank authenticateRequest
// must clear. A handful of routes additionally gate on resource-scoped access (project
// membership/management) that a global role can't express — noted in `summary` instead.
export type MinRole = "public" | "user" | "admin" | "superadmin"

export interface RouteSpec {
  method: HttpMethod
  /** OpenAPI-style path, e.g. "/clusters/{id}" — not the Next.js "[id]" folder spelling. */
  path: string
  tags: string[]
  summary: string
  minRole: MinRole
  requestSchema?: z.ZodType
}

export const ROUTES: RouteSpec[] = [
  { method: "GET", path: "/builds", tags: ["builds"], summary: "List scheduled builds in the token project scope", minRole: "admin" },
  { method: "POST", path: "/builds", tags: ["builds"], summary: "Create and apply a scheduled Buildah build (beta)", minRole: "admin", requestSchema: buildInputSchema },
  { method: "GET", path: "/builds/{id}", tags: ["builds"], summary: "Get a build definition", minRole: "admin" },
  { method: "PATCH", path: "/builds/{id}", tags: ["builds"], summary: "Replace build configuration, or pause with enabled false", minRole: "admin" },
  { method: "DELETE", path: "/builds/{id}", tags: ["builds"], summary: "Stop runs and request build cleanup", minRole: "admin" },
  { method: "POST", path: "/builds/{id}/apply", tags: ["builds"], summary: "Apply the build with current credentials", minRole: "admin" },
  { method: "POST", path: "/builds/{id}/run", tags: ["builds"], summary: "Queue a manual build (202)", minRole: "admin" },
  { method: "GET", path: "/builds/{id}/runs", tags: ["builds"], summary: "List paginated build runs (?page=0)", minRole: "admin" },
  { method: "GET", path: "/builds/{id}/runs/{runId}/logs", tags: ["builds"], summary: "Read build or preparation logs (?container=build|claim)", minRole: "admin" },
  // --- system ---
  { method: "GET", path: "/health", tags: ["system"], summary: "Liveness probe", minRole: "public" },
  { method: "GET", path: "/ready", tags: ["system"], summary: "Readiness probe (config + database)", minRole: "public" },

  // --- clusters ---
  { method: "GET", path: "/clusters", tags: ["clusters"], summary: "List clusters with health", minRole: "admin" },
  {
    method: "POST",
    path: "/clusters",
    tags: ["clusters"],
    summary: "Create a cluster",
    minRole: "admin",
    requestSchema: clusterInputSchema,
  },
  { method: "GET", path: "/clusters/{id}", tags: ["clusters"], summary: "Get cluster detail", minRole: "admin" },
  {
    method: "PUT",
    path: "/clusters/{id}",
    tags: ["clusters"],
    summary: "Update a cluster",
    minRole: "admin",
    requestSchema: clusterInputSchema,
  },
  { method: "DELETE", path: "/clusters/{id}", tags: ["clusters"], summary: "Delete a cluster", minRole: "admin" },
  {
    method: "POST",
    path: "/clusters/{id}/members",
    tags: ["clusters"],
    summary: "Add a member registry to a cluster",
    minRole: "admin",
    requestSchema: clusterMemberInputSchema,
  },
  {
    method: "DELETE",
    path: "/clusters/{id}/members",
    tags: ["clusters"],
    summary: "Remove a member registry from a cluster",
    minRole: "admin",
  },
  {
    method: "GET",
    path: "/clusters/{id}/identities",
    tags: ["clusters"],
    summary: "List the cluster's directory mappings (add ?verify=1 to check them against Harbor)",
    minRole: "admin",
  },
  {
    method: "PUT",
    path: "/clusters/{id}/identities",
    tags: ["clusters"],
    summary: "Map a user to an account in the cluster's directory, moving their grants",
    minRole: "admin",
    requestSchema: clusterIdentityInputSchema,
  },
  {
    method: "DELETE",
    path: "/clusters/{id}/identities/{userId}",
    tags: ["clusters"],
    summary: "Remove a directory mapping and revoke the grants it produced",
    minRole: "admin",
  },
  {
    method: "GET",
    path: "/clusters/{id}/directory",
    tags: ["clusters"],
    summary: "Search the cluster's own user directory through one of its Harbors",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/clusters/{id}/reconcile",
    tags: ["clusters"],
    summary: "Force reconciliation and replay the replication mesh",
    minRole: "admin",
  },

  // --- projects ---
  { method: "GET", path: "/projects", tags: ["projects"], summary: "List projects visible to the caller", minRole: "user" },
  {
    method: "POST",
    path: "/projects",
    tags: ["projects"],
    summary: "Create a project",
    minRole: "user",
    requestSchema: projectCreateInputSchema,
  },
  { method: "GET", path: "/projects/{id}", tags: ["projects"], summary: "Get project detail", minRole: "user" },
  {
    method: "DELETE",
    path: "/projects/{id}",
    tags: ["projects"],
    summary: "Delete a project (owner, project admin, or ADMIN+)",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/projects/{id}/approve",
    tags: ["projects"],
    summary: "Approve a project pending creation",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/projects/{id}/reject",
    tags: ["projects"],
    summary: "Reject a project pending creation",
    minRole: "admin",
    requestSchema: projectRejectInputSchema,
  },
  { method: "GET", path: "/projects/{id}/images", tags: ["projects"], summary: "List images in a project", minRole: "user" },
  {
    method: "DELETE",
    path: "/projects/{id}/images",
    tags: ["projects"],
    summary:
      "Delete one artifact (`?repo=&digest=`) or a whole repository (`?repo=`) from every Harbor " +
      "of the project's cluster. Write access to the project: owner, a member above GUEST, or " +
      "ADMIN+. Only a digest is accepted — a tag would take every other tag of that artifact " +
      "with it.",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/projects/{id}/delete-requests",
    tags: ["projects"],
    summary: "Ask an admin to delete this project (anyone who can see it)",
    minRole: "user",
    requestSchema: projectDeleteRequestInputSchema,
  },
  {
    method: "GET",
    path: "/projects/{id}/quota",
    tags: ["projects"],
    summary: "Read live storage quota usage across the cluster",
    minRole: "user",
  },
  {
    method: "PUT",
    path: "/projects/{id}/quota",
    tags: ["projects"],
    summary: "Set the project's storage quota",
    minRole: "admin",
    requestSchema: quotaUpdateInputSchema,
  },
  {
    method: "POST",
    path: "/projects/{id}/quota/requests",
    tags: ["projects"],
    summary: "Ask an admin for a different storage quota (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: quotaRequestInputSchema,
  },
  {
    method: "PUT",
    path: "/projects/{id}/retention",
    tags: ["projects"],
    summary: "Set the project's retention policy (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: retentionUpdateInputSchema,
  },
  {
    method: "POST",
    path: "/projects/{id}/members",
    tags: ["projects"],
    summary: "Add a project member (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: memberAddInputSchema,
  },
  {
    method: "DELETE",
    path: "/projects/{id}/members/{userId}",
    tags: ["projects"],
    summary: "Remove a project member (owner, project admin, or ADMIN+)",
    minRole: "user",
  },
  {
    method: "GET",
    path: "/projects/{id}/groups/search",
    tags: ["projects"],
    summary: "List the directory groups the project's cluster knows (owner, project admin, or ADMIN+)",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/projects/{id}/groups",
    tags: ["projects"],
    summary: "Grant a directory group a role on the project (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: groupAddInputSchema,
  },
  {
    method: "DELETE",
    path: "/projects/{id}/groups/{groupName}",
    tags: ["projects"],
    summary: "Revoke a directory group's access (owner, project admin, or ADMIN+)",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/projects/{id}/robots",
    tags: ["projects"],
    summary: "Create a robot account (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: robotCreateInputSchema,
  },
  {
    method: "PATCH",
    path: "/projects/{id}/robots/{robotId}",
    tags: ["projects"],
    summary: "Rotate a robot account's secret (owner, project admin, or ADMIN+)",
    minRole: "user",
    requestSchema: robotSecretRotateInputSchema,
  },
  {
    method: "DELETE",
    path: "/projects/{id}/robots/{robotId}",
    tags: ["projects"],
    summary: "Delete a robot account (owner, project admin, or ADMIN+)",
    minRole: "user",
  },

  // --- notifications ---
  {
    method: "GET",
    path: "/notifications",
    tags: ["notifications"],
    summary: "List the caller's own notifications with the unread count",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/notifications/read",
    tags: ["notifications"],
    summary: "Mark one notification read, or all of the caller's when no id is given",
    minRole: "user",
  },

  // --- quota requests ---
  {
    method: "POST",
    path: "/quota-requests/{id}/approve",
    tags: ["projects"],
    summary: "Approve a quota request and apply it across the cluster",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/quota-requests/{id}/reject",
    tags: ["projects"],
    summary: "Reject a quota request",
    minRole: "admin",
    requestSchema: projectRejectInputSchema,
  },

  // --- project deletion requests ---
  {
    method: "POST",
    path: "/project-delete-requests/{id}/approve",
    tags: ["projects"],
    summary:
      "Approve a deletion request and delete the project across its cluster. Refused, like the " +
      "direct delete, while the project still holds repositories.",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/project-delete-requests/{id}/reject",
    tags: ["projects"],
    summary: "Reject a project deletion request",
    minRole: "admin",
    requestSchema: projectRejectInputSchema,
  },

  // --- transfers ---
  {
    method: "POST",
    path: "/transfers",
    tags: ["transfers"],
    summary:
      "Create a transfer request to mirror an image into one or more destinations. " +
      "Send `images` instead of `repo`/`tag` to raise one request per image in a single call; " +
      "that form answers { started, failed } with an entry per image, since one can be refused " +
      "without the others being. Each entry of `images` may carry its own source " +
      "(`sourceId`, or `sourceRegistryId` + `sourceProjectName`); one that carries none uses the " +
      "source named at the top level, so a single call can pull from several registries.",
    minRole: "user",
    // A union rather than a second entry on the same method+path, which OpenAPI cannot express
    // and which this document would silently collapse into whichever came last.
    requestSchema: z.union([transferRequestCreateInputSchema, transferRequestBatchInputSchema]),
  },
  {
    method: "POST",
    path: "/transfers/{id}/approve",
    tags: ["transfers"],
    summary: "Approve a transfer request and launch its skopeo Jobs",
    minRole: "admin",
  },
  { method: "POST", path: "/transfers/{id}/reject", tags: ["transfers"], summary: "Reject a transfer request", minRole: "admin" },
  {
    method: "POST",
    path: "/transfers/{id}/sync",
    tags: ["transfers"],
    summary: "Refresh a transfer request's status from Kubernetes",
    minRole: "user",
  },

  // --- transfer rules ---
  {
    method: "GET",
    path: "/transfer-rules",
    tags: ["transfers"],
    summary: "List the rules that decide which transfers are allowed",
    minRole: "superadmin",
  },
  {
    method: "POST",
    path: "/transfer-rules",
    tags: ["transfers"],
    summary: "Open a transfer direction",
    minRole: "superadmin",
    requestSchema: transferRuleInputSchema,
  },
  {
    method: "PATCH",
    path: "/transfer-rules/{id}",
    tags: ["transfers"],
    summary: "Edit a transfer rule",
    minRole: "superadmin",
    requestSchema: transferRuleUpdateInputSchema,
  },
  {
    method: "DELETE",
    path: "/transfer-rules/{id}",
    tags: ["transfers"],
    summary: "Delete a transfer rule",
    minRole: "superadmin",
  },

  // --- scheduled mirrors ---
  {
    method: "GET",
    path: "/mirrors",
    tags: ["mirrors"],
    summary: "List scheduled mirrors",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/mirrors",
    tags: ["mirrors"],
    summary: "Schedule a recurring mirror and install it on its transport",
    minRole: "admin",
    requestSchema: mirrorCreateInputSchema,
  },
  {
    method: "PATCH",
    path: "/mirrors/{id}",
    tags: ["mirrors"],
    summary: "Edit a mirror's schedule, tag or enabled state, then re-install it",
    minRole: "admin",
    requestSchema: mirrorUpdateInputSchema,
  },
  {
    method: "DELETE",
    path: "/mirrors/{id}",
    tags: ["mirrors"],
    summary: "Delete a mirror and the policy or CronJob behind it",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/mirrors/{id}/apply",
    tags: ["mirrors"],
    summary: "Re-install a mirror on its transport",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/mirrors/{id}/run",
    tags: ["mirrors"],
    summary: "Run a mirror now instead of at its next tick",
    minRole: "admin",
  },

  // --- registries ---
  { method: "GET", path: "/registries", tags: ["registries"], summary: "List registries with health", minRole: "admin" },
  {
    method: "POST",
    path: "/registries",
    tags: ["registries"],
    summary: "Add a registry",
    minRole: "admin",
    requestSchema: registryInputSchema,
  },
  { method: "GET", path: "/registries/{id}", tags: ["registries"], summary: "Get registry detail", minRole: "admin" },
  {
    method: "PATCH",
    path: "/registries/{id}",
    tags: ["registries"],
    summary: "Update a registry",
    minRole: "admin",
    requestSchema: registryUpdateInputSchema,
  },
  { method: "DELETE", path: "/registries/{id}", tags: ["registries"], summary: "Delete a registry", minRole: "admin" },
  { method: "POST", path: "/registries/check", tags: ["registries"], summary: "Test a registry connection", minRole: "admin" },
  {
    method: "GET",
    path: "/registries/{id}/catalog",
    tags: ["registries"],
    summary: "List repositories in a registry",
    minRole: "admin",
  },
  {
    method: "GET",
    path: "/registries/{id}/tags",
    tags: ["registries"],
    summary: "List tags for a repository",
    minRole: "admin",
  },
  {
    method: "GET",
    path: "/registries/{id}/manifest",
    tags: ["registries"],
    summary: "Get an artifact manifest",
    minRole: "admin",
  },
  {
    method: "DELETE",
    path: "/registries/{id}/manifest",
    tags: ["registries"],
    summary: "Delete an artifact manifest",
    minRole: "admin",
  },
  {
    method: "POST",
    path: "/registries/{id}/system-robot",
    tags: ["registries"],
    summary: "Provision or rotate the Gateway push robot on a registry",
    minRole: "admin",
  },
  {
    method: "DELETE",
    path: "/registries/{id}/system-robot",
    tags: ["registries"],
    summary: "Forget the stored Gateway push robot credential",
    minRole: "admin",
  },
  {
    method: "GET",
    path: "/registries/{id}/health",
    tags: ["registries"],
    summary: "Check a single registry's health",
    minRole: "admin",
  },

  // --- sources ---
  { method: "GET", path: "/sources", tags: ["sources"], summary: "List upstream sources", minRole: "user" },
  {
    method: "POST",
    path: "/sources",
    tags: ["sources"],
    summary: "Add an upstream source",
    minRole: "admin",
    requestSchema: sourceInputSchema,
  },
  {
    method: "PATCH",
    path: "/sources/{id}",
    tags: ["sources"],
    summary: "Update an upstream source",
    minRole: "admin",
    requestSchema: sourceUpdateInputSchema,
  },
  { method: "DELETE", path: "/sources/{id}", tags: ["sources"], summary: "Delete an upstream source", minRole: "admin" },
  {
    method: "POST",
    path: "/sources/check",
    tags: ["sources"],
    summary: "Test an upstream source connection",
    minRole: "admin",
  },

  // --- users ---
  { method: "GET", path: "/users", tags: ["users"], summary: "List users", minRole: "superadmin" },
  {
    method: "POST",
    path: "/users",
    tags: ["users"],
    summary: "Create a user",
    minRole: "superadmin",
    requestSchema: userCreateInputSchema,
  },
  {
    method: "PATCH",
    path: "/users/{id}",
    tags: ["users"],
    summary: "Update a user",
    minRole: "superadmin",
    requestSchema: userUpdateInputSchema,
  },
  { method: "DELETE", path: "/users/{id}", tags: ["users"], summary: "Delete a user", minRole: "superadmin" },
  {
    method: "GET",
    path: "/users/directory",
    tags: ["users"],
    summary: "List users for picking (id/name only, no management fields)",
    minRole: "user",
  },
  { method: "GET", path: "/users/me", tags: ["users"], summary: "Get the caller's own profile", minRole: "user" },
  {
    method: "PATCH",
    path: "/users/me",
    tags: ["users"],
    summary: "Update the caller's own profile",
    minRole: "user",
    requestSchema: profileUpdateInputSchema,
  },
  {
    method: "POST",
    path: "/users/me/password",
    tags: ["users"],
    summary: "Change the caller's own password",
    minRole: "user",
    requestSchema: passwordChangeInputSchema,
  },
  {
    method: "GET",
    path: "/users/{id}/avatar",
    tags: ["users"],
    summary: "Get a user's avatar image",
    minRole: "user",
  },
  {
    method: "POST",
    path: "/users/{id}/avatar",
    tags: ["users"],
    summary: "Upload a user's avatar image (self, or SUPERADMIN)",
    minRole: "user",
  },
  {
    method: "DELETE",
    path: "/users/{id}/avatar",
    tags: ["users"],
    summary: "Remove a user's avatar image (self, or SUPERADMIN)",
    minRole: "user",
  },

  // --- settings ---
  { method: "GET", path: "/settings/branding", tags: ["settings"], summary: "Get instance branding", minRole: "public" },
  {
    method: "PATCH",
    path: "/settings/branding",
    tags: ["settings"],
    summary: "Update instance branding",
    minRole: "superadmin",
    requestSchema: instanceSettingsInputSchema,
  },
  {
    method: "GET",
    path: "/settings/branding/logo",
    tags: ["settings"],
    summary: "Get the instance logo image",
    minRole: "public",
  },
  {
    method: "POST",
    path: "/settings/branding/logo",
    tags: ["settings"],
    summary: "Upload the instance logo",
    minRole: "superadmin",
  },
  {
    method: "DELETE",
    path: "/settings/branding/logo",
    tags: ["settings"],
    summary: "Remove the instance logo",
    minRole: "superadmin",
  },
  { method: "GET", path: "/settings/login", tags: ["settings"], summary: "Get the login page copy", minRole: "public" },
  {
    method: "PATCH",
    path: "/settings/login",
    tags: ["settings"],
    summary: "Update the login page copy (null on a field restores the built-in text)",
    minRole: "superadmin",
    requestSchema: loginContentInputSchema,
  },

  // --- tokens ---
  { method: "GET", path: "/tokens", tags: ["tokens"], summary: "List the caller's own API tokens", minRole: "user" },
  {
    method: "POST",
    path: "/tokens",
    tags: ["tokens"],
    summary: "Create an API token (shows the secret once, in the response)",
    minRole: "user",
    requestSchema: apiTokenCreateInputSchema,
  },
  {
    method: "DELETE",
    path: "/tokens/{id}",
    tags: ["tokens"],
    summary: "Revoke an API token (own, or any if ADMIN+)",
    minRole: "user",
  },
]

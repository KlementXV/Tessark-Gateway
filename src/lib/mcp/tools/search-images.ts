import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { loadProjectForAccess } from "@/lib/projects/access"
import { listProjectImageArtifacts, listProjectImages } from "@/lib/projects/images"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Mirrors GET /api/projects/[id]/images: the project's own repositories, live from whichever
// Harbor in its cluster is in sync — not the registry-wide catalog (that one stays ADMIN-only,
// behind list_registries/the REST-only /api/registries/[id]/catalog).
export function registerSearchImagesTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "search_images",
    {
      title: "Search images",
      description:
        "List a project's repositories, or the artifacts (tags/digests) of one repository when `repo` is given.",
      inputSchema: { projectId: z.string().min(1), repo: z.string().min(1).optional() },
    },
    async ({ projectId, repo }) =>
      runTool("search_images", ctx, async () => {
        const { project } = await loadProjectForAccess(projectId, ctx.session)
        if (project.status !== "ACTIVE") throw new Error("Project is not active yet")

        if (repo) {
          const artifacts = await listProjectImageArtifacts(projectId, project.name, repo)
          return { repo, artifacts }
        }
        return listProjectImages(projectId, project.name)
      }),
  )
}

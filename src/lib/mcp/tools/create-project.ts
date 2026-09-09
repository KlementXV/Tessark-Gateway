import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { Role } from "@/generated/prisma/client"
import { AuthError, hasRole } from "@/lib/auth/guard"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"
import { prisma } from "@/lib/prisma"
import { ProjectActivationError, activateProject } from "@/lib/projects/activate"
import { projectCreateInputSchema } from "@/lib/projects/schema"

// Mirrors POST /api/projects: the destination cluster must have at least one Harbor member,
// then the row is written and — for an ADMIN+ caller, same reviewer-exists rule as pulls —
// activated across the cluster right away instead of waiting in the review queue.
export function registerCreateProjectTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Request a new project on a cluster. Activated immediately if the caller's Role is ADMIN+; " +
        "otherwise it waits in the review queue.",
      inputSchema: projectCreateInputSchema.shape,
    },
    async (input) =>
      runTool(
        "create_project",
        ctx,
        async () => {
          const cluster = await prisma.cluster.findUnique({
            where: { id: input.clusterId },
            include: { _count: { select: { registries: true } } },
          })
          if (!cluster) throw new AuthError("Cluster not found", 404)
          if (cluster._count.registries === 0) {
            throw new AuthError("This cluster has no Harbor members yet — add one before requesting a project.", 400)
          }

          let project
          try {
            project = await prisma.project.create({
              data: {
                name: input.name,
                description: input.description || null,
                clusterId: input.clusterId,
                isPublic: input.isPublic,
                ownerUserId: ctx.session.user.id,
              },
            })
          } catch (err) {
            if (err instanceof Error && err.message.includes("Unique constraint")) {
              throw new AuthError("A project with this name already exists on that cluster.", 409)
            }
            throw err
          }

          if (!hasRole(ctx.session, Role.ADMIN)) return project

          try {
            const { project: activated, placements } = await activateProject(project.id, ctx.session.user.id)
            return { ...activated, placements }
          } catch (err) {
            if (err instanceof ProjectActivationError) {
              return { ...project, activationError: `${err.message} — saved as a pending request; approve it to retry.` }
            }
            throw err
          }
        },
        (data) => (data as { id?: string } | null)?.id,
      ),
  )
}

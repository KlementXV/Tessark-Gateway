import { prisma } from "@/lib/prisma"
import { resolveConnection } from "./resolve"
import type { RegistryConnection } from "./types"

export async function loadConnection(id: string): Promise<RegistryConnection | null> {
  const registry = await prisma.registry.findUnique({ where: { id } })
  return registry ? resolveConnection(registry) : null
}

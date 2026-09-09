import { NextResponse } from "next/server"
import type { Session } from "next-auth"

import { authenticateRequest, authErrorResponse, hasRole, requireUser } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { searchImages, type ImageHit } from "@/lib/registries/image-search"

export interface SearchIndex {
  projects: { id: string; name: string; cluster: string }[]
  registries: { id: string; name: string; baseUrl: string; cluster: string | null }[]
  /** Repositories matching `?q=`. Empty unless a query long enough to be worth a Harbor call. */
  images: ImageHit[]
}

// Below this, a substring match returns most of the catalog and none of it is useful. It is
// also what keeps the palette from calling every Harbor on the first keystroke.
const MIN_IMAGE_QUERY = 2

// What the command palette jumps to. The index itself is deliberately cheap — names and ids
// only, no health checks — so it can be fetched on every open without making Ctrl+K feel slow.
//
// Images are the exception: they live in Harbor, not here, so they cannot be pre-indexed and
// are searched on demand through `?q=`. One call per cluster (its members mirror each other),
// only for clusters the user can see something in, and only past MIN_IMAGE_QUERY characters.
export async function GET(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const isAdmin = hasRole(session, Role.ADMIN)
  const [projects, registries] = await Promise.all([
    prisma.project.findMany({
      where: {
        status: "ACTIVE",
        ...(isAdmin
          ? {}
          : {
              OR: [
                { isPublic: true },
                { ownerUserId: session!.user.id },
                { members: { some: { userId: session!.user.id } } },
              ],
            }),
      },
      select: { id: true, name: true, clusterId: true, cluster: { select: { name: true } } },
      orderBy: { name: "asc" },
      take: 200,
    }),
    isAdmin
      ? prisma.registry.findMany({
          select: { id: true, name: true, baseUrl: true, cluster: { select: { name: true } } },
          orderBy: { name: "asc" },
          take: 200,
        })
      : Promise.resolve([]),
  ])

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? ""
  const images =
    query.length >= MIN_IMAGE_QUERY ? await searchImages(query, projects) : []

  const body: SearchIndex = {
    images,
    projects: projects.map((p) => ({ id: p.id, name: p.name, cluster: p.cluster.name })),
    registries: registries.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      cluster: r.cluster?.name ?? null,
    })),
  }
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } })
}


// Creating, editing and removing scheduled mirrors, and installing them on whichever
// transport they chose. Every write goes through here so that the row and the object it
// describes — a Harbor policy or a Kubernetes CronJob — never drift apart.
//
// A failed install is not a failed write: the row survives with `applied: false` and the
// reason on it. An unreachable Harbor at 9am should not cost an operator the definition they
// just typed; re-applying is one action, retyping is not.
import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/logger"
import { errorMessage } from "@/lib/clusters/fanout"
import {
  applyHarborMirror,
  MirrorTransportError,
  removeHarborMirror,
  runHarborMirrorNow,
} from "./harbor-transport"
import {
  applySkopeoMirror,
  removeSkopeoMirror,
  runSkopeoMirrorNow,
} from "./skopeo-transport"
import { mirrorInclude, toPublicMirror, type MirrorRow, type PublicMirror } from "./public"
import { validateMirror } from "./validate"
import type { MirrorCreateInput, MirrorUpdateInput } from "./schema"

export { MirrorTransportError }

async function loadMirror(id: string): Promise<MirrorRow> {
  const mirror = await prisma.scheduledMirror.findUnique({ where: { id }, include: mirrorInclude })
  if (!mirror) throw new MirrorTransportError("That mirror no longer exists.", 404)
  return mirror
}

// The transports need the *whole* upstream source, credentials included, which is exactly
// what mirrorInclude withholds so a DTO can never carry one by accident. Two loads rather
// than one wide include, so the shape that reaches the client stays incapable of leaking.
async function loadMirrorForTransport(id: string) {
  const mirror = await prisma.scheduledMirror.findUnique({
    where: { id },
    include: { source: true },
  })
  if (!mirror) throw new MirrorTransportError("That mirror no longer exists.", 404)
  return mirror
}

export async function listMirrors(): Promise<PublicMirror[]> {
  const mirrors = await prisma.scheduledMirror.findMany({
    include: mirrorInclude,
    orderBy: { name: "asc" },
  })
  return mirrors.map(toPublicMirror)
}

/**
 * Installs the mirror on its transport and records the outcome on the row.
 *
 * Never throws for a transport failure — the caller wants the mirror back either way, and the
 * reason belongs on the row where the page can show it. It throws only for a mirror that does
 * not exist, which is a different kind of wrong.
 */
export async function applyMirror(id: string): Promise<PublicMirror> {
  const mirror = await loadMirrorForTransport(id)

  try {
    if (mirror.transport === "harbor") {
      const applied = await applyHarborMirror(mirror)
      await prisma.scheduledMirror.update({
        where: { id },
        data: {
          harborRegistryId: applied.harborRegistryId,
          harborEndpointId: applied.harborEndpointId,
          harborPolicyId: applied.harborPolicyId,
          applied: true,
          lastAppliedAt: new Date(),
          lastError: null,
        },
      })
    } else {
      const applied = await applySkopeoMirror(mirror)
      await prisma.scheduledMirror.update({
        where: { id },
        data: {
          k8sCronJobName: applied.cronJobName,
          applied: true,
          lastAppliedAt: new Date(),
          lastError: null,
        },
      })
    }
    logger.info("Scheduled mirror applied", { mirrorId: id, transport: mirror.transport })
  } catch (err) {
    const error = errorMessage(err)
    logger.error("Scheduled mirror could not be applied", {
      mirrorId: id,
      transport: mirror.transport,
      error,
    })
    await prisma.scheduledMirror.update({
      where: { id },
      data: { applied: false, lastError: error },
    })
  }

  return toPublicMirror(await loadMirror(id))
}

export async function createMirror(
  input: MirrorCreateInput,
  createdByUserId: string,
): Promise<PublicMirror> {
  const validated = await validateMirror(input)

  const created = await prisma.scheduledMirror.create({
    data: {
      name: input.name,
      description: input.description || null,
      sourceId: validated.sourceId,
      sourceRegistryId: validated.sourceRegistryId,
      sourceProjectName: validated.sourceProjectName,
      sourceRepo: validated.sourceRepo,
      sourceTag: validated.sourceTag,
      projectId: validated.projectId,
      destRegistryId: validated.destRegistryId,
      destProjectName: validated.destProjectName,
      targetRepo: validated.targetRepo,
      schedule: input.schedule,
      transport: input.transport,
      enabled: input.enabled,
      createdByUserId,
    },
  })

  return applyMirror(created.id)
}

/**
 * Edits what can be edited — schedule, tag, description, on/off — and re-installs.
 *
 * The source and the destination are not editable: changing either makes it a different
 * mirror, and reusing the row would leave the transport object installed under a name that
 * now means something else. Delete and recreate is the honest path, and it is one action.
 */
export async function updateMirror(id: string, input: MirrorUpdateInput): Promise<PublicMirror> {
  await loadMirror(id)

  await prisma.scheduledMirror.update({
    where: { id },
    data: {
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.tag !== undefined ? { sourceTag: input.tag } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  })

  return applyMirror(id)
}

export async function deleteMirror(id: string): Promise<void> {
  const mirror = await loadMirror(id)

  if (mirror.transport === "harbor") {
    await removeHarborMirror(mirror)
  } else {
    await removeSkopeoMirror(mirror)
  }

  await prisma.scheduledMirror.delete({ where: { id } })
  logger.info("Scheduled mirror deleted", { mirrorId: id, transport: mirror.transport })
}

/** Runs the copy now, without waiting for the next tick. Throws what the transport refused. */
export async function runMirrorNow(id: string): Promise<void> {
  const mirror = await loadMirrorForTransport(id)

  if (mirror.transport === "harbor") {
    await runHarborMirrorNow(mirror)
  } else {
    await runSkopeoMirrorNow(mirror)
  }
  logger.info("Scheduled mirror run triggered", { mirrorId: id, transport: mirror.transport })
}

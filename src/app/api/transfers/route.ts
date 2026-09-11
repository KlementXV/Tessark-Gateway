import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, hasRole, requireUser } from "@/lib/auth/guard"
import type { Session } from "next-auth"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { TransferLaunchError, launchTransferRequest } from "@/lib/transfers/launch"
import {
  resolveImageSource,
  transferRequestBatchInputSchema,
  transferRequestCreateInputSchema,
  type TransferRequestBatchInput,
} from "@/lib/transfers/schema"
import { TransferValidationError, validateTransferRequest } from "@/lib/transfers/validate"
import { expandAllTags } from "@/lib/transfers/all-tags"
import { MAX_TRANSFER_TAGS } from "@/lib/transfers/repository-tags"
import { notify } from "@/lib/notifications/service"

// Creation lives here rather than under a project: a request can land in several destinations
// at once — and not all of them are projects the Gateway owns — so none of them owns it.
// Where it lands is in the body.
export async function POST(request: Request) {
  let session: Session | null
  try {
    session = await authenticateRequest(request)
    requireUser(session)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)

  // Two shapes on one endpoint, told apart by the field that is only in one of them. A list is
  // the same request repeated, so it must not be a second route with its own idea of what a
  // transfer is allowed to be.
  if (body && typeof body === "object" && Array.isArray((body as { images?: unknown }).images)) {
    return createBatch(body, session)
  }

  const parsed = transferRequestCreateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  if (parsed.data.allTags) {
    return createBatch({ ...parsed.data, images: [{ repo: parsed.data.repo, tag: parsed.data.tag }] }, session)
  }

  let validated
  try {
    validated = await validateTransferRequest(parsed.data, session)
  } catch (err) {
    if (err instanceof TransferValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const transferRequest = await prisma.transferRequest.create({
    data: {
      sourceId: validated.sourceId,
      sourceRegistryId: validated.sourceRegistryId,
      sourceProjectName: validated.sourceProjectName,
      sourceRepo: validated.repo,
      sourceTag: validated.tag,
      sourceImage: validated.sourceImage,
      sourceDigest: validated.sourceDigest,
      useCustomCa: parsed.data.useCustomCa ?? (await getEnterpriseCa()).jobDefault,
      requestedByUserId: session.user.id,
      targets: { create: validated.targets },
    },
    include: { targets: true },
  })

  // Two things decide whether the jobs start now. The rules decide whether this direction
  // needs review at all — a rule with requiresApproval false lets an internal transfer go
  // straight through, whoever asked. When review *is* required, an admin still short-circuits
  // it: a request exists to be reviewed by someone with the authority to approve it, and
  // making them queue behind themselves helps nobody.
  if (validated.requiresApproval && !hasRole(session, Role.ADMIN)) {
    await notify({
      kind: "TRANSFER_REQUESTED",
      payload: {
        image: validated.sourceImage,
        destinations:
          validated.targets.length === 1 ? "1 destination" : `${validated.targets.length} destinations`,
      },
      audience: { admins: true },
      href: "/requests",
      actorUserId: session.user.id,
    })
    return NextResponse.json(transferRequest, { status: 201 })
  }

  try {
    const launched = await launchTransferRequest(transferRequest.id, session.user.id)
    return NextResponse.json(launched, { status: 201 })
  } catch (err) {
    if (err instanceof TransferLaunchError) {
      // The row survives as PENDING: the transfer is defined, only the launch failed (no robot
      // account, cluster unreachable, k8s refused the Job). Approving it from Requests
      // retries the identical launch.
      return NextResponse.json(
        { error: `${err.message} — saved as a pending request you can approve to retry.` },
        { status: err.status },
      )
    }
    throw err
  }
}

/**
 * One request per image, sharing a set of destinations and a CA answer.
 *
 * The source is per image, not per batch: a line carrying its own host names its own source,
 * and only a line without one inherits the batch's. That is what lets a single paste mix Docker
 * Hub with a DMZ Harbor — see resolveImageSource().
 *
 * Images are independent on purpose: a repository outside the source's allowlist, or a tag that
 * no longer exists, refuses that image and no other. The response says what happened to each,
 * because "12 of 14 started" is the only honest answer and a single status code cannot carry it.
 *
 * Every row of a multi-image paste is stamped with the same `batchId`. It changes nothing about
 * what a transfer is — each row still carries its own approval, status and retry — it only lets
 * the review queue show the fourteen rows as the one gesture that produced them, and approve a
 * subset of them (see src/lib/requests/service.ts).
 */
async function createBatch(body: unknown, session: Session) {
  const parsed = transferRequestBatchInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const input: TransferRequestBatchInput = parsed.data
  const started: { image: string; id: string; pending: boolean }[] = []
  const failed: { image: string; error: string }[] = []
  let images: (TransferRequestBatchInput["images"][number] & { pinnedDigest?: string })[] = input.images
  if (input.allTags) {
    images = []
    const seen = new Set<string>()
    for (const image of input.images) {
      const source = resolveImageSource(input, image)!
      const key = JSON.stringify([source, image.repo, image.tag])
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const expanded = await expandAllTags({ ...source, repo: image.repo, tag: image.tag,
          allTags: true, targets: input.targets, useCustomCa: input.useCustomCa }, session)
        for (const entry of expanded) {
          const duplicate = images.find(existing => existing.repo === entry.repo && existing.tag === entry.tag &&
            existing.sourceId === entry.sourceId && existing.sourceRegistryId === entry.sourceRegistryId &&
            existing.sourceProjectName === entry.sourceProjectName)
          if (duplicate && duplicate.pinnedDigest !== entry.pinnedDigest) {
            return NextResponse.json({ error: "A source tag changed between artifact selections; no transfers were created. Retry the request." }, { status: 409 })
          }
          if (!duplicate) images.push(entry)
        }
      } catch (error) {
        if (!(error instanceof TransferValidationError)) throw error
        failed.push({ image: `${image.repo}:${image.tag}`, error: error.message })
      }
      if (images.length > MAX_TRANSFER_TAGS) {
        return NextResponse.json({ error: `All-tags batches are limited to ${MAX_TRANSFER_TAGS} tags; no transfers were created.` }, { status: 400 })
      }
    }
  }
  const jobDefault = (await getEnterpriseCa()).jobDefault
  const batchId = images.length > 1 ? crypto.randomUUID() : null

  for (const image of images) {
    const source = resolveImageSource(input, image)
    const label = `${image.repo}:${image.tag}`
    if (!source) {
      failed.push({ image: label, error: "This image names no source." })
      continue
    }
    try {
      const validated = await validateTransferRequest(
        {
          // Spelled out rather than spread over `input`: the batch's own source fields must
          // not survive alongside the line's, or a line naming a registry would be read as
          // the upstream source the top of the form happens to hold.
          sourceId: source.sourceId,
          sourceRegistryId: source.sourceRegistryId,
          sourceProjectName: source.sourceProjectName,
          repo: image.repo,
          tag: image.tag,
          useCustomCa: input.useCustomCa,
          targets: input.targets,
        },
        session,
        { pinnedDigest: image.pinnedDigest },
      )

      const created = await prisma.transferRequest.create({
        data: {
          sourceId: validated.sourceId,
          sourceRegistryId: validated.sourceRegistryId,
          sourceProjectName: validated.sourceProjectName,
          sourceRepo: validated.repo,
          sourceTag: validated.tag,
          sourceImage: validated.sourceImage,
          sourceDigest: validated.sourceDigest,
          useCustomCa: input.useCustomCa ?? jobDefault,
          requestedByUserId: session.user.id,
          batchId,
          targets: { create: validated.targets },
        },
        select: { id: true },
      })

      // Reported under the reference that was actually resolved, host included: in a list
      // mixing two registries, "nginx:1.27" alone no longer says which one it came from.
      const needsReview = validated.requiresApproval && !hasRole(session, Role.ADMIN)
      if (needsReview) {
        started.push({ image: validated.sourceImage, id: created.id, pending: true })
        continue
      }

      await launchTransferRequest(created.id, session.user.id)
      started.push({ image: validated.sourceImage, id: created.id, pending: false })
    } catch (err) {
      // A launch failure leaves the row PENDING and retryable, exactly as in the single form —
      // so it is reported as a failure of *this image*, not of the batch.
      const message =
        err instanceof TransferValidationError || err instanceof TransferLaunchError
          ? err.message
          : "Failed to create the transfer"
      if (!(err instanceof TransferValidationError) && !(err instanceof TransferLaunchError)) throw err
      failed.push({ image: label, error: message })
    }
  }

  const pending = started.filter((entry) => entry.pending)
  if (pending.length > 0) {
    // One notification for the batch, not one per image: a reviewer needs to know a queue
    // appeared, and fifty rows in the bell is how a notification centre becomes noise.
    const names = pending.slice(0, 3).map((entry) => entry.image).join(", ")
    await notify({
      kind: "TRANSFER_REQUESTED",
      payload: {
        image:
          pending.length === 1
            ? pending[0].image
            : `${pending.length} images (${names}${pending.length > 3 ? ", …" : ""})`,
        destinations:
          input.targets.length === 1 ? "1 destination" : `${input.targets.length} destinations`,
      },
      audience: { admins: true },
      href: "/requests",
      actorUserId: session.user.id,
    })
  }

  // Nothing created at all is a rejected request, not a partial success — the caller changed
  // nothing and the body says why, image by image.
  return NextResponse.json({ started, failed }, { status: started.length > 0 ? 201 : 400 })
}

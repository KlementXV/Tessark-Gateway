import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { caFingerprint } from "@/lib/ca"
import { getConfig } from "@/lib/config"
import { readEnterpriseCa, updateEnterpriseCa, type EnterpriseCa } from "@/lib/settings/enterprise-ca"
import { enterpriseCaInputSchema } from "@/lib/settings/schema"

// The instance-wide certificate authority, so SUPERADMIN like the rest of InstanceSettings:
// this widens what *every* connection of the Gateway is willing to trust, admins and their
// registries included, and it is not something one operator changes for the whole estate on
// their own authority.
//
// The PEM itself is never returned. It is a public certificate, so this is not about secrecy —
// it is that nothing needs it back: the screen shows whether one is configured and its
// fingerprint, which is what an operator checks a bundle against.
function summarize(state: EnterpriseCa) {
  return {
    configured: Boolean(state.pem),
    fingerprint: state.pem ? caFingerprint(state.pem) : null,
    jobDefault: state.jobDefault,
    enabled: getConfig().customCaBetaEnabled,
  }
}

export async function GET(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  return NextResponse.json(summarize(await readEnterpriseCa()))
}

export async function PUT(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const parsed = enterpriseCaInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { enterpriseCaPem, enterpriseCaJobDefault } = parsed.data
  if (enterpriseCaPem === undefined && enterpriseCaJobDefault === undefined) {
    // Both fields optional so that either can be changed alone — but a body naming neither can
    // only be a client bug, and answering 200 to it would say something was written.
    return NextResponse.json(
      { error: "Name at least one of enterpriseCaPem (null to remove it) or enterpriseCaJobDefault" },
      { status: 400 },
    )
  }

  const stored = await updateEnterpriseCa({ pem: enterpriseCaPem, jobDefault: enterpriseCaJobDefault })
  return NextResponse.json(summarize(stored))
}

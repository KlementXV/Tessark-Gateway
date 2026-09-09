import { NextResponse } from "next/server"
import { authErrorResponse } from "@/lib/auth/guard"
import { Prisma } from "@/generated/prisma/client"
import { ZodError } from "zod"

export async function buildResponse(fn: () => Promise<unknown>, status = 200) {
  try { return NextResponse.json(await fn(), { status }) }
  catch (err) {
    const auth = authErrorResponse(err)
    if (auth) return auth
    if (err instanceof ZodError) return NextResponse.json({ error: "Invalid build configuration", details: err.flatten() }, { status: 400 })
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return NextResponse.json({ error: "A build with this name or destination tag already exists" }, { status: 409 })
    return NextResponse.json({ error: "Build operation failed; check the service or retry" }, { status: 502 })
  }
}

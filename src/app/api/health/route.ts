import { NextResponse } from "next/server"

// Liveness only: the process can answer HTTP, nothing more. Deliberately does not touch the
// database or Kubernetes — that's /api/ready's job. A liveness probe that depends on external
// state would make the kubelet restart a perfectly healthy pod just because Postgres hiccuped.
export async function GET() {
  return NextResponse.json({ status: "ok" })
}

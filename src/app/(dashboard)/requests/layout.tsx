import { redirect } from "next/navigation"

import { auth } from "@/auth"
import { hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"

// Reviewing requests is an admin/superadmin concern — regular users see their own requests
// on the project they belong to.
export default async function RequestsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!hasRole(session, Role.ADMIN)) redirect("/projects")

  return children
}

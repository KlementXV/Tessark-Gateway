import { redirect } from "next/navigation"

import { auth } from "@/auth"
import { hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"

// Registries are an admin/superadmin concern — regular users work through Projects instead.
export default async function RegistriesLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!hasRole(session, Role.ADMIN)) redirect("/projects")

  return children
}

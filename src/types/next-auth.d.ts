import type { Role } from "@/generated/prisma/client"
import type { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface User {
    role: Role
  }

  interface Session {
    /** Server-side scope of a Bearer token; absent for cookie sessions. */
    buildProjectScope?: string[]
    user: {
      id: string
      role: Role
    } & DefaultSession["user"]
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string
    role: Role
    /**
     * When `role`/`disabled` were last re-read from the database, as an epoch millisecond
     * stamp. Drives the AUTH_SESSION_REFRESH_SECONDS re-check in src/auth.ts; absent on a
     * token minted before that check existed, which simply forces one refresh.
     */
    checkedAt?: number
    /**
     * The provider's ID token, kept only when OIDC_LOGOUT_MODE=idp — it is what the
     * end-session endpoint wants as `id_token_hint` (src/app/api/auth/logout-target). Never
     * copied onto the session: the browser has no use for it, and it would then be readable
     * by any script on the page. Absent in every other mode, so the cookie stays small.
     */
    idToken?: string
  }
}

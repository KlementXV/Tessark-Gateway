"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { signIn } from "next-auth/react"
import { AlertCircle, ArrowRight, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, User } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Codes src/lib/auth/oidc.ts can redirect with. Anything else — a provider-side failure, a
// NextAuth built-in like AccessDenied — falls back to the generic message rather than
// showing the raw code to whoever is trying to sign in.
const OIDC_ERROR_KEYS = {
  OidcAccountExists: "oidcErrors.accountExists",
  OidcEmailUnverified: "oidcErrors.emailUnverified",
  OidcSignupDisabled: "oidcErrors.signupDisabled",
  OidcAccountDisabled: "oidcErrors.accountDisabled",
  OidcMissingSubject: "oidcErrors.missingSubject",
} as const

type OidcErrorKey = (typeof OIDC_ERROR_KEYS)[keyof typeof OIDC_ERROR_KEYS] | "oidcErrors.generic"

function oidcErrorKey(code: string): OidcErrorKey {
  return OIDC_ERROR_KEYS[code as keyof typeof OIDC_ERROR_KEYS] ?? "oidcErrors.generic"
}

export interface LoginFormProps {
  /** Whether the SSO button is offered at all — mirrors OIDC_ENABLED. */
  oidcEnabled: boolean
  /** OIDC_DISPLAY_NAME, so the button names the operator's provider rather than "OIDC". */
  oidcDisplayName: string
  /**
   * Mirrors OIDC_ALLOW_LOCAL_LOGIN. False hides the username/password fields — and the
   * provider itself is not registered server-side either, so this is presentation catching
   * up with the auth config, not the enforcement of it.
   */
  localLoginEnabled: boolean
}

function LoginFormInner({ oidcEnabled, oidcDisplayName, localLoginEnabled }: LoginFormProps) {
  const t = useTranslations("login")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [ssoLoading, setSsoLoading] = React.useState(false)
  const errorRef = React.useRef<HTMLParagraphElement>(null)

  // A refused SSO sign-in comes back as a redirect carrying a stable code (see
  // src/lib/auth/oidc.ts) rather than a message, so the reason is translated here rather than
  // rendered in whatever language the server happened to be configured in. Derived during
  // render, not pushed into state by an effect: it is a function of the URL, and a failed
  // credentials attempt afterwards must be able to take over the same slot.
  const errorCode = searchParams.get("error")
  const displayError = error ?? (errorCode ? t(oidcErrorKey(errorCode)) : null)

  React.useEffect(() => {
    if (displayError) errorRef.current?.focus()
  }, [displayError])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const res = await signIn("credentials", {
      username,
      password,
      redirect: false,
    })

    setLoading(false)

    if (res?.error) {
      setError(t("invalid"))
      return
    }

    router.push(searchParams.get("callbackUrl") ?? "/projects")
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {oidcEnabled && (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={ssoLoading}
            onClick={() => {
              setSsoLoading(true)
              // Full redirect, not the ajax form of signIn: the provider owns the next few
              // navigations, and a refusal comes back as ?error= on this same page.
              void signIn("oidc", { callbackUrl: searchParams.get("callbackUrl") ?? "/projects" })
            }}
            className="h-10 w-full shadow-[var(--elevation-sm)]"
          >
            {ssoLoading ? <Loader2 className="animate-spin" /> : <ShieldCheck aria-hidden="true" />}
            {t("oidcButton", { provider: oidcDisplayName })}
          </Button>
          {localLoginEnabled && (
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">{t("orDivider")}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
        </>
      )}
      {localLoginEnabled && (
      <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="username" className="text-xs font-medium text-muted-foreground">
          {t("username")}
        </Label>
        <div className="relative">
          <User
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            placeholder={t("usernamePlaceholder")}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            className="h-10 pl-9"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">
          {t("password")}
        </Label>
        <div className="relative">
          <KeyRound
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder={t("passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            aria-invalid={Boolean(displayError)}
            aria-describedby={displayError ? "login-error" : undefined}
            className="h-10 pr-10 pl-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            aria-label={showPassword ? t("hidePassword") : t("showPassword")}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </div>
      </>
      )}
      {displayError && (
        <p
          id="login-error"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="animate-enter-scale flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-px size-4 shrink-0" />
          {displayError}
        </p>
      )}
      {localLoginEnabled && (
      <Button
        type="submit"
        disabled={loading}
        className="group mt-2 h-10 w-full shadow-[var(--elevation-sm)] transition-transform active:scale-[0.99]"
      >
        {loading ? <Loader2 className="animate-spin" /> : null}
        {t("submit")}
        {!loading && (
          <ArrowRight
            aria-hidden="true"
            className="transition-transform duration-200 group-hover:translate-x-0.5"
          />
        )}
      </Button>
      )}
    </form>
  )
}

export function LoginForm(props: LoginFormProps) {
  return (
    <React.Suspense fallback={null}>
      <LoginFormInner {...props} />
    </React.Suspense>
  )
}

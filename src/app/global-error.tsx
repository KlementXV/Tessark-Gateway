"use client"

import en from "../../messages/en.json"
import fr from "../../messages/fr.json"
import { readLocaleCookie } from "@/i18n/locale"

// Rendered in place of the root layout when it throws, so there is no NextIntlClientProvider
// above this component: the language is read straight from the cookie and the two catalogues
// are imported directly. Both are small, and this page must work with nothing else running.
const MESSAGES = { en, fr } as const

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const locale = readLocaleCookie() ?? "en"
  const messages = MESSAGES[locale]

  return (
    <html lang={locale}>
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#fafafa", color: "#18181b" }}>
        <main
          style={{
            minHeight: "100dvh",
            display: "grid",
            placeItems: "center",
            padding: "1.5rem",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: "28rem" }}>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{messages.errors.globalTitle}</h1>
            <p style={{ margin: "0.75rem 0 1.25rem", color: "#52525b", lineHeight: 1.6 }}>
              {messages.errors.globalDescription}
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                border: 0,
                borderRadius: "0.5rem",
                background: "#18181b",
                color: "white",
                padding: "0.65rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {messages.common.tryAgain}
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}

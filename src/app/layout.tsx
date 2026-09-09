import type { CSSProperties } from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getTranslations } from "next-intl/server"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { brandTitle, brandingCssVars } from "@/lib/settings/branding"
import { getInstanceSettings } from "@/lib/settings/service"
import "./globals.css"

// Every route reads branding through the root layout (getInstanceSettings(), a Prisma query),
// which made Next try to statically prerender /login and /icon.svg at *build* time — the one
// place DATABASE_URL is guaranteed absent (CLAUDE.md §1: config is read at runtime, never
// baked into the image). Forcing the whole app dynamic closes that off for any future static
// leaf page too, not just the ones that happen to trip it today; there is no static/marketing
// surface here worth optimizing for at the cost of that guarantee.
export const dynamic = "force-dynamic"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export async function generateMetadata(): Promise<Metadata> {
  const [branding, t] = await Promise.all([getInstanceSettings(), getTranslations("meta")])
  return {
    title: {
      default: brandTitle(branding),
      template: `%s · ${branding.brandName}`,
    },
    description: t("description"),
    icons: branding.logoUrl ? { icon: branding.logoUrl } : undefined,
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [{ primaryColor }, locale] = await Promise.all([getInstanceSettings(), getLocale()])
  const style = brandingCssVars(primaryColor) as CSSProperties | undefined

  return (
    <html lang={locale} suppressHydrationWarning style={style}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/* Locale, messages and time zone come from src/i18n/request.ts — the provider
            forwards them to Client Components without a prop. */}
        <NextIntlClientProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"

type ViewTransition = {
  ready: Promise<void>
  finished: Promise<void>
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransition
}

export function ThemeToggle() {
  const t = useTranslations("nav")
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  // Hydration guard: resolvedTheme is only meaningful once mounted on the client.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === "dark"

  function toggleTheme() {
    if (!mounted) return

    const nextTheme = isDark ? "light" : "dark"
    const root = document.documentElement
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const transitionDocument = document as ViewTransitionDocument

    if (!transitionDocument.startViewTransition || reduceMotion) {
      setTheme(nextTheme)
      return
    }

    const rect = buttonRef.current?.getBoundingClientRect()
    const originX = rect ? rect.right - 24 : window.innerWidth / 2
    const originY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
    const radius = Math.hypot(
      Math.max(originX, window.innerWidth - originX),
      Math.max(originY, window.innerHeight - originY),
    )

    root.dataset.themeTransition = nextTheme

    const transition = transitionDocument.startViewTransition(() => {
      setTheme(nextTheme)
    })

    transition.ready
      .then(() => {
        root.animate(
          {
            clipPath: [
              `circle(0px at ${originX}px ${originY}px)`,
              `circle(${radius}px at ${originX}px ${originY}px)`,
            ],
          },
          {
            duration: 620,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          } as KeyframeAnimationOptions,
        )
      })
      .catch(() => undefined)

    transition.finished.finally(() => {
      delete root.dataset.themeTransition
    })
  }

  const label = t("switchTheme", { theme: isDark ? "light" : "dark" })

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          ref={buttonRef}
          role="switch"
          aria-checked={isDark}
          aria-label={label}
          disabled={!mounted}
          onClick={toggleTheme}
          tooltip={label}
          className="h-11 gap-3 rounded-xl px-3 text-sidebar-foreground/70 transition-[background-color,color,transform] duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.985] disabled:opacity-100 group-data-[collapsible=icon]:justify-center"
        >
          <span className="relative size-4 shrink-0">
            <Sun
              className={cn(
                "absolute inset-0 size-4 transition-[opacity,transform] duration-500 ease-out",
                isDark ? "scale-50 -rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
              )}
            />
            <Moon
              className={cn(
                "absolute inset-0 size-4 transition-[opacity,transform] duration-500 ease-out",
                isDark ? "scale-100 rotate-0 opacity-100" : "scale-50 rotate-90 opacity-0",
              )}
            />
          </span>

          <span className="text-[13px] font-medium group-data-[collapsible=icon]:hidden">
            {t("appearance")}
          </span>

          <span
            data-theme={isDark ? "dark" : "light"}
            aria-hidden="true"
            className={cn(
              "group/theme-switch relative ml-auto h-7 w-12 shrink-0 overflow-hidden rounded-full border border-sidebar-foreground/8 bg-sidebar-foreground/12 shadow-inner transition-[background-color,border-color,box-shadow] ease-out group-data-[collapsible=icon]:hidden",
              mounted ? "duration-500" : "duration-0",
              isDark && "bg-sidebar-foreground/24 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.04)]",
            )}
          >
            <span
              className={cn(
                "absolute top-[3px] left-[3px] flex size-5 items-center justify-center rounded-full bg-white text-neutral-700 shadow-[0_2px_7px_oklch(0_0_0/0.28)] transition-transform will-change-transform group-data-[theme=dark]/theme-switch:translate-x-5 dark:bg-neutral-100",
                mounted
                  ? "duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                  : "duration-0",
              )}
            >
              <Sun
                className={cn(
                  "absolute size-3 transition-[opacity,transform] duration-300",
                  isDark ? "scale-50 -rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
                )}
                strokeWidth={2.25}
              />
              <Moon
                className={cn(
                  "absolute size-3 transition-[opacity,transform] duration-300",
                  isDark ? "scale-100 rotate-0 opacity-100" : "scale-50 rotate-90 opacity-0",
                )}
                strokeWidth={2.25}
              />
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import {
  Boxes,
  CalendarClock,
  CloudDownload,
  Inbox,
  KeyRound,
  LogIn,
  LogOut,
  MoonStar,
  Network,
  Package,
  Palette,
  Search,
  Layers,
  Server,
  Settings2,
  SunMedium,
  Users,
  type LucideIcon,
} from "lucide-react"

import type { SearchIndex } from "@/app/api/search/route"
import { Role } from "@/generated/prisma/client"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { signOutTo } from "@/lib/auth/sign-out"
import { cn } from "@/lib/utils"

type Page = { label: string; href: string; icon: LucideIcon; keywords?: string }

// Keywords stay English on purpose: they are hidden search aliases, and an operator who
// types "harbor" or "mirror" expects a hit whatever language the labels are shown in.
function pagesFor(role: Role, t: ReturnType<typeof useTranslations<"nav">>): Page[] {
  const isAdmin = role === Role.ADMIN || role === Role.SUPERADMIN
  const pages: Page[] = [
    { label: t("projects"), href: "/projects", icon: Boxes },
    { label: t("myRequests"), href: "/projects/requests", icon: Inbox, keywords: "pull project request" },
  ]
  if (isAdmin) {
    pages.push(
      { label: t("registries"), href: "/registries", icon: Server, keywords: "harbor fleet cluster" },
      { label: t("mirrors"), href: "/registries/mirrors", icon: CalendarClock, keywords: "scheduled mirror cron daily nginx latest" },
      { label: t("activity"), href: "/registries/activity", icon: Network, keywords: "jobs executions runs logs replication mesh" },
      { label: t("policy"), href: "/registries/policy", icon: CloudDownload, keywords: "upstream sources docker hub transfer rules allowed" },
      { label: t("reviewQueue"), href: "/requests", icon: Inbox, keywords: "pending approve reject" },
      { label: t("requestHistory"), href: "/requests/history", icon: Inbox },
    )
  }
  pages.push(
    { label: t("profile"), href: "/settings", icon: Settings2, keywords: "settings account password" },
    { label: t("apiTokens"), href: "/settings/tokens", icon: KeyRound, keywords: "settings" },
  )
  if (role === Role.SUPERADMIN) {
    pages.push(
      { label: t("users"), href: "/settings/users", icon: Users, keywords: "settings accounts roles" },
      { label: t("branding"), href: "/settings/branding", icon: Palette, keywords: "settings logo color" },
      {
        label: t("loginPage"),
        href: "/settings/branding#login",
        icon: LogIn,
        keywords: "settings login sign-in text copy",
      },
    )
  }
  return pages
}

/**
 * Ctrl/⌘+K jump-anywhere: pages, then the user's projects and (for admins) registries,
 * fetched when the palette opens so the list is never stale after a create or delete.
 */
export function CommandPalette({ userRole, className }: { userRole: Role; className?: string }) {
  const t = useTranslations("nav")
  const tc = useTranslations("common")
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [open, setOpen] = React.useState(false)
  const [index, setIndex] = React.useState<SearchIndex | null>(null)
  const [loading, setLoading] = React.useState(false)
  // What has been typed. Pages, projects and registries are filtered in the browser out of the
  // index; images cannot be — they live in Harbor — so the query goes back to the server.
  const [query, setQuery] = React.useState("")
  const isMac = React.useSyncExternalStore(
    () => () => {},
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false,
  )

  // Refetched on every open, and again as the query changes: the index is tiny, a project
  // created a second ago must already be reachable from here, and the image half of the answer
  // depends on what has been typed.
  //
  // Each call is stamped, and only the newest one is allowed to write: the image half of the
  // answer is a Harbor round trip, so a slow "ngin" can land after a fast "nginx" and leave
  // the palette showing results for a query nobody is looking at any more — and its
  // `finally` would clear the spinner while the real request is still running.
  const requestSeq = React.useRef(0)
  const refresh = React.useCallback((search: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    fetch(`/api/search?q=${encodeURIComponent(search)}`)
      .then((res) => (res.ok ? (res.json() as Promise<SearchIndex>) : null))
      .then((body) => {
        if (seq !== requestSeq.current) return
        if (body) setIndex(body)
      })
      .catch(() => {})
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false)
      })
  }, [])

  const setOpenAndLoad = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      setQuery("")
      if (next) refresh("")
    },
    [refresh],
  )

  // Typing is debounced because each keystroke can cost one Harbor call per cluster. The
  // in-browser filtering of pages and projects is unaffected — cmdk does that on its own,
  // instantly, from the index already loaded.
  React.useEffect(() => {
    if (!open || query === "") return
    const timer = setTimeout(() => refresh(query), 250)
    return () => clearTimeout(timer)
  }, [open, query, refresh])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpenAndLoad(!open)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, setOpenAndLoad])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  const pages = pagesFor(userRole, t)
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark"

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpenAndLoad(true)}
        className={cn(
          "h-8 gap-2 text-muted-foreground shadow-none hover:text-foreground sm:w-56 sm:justify-start",
          className,
        )}
        aria-label={t("palette.open")}
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      >
        <Search />
        {/* min-w-0 + truncate: the hint is translated, and a longer string must eat into
            its own room rather than push the shortcut out of the button. */}
        <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">
          {t("palette.hint")}
        </span>
        <kbd className="pointer-events-none ml-auto hidden h-5 shrink-0 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
          {isMac ? "⌘" : "Ctrl"} K
        </kbd>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpenAndLoad}>
        <CommandInput
          placeholder={t("palette.placeholder")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>{loading ? tc("loading") : t("palette.noResults")}</CommandEmpty>

          <CommandGroup heading={t("palette.goTo")}>
            {pages.map((page) => (
              <CommandItem
                key={page.href}
                value={`${page.label} ${page.keywords ?? ""}`}
                onSelect={() => go(page.href)}
              >
                <page.icon />
                {page.label}
              </CommandItem>
            ))}
          </CommandGroup>

          {index && index.projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("palette.projects")}>
                {index.projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`project ${project.name} ${project.cluster}`}
                    onSelect={() => go(`/projects/${project.id}`)}
                  >
                    <Package />
                    <span className="truncate">{project.name}</span>
                    <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{project.cluster}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {index && index.images.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("palette.images")}>
                {index.images.map((image) => (
                  <CommandItem
                    key={`${image.projectId}/${image.repository}`}
                    // The value is what cmdk filters on, and the server already decided this
                    // row matches — including it verbatim keeps the client from filtering the
                    // hit back out.
                    value={`image ${image.projectName}/${image.repository} ${query}`}
                    onSelect={() =>
                      go(
                        `/projects/${image.projectId}?tab=images&repo=${encodeURIComponent(image.repository)}`,
                      )
                    }
                  >
                    <Layers />
                    <span className="truncate">
                      <span className="text-muted-foreground">{image.projectName}/</span>
                      {image.repository}
                    </span>
                    <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                      {t("palette.tagCount", { count: image.artifactCount })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {index && index.registries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("palette.registries")}>
                {index.registries.map((registry) => (
                  <CommandItem
                    key={registry.id}
                    value={`registry ${registry.name} ${registry.baseUrl} ${registry.cluster ?? ""}`}
                    onSelect={() => go(`/registries/${registry.id}`)}
                  >
                    <Server />
                    <span className="truncate">{registry.name}</span>
                    <span className="ml-auto truncate pl-3 font-mono text-xs text-muted-foreground">
                      {registry.baseUrl.replace(/^https?:\/\//, "")}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading={t("palette.actions")}>
            <CommandItem
              value={`switch to ${nextTheme} theme appearance`}
              onSelect={() => {
                setTheme(nextTheme)
                setOpen(false)
              }}
            >
              {nextTheme === "dark" ? <MoonStar /> : <SunMedium />}
              {t("switchTheme", { theme: nextTheme })}
            </CommandItem>
            <CommandItem value="log out sign out" onSelect={() => void signOutTo()}>
              <LogOut />
              {t("logOut")}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}

// Parsing the image list of the transfer dialog: one line, one image.
//
// Shared with nothing else — but kept out of the component so it can be tested on its own, and
// so the rules it applies (what a line may look like, which source a line names, what counts
// as a duplicate) are written once rather than re-derived in the browser and again on the
// server.
//
// A line may carry its own host — "docker.io/library/nginx:1.27" — and that host is what says
// where the image comes from. It is resolved against the sources the requester may use, never
// taken at face value: an unknown host refuses the line rather than becoming a registry the
// Gateway would then try to pull from. That is the same property the source picker had, kept
// intact now that a list may mix Docker Hub, a DMZ Harbor and a partner registry in one paste.

import { normalizeRepoPath } from "@/lib/sources/repo"

/** One source a line may resolve to, in the shape the dialog already holds. */
export interface ImageListSource {
  /** `upstream:<id>` or `registry:<id>` — the key the dialog keys its picker on. */
  key: string
  /** Bare host, no scheme: "docker.io", "harbor-dmz.local:8443". */
  host: string
  /**
   * Projects an image may be taken from, for a Harbor source. Undefined for an upstream host,
   * which has no project level: that is what tells the two kinds apart here.
   */
  projects?: string[]
}

/** A repository path within the source host, and the tag. Same split the form used to make. */
export interface ParsedImage {
  repo: string
  tag: string
  /** 1-based, so a message can point at the line the operator is looking at. */
  line: number
  /** Which source this line resolved to — a detected host, or the picked default. */
  sourceKey: string
  /** The project the image sits in, for a Harbor source; null for an upstream host. */
  sourceProject: string | null
  /** True when the host was written on the line rather than inherited from the picker. */
  detected: boolean
}

/**
 * Why a line is not usable. Codes rather than sentences: the message is written in the
 * component, in the reader's own language.
 */
export type InvalidReason =
  | "syntax"
  /** The host on the line is not one of the sources this requester may pull from. */
  | "unknownHost"
  /** A Harbor source needs a project, and the reference stops at the repository. */
  | "missingProject"
  /** The project named on the line is not one this Harbor offers. */
  | "unknownProject"
  /** No host on the line and no source picked, so nothing says where the image comes from. */
  | "noSource"

export interface InvalidLine {
  line: number
  text: string
  reason: InvalidReason
  /** The offending host or project, for the reasons that have one to name. */
  detail?: string
}

export interface ParsedImageList {
  images: ParsedImage[]
  /** Lines that are not a usable reference, with the reason, in the order they appear. */
  invalid: InvalidLine[]
  /** Repeated `repo:tag` *within one source*, naming the line it first appeared on. */
  duplicates: { line: number; text: string; firstLine: number }[]
  /** The source keys the list actually uses, in first-appearance order. */
  sourceKeys: string[]
}

export interface ParseImageListOptions {
  /** Every source the requester may name, by host. Empty means the picker is all there is. */
  sources?: ImageListSource[]
  /** Source of a line that carries no host of its own. */
  defaultSourceKey?: string
  /** Project of that default source, when it is a Harbor. */
  defaultSourceProject?: string | null
}

const REPO_RE = /^[a-z0-9]+(?:[-_./][a-z0-9]+)*$/
const TAG_RE = /^\w[\w.-]*$/
const PROJECT_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/

// Docker Hub answers to several names and users paste all of them. Matching a source on any of
// its aliases is what makes "docker.io/library/nginx" and "index.docker.io/library/nginx" the
// one source they are — the same set normalizeRepoPath() folds for the `library/` prefix.
const HOST_ALIASES = new Map(
  Object.entries({
    "index.docker.io": "docker.io",
    "registry-1.docker.io": "docker.io",
    "registry.hub.docker.com": "docker.io",
  }),
)

function canonicalHost(host: string): string {
  const lower = host.toLowerCase()
  return HOST_ALIASES.get(lower) ?? lower
}

/**
 * Whether the first segment of a reference is a registry host rather than the first half of a
 * repository path.
 *
 * Docker's own rule, and the only one that can be applied without knowing the answer already:
 * a host has a dot or a port, or is `localhost`. It is why "library/nginx" is a path on the
 * picked source while "quay.io/prometheus/node-exporter" names its own.
 */
function looksLikeHost(segment: string): boolean {
  return segment === "localhost" || segment.includes(".") || segment.includes(":")
}

/**
 * Splits `library/nginx:1.27` into its two halves.
 *
 * The last colon is the separator, but only when what follows it holds no "/" — otherwise it is
 * a port in a host that has not been split off yet, not a tag. A line with no tag means
 * `latest`, the same default the single-image form applied.
 */
function splitRef(text: string): { repo: string; tag: string } {
  const colon = text.lastIndexOf(":")
  if (colon <= 0 || text.slice(colon + 1).includes("/")) return { repo: text, tag: "latest" }
  return { repo: text.slice(0, colon), tag: text.slice(colon + 1) || "latest" }
}

export function parseImageList(
  value: string,
  options: ParseImageListOptions = {},
): ParsedImageList {
  const sources = options.sources ?? []
  const byHost = new Map(sources.map((source) => [canonicalHost(source.host), source]))
  const byKey = new Map(sources.map((source) => [source.key, source]))

  const images: ParsedImage[] = []
  const invalid: InvalidLine[] = []
  const duplicates: ParsedImageList["duplicates"] = []
  const sourceKeys: string[] = []
  // Keyed on the resolved source *and* pair, so "nginx" and "nginx:latest" on two lines are the
  // one duplicate they actually are — while the same image taken from two different sources is
  // two transfers, not a repeat.
  const seen = new Map<string, number>()

  value.split("\n").forEach((raw, index) => {
    const line = index + 1
    // Blank lines and comments are how a pasted list arrives from a file or a wiki page.
    const text = raw.trim().replace(/^#.*/, "")
    if (!text) return
    const reject = (reason: InvalidReason, detail?: string) =>
      invalid.push({ line, text, reason, detail })

    // Helm OCI references use an explicit version. Build metadata is stored as `_`
    // in registry tags; preserve its case (tags, unlike repositories, are case-sensitive).
    const isChart = text.startsWith("oci://")
    const reference = isChart ? text.slice(6) : text
    if (isChart && !/:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+_][0-9A-Za-z.-]+)?$/.test(reference)) {
      return reject("syntax")
    }
    const ref = splitRef(reference)
    const lowered = `${ref.repo.toLowerCase().replace(/^\/+|\/+$/g, "")}:${isChart ? ref.tag.replace("+", "_") : ref.tag}`
    // A reference may name its own registry. Everything before the first "/" is inspected
    // first, because whether it is a host decides what the rest of the line even means.
    const slash = lowered.indexOf("/")
    const head = slash === -1 ? lowered : lowered.slice(0, slash)
    const detected = slash !== -1 && looksLikeHost(head)

    let source: ImageListSource | undefined
    let rest: string
    if (detected) {
      source = byHost.get(canonicalHost(head))
      if (!source) return reject("unknownHost", head)
      rest = lowered.slice(slash + 1)
    } else {
      if (!options.defaultSourceKey) return reject("noSource")
      source = byKey.get(options.defaultSourceKey)
      rest = lowered
    }

    // A Harbor source is addressed project-first: the segment after the host names the project,
    // exactly as it does in a `docker pull`. A line that inherits the picked source inherits
    // its project too, since that is what the picker next to it says.
    let sourceProject: string | null = null
    if (source?.projects) {
      if (detected) {
        const projectSlash = rest.indexOf("/")
        if (projectSlash <= 0) return reject("missingProject")
        sourceProject = rest.slice(0, projectSlash)
        rest = rest.slice(projectSlash + 1)
        if (!PROJECT_RE.test(sourceProject)) return reject("unknownProject", sourceProject)
        // Only checked when the source knows its own list. An empty list is a Harbor whose
        // projects could not be read, and refusing every line for that would be a worse answer
        // than letting the server say so.
        if (
          source.projects.length > 0 &&
          !source.projects.some((project) => project.toLowerCase() === sourceProject)
        ) {
          return reject("unknownProject", sourceProject)
        }
      } else {
        if (!options.defaultSourceProject) return reject("missingProject")
        sourceProject = options.defaultSourceProject.toLowerCase()
      }
    }

    const split = splitRef(rest)
    // The short form users type on Docker Hub is not the path the registry serves, and the
    // preview, the duplicate check and the allowlist all have to agree on which one this is.
    const repo = source ? normalizeRepoPath(source.host, split.repo) : split.repo
    const tag = split.tag
    if (!repo || !REPO_RE.test(repo) || !TAG_RE.test(tag)) return reject("syntax")

    const sourceKey = source?.key ?? options.defaultSourceKey ?? ""
    const key = `${sourceKey}|${sourceProject ?? ""}|${repo}:${tag}`
    const first = seen.get(key)
    if (first !== undefined) {
      duplicates.push({ line, text: `${repo}:${tag}`, firstLine: first })
      return
    }
    seen.set(key, line)
    if (!sourceKeys.includes(sourceKey)) sourceKeys.push(sourceKey)
    images.push({ repo, tag, line, sourceKey, sourceProject, detected })
  })

  return { images, invalid, duplicates, sourceKeys }
}

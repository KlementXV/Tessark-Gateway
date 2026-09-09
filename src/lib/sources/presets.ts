// The registries an admin almost always ends up adding by hand. Offered as one-click fills in
// the add-source dialog — nothing here is written to the database on its own, and every field
// stays editable afterwards. A preset is a starting point, not a policy.
//
// `allowedRepos` is deliberately narrow where a sensible narrow default exists (Docker Hub's
// `library/**` is the official images and nothing else). Widening is a decision the admin
// makes on purpose; the form warns when the list is empty, not when it is small.

export interface SourcePreset {
  /** Stable key, used for React lists and nothing else. */
  id: string
  name: string
  host: string
  authType: "none" | "basic" | "token"
  allowedRepos: string[]
  description: string
  /**
   * A repository known to exist on this registry, used as the default target of the
   * connection test. Reading it is what actually exercises the credentials — see
   * ./check.ts. Omitted where no repository is public or universal enough to assume.
   */
  probeRepo?: string
  /** Shown under the picker when chosen — the thing that trips people up on this registry. */
  hint?: string
}

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    id: "dockerhub",
    name: "Docker Hub",
    host: "docker.io",
    authType: "none",
    allowedRepos: ["library/**"],
    description: "Official Docker images",
    probeRepo: "library/alpine",
    hint: "Anonymous pulls are rate-limited per IP. Add Basic auth with a Docker ID to lift it.",
  },
  {
    id: "dhi",
    name: "Docker Hardened Images",
    host: "docker.io",
    authType: "basic",
    allowedRepos: ["*/dhi-**"],
    description: "Docker's hardened base images (subscription)",
    hint: "DHI repositories are mirrored into your own Docker Hub namespace as <org>/dhi-<image>, so they live on docker.io. If Docker Hub is already a source, add the glob there instead of creating a second one — the host is unique.",
  },
  {
    id: "ghcr",
    name: "GitHub Container Registry",
    host: "ghcr.io",
    authType: "none",
    allowedRepos: ["**"],
    description: "Images published from GitHub repositories",
    probeRepo: "homebrew/core/git",
    hint: "Private packages need a PAT with read:packages as the Basic auth password.",
  },
  {
    id: "quay",
    name: "Quay.io",
    host: "quay.io",
    authType: "none",
    allowedRepos: ["**"],
    description: "Red Hat's public registry",
    probeRepo: "prometheus/prometheus",
  },
  {
    id: "registry-k8s",
    name: "Kubernetes",
    host: "registry.k8s.io",
    authType: "none",
    allowedRepos: ["**"],
    description: "Kubernetes project images (kube-apiserver, CoreDNS, …)",
    probeRepo: "pause",
  },
  {
    id: "mcr",
    name: "Microsoft Artifact Registry",
    host: "mcr.microsoft.com",
    authType: "none",
    allowedRepos: ["**"],
    description: ".NET, SQL Server, Windows base images",
    probeRepo: "dotnet/runtime",
  },
  {
    id: "ecr-public",
    name: "Amazon ECR Public",
    host: "public.ecr.aws",
    authType: "none",
    allowedRepos: ["**"],
    description: "AWS public gallery",
    probeRepo: "docker/library/alpine",
  },
  {
    id: "redhat",
    name: "Red Hat Registry",
    host: "registry.access.redhat.com",
    authType: "none",
    allowedRepos: ["**"],
    description: "UBI and Red Hat certified images",
    probeRepo: "ubi9/ubi",
  },
  {
    id: "chainguard",
    name: "Chainguard",
    host: "cgr.dev",
    authType: "none",
    allowedRepos: ["chainguard/**"],
    description: "Minimal, zero-CVE base images",
    probeRepo: "chainguard/static",
    hint: "The free tier is the chainguard/ namespace on :latest only. Private repos need a cgr.dev token.",
  },
  {
    id: "nvcr",
    name: "NVIDIA NGC",
    host: "nvcr.io",
    authType: "basic",
    allowedRepos: ["nvidia/**"],
    description: "CUDA, Triton, and NGC catalog images",
    probeRepo: "nvidia/cuda",
    hint: 'NGC uses the literal username $oauthtoken with your API key as the password.',
  },
  {
    id: "gcr",
    name: "Google Container Registry",
    host: "gcr.io",
    authType: "none",
    allowedRepos: ["**"],
    description: "Distroless and legacy GCR images",
    probeRepo: "distroless/static",
  },
  {
    id: "gitlab",
    name: "GitLab Registry",
    host: "registry.gitlab.com",
    authType: "none",
    allowedRepos: ["**"],
    description: "Images published from GitLab projects",
    hint: "Private projects need a deploy token or PAT with read_registry.",
  },
]

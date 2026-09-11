# Multi-stage build for an immutable, instance-agnostic image (CLAUDE.md §5): no ARG carries
# any application configuration, only build-time neutrals. Every value that varies between
# installations arrives at runtime via the ConfigMap/Secret (src/lib/config.ts).
#
# node:*-alpine (musl) is used for every stage on purpose: Prisma's query engine binary is
# picked by `prisma generate` for the platform it *runs on* ("native" target, no
# `binaryTargets` override in schema.prisma) — mixing a glibc builder with a musl runner would
# generate a debian-openssl engine that silently fails to load in the alpine runner.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
# The Prisma CLI needs OpenSSL to generate the query engine for this platform.
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No application env var is required here — see CLAUDE.md §1 and src/lib/config.ts: getConfig()
# is only ever called at request time, never at module load, so `next build` must succeed (and
# does — verified repeatedly throughout this plan) against a completely empty environment.
RUN npx prisma generate
# `npm run build`'s own "prebuild" hook (scripts/copy-swagger-ui.mjs) vendors Swagger UI's
# static assets into public/ before Next builds — see package.json.
RUN npm run build
# Assemble the final tree before COPY so removed build dependencies never enter a layer.
RUN node scripts/prepare-runtime.mjs

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

# Build-time neutrals only (CLAUDE.md §5: "aucun ARG de configuration applicative") — identify
# *which build* this is, never how a given instance is configured.
ARG GIT_REVISION=unknown
ARG IMAGE_VERSION=0.0.0-dev
ARG IMAGE_SOURCE=""

# The query engine and the `prisma`/`tsx` CLIs both need OpenSSL at runtime, not just at
# generate time.
RUN apk add --no-cache openssl && \
    addgroup -g 1001 gateway && \
    adduser -u 1001 -G gateway -D gateway

ENV NODE_ENV=production
# Next's standalone server binds to "localhost" unless told otherwise — unreachable from
# outside the container.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# --- The web server: `output: "standalone"` traces only what next start needs into its own
# self-contained node_modules. This is what the Deployment's default command runs.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=gateway:gateway /app/.next/standalone ./
COPY --from=builder --chown=gateway:gateway /app/.next/static ./.next/static

# Migration and seed tooling was added to standalone by prepare-runtime.mjs. Do not copy
# the builder's full node_modules here: it contains compilers, linters and unused UI packages.
COPY --from=builder /app/package.json ./package.json

USER 1001
EXPOSE 3000

LABEL org.opencontainers.image.title="tessark-gateway" \
      org.opencontainers.image.description="Harbor fleet management portal" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${GIT_REVISION}" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

CMD ["node", "server.js"]

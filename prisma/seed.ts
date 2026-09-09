// Bootstraps the first SUPERADMIN, and optionally extra users and upstream sources, from
// env — all gated on the User table being empty. Safe to re-run: a no-op once any user
// exists. These env vars stop being read anywhere else once this has run once.
import "dotenv/config"
import { z } from "zod"

import { getConfig } from "../src/lib/config"
import { encryptSecret, hashPassword } from "../src/lib/crypto"
import { logger } from "../src/lib/logger"
import { PrismaClient, Role } from "../src/generated/prisma/client"
import { userCreateInputSchema } from "../src/lib/users/schema"
import { sourceInputSchema } from "../src/lib/sources/schema"

const prisma = new PrismaClient()

// Same shape the /settings/users form validates against, except role is optional here and
// defaults to USER — most seeded accounts aren't admins, and requiring every JSON entry to
// spell out "USER" is friction without a safety benefit.
const seedUserSchema = userCreateInputSchema.extend({ role: z.enum(Role).default(Role.USER) })

async function seedAdmin() {
  const { adminUsername: username, adminPassword: password } = getConfig()
  if (!username || !password) {
    throw new Error(
      "GATEWAY_ADMIN_USERNAME and GATEWAY_ADMIN_PASSWORD must be set to bootstrap the first superadmin."
    )
  }

  await prisma.user.create({
    data: {
      username,
      email: `${username}@local`,
      name: username,
      passwordHash: hashPassword(password),
      role: Role.SUPERADMIN,
    },
  })

  logger.info(`Created bootstrap superadmin "${username}".`)
}

// GATEWAY_SEED_USERS: JSON array of { username, email, password, name?, role? } — additional
// accounts on top of the guaranteed superadmin above. Validated up front (one bad entry fails
// the whole batch loudly, per CLAUDE.md §0.5) before any row is written.
async function seedExtraUsers() {
  const { seedUsers } = getConfig()
  if (seedUsers.length === 0) return

  const parsed = seedUsers.map((raw, i) => {
    const result = seedUserSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(`GATEWAY_SEED_USERS[${i}] is invalid: ${result.error.message}`)
    }
    return result.data
  })

  for (const { password, ...data } of parsed) {
    await prisma.user.create({ data: { ...data, passwordHash: hashPassword(password) } })
    logger.info(`Seeded user "${data.username}" (${data.role}).`)
  }
}

// GATEWAY_SEED_SOURCES: JSON array shaped like the add-source form (sourceInputSchema) — see
// src/lib/sources/presets.ts for ready-made examples (Docker Hub, GHCR, Quay, ...). Mirrors
// the encryption/normalization POST /api/sources applies, minus the live connection check:
// the target registry isn't guaranteed reachable this early in a cluster's life.
async function seedSources() {
  const { seedSources } = getConfig()
  if (seedSources.length === 0) return

  const parsed = seedSources.map((raw, i) => {
    const result = sourceInputSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(`GATEWAY_SEED_SOURCES[${i}] is invalid: ${result.error.message}`)
    }
    return result.data
  })

  for (const { secret, allowedRepos, authType, username, ...data } of parsed) {
    await prisma.upstreamSource.create({
      data: {
        ...data,
        authType,
        username: authType !== "none" ? username || null : null,
        encryptedSecret: authType !== "none" && secret ? encryptSecret(secret) : null,
        allowedRepos: JSON.stringify(allowedRepos),
      },
    })
    logger.info(`Seeded upstream source "${data.name}" (${data.host}).`)
  }
}

async function main() {
  const existingUsers = await prisma.user.count()
  if (existingUsers > 0) {
    logger.info(`Skipping seed — ${existingUsers} user(s) already exist.`)
    return
  }

  await seedAdmin()
  await seedExtraUsers()
  await seedSources()
}

main()
  .catch((err) => {
    logger.error("Seed failed", { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

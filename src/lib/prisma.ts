// Singleton pattern to prevent multiple PrismaClient instances during Next.js hot-reload.
import { PrismaClient } from "@/generated/prisma/client"

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

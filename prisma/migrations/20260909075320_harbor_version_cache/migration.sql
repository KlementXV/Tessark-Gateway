-- AlterTable
ALTER TABLE "Registry" ADD COLUMN     "harborVersion" TEXT,
ADD COLUMN     "harborVersionSeenAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "QuotaRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "QuotaRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedQuotaMib" INTEGER,
    "currentQuotaMib" INTEGER,
    "reason" TEXT,
    "status" "QuotaRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotaRequest_projectId_status_idx" ON "QuotaRequest"("projectId", "status");

-- AddForeignKey
ALTER TABLE "QuotaRequest" ADD CONSTRAINT "QuotaRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

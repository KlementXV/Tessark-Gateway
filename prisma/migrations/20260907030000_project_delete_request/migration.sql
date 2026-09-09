-- A member asking for a project to be taken down, and the record of the decision. The direct
-- delete a manager already has is untouched; approving one of these runs the identical deletion,
-- non-empty-project refusal included.
--
-- `projectId` is SET NULL rather than CASCADE: an approved request is the deletion of its own
-- project, so a cascade would erase the record of the decision at the moment it was carried out.
-- `projectName` is the frozen name the row can still show afterwards.
CREATE TYPE "ProjectDeleteRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "ProjectDeleteRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "projectName" TEXT NOT NULL,
    "reason" TEXT,
    "status" "ProjectDeleteRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDeleteRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectDeleteRequest_projectId_status_idx" ON "ProjectDeleteRequest"("projectId", "status");

ALTER TABLE "ProjectDeleteRequest" ADD CONSTRAINT "ProjectDeleteRequest_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New values only; nothing in this migration uses them, which is what keeps ALTER TYPE ... ADD
-- VALUE legal inside the transaction Prisma wraps a migration in.
ALTER TYPE "NotificationKind" ADD VALUE 'PROJECT_DELETE_REQUESTED';
ALTER TYPE "NotificationKind" ADD VALUE 'PROJECT_DELETE_APPROVED';
ALTER TYPE "NotificationKind" ADD VALUE 'PROJECT_DELETE_REJECTED';

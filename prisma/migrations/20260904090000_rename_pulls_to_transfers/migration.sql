-- Renaming the pull domain to transfers: a pull request is now one shape of a transfer,
-- alongside pushing an image from one Harbor to another (see docs/plan-transfers.md, lot 1).
-- Written by hand rather than generated: `prisma migrate dev` produces a DROP/CREATE pair for
-- what is only a rename, which would discard existing history for no reason.

-- Enums
ALTER TYPE "PullRequestStatus" RENAME TO "TransferStatus";
ALTER TYPE "NotificationKind" RENAME VALUE 'PULL_REQUESTED' TO 'TRANSFER_REQUESTED';
ALTER TYPE "NotificationKind" RENAME VALUE 'PULL_APPROVED' TO 'TRANSFER_APPROVED';
ALTER TYPE "NotificationKind" RENAME VALUE 'PULL_REJECTED' TO 'TRANSFER_REJECTED';

-- Tables and columns
ALTER TABLE "PullRequest" RENAME TO "TransferRequest";
ALTER TABLE "PullTarget" RENAME TO "TransferTarget";
ALTER TABLE "TransferTarget" RENAME COLUMN "pullRequestId" TO "transferRequestId";

-- Constraints and indexes, so the names Prisma expects match what the database holds
ALTER TABLE "TransferRequest" RENAME CONSTRAINT "PullRequest_pkey" TO "TransferRequest_pkey";
ALTER TABLE "TransferRequest" RENAME CONSTRAINT "PullRequest_sourceId_fkey" TO "TransferRequest_sourceId_fkey";
ALTER TABLE "TransferTarget" RENAME CONSTRAINT "PullTarget_pkey" TO "TransferTarget_pkey";
ALTER TABLE "TransferTarget" RENAME CONSTRAINT "PullTarget_projectId_fkey" TO "TransferTarget_projectId_fkey";
ALTER TABLE "TransferTarget" RENAME CONSTRAINT "PullTarget_pullRequestId_fkey" TO "TransferTarget_transferRequestId_fkey";
ALTER INDEX "PullTarget_pullRequestId_projectId_key" RENAME TO "TransferTarget_transferRequestId_projectId_key";

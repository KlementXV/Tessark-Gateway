-- A transfer destination becomes a coordinate (one Harbor, one project name) instead of a
-- foreign key to a Gateway-managed project, so an image can be delivered to a Harbor whose
-- projects the Gateway does not own. See docs/plan-transfers.md, lot 3.

-- The old unique cannot survive: a coordinate spans three nullable columns and Postgres
-- treats NULLs as distinct, so uniqueness moves into validateTransfer().
DROP INDEX "TransferTarget_transferRequestId_projectId_key";

ALTER TABLE "TransferTarget" DROP CONSTRAINT "TransferTarget_projectId_fkey";
ALTER TABLE "TransferTarget" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "TransferTarget" ADD COLUMN "destRegistryId" TEXT;
ALTER TABLE "TransferTarget" ADD COLUMN "destProjectName" TEXT;

-- SetNull rather than Cascade on both sides: a transfer that already ran is history, and
-- deleting the project or registry it aimed at must not erase the record that it happened.
ALTER TABLE "TransferTarget" ADD CONSTRAINT "TransferTarget_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransferTarget" ADD CONSTRAINT "TransferTarget_destRegistryId_fkey"
  FOREIGN KEY ("destRegistryId") REFERENCES "Registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TransferTarget_transferRequestId_idx" ON "TransferTarget"("transferRequestId");
CREATE INDEX "TransferTarget_projectId_idx" ON "TransferTarget"("projectId");
CREATE INDEX "TransferTarget_destRegistryId_idx" ON "TransferTarget"("destRegistryId");

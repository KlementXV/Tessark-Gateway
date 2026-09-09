-- A transfer source becomes a coordinate too: either an allowed upstream host, or a project
-- on a Harbor the Gateway knows. Plus the digest the tag pointed at when the request was
-- raised, so that what a reviewer approves is what actually travels.
-- See docs/plan-transfers.md, lot 4.
ALTER TABLE "TransferRequest" ADD COLUMN "sourceRegistryId" TEXT;
ALTER TABLE "TransferRequest" ADD COLUMN "sourceProjectName" TEXT;
ALTER TABLE "TransferRequest" ADD COLUMN "sourceDigest" TEXT;

ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_sourceRegistryId_fkey"
  FOREIGN KEY ("sourceRegistryId") REFERENCES "Registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TransferRequest_sourceRegistryId_idx" ON "TransferRequest"("sourceRegistryId");

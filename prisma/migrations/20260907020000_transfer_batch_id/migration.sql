-- Several images asked for in one gesture: the rows stay independent (one approval, one status,
-- one retry each), and this only records which paste produced them so the review queue can group
-- them and approve a subset.
ALTER TABLE "TransferRequest" ADD COLUMN "batchId" TEXT;

CREATE INDEX "TransferRequest_batchId_idx" ON "TransferRequest"("batchId");

-- Days of settled request history to keep. 30 by default, 0 disables the purge entirely.
-- Applies to TransferRequest, QuotaRequest and Notification — see src/lib/history/retention.ts.
ALTER TABLE "InstanceSettings" ADD COLUMN "historyRetentionDays" INTEGER NOT NULL DEFAULT 30;

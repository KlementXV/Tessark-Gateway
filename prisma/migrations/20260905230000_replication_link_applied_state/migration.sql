-- What the Gateway actually wrote to the source Harbor for this edge, plus the last time that
-- Harbor confirmed it can reach the peer. All nullable: an existing link has never been
-- fingerprinted nor probed, and the next sync fills both in.
ALTER TABLE "ReplicationLink" ADD COLUMN "appliedFingerprint" TEXT;
ALTER TABLE "ReplicationLink" ADD COLUMN "appliedBaseUrl" TEXT;
ALTER TABLE "ReplicationLink" ADD COLUMN "lastPingAt" TIMESTAMP(3);

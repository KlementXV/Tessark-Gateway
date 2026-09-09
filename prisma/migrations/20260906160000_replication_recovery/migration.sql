ALTER TABLE "ReplicationLink"
 ADD COLUMN "catchUpRequested" BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN "executionId" INTEGER,
 ADD COLUMN "lastExecutionId" INTEGER,
 ADD COLUMN "executionStatus" TEXT,
 ADD COLUMN "executionError" TEXT,
 ADD COLUMN "lastCatchUpAt" TIMESTAMP(3),
 ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "ReplicationCleanup" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "sourceRegistryId" TEXT NOT NULL,
 "destRegistryId" TEXT NOT NULL,
 "encryptedConnection" TEXT NOT NULL,
 "harborPolicyId" INTEGER,
 "harborEndpointId" INTEGER,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

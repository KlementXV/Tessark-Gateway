-- CreateTable
CREATE TABLE "ScheduledMirror" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceId" TEXT,
    "sourceRegistryId" TEXT,
    "sourceProjectName" TEXT,
    "sourceRepo" TEXT NOT NULL,
    "sourceTag" TEXT NOT NULL DEFAULT 'latest',
    "projectId" TEXT,
    "destRegistryId" TEXT,
    "destProjectName" TEXT,
    "targetRepo" TEXT,
    "schedule" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'harbor',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "harborRegistryId" TEXT,
    "harborEndpointId" INTEGER,
    "harborPolicyId" INTEGER,
    "k8sCronJobName" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "lastAppliedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledMirror_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledMirror_name_key" ON "ScheduledMirror"("name");

-- CreateIndex
CREATE INDEX "ScheduledMirror_sourceId_idx" ON "ScheduledMirror"("sourceId");

-- CreateIndex
CREATE INDEX "ScheduledMirror_sourceRegistryId_idx" ON "ScheduledMirror"("sourceRegistryId");

-- CreateIndex
CREATE INDEX "ScheduledMirror_projectId_idx" ON "ScheduledMirror"("projectId");

-- CreateIndex
CREATE INDEX "ScheduledMirror_destRegistryId_idx" ON "ScheduledMirror"("destRegistryId");

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "UpstreamSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_sourceRegistryId_fkey" FOREIGN KEY ("sourceRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_destRegistryId_fkey" FOREIGN KEY ("destRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_harborRegistryId_fkey" FOREIGN KEY ("harborRegistryId") REFERENCES "Registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

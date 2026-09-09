CREATE TABLE "ScheduledBuild" (
 "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "projectId" TEXT NOT NULL,
 "targetRepo" TEXT NOT NULL, "tag" TEXT NOT NULL, "config" TEXT NOT NULL, "schedule" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "applied" BOOLEAN NOT NULL DEFAULT false,
 "appliedRevisionId" TEXT, "lastAppliedAt" TIMESTAMP(3), "lastError" TEXT,
 "deleting" BOOLEAN NOT NULL DEFAULT false, "createdByUserId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ScheduledBuild_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScheduledBuild_name_key" ON "ScheduledBuild"("name");
CREATE UNIQUE INDEX "ScheduledBuild_projectId_targetRepo_tag_key" ON "ScheduledBuild"("projectId", "targetRepo", "tag");
CREATE TABLE "BuildRevision" (
 "id" TEXT NOT NULL PRIMARY KEY, "buildId" TEXT NOT NULL, "config" TEXT NOT NULL,
 "destination" TEXT NOT NULL, "registryId" TEXT NOT NULL, "robotId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BuildRevision_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "ScheduledBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BuildRevision_buildId_idx" ON "BuildRevision"("buildId");
CREATE TABLE "BuildRun" (
 "id" TEXT NOT NULL PRIMARY KEY, "buildId" TEXT NOT NULL, "revisionId" TEXT NOT NULL,
 "jobName" TEXT NOT NULL, "jobUid" TEXT, "origin" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "commit" TEXT, "digest" TEXT, "stage" TEXT, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BuildRun_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "ScheduledBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "BuildRun_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "BuildRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BuildRun_jobName_key" ON "BuildRun"("jobName");
CREATE UNIQUE INDEX "BuildRun_jobUid_key" ON "BuildRun"("jobUid");
CREATE INDEX "BuildRun_buildId_createdAt_idx" ON "BuildRun"("buildId", "createdAt");
CREATE INDEX "BuildRun_status_idx" ON "BuildRun"("status");

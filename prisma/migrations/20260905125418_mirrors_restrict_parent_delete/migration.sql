-- DropForeignKey
ALTER TABLE "ScheduledMirror" DROP CONSTRAINT "ScheduledMirror_destRegistryId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledMirror" DROP CONSTRAINT "ScheduledMirror_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledMirror" DROP CONSTRAINT "ScheduledMirror_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledMirror" DROP CONSTRAINT "ScheduledMirror_sourceRegistryId_fkey";

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "UpstreamSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_sourceRegistryId_fkey" FOREIGN KEY ("sourceRegistryId") REFERENCES "Registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMirror" ADD CONSTRAINT "ScheduledMirror_destRegistryId_fkey" FOREIGN KEY ("destRegistryId") REFERENCES "Registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

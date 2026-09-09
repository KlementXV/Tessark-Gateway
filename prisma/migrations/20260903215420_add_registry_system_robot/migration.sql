-- AlterTable
ALTER TABLE "Registry" ADD COLUMN     "systemRobotId" INTEGER,
ADD COLUMN     "systemRobotName" TEXT,
ADD COLUMN     "systemRobotSecret" TEXT,
ADD COLUMN     "systemRobotSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "externalId" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");


-- AlterTable
ALTER TABLE "Registry" ADD COLUMN     "ldapAppliedAt" TIMESTAMP(3),
ADD COLUMN     "ldapAppliedFingerprint" TEXT;

-- CreateTable
CREATE TABLE "ClusterDirectoryConfig" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "searchDn" TEXT NOT NULL DEFAULT '',
    "encryptedSearchPassword" TEXT,
    "baseDn" TEXT NOT NULL,
    "filter" TEXT NOT NULL DEFAULT '',
    "uid" TEXT NOT NULL DEFAULT 'uid',
    "scope" INTEGER NOT NULL DEFAULT 2,
    "verifyCert" BOOLEAN NOT NULL DEFAULT true,
    "groupBaseDn" TEXT NOT NULL DEFAULT '',
    "groupSearchFilter" TEXT NOT NULL DEFAULT '',
    "groupAttributeName" TEXT NOT NULL DEFAULT 'cn',
    "groupMembershipAttribute" TEXT NOT NULL DEFAULT 'memberof',
    "groupSearchScope" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterDirectoryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClusterDirectoryConfig_clusterId_key" ON "ClusterDirectoryConfig"("clusterId");

-- AddForeignKey
ALTER TABLE "ClusterDirectoryConfig" ADD CONSTRAINT "ClusterDirectoryConfig_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

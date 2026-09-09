-- CreateEnum
CREATE TYPE "ClusterIdentityMode" AS ENUM ('GATEWAY', 'MAPPED');

-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "identityMode" "ClusterIdentityMode" NOT NULL DEFAULT 'GATEWAY';

-- CreateTable
CREATE TABLE "UserClusterIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "harborUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClusterIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserClusterIdentity_userId_clusterId_key" ON "UserClusterIdentity"("userId", "clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "UserClusterIdentity_clusterId_harborUsername_key" ON "UserClusterIdentity"("clusterId", "harborUsername");

-- AddForeignKey
ALTER TABLE "UserClusterIdentity" ADD CONSTRAINT "UserClusterIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClusterIdentity" ADD CONSTRAINT "UserClusterIdentity_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

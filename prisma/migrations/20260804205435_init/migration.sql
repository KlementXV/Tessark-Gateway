-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('PROJECT_ADMIN', 'DEVELOPER', 'GUEST');

-- CreateEnum
CREATE TYPE "PlacementStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "PullRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "authProvider" TEXT NOT NULL DEFAULT 'local',
    "avatarData" BYTEA,
    "avatarMimeType" TEXT,
    "avatarUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "brandName" TEXT NOT NULL DEFAULT 'Tessark',
    "brandTagline" TEXT NOT NULL DEFAULT 'Gateway',
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "logoData" BYTEA,
    "logoMimeType" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "registryUrl" TEXT,
    "replicationMode" TEXT NOT NULL DEFAULT 'event_based',
    "replicationCron" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "username" TEXT,
    "encryptedSecret" TEXT,
    "insecureTLS" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clusterId" TEXT,

    CONSTRAINT "Registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PENDING',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "storageQuotaMib" INTEGER,
    "clusterId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectPlacement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "harborProjectId" INTEGER,
    "harborRetentionId" INTEGER,
    "harborQuotaId" INTEGER,
    "status" "PlacementStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'DEVELOPER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobotAccount" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "unifiedSecret" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RobotAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RobotPlacement" (
    "id" TEXT NOT NULL,
    "robotAccountId" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "harborRobotId" INTEGER,
    "encryptedSecret" TEXT,
    "status" "PlacementStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobotPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "keepLastN" INTEGER NOT NULL DEFAULT 10,
    "tagPattern" TEXT NOT NULL DEFAULT '**',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "username" TEXT,
    "encryptedSecret" TEXT,
    "allowedRepos" TEXT NOT NULL DEFAULT '["**"]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpstreamSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceRepo" TEXT NOT NULL,
    "sourceTag" TEXT NOT NULL DEFAULT 'latest',
    "sourceImage" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "PullRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullTarget" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetRepo" TEXT,
    "profileId" TEXT,
    "status" "PullRequestStatus" NOT NULL DEFAULT 'PENDING',
    "k8sJobName" TEXT,
    "errorMessage" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingOperation" (
    "id" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "projectId" TEXT,
    "robotAccountId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplicationLink" (
    "id" TEXT NOT NULL,
    "sourceRegistryId" TEXT NOT NULL,
    "destRegistryId" TEXT NOT NULL,
    "harborEndpointId" INTEGER,
    "harborPolicyId" INTEGER,
    "status" "PlacementStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplicationLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_name_key" ON "Cluster"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Registry_baseUrl_key" ON "Registry"("baseUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Project_clusterId_name_key" ON "Project"("clusterId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectPlacement_projectId_registryId_key" ON "ProjectPlacement"("projectId", "registryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RobotAccount_projectId_name_key" ON "RobotAccount"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RobotPlacement_robotAccountId_registryId_key" ON "RobotPlacement"("robotAccountId", "registryId");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_projectId_key" ON "RetentionPolicy"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamSource_name_key" ON "UpstreamSource"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamSource_host_key" ON "UpstreamSource"("host");

-- CreateIndex
CREATE UNIQUE INDEX "PullTarget_pullRequestId_projectId_key" ON "PullTarget"("pullRequestId", "projectId");

-- CreateIndex
CREATE INDEX "PendingOperation_registryId_createdAt_idx" ON "PendingOperation"("registryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplicationLink_sourceRegistryId_destRegistryId_key" ON "ReplicationLink"("sourceRegistryId", "destRegistryId");

-- AddForeignKey
ALTER TABLE "Registry" ADD CONSTRAINT "Registry_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPlacement" ADD CONSTRAINT "ProjectPlacement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPlacement" ADD CONSTRAINT "ProjectPlacement_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotAccount" ADD CONSTRAINT "RobotAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotPlacement" ADD CONSTRAINT "RobotPlacement_robotAccountId_fkey" FOREIGN KEY ("robotAccountId") REFERENCES "RobotAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RobotPlacement" ADD CONSTRAINT "RobotPlacement_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "UpstreamSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullTarget" ADD CONSTRAINT "PullTarget_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullTarget" ADD CONSTRAINT "PullTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingOperation" ADD CONSTRAINT "PendingOperation_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplicationLink" ADD CONSTRAINT "ReplicationLink_sourceRegistryId_fkey" FOREIGN KEY ("sourceRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplicationLink" ADD CONSTRAINT "ReplicationLink_destRegistryId_fkey" FOREIGN KEY ("destRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('PROJECT_REQUESTED', 'PROJECT_APPROVED', 'PROJECT_REJECTED', 'PULL_REQUESTED', 'PULL_APPROVED', 'PULL_REJECTED', 'QUOTA_REQUESTED', 'QUOTA_APPROVED', 'QUOTA_REJECTED', 'MEMBER_ADDED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

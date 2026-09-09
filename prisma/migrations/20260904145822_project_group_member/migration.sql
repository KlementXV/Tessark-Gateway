-- CreateTable
CREATE TABLE "ProjectGroupMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'DEVELOPER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGroupMember_projectId_groupName_key" ON "ProjectGroupMember"("projectId", "groupName");

-- AddForeignKey
ALTER TABLE "ProjectGroupMember" ADD CONSTRAINT "ProjectGroupMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

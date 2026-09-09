-- The policy layer: who may move what, from where, to where. Without a matching enabled rule
-- a transfer is refused, so the seeding at the bottom is what keeps existing installations
-- working — one rule per enabled upstream source, reproducing today's behaviour exactly.
-- See docs/plan-transfers.md, lot 5.
CREATE TABLE "TransferRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceUpstreamId" TEXT,
    "sourceRegistryId" TEXT,
    "destRegistryId" TEXT,
    "projectFilter" TEXT NOT NULL DEFAULT '["**"]',
    "repoFilter" TEXT NOT NULL DEFAULT '["**"]',
    "transport" TEXT NOT NULL DEFAULT 'skopeo',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "skopeoOverrides" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransferRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TransferRule_name_key" ON "TransferRule"("name");
CREATE INDEX "TransferRule_sourceUpstreamId_idx" ON "TransferRule"("sourceUpstreamId");
CREATE INDEX "TransferRule_sourceRegistryId_idx" ON "TransferRule"("sourceRegistryId");
CREATE INDEX "TransferRule_destRegistryId_idx" ON "TransferRule"("destRegistryId");

ALTER TABLE "TransferRule" ADD CONSTRAINT "TransferRule_sourceUpstreamId_fkey"
  FOREIGN KEY ("sourceUpstreamId") REFERENCES "UpstreamSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransferRule" ADD CONSTRAINT "TransferRule_sourceRegistryId_fkey"
  FOREIGN KEY ("sourceRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransferRule" ADD CONSTRAINT "TransferRule_destRegistryId_fkey"
  FOREIGN KEY ("destRegistryId") REFERENCES "Registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Compatibility: every upstream source that exists today was, by definition, allowed to reach
-- every managed project — that was the only shape a request could take. One rule each keeps
-- that true under the new default-deny, with approval still required exactly as before.
-- `md5(...)` only needs to be stable and unique here; these ids never leave the database.
INSERT INTO "TransferRule" ("id", "name", "description", "sourceUpstreamId", "destRegistryId", "requiresApproval", "updatedAt")
SELECT
    'rule_' || md5("id"),
    'Mirror from ' || "name",
    'Created automatically when transfer rules were introduced, to preserve this source''s existing reach.',
    "id",
    NULL,
    true,
    CURRENT_TIMESTAMP
FROM "UpstreamSource";

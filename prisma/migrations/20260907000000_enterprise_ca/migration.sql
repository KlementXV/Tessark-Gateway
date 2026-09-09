-- The private CA moves from each connection to a single instance-wide bundle: an internal
-- authority signs the whole estate, and one copy per registry and per source is one copy to
-- forget when it is rotated.
ALTER TABLE "InstanceSettings" ADD COLUMN "enterpriseCaPem" TEXT;

-- Carry over whatever the beta already stored rather than dropping it silently. Deterministic
-- despite the LIMIT: an instance with two different bundles has no right answer here, and the
-- admin has to re-paste the one they mean — the alternative is choosing for them.
INSERT INTO "InstanceSettings" ("id", "updatedAt") VALUES ('default', now())
  ON CONFLICT ("id") DO NOTHING;

UPDATE "InstanceSettings"
   SET "enterpriseCaPem" = COALESCE(
         (SELECT "customCaPem" FROM "Registry"       WHERE "customCaPem" IS NOT NULL ORDER BY "id" LIMIT 1),
         (SELECT "customCaPem" FROM "UpstreamSource" WHERE "customCaPem" IS NOT NULL ORDER BY "id" LIMIT 1))
 WHERE "id" = 'default' AND "enterpriseCaPem" IS NULL;

ALTER TABLE "Registry" DROP COLUMN "customCaPem";
ALTER TABLE "UpstreamSource" DROP COLUMN "customCaPem";

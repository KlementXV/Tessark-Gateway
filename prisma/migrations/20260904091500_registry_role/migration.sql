-- What the Gateway may do with a Harbor: own it (the existing behaviour) or only deliver
-- images into it. Every existing registry is MANAGED, so behaviour is unchanged on upgrade.
-- See docs/plan-transfers.md, lot 2.
CREATE TYPE "RegistryRole" AS ENUM ('MANAGED', 'DELIVERY');
ALTER TABLE "Registry" ADD COLUMN "role" "RegistryRole" NOT NULL DEFAULT 'MANAGED';

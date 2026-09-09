-- Harbor project metadata `auto_scan` / `auto_sbom_generation`, fanned out to every cluster
-- member like isPublic and the storage quota. Default false: an existing project keeps the
-- behaviour it has today until someone turns these on.
ALTER TABLE "Project" ADD COLUMN "autoScan" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "autoSbom" BOOLEAN NOT NULL DEFAULT false;

-- Default answer for "do the skopeo copy Jobs get the enterprise CA?". True keeps the
-- behaviour introduced with the bundle itself; the transfer dialog's per-run switch starts
-- from this value.
ALTER TABLE "InstanceSettings" ADD COLUMN "enterpriseCaJobDefault" BOOLEAN NOT NULL DEFAULT true;

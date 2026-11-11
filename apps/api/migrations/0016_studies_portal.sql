-- Studies (lab, imaging, documents) attached to the clinical record, and what the patient sees in
-- their portal (shared_at).
ALTER TABLE "record_photos" DROP CONSTRAINT IF EXISTS "record_photos_kind";
--> statement-breakpoint
ALTER TABLE "record_photos" ADD CONSTRAINT "record_photos_kind" CHECK ("kind" IN ('before', 'after', 'other', 'lab', 'imaging', 'document'));
--> statement-breakpoint
ALTER TABLE "record_photos" ADD COLUMN IF NOT EXISTS "shared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD COLUMN IF NOT EXISTS "shared_at" timestamp with time zone;

-- T12 (ADR-53): latest website check per lead, stored as untrusted data.
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "websiteEnrichment" JSONB;

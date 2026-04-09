-- Migration: add_council_columns
-- Adds councilSize and councilReport columns to the tasks table.

ALTER TABLE "tasks" ADD COLUMN "council_size" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "tasks" ADD COLUMN "council_report" JSONB;

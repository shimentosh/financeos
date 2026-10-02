-- Renewal reminders go out three times: two days before, the day before, and on the due day.
-- Only lists still on the old default change; a list someone customised is left as it is.
UPDATE "workspace"
SET "settings" = jsonb_set("settings", '{reminderOffsets}', '[2, 1, 0]'::jsonb)
WHERE "settings"->'reminderOffsets' = '[30, 14, 7, 3, 1, 0]'::jsonb;
--> statement-breakpoint
UPDATE "commitment"
SET "reminder_offsets" = ARRAY[2, 1, 0]
WHERE "reminder_offsets" = ARRAY[30, 14, 7, 3, 1, 0];

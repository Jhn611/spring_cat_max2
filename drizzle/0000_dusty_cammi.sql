CREATE TABLE IF NOT EXISTS "event_slots" (
	"event_id" text NOT NULL,
	"id" text NOT NULL,
	"label" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_slots_event_id_id_pk" PRIMARY KEY("event_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" text PRIMARY KEY NOT NULL,
	"university_id" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"format" text NOT NULL,
	"capacity" integer NOT NULL,
	"description" text NOT NULL,
	"requirements" text NOT NULL,
	"location_or_url" text NOT NULL,
	"cancel_policy" text NOT NULL,
	"registration_closed" boolean NOT NULL,
	"late_cancel_allowed" boolean NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"event_id" text NOT NULL,
	"slot_id" text,
	"user_id" bigint NOT NULL,
	"user_name" text NOT NULL,
	"status" text NOT NULL,
	"notifications_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "registrations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "universities" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"short_title" text NOT NULL,
	"city" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"role" text NOT NULL,
	"university_id" text,
	"consent_json" jsonb,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_slots_event_id_idx" ON "event_slots" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_university_id_idx" ON "events" USING btree ("university_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_deleted_at_idx" ON "events" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registrations_event_id_idx" ON "registrations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registrations_user_id_idx" ON "registrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_university_id_idx" ON "users" USING btree ("university_id");

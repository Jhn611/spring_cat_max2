CREATE TABLE "event_registrars" (
	"event_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"assigned_by" bigint NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_registrars_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "attended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "attended_by" bigint;--> statement-breakpoint
CREATE INDEX "event_registrars_user_id_idx" ON "event_registrars" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_registrars_event_id_idx" ON "event_registrars" USING btree ("event_id");
CREATE TABLE "external_logins" (
	"login" text PRIMARY KEY NOT NULL,
	"user_id" bigint,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "external_logins_user_id_idx" ON "external_logins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "external_logins_code_expires_at_idx" ON "external_logins" USING btree ("code_expires_at");
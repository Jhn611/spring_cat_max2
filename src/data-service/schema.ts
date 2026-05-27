import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const universities = pgTable('universities', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  shortTitle: text('short_title').notNull(),
  city: text('city').notNull(),
  description: text('description').notNull()
});

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  username: text('username'),
  role: text('role').notNull(),
  universityId: text('university_id'),
  consent: jsonb('consent_json'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
});

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  universityId: text('university_id').notNull(),
  title: text('title').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  format: text('format').notNull(),
  capacity: integer('capacity').notNull(),
  description: text('description').notNull(),
  requirements: text('requirements').notNull(),
  locationOrUrl: text('location_or_url').notNull(),
  cancelPolicy: text('cancel_policy').notNull(),
  registrationClosed: boolean('registration_closed').notNull(),
  lateCancelAllowed: boolean('late_cancel_allowed').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
});

export const eventSlots = pgTable(
  'event_slots',
  {
    eventId: text('event_id').notNull(),
    id: text('id').notNull(),
    label: text('label').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull()
  },
  (table) => [primaryKey({ columns: [table.eventId, table.id] })]
);

export const registrations = pgTable('registrations', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  eventId: text('event_id').notNull(),
  slotId: text('slot_id'),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  userName: text('user_name').notNull(),
  status: text('status').notNull(),
  notificationsEnabled: boolean('notifications_enabled').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
});

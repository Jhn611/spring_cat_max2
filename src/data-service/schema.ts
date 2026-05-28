import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Drizzle-схема является источником правды для структуры PostgreSQL. Миграции
// строятся вокруг этих таблиц, а DatabaseStore использует их вместо ручного SQL.
export const universities = pgTable('universities', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  shortTitle: text('short_title').notNull(),
  city: text('city').notNull(),
  description: text('description').notNull()
});

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    username: text('username'),
    role: text('role').notNull(),
    universityId: text('university_id'),
    consent: jsonb('consent_json'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
  },
  (table) => [index('users_role_idx').on(table.role), index('users_university_id_idx').on(table.universityId)]
);

export const events = pgTable(
  'events',
  {
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
  },
  (table) => [index('events_university_id_idx').on(table.universityId), index('events_deleted_at_idx').on(table.deletedAt)]
);

export const eventSlots = pgTable(
  'event_slots',
  {
    eventId: text('event_id').notNull(),
    id: text('id').notNull(),
    label: text('label').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull()
  },
  (table) => [primaryKey({ columns: [table.eventId, table.id] }), index('event_slots_event_id_idx').on(table.eventId)]
);

export const registrations = pgTable(
  'registrations',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    eventId: text('event_id').notNull(),
    slotId: text('slot_id'),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    userName: text('user_name').notNull(),
    status: text('status').notNull(),
    notificationsEnabled: boolean('notifications_enabled').notNull(),
    attendedAt: timestamp('attended_at', { withTimezone: true }),
    attendedBy: bigint('attended_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
  },
  (table) => [index('registrations_event_id_idx').on(table.eventId), index('registrations_user_id_idx').on(table.userId)]
);

export const eventRegistrars = pgTable(
  'event_registrars',
  {
    eventId: text('event_id').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    assignedBy: bigint('assigned_by', { mode: 'number' }).notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId] }),
    index('event_registrars_user_id_idx').on(table.userId),
    index('event_registrars_event_id_idx').on(table.eventId)
  ]
);

export const externalLogins = pgTable(
  'external_logins',
  {
    login: text('login').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }),
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
  },
  (table) => [index('external_logins_user_id_idx').on(table.userId), index('external_logins_code_expires_at_idx').on(table.codeExpiresAt)]
);

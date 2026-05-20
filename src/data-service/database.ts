import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { events as seedEvents } from './seed-events.js';
import { isActiveStatus } from '../shared/domain.js';
import type { EventCard, Registration, Role, StoredUser } from '../shared/types.js';

type DbUserRow = {
  id: number;
  name: string;
  username: string | null;
  role: Role;
  consent_json: string | null;
  updated_at: string;
};

type DbRegistrationRow = {
  id: string;
  code: string;
  event_id: string;
  slot_id: string | null;
  user_id: number;
  user_name: string;
  status: Registration['status'];
  notifications_enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

type DbEventRow = {
  id: string;
  data_json: string;
};

export class DatabaseStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.seedEvents();
  }

  listEvents(): EventCard[] {
    const rows = this.db.prepare('SELECT data_json FROM events ORDER BY starts_at').all() as Array<{ data_json: string }>;
    return rows.map((row) => JSON.parse(row.data_json) as EventCard);
  }

  getEvent(eventId: string): EventCard | undefined {
    const row = this.db.prepare('SELECT data_json FROM events WHERE id = ?').get(eventId) as DbEventRow | undefined;
    return row ? (JSON.parse(row.data_json) as EventCard) : undefined;
  }

  listManageableEvents(userId: number, role: Role): EventCard[] {
    const events = this.listEvents();
    return role === 'admin' ? events : events.filter((event) => event.organizerIds.includes(userId));
  }

  freeSeats(eventId: string): number {
    const event = this.getEvent(eventId);

    if (!event) {
      return 0;
    }

    const registrations = this.listRegistrations(eventId);
    const occupied = registrations.filter((item) => isActiveStatus(item.status)).length;
    return Math.max(event.capacity - occupied, 0);
  }

  upsertUser(user: Omit<StoredUser, 'updatedAt'>): StoredUser {
    const existing = this.getUser(user.id);
    const next: StoredUser = { ...existing, ...user, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        [
          'INSERT INTO users (id, name, username, role, consent_json, updated_at)',
          'VALUES (?, ?, ?, ?, ?, ?)',
          'ON CONFLICT(id) DO UPDATE SET',
          'name = excluded.name, username = excluded.username, role = excluded.role,',
          'consent_json = excluded.consent_json, updated_at = excluded.updated_at'
        ].join(' ')
      )
      .run(next.id, next.name, next.username ?? null, next.role, next.consent ? JSON.stringify(next.consent) : null, next.updatedAt);
    return next;
  }

  getUser(userId: number): StoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUserRow | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  setUserRole(userId: number, role: Role): void {
    this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, new Date().toISOString(), userId);
  }

  createRegistration(registration: Registration): void {
    this.db
      .prepare(
        [
          'INSERT INTO registrations',
          '(id, code, event_id, slot_id, user_id, user_name, status, notifications_enabled, created_at, updated_at)',
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ].join(' ')
      )
      .run(
        registration.id,
        registration.code,
        registration.eventId,
        registration.slotId ?? null,
        registration.userId,
        registration.userName,
        registration.status,
        registration.notificationsEnabled ? 1 : 0,
        registration.createdAt,
        registration.updatedAt
      );
  }

  updateRegistration(id: string, patch: Partial<Registration>): Registration | undefined {
    const current = this.listRegistrations().find((item) => item.id === id);

    if (!current) {
      return undefined;
    }

    const next: Registration = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        [
          'UPDATE registrations SET',
          'code = ?, event_id = ?, slot_id = ?, user_id = ?, user_name = ?, status = ?,',
          'notifications_enabled = ?, created_at = ?, updated_at = ? WHERE id = ?'
        ].join(' ')
      )
      .run(
        next.code,
        next.eventId,
        next.slotId ?? null,
        next.userId,
        next.userName,
        next.status,
        next.notificationsEnabled ? 1 : 0,
        next.createdAt,
        next.updatedAt,
        next.id
      );
    return next;
  }

  listRegistrations(eventId?: string, userId?: number): Registration[] {
    let query = 'SELECT * FROM registrations';
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (eventId) {
      clauses.push('event_id = ?');
      params.push(eventId);
    }

    if (userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(userId);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }

    query += ' ORDER BY created_at DESC';
    return (this.db.prepare(query).all(...params) as DbRegistrationRow[]).map(this.mapRegistration);
  }

  findRegistrationByCode(code: string): Registration | undefined {
    const normalized = code.trim().toUpperCase();
    const row = this.db.prepare('SELECT * FROM registrations WHERE code = ?').get(normalized) as DbRegistrationRow | undefined;
    return row ? this.mapRegistration(row) : undefined;
  }

  activeRegistration(userId: number, eventId: string): Registration | undefined {
    return this.listRegistrations(eventId, userId).find((item) => isActiveStatus(item.status));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT,
        role TEXT NOT NULL,
        consent_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        starts_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        slot_id TEXT,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        status TEXT NOT NULL,
        notifications_enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
  }

  private seedEvents(): void {
    const insert = this.db.prepare(
      'INSERT INTO events (id, starts_at, data_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET starts_at = excluded.starts_at, data_json = excluded.data_json'
    );

    for (const event of seedEvents) {
      insert.run(event.id, event.startsAt, JSON.stringify(event));
    }
  }

  private mapUser(row: DbUserRow): StoredUser {
    return {
      id: row.id,
      name: row.name,
      username: row.username ?? undefined,
      role: row.role,
      consent: row.consent_json ? JSON.parse(row.consent_json) : undefined,
      updatedAt: row.updated_at
    };
  }

  private mapRegistration(row: DbRegistrationRow): Registration {
    return {
      id: row.id,
      code: row.code,
      eventId: row.event_id,
      slotId: row.slot_id ?? undefined,
      userId: row.user_id,
      userName: row.user_name,
      status: row.status,
      notificationsEnabled: row.notifications_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

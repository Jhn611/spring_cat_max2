import pg from 'pg';
import { events as seedEvents } from './seed-events.js';
import { universities as seedUniversities } from './seed-universities.js';
import { isActiveStatus } from '../shared/domain.js';
import type { EventCard, Registration, Role, StoredUser, University } from '../shared/types.js';

const { Pool } = pg;

type DbUserRow = {
  id: string;
  name: string;
  username: string | null;
  role: Role;
  university_id: string | null;
  consent_json: string | object | null;
  updated_at: Date | string;
};

type DbRegistrationRow = {
  id: string;
  code: string;
  event_id: string;
  slot_id: string | null;
  user_id: string;
  user_name: string;
  status: Registration['status'];
  notifications_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbEventRow = {
  id: string;
  data_json: EventCard | string;
};

type DbUniversityRow = {
  id: string;
  title: string;
  short_title: string;
  city: string;
  description: string;
};

export class DatabaseStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.migrate();
    await this.seedUniversities();
    await this.seedEvents();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listUniversities(): Promise<University[]> {
    const { rows } = await this.pool.query<DbUniversityRow>('SELECT * FROM universities ORDER BY title');
    return rows.map((row) => this.mapUniversity(row));
  }

  async getUniversity(universityId: string): Promise<University | undefined> {
    const { rows } = await this.pool.query<DbUniversityRow>('SELECT * FROM universities WHERE id = $1', [universityId]);
    return rows[0] ? this.mapUniversity(rows[0]) : undefined;
  }

  async listEvents(universityId?: string): Promise<EventCard[]> {
    const params = universityId ? [universityId] : [];
    const where = universityId ? 'WHERE university_id = $1' : '';
    const { rows } = await this.pool.query<{ data_json: EventCard | string }>(
      `SELECT data_json FROM events ${where} ORDER BY starts_at`,
      params
    );
    return rows.map((row) => this.parseEvent(row.data_json));
  }

  async getEvent(eventId: string): Promise<EventCard | undefined> {
    const { rows } = await this.pool.query<DbEventRow>('SELECT data_json FROM events WHERE id = $1', [eventId]);
    return rows[0] ? this.parseEvent(rows[0].data_json) : undefined;
  }

  async listManageableEvents(userId: number, role: Role): Promise<EventCard[]> {
    const user = await this.getUser(userId);
    const events = await this.listEvents();

    if (role === 'tech_admin') {
      return events;
    }

    if (role === 'admin') {
      return user?.universityId ? events.filter((event) => event.universityId === user.universityId) : [];
    }

    return events.filter((event) => event.universityId === user?.universityId || event.organizerIds.includes(userId));
  }

  async listUsers(role?: Role, universityId?: string): Promise<StoredUser[]> {
    const clauses: string[] = [];
    const params: string[] = [];

    if (role) {
      params.push(role);
      clauses.push(`role = $${params.length}`);
    }

    if (universityId) {
      params.push(universityId);
      clauses.push(`university_id = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query<DbUserRow>(`SELECT * FROM users ${where} ORDER BY updated_at DESC`, params);
    return rows.map((row) => this.mapUser(row));
  }

  async freeSeats(eventId: string): Promise<number> {
    const event = await this.getEvent(eventId);

    if (!event) {
      return 0;
    }

    const registrations = await this.listRegistrations(eventId);
    const occupied = registrations.filter((item) => isActiveStatus(item.status)).length;
    return Math.max(event.capacity - occupied, 0);
  }

  async upsertUser(user: Omit<StoredUser, 'updatedAt'>): Promise<StoredUser> {
    const existing = await this.getUser(user.id);
    const next: StoredUser = { ...existing, ...user, universityId: existing?.universityId ?? user.universityId, updatedAt: new Date().toISOString() };

    await this.pool.query(
      [
        'INSERT INTO users (id, name, username, role, university_id, consent_json, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6, $7)',
        'ON CONFLICT(id) DO UPDATE SET',
        'name = EXCLUDED.name, username = EXCLUDED.username, role = EXCLUDED.role,',
        "university_id = CASE WHEN EXCLUDED.role IN ('tech_admin', 'applicant') THEN NULL ELSE COALESCE(users.university_id, EXCLUDED.university_id) END,",
        'consent_json = EXCLUDED.consent_json, updated_at = EXCLUDED.updated_at'
      ].join(' '),
      [
        next.id,
        next.name,
        next.username ?? null,
        next.role,
        next.universityId ?? null,
        next.consent ? JSON.stringify(next.consent) : null,
        next.updatedAt
      ]
    );

    return next;
  }

  async getUser(userId: number): Promise<StoredUser | undefined> {
    const { rows } = await this.pool.query<DbUserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return rows[0] ? this.mapUser(rows[0]) : undefined;
  }

  async setUserRole(userId: number, role: Role, universityId?: string | null): Promise<StoredUser> {
    const existing = await this.getUser(userId);
    const now = new Date().toISOString();
    const next: StoredUser = {
      id: userId,
      name: existing?.name ?? `MAX ID ${userId}`,
      username: existing?.username,
      role,
      universityId: role === 'tech_admin' || role === 'applicant' ? undefined : universityId ?? existing?.universityId,
      consent: existing?.consent,
      updatedAt: now
    };

    await this.pool.query(
      [
        'INSERT INTO users (id, name, username, role, university_id, consent_json, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6, $7)',
        'ON CONFLICT(id) DO UPDATE SET',
        'role = EXCLUDED.role, university_id = EXCLUDED.university_id, updated_at = EXCLUDED.updated_at'
      ].join(' '),
      [
        next.id,
        next.name,
        next.username ?? null,
        next.role,
        next.universityId ?? null,
        next.consent ? JSON.stringify(next.consent) : null,
        now
      ]
    );

    return next;
  }

  async createRegistration(registration: Registration): Promise<void> {
    await this.pool.query(
      [
        'INSERT INTO registrations',
        '(id, code, event_id, slot_id, user_id, user_name, status, notifications_enabled, created_at, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)'
      ].join(' '),
      [
        registration.id,
        registration.code,
        registration.eventId,
        registration.slotId ?? null,
        registration.userId,
        registration.userName,
        registration.status,
        registration.notificationsEnabled,
        registration.createdAt,
        registration.updatedAt
      ]
    );
  }

  async updateRegistration(id: string, patch: Partial<Registration>): Promise<Registration | undefined> {
    const current = (await this.listRegistrations()).find((item) => item.id === id);

    if (!current) {
      return undefined;
    }

    const next: Registration = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.pool.query(
      [
        'UPDATE registrations SET',
        'code = $1, event_id = $2, slot_id = $3, user_id = $4, user_name = $5, status = $6,',
        'notifications_enabled = $7, created_at = $8, updated_at = $9 WHERE id = $10'
      ].join(' '),
      [
        next.code,
        next.eventId,
        next.slotId ?? null,
        next.userId,
        next.userName,
        next.status,
        next.notificationsEnabled,
        next.createdAt,
        next.updatedAt,
        next.id
      ]
    );

    return next;
  }

  async listRegistrations(eventId?: string, userId?: number): Promise<Registration[]> {
    let query = 'SELECT * FROM registrations';
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (eventId) {
      params.push(eventId);
      clauses.push(`event_id = $${params.length}`);
    }

    if (userId !== undefined) {
      params.push(userId);
      clauses.push(`user_id = $${params.length}`);
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }

    query += ' ORDER BY created_at DESC';
    const { rows } = await this.pool.query<DbRegistrationRow>(query, params);
    return rows.map((row) => this.mapRegistration(row));
  }

  async findRegistrationByCode(code: string): Promise<Registration | undefined> {
    const normalized = code.trim().toUpperCase();
    const { rows } = await this.pool.query<DbRegistrationRow>('SELECT * FROM registrations WHERE code = $1', [normalized]);
    return rows[0] ? this.mapRegistration(rows[0]) : undefined;
  }

  async activeRegistration(userId: number, eventId: string): Promise<Registration | undefined> {
    return (await this.listRegistrations(eventId, userId)).find((item) => isActiveStatus(item.status));
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS universities (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        short_title TEXT NOT NULL,
        city TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT,
        role TEXT NOT NULL,
        university_id TEXT REFERENCES universities(id),
        consent_json JSONB,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        university_id TEXT REFERENCES universities(id),
        starts_at TIMESTAMPTZ NOT NULL,
        data_json JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL REFERENCES events(id),
        slot_id TEXT,
        user_id BIGINT NOT NULL REFERENCES users(id),
        user_name TEXT NOT NULL,
        status TEXT NOT NULL,
        notifications_enabled BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);

    await this.pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS university_id TEXT');
    await this.pool.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS university_id TEXT');
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS events_university_id_idx ON events(university_id);
      CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
      CREATE INDEX IF NOT EXISTS users_university_id_idx ON users(university_id);
      CREATE INDEX IF NOT EXISTS registrations_event_id_idx ON registrations(event_id);
      CREATE INDEX IF NOT EXISTS registrations_user_id_idx ON registrations(user_id);
    `);
  }

  private async seedUniversities(): Promise<void> {
    for (const university of seedUniversities) {
      await this.pool.query(
        [
          'INSERT INTO universities (id, title, short_title, city, description)',
          'VALUES ($1, $2, $3, $4, $5)',
          'ON CONFLICT(id) DO UPDATE SET',
          'title = EXCLUDED.title, short_title = EXCLUDED.short_title,',
          'city = EXCLUDED.city, description = EXCLUDED.description'
        ].join(' '),
        [university.id, university.title, university.shortTitle, university.city, university.description]
      );
    }
  }

  private async seedEvents(): Promise<void> {
    for (const event of seedEvents) {
      await this.pool.query(
        [
          'INSERT INTO events (id, university_id, starts_at, data_json)',
          'VALUES ($1, $2, $3, $4)',
          'ON CONFLICT(id) DO UPDATE SET',
          'university_id = EXCLUDED.university_id, starts_at = EXCLUDED.starts_at, data_json = EXCLUDED.data_json'
        ].join(' '),
        [event.id, event.universityId, event.startsAt, JSON.stringify(event)]
      );
    }
  }

  private parseEvent(value: EventCard | string): EventCard {
    return typeof value === 'string' ? (JSON.parse(value) as EventCard) : value;
  }

  private parseJson<T>(value: string | object | null): T | undefined {
    if (!value) {
      return undefined;
    }

    return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
  }

  private mapUser(row: DbUserRow): StoredUser {
    return {
      id: Number(row.id),
      name: row.name,
      username: row.username ?? undefined,
      role: row.role,
      universityId: row.university_id ?? undefined,
      consent: this.parseJson(row.consent_json),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private mapRegistration(row: DbRegistrationRow): Registration {
    return {
      id: row.id,
      code: row.code,
      eventId: row.event_id,
      slotId: row.slot_id ?? undefined,
      userId: Number(row.user_id),
      userName: row.user_name,
      status: row.status,
      notificationsEnabled: row.notifications_enabled,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private mapUniversity(row: DbUniversityRow): University {
    return {
      id: row.id,
      title: row.title,
      shortTitle: row.short_title,
      city: row.city,
      description: row.description
    };
  }
}

import pg from 'pg';
import { events as seedEvents } from './seed-events.js';
import { isActiveStatus } from '../shared/domain.js';
import type { EventCard, Registration, Role, StoredUser } from '../shared/types.js';

const { Pool } = pg;

type DbUserRow = {
  id: string;
  name: string;
  username: string | null;
  role: Role;
  consent_json: string | null;
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

export class DatabaseStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.migrate();
    await this.seedEvents();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listEvents(): Promise<EventCard[]> {
    const { rows } = await this.pool.query<{ data_json: EventCard | string }>(
      'SELECT data_json FROM events ORDER BY starts_at'
    );
    return rows.map((row) => this.parseEvent(row.data_json));
  }

  async getEvent(eventId: string): Promise<EventCard | undefined> {
    const { rows } = await this.pool.query<DbEventRow>('SELECT data_json FROM events WHERE id = $1', [eventId]);
    return rows[0] ? this.parseEvent(rows[0].data_json) : undefined;
  }

  async listManageableEvents(userId: number, role: Role): Promise<EventCard[]> {
    const events = await this.listEvents();
    return role === 'admin' || role === 'tech_admin' ? events : events.filter((event) => event.organizerIds.includes(userId));
  }

  async listUsers(role?: Role): Promise<StoredUser[]> {
    const result = role
      ? await this.pool.query<DbUserRow>('SELECT * FROM users WHERE role = $1 ORDER BY updated_at DESC', [role])
      : await this.pool.query<DbUserRow>('SELECT * FROM users ORDER BY updated_at DESC');
    return result.rows.map((row) => this.mapUser(row));
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
    const next: StoredUser = { ...existing, ...user, updatedAt: new Date().toISOString() };

    await this.pool.query(
      [
        'INSERT INTO users (id, name, username, role, consent_json, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6)',
        'ON CONFLICT(id) DO UPDATE SET',
        'name = EXCLUDED.name, username = EXCLUDED.username, role = EXCLUDED.role,',
        'consent_json = EXCLUDED.consent_json, updated_at = EXCLUDED.updated_at'
      ].join(' '),
      [
        next.id,
        next.name,
        next.username ?? null,
        next.role,
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

  async setUserRole(userId: number, role: Role): Promise<StoredUser> {
    const existing = await this.getUser(userId);
    const now = new Date().toISOString();
    const next: StoredUser = {
      id: userId,
      name: existing?.name ?? `MAX ID ${userId}`,
      username: existing?.username,
      role,
      consent: existing?.consent,
      updatedAt: now
    };

    await this.pool.query(
      [
        'INSERT INTO users (id, name, username, role, consent_json, updated_at)',
        'VALUES ($1, $2, $3, $4, $5, $6)',
        'ON CONFLICT(id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at'
      ].join(' '),
      [next.id, next.name, next.username ?? null, next.role, next.consent ? JSON.stringify(next.consent) : null, now]
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
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT,
        role TEXT NOT NULL,
        consent_json JSONB,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS registrations_event_id_idx ON registrations(event_id);
      CREATE INDEX IF NOT EXISTS registrations_user_id_idx ON registrations(user_id);
    `);
  }

  private async seedEvents(): Promise<void> {
    for (const event of seedEvents) {
      await this.pool.query(
        [
          'INSERT INTO events (id, starts_at, data_json)',
          'VALUES ($1, $2, $3)',
          'ON CONFLICT(id) DO UPDATE SET starts_at = EXCLUDED.starts_at, data_json = EXCLUDED.data_json'
        ].join(' '),
        [event.id, event.startsAt, JSON.stringify(event)]
      );
    }
  }

  private parseEvent(value: EventCard | string): EventCard {
    return typeof value === 'string' ? (JSON.parse(value) as EventCard) : value;
  }

  private mapUser(row: DbUserRow): StoredUser {
    const consent =
      typeof row.consent_json === 'string' ? JSON.parse(row.consent_json) : row.consent_json ?? undefined;

    return {
      id: Number(row.id),
      name: row.name,
      username: row.username ?? undefined,
      role: row.role,
      consent,
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
}

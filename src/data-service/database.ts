import pg from 'pg';
import { isActiveStatus } from '../shared/domain.js';
import type { EventCard, EventFormat, EventSlot, Registration, Role, StoredUser, University } from '../shared/types.js';

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
  university_id: string;
  title: string;
  starts_at: Date | string;
  duration_minutes: number;
  format: EventFormat;
  capacity: number;
  description: string;
  requirements: string;
  location_or_url: string;
  cancel_policy: string;
  registration_closed: boolean;
  late_cancel_allowed: boolean;
};

type DbEventSlotRow = {
  id: string;
  label: string;
  starts_at: Date | string;
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
    const { rows } = await this.pool.query<DbEventRow>(`SELECT * FROM events ${where} ORDER BY starts_at`, params);
    return Promise.all(rows.map((row) => this.mapEvent(row)));
  }

  async getEvent(eventId: string): Promise<EventCard | undefined> {
    const { rows } = await this.pool.query<DbEventRow>('SELECT * FROM events WHERE id = $1', [eventId]);
    return rows[0] ? this.mapEvent(rows[0]) : undefined;
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

    return events.filter((event) => event.universityId === user?.universityId);
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
    const next: StoredUser = {
      ...existing,
      ...user,
      universityId: existing?.universityId ?? user.universityId,
      updatedAt: new Date().toISOString()
    };

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
        university_id TEXT,
        consent_json JSONB,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        university_id TEXT,
        starts_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_slots (
        event_id TEXT NOT NULL,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (event_id, id)
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        slot_id TEXT,
        user_id BIGINT NOT NULL,
        user_name TEXT NOT NULL,
        status TEXT NOT NULL,
        notifications_enabled BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);

    await this.pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS university_id TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS university_id TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS title TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS format TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS capacity INTEGER;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS requirements TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS location_or_url TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS cancel_policy TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_closed BOOLEAN;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS late_cancel_allowed BOOLEAN;
    `);

    await this.migrateLegacyEventJson();
    await this.pool.query('ALTER TABLE events DROP COLUMN IF EXISTS data_json');
    await this.fillEventDefaults();

    await this.pool.query(`
      ALTER TABLE events ALTER COLUMN university_id SET NOT NULL;
      ALTER TABLE events ALTER COLUMN title SET NOT NULL;
      ALTER TABLE events ALTER COLUMN duration_minutes SET NOT NULL;
      ALTER TABLE events ALTER COLUMN format SET NOT NULL;
      ALTER TABLE events ALTER COLUMN capacity SET NOT NULL;
      ALTER TABLE events ALTER COLUMN description SET NOT NULL;
      ALTER TABLE events ALTER COLUMN requirements SET NOT NULL;
      ALTER TABLE events ALTER COLUMN location_or_url SET NOT NULL;
      ALTER TABLE events ALTER COLUMN cancel_policy SET NOT NULL;
      ALTER TABLE events ALTER COLUMN registration_closed SET NOT NULL;
      ALTER TABLE events ALTER COLUMN late_cancel_allowed SET NOT NULL;

      CREATE INDEX IF NOT EXISTS events_university_id_idx ON events(university_id);
      CREATE INDEX IF NOT EXISTS event_slots_event_id_idx ON event_slots(event_id);
      CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
      CREATE INDEX IF NOT EXISTS users_university_id_idx ON users(university_id);
      CREATE INDEX IF NOT EXISTS registrations_event_id_idx ON registrations(event_id);
      CREATE INDEX IF NOT EXISTS registrations_user_id_idx ON registrations(user_id);
    `);
  }

  private async migrateLegacyEventJson(): Promise<void> {
    const hasDataJson = await this.hasColumn('events', 'data_json');

    if (!hasDataJson) {
      return;
    }

    await this.pool.query(`
      UPDATE events
      SET
        university_id = COALESCE(university_id, data_json->>'universityId', 'rtu-mirea'),
        title = COALESCE(title, data_json->>'title', id),
        duration_minutes = COALESCE(duration_minutes, (data_json->>'durationMinutes')::INTEGER, 60),
        format = COALESCE(format, data_json->>'format', 'offline'),
        capacity = COALESCE(capacity, (data_json->>'capacity')::INTEGER, 1),
        description = COALESCE(description, data_json->>'description', ''),
        requirements = COALESCE(requirements, data_json->>'requirements', ''),
        location_or_url = COALESCE(location_or_url, data_json->>'locationOrUrl', ''),
        cancel_policy = COALESCE(cancel_policy, data_json->>'cancelPolicy', ''),
        registration_closed = COALESCE(registration_closed, (data_json->>'registrationClosed')::BOOLEAN, FALSE),
        late_cancel_allowed = COALESCE(late_cancel_allowed, (data_json->>'lateCancelAllowed')::BOOLEAN, FALSE)
      WHERE data_json IS NOT NULL;
    `);

    await this.pool.query(`
      INSERT INTO event_slots (event_id, id, label, starts_at)
      SELECT events.id, slot->>'id', slot->>'label', (slot->>'startsAt')::TIMESTAMPTZ
      FROM events
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(events.data_json->'slots', '[]'::jsonb)) AS slot
      ON CONFLICT(event_id, id) DO UPDATE SET
        label = EXCLUDED.label,
        starts_at = EXCLUDED.starts_at;
    `);
  }

  private async fillEventDefaults(): Promise<void> {
    await this.pool.query(`
      INSERT INTO universities (id, title, short_title, city, description)
      VALUES
        ('rtu-mirea', 'Российский технологический университет МИРЭА', 'РТУ МИРЭА', 'Москва', 'Технологический университет с ИТ, инженерными и естественно-научными направлениями.'),
        ('spring-demo', 'Весенний демонстрационный университет', 'Spring Demo University', 'Москва', 'Демо-вуз для проверки мультивузовой модели бота.')
      ON CONFLICT(id) DO UPDATE SET
        title = EXCLUDED.title,
        short_title = EXCLUDED.short_title,
        city = EXCLUDED.city,
        description = EXCLUDED.description;
    `);

    await this.pool.query(`
      INSERT INTO events
        (id, university_id, title, starts_at, duration_minutes, format, capacity, description, requirements, location_or_url, cancel_policy, registration_closed, late_cancel_allowed)
      VALUES
        ('open-day-it', 'rtu-mirea', 'День открытых дверей ИТ-направлений', '2026-05-28T15:00:00+03:00', 90, 'offline', 40, 'Встреча с приемной комиссией и кафедрами: программы, проходные баллы, проектное обучение и вопросы абитуриентов.', 'Возьмите документ, удостоверяющий личность. Для прохода достаточно кода записи.', 'Главный корпус, аудитория 214', 'Отмена доступна до начала мероприятия. Поздняя отмена запрещена.', FALSE, FALSE),
        ('campus-tour', 'rtu-mirea', 'Экскурсия по кампусу', '2026-05-30T12:00:00+03:00', 60, 'offline', 25, 'Маршрут по учебным корпусам, лабораториям, библиотеке и пространствам для студенческих проектов.', 'Удобная обувь и подтверждение записи с кодом.', 'Сбор у центрального входа', 'Отмена доступна до начала мероприятия. Поздняя отмена помечается отдельно.', FALSE, TRUE),
        ('online-consulting', 'spring-demo', 'Онлайн-консультация по поступлению', '2026-06-02T18:00:00+03:00', 45, 'online', 80, 'Короткая консультация о подаче документов, индивидуальных достижениях и сроках приемной кампании.', 'Стабильный интернет и возможность открыть ссылку на подключение.', 'Ссылка будет отправлена участникам за сутки до начала.', 'Отмена доступна до начала мероприятия.', FALSE, FALSE)
      ON CONFLICT(id) DO NOTHING;
    `);

    await this.pool.query(`
      UPDATE events
      SET
        university_id = COALESCE(university_id, 'rtu-mirea'),
        title = COALESCE(title, id),
        duration_minutes = COALESCE(duration_minutes, 60),
        format = COALESCE(format, 'offline'),
        capacity = COALESCE(capacity, 1),
        description = COALESCE(description, ''),
        requirements = COALESCE(requirements, ''),
        location_or_url = COALESCE(location_or_url, ''),
        cancel_policy = COALESCE(cancel_policy, ''),
        registration_closed = COALESCE(registration_closed, FALSE),
        late_cancel_allowed = COALESCE(late_cancel_allowed, FALSE);
    `);

    await this.pool.query(`
      INSERT INTO event_slots (event_id, id, label, starts_at)
      VALUES
        ('open-day-it', '15-00', '15:00-16:30', '2026-05-28T15:00:00+03:00'),
        ('open-day-it', '17-00', '17:00-18:30', '2026-05-28T17:00:00+03:00')
      ON CONFLICT(event_id, id) DO UPDATE SET
        label = EXCLUDED.label,
        starts_at = EXCLUDED.starts_at;
    `);
  }

  private async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
        ) AS exists
      `,
      [tableName, columnName]
    );

    return rows[0]?.exists ?? false;
  }

  private parseJson<T>(value: string | object | null): T | undefined {
    if (!value) {
      return undefined;
    }

    return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
  }

  private async mapEvent(row: DbEventRow): Promise<EventCard> {
    const { rows: slots } = await this.pool.query<DbEventSlotRow>(
      'SELECT id, label, starts_at FROM event_slots WHERE event_id = $1 ORDER BY starts_at',
      [row.id]
    );

    return {
      id: row.id,
      universityId: row.university_id,
      title: row.title,
      startsAt: new Date(row.starts_at).toISOString(),
      durationMinutes: row.duration_minutes,
      format: row.format,
      capacity: row.capacity,
      organizerIds: [],
      description: row.description,
      requirements: row.requirements,
      locationOrUrl: row.location_or_url,
      cancelPolicy: row.cancel_policy,
      registrationClosed: row.registration_closed,
      lateCancelAllowed: row.late_cancel_allowed,
      slots: slots.map((slot): EventSlot => ({
        id: slot.id,
        label: slot.label,
        startsAt: new Date(slot.starts_at).toISOString()
      }))
    };
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

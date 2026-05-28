import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActiveStatus } from '../shared/domain.js';
import * as schema from './schema.js';
import type {
  CreateEventInput,
  DeleteEventResult,
  EventCard,
  EventFormat,
  EventRegistrar,
  EventSlot,
  ExternalLoginCodeResult,
  ExternalLoginStartResult,
  ExternalLoginVerifyResult,
  Registration,
  Role,
  StoredUser,
  UpdateEventInput,
  University
} from '../shared/types.js';

const { Pool } = pg;

// DatabaseStore инкапсулирует всю работу с PostgreSQL через Drizzle: маршруты
// data-service вызывают методы хранилища и не зависят от таблиц, индексов и миграций.
type DbUserRow = typeof schema.users.$inferSelect;
type DbRegistrationRow = typeof schema.registrations.$inferSelect;
type DbEventRow = typeof schema.events.$inferSelect;
type DbEventSlotRow = typeof schema.eventSlots.$inferSelect;
type DbUniversityRow = typeof schema.universities.$inferSelect;
type DbExternalLoginRow = typeof schema.externalLogins.$inferSelect;
type DbEventRegistrarRow = typeof schema.eventRegistrars.$inferSelect;

export class DatabaseStore {
  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool, { schema });
  }

  async init(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
    await migrate(this.db, { migrationsFolder: './drizzle' });
    await this.fillEventDefaults();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listUniversities(): Promise<University[]> {
    const rows = await this.db.select().from(schema.universities).orderBy(asc(schema.universities.title));
    return rows.map((row) => this.mapUniversity(row));
  }

  async getUniversity(universityId: string): Promise<University | undefined> {
    const rows = await this.db.select().from(schema.universities).where(eq(schema.universities.id, universityId)).limit(1);
    return rows[0] ? this.mapUniversity(rows[0]) : undefined;
  }

  async listEvents(universityId?: string, includeDeleted = false): Promise<EventCard[]> {
    const filters: SQL[] = [];

    if (universityId) {
      filters.push(eq(schema.events.universityId, universityId));
    }

    if (!includeDeleted) {
      filters.push(isNull(schema.events.deletedAt));
    }

    const rows =
      filters.length > 0
        ? await this.db.select().from(schema.events).where(and(...filters)).orderBy(asc(schema.events.startsAt))
        : await this.db.select().from(schema.events).orderBy(asc(schema.events.startsAt));

    return Promise.all(rows.map((row) => this.mapEvent(row)));
  }

  async getEvent(eventId: string): Promise<EventCard | undefined> {
    const rows = await this.db.select().from(schema.events).where(eq(schema.events.id, eventId)).limit(1);
    return rows[0] ? this.mapEvent(rows[0]) : undefined;
  }

  async createEvent(input: CreateEventInput): Promise<EventCard> {
    const id = await this.nextEventId(input.title);

    await this.db.transaction(async (tx) => {
      await tx.insert(schema.events).values({
        id,
        universityId: input.universityId,
        title: input.title,
        startsAt: toDate(input.startsAt),
        durationMinutes: input.durationMinutes,
        format: input.format,
        capacity: input.capacity,
        description: input.description,
        requirements: input.requirements,
        locationOrUrl: input.locationOrUrl,
        cancelPolicy: input.cancelPolicy,
        registrationClosed: input.registrationClosed ?? false,
        lateCancelAllowed: input.lateCancelAllowed ?? false
      });

      if (!input.slots?.length) {
        return;
      }

      await tx.insert(schema.eventSlots).values(
        input.slots.map((slot) => ({
          eventId: id,
          id: slot.id,
          label: slot.label,
          startsAt: toDate(slot.startsAt)
        }))
      );
    });

    const event = await this.getEvent(id);

    if (!event) {
      throw new Error(`Event ${id} was not created`);
    }

    return event;
  }

  async updateEvent(eventId: string, patch: UpdateEventInput): Promise<EventCard | undefined> {
    const current = await this.getEvent(eventId);

    if (!current) {
      return undefined;
    }

    const next: EventCard = { ...current, ...patch };
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.events)
        .set({
          universityId: next.universityId,
          title: next.title,
          startsAt: toDate(next.startsAt),
          durationMinutes: next.durationMinutes,
          format: next.format,
          capacity: next.capacity,
          description: next.description,
          requirements: next.requirements,
          locationOrUrl: next.locationOrUrl,
          cancelPolicy: next.cancelPolicy,
          registrationClosed: next.registrationClosed,
          lateCancelAllowed: next.lateCancelAllowed
        })
        .where(eq(schema.events.id, eventId));

      if (!patch.slots) {
        return;
      }

      await tx.delete(schema.eventSlots).where(eq(schema.eventSlots.eventId, eventId));

      if (!patch.slots.length) {
        return;
      }

      await tx.insert(schema.eventSlots).values(
        patch.slots.map((slot) => ({
          eventId,
          id: slot.id,
          label: slot.label,
          startsAt: toDate(slot.startsAt)
        }))
      );
    });

    return this.getEvent(eventId);
  }

  async deleteEvent(eventId: string): Promise<DeleteEventResult> {
    const event = await this.getEvent(eventId);

    if (!event) {
      return 'not_found';
    }

    await this.db
      .update(schema.events)
      .set({ deletedAt: event.deletedAt ? toDate(event.deletedAt) : new Date() })
      .where(eq(schema.events.id, eventId));

    return 'deleted';
  }

  async restoreEvent(eventId: string): Promise<EventCard | undefined> {
    await this.db.update(schema.events).set({ deletedAt: null }).where(eq(schema.events.id, eventId));
    return this.getEvent(eventId);
  }

  async listManageableEvents(userId: number, role: Role): Promise<EventCard[]> {
    const user = await this.getUser(userId);
    const events = await this.listEvents(undefined, true);
    const registrarEvents = events.filter((event) => event.registrarIds.includes(userId));

    if (role === 'tech_admin') {
      return events;
    }

    if (role === 'admin') {
      const adminEvents = user?.universityId ? events.filter((event) => event.universityId === user.universityId) : [];
      return uniqueEvents([...adminEvents, ...registrarEvents]);
    }

    const organizerEvents = events.filter((event) => event.universityId === user?.universityId);
    return uniqueEvents([...organizerEvents, ...registrarEvents]);
  }

  async listUsers(role?: Role, universityId?: string): Promise<StoredUser[]> {
    const filters: SQL[] = [];

    if (role) {
      filters.push(eq(schema.users.role, role));
    }

    if (universityId) {
      filters.push(eq(schema.users.universityId, universityId));
    }

    const rows =
      filters.length > 0
        ? await this.db.select().from(schema.users).where(and(...filters)).orderBy(desc(schema.users.updatedAt))
        : await this.db.select().from(schema.users).orderBy(desc(schema.users.updatedAt));

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

    await this.db
      .insert(schema.users)
      .values({
        id: next.id,
        name: next.name,
        username: next.username ?? null,
        role: next.role,
        universityId: next.universityId ?? null,
        consent: next.consent ?? null,
        updatedAt: toDate(next.updatedAt)
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          name: sql`excluded.name`,
          username: sql`excluded.username`,
          role: sql`excluded.role`,
          universityId: sql`
            CASE
              WHEN excluded.role IN ('tech_admin', 'applicant') THEN NULL
              ELSE COALESCE(${schema.users.universityId}, excluded.university_id)
            END
          `,
          consent: sql`excluded.consent_json`,
          updatedAt: sql`excluded.updated_at`
        }
      });

    return next;
  }

  async getUser(userId: number): Promise<StoredUser | undefined> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
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

    await this.db
      .insert(schema.users)
      .values({
        id: next.id,
        name: next.name,
        username: next.username ?? null,
        role: next.role,
        universityId: next.universityId ?? null,
        consent: next.consent ?? null,
        updatedAt: toDate(now)
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          role: sql`excluded.role`,
          universityId: sql`excluded.university_id`,
          updatedAt: sql`excluded.updated_at`
        }
      });

    return next;
  }

  async createRegistration(registration: Registration): Promise<void> {
    await this.db.insert(schema.registrations).values({
      id: registration.id,
      code: registration.code,
      eventId: registration.eventId,
      slotId: registration.slotId ?? null,
      userId: registration.userId,
      userName: registration.userName,
      status: registration.status,
      notificationsEnabled: registration.notificationsEnabled,
      attendedAt: registration.attendedAt ? toDate(registration.attendedAt) : null,
      attendedBy: registration.attendedBy ?? null,
      createdAt: toDate(registration.createdAt),
      updatedAt: toDate(registration.updatedAt)
    });
  }

  async updateRegistration(id: string, patch: Partial<Registration>): Promise<Registration | undefined> {
    const rows = await this.db.select().from(schema.registrations).where(eq(schema.registrations.id, id)).limit(1);
    const current = rows[0] ? this.mapRegistration(rows[0]) : undefined;

    if (!current) {
      return undefined;
    }

    const next: Registration = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.db
      .update(schema.registrations)
      .set({
        code: next.code,
        eventId: next.eventId,
        slotId: next.slotId ?? null,
        userId: next.userId,
        userName: next.userName,
        status: next.status,
        notificationsEnabled: next.notificationsEnabled,
        attendedAt: next.attendedAt ? toDate(next.attendedAt) : null,
        attendedBy: next.attendedBy ?? null,
        createdAt: toDate(next.createdAt),
        updatedAt: toDate(next.updatedAt)
      })
      .where(eq(schema.registrations.id, next.id));

    return next;
  }

  async listRegistrations(eventId?: string, userId?: number): Promise<Registration[]> {
    const filters: SQL[] = [];

    if (eventId) {
      filters.push(eq(schema.registrations.eventId, eventId));
    }

    if (userId !== undefined) {
      filters.push(eq(schema.registrations.userId, userId));
    }

    const rows =
      filters.length > 0
        ? await this.db
            .select()
            .from(schema.registrations)
            .where(and(...filters))
            .orderBy(desc(schema.registrations.createdAt))
        : await this.db.select().from(schema.registrations).orderBy(desc(schema.registrations.createdAt));

    return rows.map((row) => this.mapRegistration(row));
  }

  async findRegistrationByCode(code: string): Promise<Registration | undefined> {
    const normalized = code.trim().toUpperCase();
    const rows = await this.db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.code, normalized))
      .limit(1);

    return rows[0] ? this.mapRegistration(rows[0]) : undefined;
  }

  async activeRegistration(userId: number, eventId: string): Promise<Registration | undefined> {
    return (await this.listRegistrations(eventId, userId)).find((item) => isActiveStatus(item.status));
  }

  async listEventRegistrars(eventId: string): Promise<EventRegistrar[]> {
    const rows = await this.db
      .select()
      .from(schema.eventRegistrars)
      .where(eq(schema.eventRegistrars.eventId, eventId))
      .orderBy(asc(schema.eventRegistrars.assignedAt));

    return rows.map((row) => this.mapEventRegistrar(row));
  }

  async assignEventRegistrar(eventId: string, userId: number, assignedBy: number): Promise<EventRegistrar> {
    const now = new Date();

    await this.db
      .insert(schema.eventRegistrars)
      .values({
        eventId,
        userId,
        assignedBy,
        assignedAt: now
      })
      .onConflictDoUpdate({
        target: [schema.eventRegistrars.eventId, schema.eventRegistrars.userId],
        set: {
          assignedBy,
          assignedAt: now
        }
      });

    return {
      eventId,
      userId,
      assignedBy,
      assignedAt: now.toISOString()
    };
  }

  async removeEventRegistrar(eventId: string, userId: number): Promise<boolean> {
    const result = await this.db
      .delete(schema.eventRegistrars)
      .where(and(eq(schema.eventRegistrars.eventId, eventId), eq(schema.eventRegistrars.userId, userId)));

    return (result.rowCount ?? 0) > 0;
  }

  async startExternalLogin(login: string): Promise<ExternalLoginStartResult> {
    const normalized = normalizeLogin(login);
    const existing = await this.getExternalLogin(normalized);

    if (!existing) {
      await this.db.insert(schema.externalLogins).values({
        login: normalized,
        userId: null,
        codeHash: null,
        codeExpiresAt: null,
        linkedAt: null,
        updatedAt: new Date()
      });

      return { login: normalized, linked: false };
    }

    if (!existing.userId) {
      return { login: normalized, linked: false };
    }

    const issued = await this.issueExternalLoginCode(normalized, existing.userId);
    return { ...issued, linked: true, userId: existing.userId };
  }

  async issueExternalLoginCode(login: string, userId: number): Promise<ExternalLoginCodeResult> {
    const normalized = normalizeLogin(login);
    const code = randomDigits(6);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const now = new Date();

    await this.db
      .insert(schema.externalLogins)
      .values({
        login: normalized,
        userId,
        codeHash: hashCode(code),
        codeExpiresAt: expiresAt,
        linkedAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: schema.externalLogins.login,
        set: {
          userId,
          codeHash: hashCode(code),
          codeExpiresAt: expiresAt,
          linkedAt: sql`COALESCE(${schema.externalLogins.linkedAt}, ${now})`,
          updatedAt: now
        }
      });

    return { login: normalized, code, expiresAt: expiresAt.toISOString() };
  }

  async verifyExternalLoginCode(login: string, code: string): Promise<ExternalLoginVerifyResult | undefined> {
    const normalized = normalizeLogin(login);
    const existing = await this.getExternalLogin(normalized);

    if (!existing?.userId || !existing.codeHash || !existing.codeExpiresAt) {
      return undefined;
    }

    if (existing.codeExpiresAt.getTime() < Date.now()) {
      return undefined;
    }

    if (existing.codeHash !== hashCode(normalizeCode(code))) {
      return undefined;
    }

    await this.db
      .update(schema.externalLogins)
      .set({
        codeHash: null,
        codeExpiresAt: null,
        updatedAt: new Date()
      })
      .where(eq(schema.externalLogins.login, normalized));

    return { login: normalized, userId: existing.userId };
  }

  private async nextEventId(title: string): Promise<string> {
    const base = slugify(title) || 'event';

    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? '' : `-${index + 1}`;
      const id = `${base}${suffix}`;
      const rows = await this.db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.id, id)).limit(1);

      if (rows.length === 0) {
        return id;
      }
    }

    return `${base}-${Date.now().toString(36)}`;
  }

  private async getExternalLogin(login: string): Promise<DbExternalLoginRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.externalLogins)
      .where(eq(schema.externalLogins.login, normalizeLogin(login)))
      .limit(1);

    return rows[0];
  }

  private async fillEventDefaults(): Promise<void> {
    await this.db
      .insert(schema.universities)
      .values([
        {
          id: 'rtu-mirea',
          title: 'Российский технологический университет МИРЭА',
          shortTitle: 'РТУ МИРЭА',
          city: 'Москва',
          description: 'Технологический университет с ИТ, инженерными и естественно-научными направлениями.'
        },
        {
          id: 'spring-demo',
          title: 'Весенний демонстрационный университет',
          shortTitle: 'Spring Demo University',
          city: 'Москва',
          description: 'Демо-вуз для проверки мультивузовой модели бота.'
        }
      ])
      .onConflictDoUpdate({
        target: schema.universities.id,
        set: {
          title: sql`excluded.title`,
          shortTitle: sql`excluded.short_title`,
          city: sql`excluded.city`,
          description: sql`excluded.description`
        }
      });

    await this.db
      .insert(schema.events)
      .values([
        {
          id: 'open-day-it',
          universityId: 'rtu-mirea',
          title: 'День открытых дверей ИТ-направлений',
          startsAt: toDate('2026-05-28T15:00:00+03:00'),
          durationMinutes: 90,
          format: 'offline',
          capacity: 40,
          description:
            'Встреча с приемной комиссией и кафедрами: программы, проходные баллы, проектное обучение и вопросы абитуриентов.',
          requirements: 'Возьмите документ, удостоверяющий личность. Для прохода достаточно кода записи.',
          locationOrUrl: 'Главный корпус, аудитория 214',
          cancelPolicy: 'Отмена доступна до начала мероприятия. Поздняя отмена запрещена.',
          registrationClosed: false,
          lateCancelAllowed: false
        },
        {
          id: 'campus-tour',
          universityId: 'rtu-mirea',
          title: 'Экскурсия по кампусу',
          startsAt: toDate('2026-05-30T12:00:00+03:00'),
          durationMinutes: 60,
          format: 'offline',
          capacity: 25,
          description: 'Маршрут по учебным корпусам, лабораториям, библиотеке и пространствам для студенческих проектов.',
          requirements: 'Удобная обувь и подтверждение записи с кодом.',
          locationOrUrl: 'Сбор у центрального входа',
          cancelPolicy: 'Отмена доступна до начала мероприятия. Поздняя отмена помечается отдельно.',
          registrationClosed: false,
          lateCancelAllowed: true
        },
        {
          id: 'online-consulting',
          universityId: 'spring-demo',
          title: 'Онлайн-консультация по поступлению',
          startsAt: toDate('2026-06-02T18:00:00+03:00'),
          durationMinutes: 45,
          format: 'online',
          capacity: 80,
          description: 'Короткая консультация о подаче документов, индивидуальных достижениях и сроках приемной кампании.',
          requirements: 'Стабильный интернет и возможность открыть ссылку на подключение.',
          locationOrUrl: 'Ссылка будет отправлена участникам за сутки до начала.',
          cancelPolicy: 'Отмена доступна до начала мероприятия.',
          registrationClosed: false,
          lateCancelAllowed: false
        }
      ])
      .onConflictDoNothing();

    await this.db
      .update(schema.events)
      .set({
        universityId: sql`COALESCE(${schema.events.universityId}, 'rtu-mirea')`,
        title: sql`COALESCE(${schema.events.title}, ${schema.events.id})`,
        durationMinutes: sql`COALESCE(${schema.events.durationMinutes}, 60)`,
        format: sql`COALESCE(${schema.events.format}, 'offline')`,
        capacity: sql`COALESCE(${schema.events.capacity}, 1)`,
        description: sql`COALESCE(${schema.events.description}, '')`,
        requirements: sql`COALESCE(${schema.events.requirements}, '')`,
        locationOrUrl: sql`COALESCE(${schema.events.locationOrUrl}, '')`,
        cancelPolicy: sql`COALESCE(${schema.events.cancelPolicy}, '')`,
        registrationClosed: sql`COALESCE(${schema.events.registrationClosed}, FALSE)`,
        lateCancelAllowed: sql`COALESCE(${schema.events.lateCancelAllowed}, FALSE)`
      });

    await this.db
      .insert(schema.eventSlots)
      .values([
        {
          eventId: 'open-day-it',
          id: '15-00',
          label: '15:00-16:30',
          startsAt: toDate('2026-05-28T15:00:00+03:00')
        },
        {
          eventId: 'open-day-it',
          id: '17-00',
          label: '17:00-18:30',
          startsAt: toDate('2026-05-28T17:00:00+03:00')
        }
      ])
      .onConflictDoUpdate({
        target: [schema.eventSlots.eventId, schema.eventSlots.id],
        set: {
          label: sql`excluded.label`,
          startsAt: sql`excluded.starts_at`
        }
      });
  }

  private parseJson<T>(value: unknown): T | undefined {
    if (!value) {
      return undefined;
    }

    return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
  }

  private async mapEvent(row: DbEventRow): Promise<EventCard> {
    const [slots, registrars] = await Promise.all([
      this.db
        .select()
        .from(schema.eventSlots)
        .where(eq(schema.eventSlots.eventId, row.id))
        .orderBy(asc(schema.eventSlots.startsAt)),
      this.db
        .select()
        .from(schema.eventRegistrars)
        .where(eq(schema.eventRegistrars.eventId, row.id))
        .orderBy(asc(schema.eventRegistrars.assignedAt))
    ]);

    return {
      id: row.id,
      universityId: row.universityId,
      title: row.title,
      startsAt: row.startsAt.toISOString(),
      durationMinutes: row.durationMinutes,
      format: row.format as EventFormat,
      capacity: row.capacity,
      organizerIds: [],
      description: row.description,
      requirements: row.requirements,
      locationOrUrl: row.locationOrUrl,
      cancelPolicy: row.cancelPolicy,
      registrationClosed: row.registrationClosed,
      lateCancelAllowed: row.lateCancelAllowed,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : undefined,
      slots: slots.map((slot): EventSlot => this.mapSlot(slot)),
      registrarIds: registrars.map((registrar) => registrar.userId)
    };
  }

  private mapSlot(slot: DbEventSlotRow): EventSlot {
    return {
      id: slot.id,
      label: slot.label,
      startsAt: slot.startsAt.toISOString()
    };
  }

  private mapUser(row: DbUserRow): StoredUser {
    return {
      id: row.id,
      name: row.name,
      username: row.username ?? undefined,
      role: row.role as Role,
      universityId: row.universityId ?? undefined,
      consent: this.parseJson(row.consent),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  private mapRegistration(row: DbRegistrationRow): Registration {
    return {
      id: row.id,
      code: row.code,
      eventId: row.eventId,
      slotId: row.slotId ?? undefined,
      userId: row.userId,
      userName: row.userName,
      status: row.status as Registration['status'],
      notificationsEnabled: row.notificationsEnabled,
      attendedAt: row.attendedAt?.toISOString(),
      attendedBy: row.attendedBy ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  private mapEventRegistrar(row: DbEventRegistrarRow): EventRegistrar {
    return {
      eventId: row.eventId,
      userId: row.userId,
      assignedBy: row.assignedBy,
      assignedAt: row.assignedAt.toISOString()
    };
  }

  private mapUniversity(row: DbUniversityRow): University {
    return {
      id: row.id,
      title: row.title,
      shortTitle: row.shortTitle,
      city: row.city,
      description: row.description
    };
  }
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function normalizeCode(code: string): string {
  return code.trim().replace(/\D/g, '');
}

function randomDigits(length: number): string {
  const max = 10 ** length;
  return String(randomBytes(4).readUInt32BE(0) % max).padStart(length, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function uniqueEvents(events: EventCard[]): EventCard[] {
  const byId = new Map<string, EventCard>();

  for (const event of events) {
    byId.set(event.id, event);
  }

  return [...byId.values()].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'e')
    .replace(/[а-я]/g, (letter) => {
      const map: Record<string, string> = {
        а: 'a',
        б: 'b',
        в: 'v',
        г: 'g',
        д: 'd',
        е: 'e',
        ж: 'zh',
        з: 'z',
        и: 'i',
        й: 'y',
        к: 'k',
        л: 'l',
        м: 'm',
        н: 'n',
        о: 'o',
        п: 'p',
        р: 'r',
        с: 's',
        т: 't',
        у: 'u',
        ф: 'f',
        х: 'h',
        ц: 'c',
        ч: 'ch',
        ш: 'sh',
        щ: 'sch',
        ъ: '',
        ы: 'y',
        ь: '',
        э: 'e',
        ю: 'yu',
        я: 'ya'
      };
      return map[letter] ?? '';
    });

  return normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

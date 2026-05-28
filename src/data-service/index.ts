import 'dotenv/config';
import Fastify from 'fastify';
import { DatabaseStore } from './database.js';
import type { CreateEventInput, EventRegistrar, Registration, Role, StoredUser, UpdateEventInput } from '../shared/types.js';

const port = Number(process.env.DATA_SERVICE_PORT ?? 3060);
const host = process.env.DATA_SERVICE_HOST ?? '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://springcat:springcat@localhost:5432/springcat';
const store = new DatabaseStore(databaseUrl);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'data-service',
      log_type: 'technical'
    }
  }
});

function businessLog(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    log_type: 'business',
    event,
    ...fields
  };
}

app.setErrorHandler((error, _request, reply) => {
  const fastifyError = error as { statusCode?: number; code?: string; message?: string };

  app.log.error(error);
  reply.status(fastifyError.statusCode ?? 500).send({
    error: fastifyError.code ?? 'internal_error',
    message: fastifyError.statusCode === 400 ? fastifyError.message : undefined
  });
});

app.get('/health', async () => {
  return { ok: true };
});

function validationError(message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'validation_error'
  });
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw validationError(`${field} must be a positive integer`);
  }
}

function assertIsoDate(value: unknown, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw validationError(`${field} must be a valid date`);
  }
}

function minutesOfDay(hour: string, minute: string): number {
  return Number(hour) * 60 + Number(minute);
}

function slotInterval(label: string): { start: number; end: number } | undefined {
  const match = label.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);

  if (!match) {
    return undefined;
  }

  return {
    start: minutesOfDay(match[1], match[2]),
    end: minutesOfDay(match[3], match[4])
  };
}

function assertSlots(slots: CreateEventInput['slots']): void {
  for (const slot of slots ?? []) {
    if (!slot.id || !slot.label) {
      throw validationError('slot id and label are required');
    }

    const match = slot.label.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);

    if (!match) {
      throw validationError(`slot "${slot.label}" must use HH:MM-HH:MM format`);
    }

    const [, startHour, startMinute, endHour, endMinute] = match;
    const numbers = [startHour, startMinute, endHour, endMinute].map(Number);
    const [sh, sm, eh, em] = numbers;

    if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
      throw validationError(`slot "${slot.label}" has invalid hours or minutes`);
    }

    if (minutesOfDay(endHour, endMinute) <= minutesOfDay(startHour, startMinute)) {
      throw validationError(`slot "${slot.label}" must end after it starts`);
    }

    assertIsoDate(slot.startsAt, 'slot.startsAt');
  }

  const normalized = slots ?? [];

  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const leftInterval = slotInterval(normalized[left].label);
      const rightInterval = slotInterval(normalized[right].label);

      if (leftInterval && rightInterval && leftInterval.start < rightInterval.end && rightInterval.start < leftInterval.end) {
        throw validationError(`slots "${normalized[left].label}" and "${normalized[right].label}" overlap`);
      }
    }
  }
}

// DataService is the last line of defense for data quality: clients may be bots,
// admin panels or future integrations, so the database-facing API validates the
// same business limits that the MAX dialog validates for humans.
function assertEventInput(input: CreateEventInput | UpdateEventInput, partial = false): void {
  const requiredFields: (keyof CreateEventInput)[] = [
    'universityId',
    'title',
    'startsAt',
    'durationMinutes',
    'format',
    'capacity',
    'description',
    'requirements',
    'locationOrUrl',
    'cancelPolicy'
  ];

  if (!partial) {
    for (const field of requiredFields) {
      if (input[field] === undefined || input[field] === null || input[field] === '') {
        throw validationError(`${field} is required`);
      }
    }
  }

  if (input.startsAt !== undefined) assertIsoDate(input.startsAt, 'startsAt');
  if (input.durationMinutes !== undefined) assertPositiveInteger(input.durationMinutes, 'durationMinutes');
  if (input.capacity !== undefined) assertPositiveInteger(input.capacity, 'capacity');
  if (input.format !== undefined && input.format !== 'online' && input.format !== 'offline') {
    throw validationError('format must be online or offline');
  }
  if (input.slots !== undefined) assertSlots(input.slots);
}

app.get('/universities', async () => {
  return store.listUniversities();
});

app.get<{ Params: { universityId: string } }>('/universities/:universityId', async (request, reply) => {
  const university = await store.getUniversity(request.params.universityId);

  if (!university) {
    return reply.status(404).send({ error: 'not_found' });
  }

  return university;
});

app.get<{ Querystring: { universityId?: string; includeDeleted?: string } }>('/events', async (request) => {
  return store.listEvents(request.query.universityId, request.query.includeDeleted === 'true');
});

app.get<{ Querystring: { userId: string; role?: Role } }>('/events/manageable', async (request) => {
  return store.listManageableEvents(Number(request.query.userId), request.query.role ?? 'applicant');
});

app.get<{ Params: { eventId: string } }>('/events/:eventId', async (request, reply) => {
  const event = await store.getEvent(request.params.eventId);

  if (!event) {
    return reply.status(404).send({ error: 'not_found' });
  }

  return event;
});

app.post<{ Body: CreateEventInput }>('/events', async (request, reply) => {
  assertEventInput(request.body);
  const event = await store.createEvent(request.body);
  app.log.info(businessLog('event_created', { event_id: event.id, university_id: event.universityId }), 'event created');
  return reply.status(201).send(event);
});

app.patch<{ Params: { eventId: string }; Body: UpdateEventInput }>('/events/:eventId', async (request, reply) => {
  assertEventInput(request.body, true);
  const event = await store.updateEvent(request.params.eventId, request.body);

  if (!event) {
    return reply.status(404).send({ error: 'not_found' });
  }

  app.log.info(businessLog('event_updated', { event_id: event.id, university_id: event.universityId, patch_fields: Object.keys(request.body) }), 'event updated');
  return event;
});

app.delete<{ Params: { eventId: string } }>('/events/:eventId', async (request, reply) => {
  const result = await store.deleteEvent(request.params.eventId);

  if (result === 'not_found') {
    return reply.status(404).send({ error: result });
  }

  app.log.info(businessLog('event_deleted', { event_id: request.params.eventId }), 'event soft deleted');
  return reply.status(204).send();
});

app.post<{ Params: { eventId: string } }>('/events/:eventId/restore', async (request, reply) => {
  const event = await store.restoreEvent(request.params.eventId);

  if (!event) {
    return reply.status(404).send({ error: 'not_found' });
  }

  app.log.info(businessLog('event_restored', { event_id: event.id, university_id: event.universityId }), 'event restored');
  return event;
});

app.get<{ Params: { eventId: string } }>('/events/:eventId/free-seats', async (request) => {
  return { freeSeats: await store.freeSeats(request.params.eventId) };
});

app.get<{ Params: { eventId: string } }>('/events/:eventId/registrars', async (request) => {
  return store.listEventRegistrars(request.params.eventId);
});

app.post<{ Params: { eventId: string }; Body: { userId: number; assignedBy: number } }>(
  '/events/:eventId/registrars',
  async (request, reply) => {
    if (!Number.isSafeInteger(request.body.userId) || request.body.userId <= 0 || !Number.isSafeInteger(request.body.assignedBy) || request.body.assignedBy <= 0) {
      return reply.status(400).send({ error: 'invalid_registrar_assignment' });
    }

    const event = await store.getEvent(request.params.eventId);

    if (!event) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const registrar: EventRegistrar = await store.assignEventRegistrar(request.params.eventId, request.body.userId, request.body.assignedBy);
    app.log.info(
      businessLog('event_registrar_assigned', {
        event_id: registrar.eventId,
        registrar_user_id: registrar.userId,
        assigned_by: registrar.assignedBy,
        university_id: event.universityId
      }),
      'event registrar assigned'
    );
    return reply.status(201).send(registrar);
  }
);

app.delete<{ Params: { eventId: string; userId: string } }>('/events/:eventId/registrars/:userId', async (request, reply) => {
  const removed = await store.removeEventRegistrar(request.params.eventId, Number(request.params.userId));

  if (!removed) {
    return reply.status(404).send({ error: 'not_found' });
  }

  app.log.info(
    businessLog('event_registrar_removed', {
      event_id: request.params.eventId,
      registrar_user_id: Number(request.params.userId)
    }),
    'event registrar removed'
  );
  return reply.status(204).send();
});

app.get<{ Querystring: { role?: Role; universityId?: string } }>('/users', async (request) => {
  return store.listUsers(request.query.role, request.query.universityId);
});

app.get<{ Params: { userId: string } }>('/users/:userId', async (request, reply) => {
  const user = await store.getUser(Number(request.params.userId));

  if (!user) {
    return reply.status(404).send({ error: 'not_found' });
  }

  return user;
});

app.post<{ Body: Omit<StoredUser, 'updatedAt'> }>('/users/upsert', async (request) => {
  return store.upsertUser(request.body);
});

app.patch<{ Params: { userId: string }; Body: { role: Role; universityId?: string | null } }>(
  '/users/:userId/role',
  async (request) => {
    const user = await store.setUserRole(Number(request.params.userId), request.body.role, request.body.universityId);
    app.log.info(businessLog('user_role_saved', { target_user_id: user.id, target_role: user.role, university_id: user.universityId }), 'user role saved');
    return user;
  }
);

app.get<{ Querystring: { eventId?: string; userId?: string } }>('/registrations', async (request) => {
  const userId = request.query.userId ? Number(request.query.userId) : undefined;
  return store.listRegistrations(request.query.eventId, userId);
});

app.post<{ Body: Registration }>('/registrations', async (request, reply) => {
  await store.createRegistration(request.body);
  app.log.info(
    businessLog('registration_created', {
      registration_id: request.body.id,
      registration_code: request.body.code,
      event_id: request.body.eventId,
      user_id: request.body.userId,
      slot_id: request.body.slotId
    }),
    'registration created'
  );
  return reply.status(201).send(request.body);
});

app.patch<{ Params: { registrationId: string }; Body: Partial<Registration> }>(
  '/registrations/:registrationId',
  async (request, reply) => {
    const updated = await store.updateRegistration(request.params.registrationId, request.body);

    if (!updated) {
      return reply.status(404).send({ error: 'not_found' });
    }

    app.log.info(
      businessLog('registration_updated', {
        registration_id: updated.id,
        registration_code: updated.code,
        event_id: updated.eventId,
        user_id: updated.userId,
        status: updated.status,
        notifications_enabled: updated.notificationsEnabled,
        patch_fields: Object.keys(request.body)
      }),
      'registration updated'
    );
    return updated;
  }
);

app.get<{ Params: { code: string } }>('/registrations/code/:code', async (request, reply) => {
  const registration = await store.findRegistrationByCode(request.params.code);

  if (!registration) {
    return reply.status(404).send({ error: 'not_found' });
  }

  return registration;
});

app.get<{ Querystring: { userId: string; eventId?: string } }>('/registrations/active', async (request, reply) => {
  if (!request.query.eventId) {
    return reply.status(400).send({ error: 'eventId_required' });
  }

  const registration = await store.activeRegistration(Number(request.query.userId), request.query.eventId);

  if (!registration) {
    return reply.status(404).send({ error: 'not_found' });
  }

  return registration;
});

app.post<{ Body: { login: string } }>('/auth/external/start', async (request, reply) => {
  const login = normalizeLoginInput(request.body.login);

  if (!login) {
    return reply.status(400).send({ error: 'login_required' });
  }

  const result = await store.startExternalLogin(login);
  app.log.info(businessLog('external_login_started', { login: result.login, linked: result.linked }), 'external login started');
  return result;
});

app.post<{ Body: { login: string; userId: number } }>('/auth/external/code', async (request, reply) => {
  const login = normalizeLoginInput(request.body.login);

  if (!login || !Number.isSafeInteger(request.body.userId) || request.body.userId <= 0) {
    return reply.status(400).send({ error: 'invalid_login_code_request' });
  }

  const result = await store.issueExternalLoginCode(login, request.body.userId);
  app.log.info(businessLog('external_login_code_issued', { login: result.login, user_id: request.body.userId }), 'external login code issued');
  return result;
});

app.post<{ Body: { login: string; code: string } }>('/auth/external/verify', async (request, reply) => {
  const login = normalizeLoginInput(request.body.login);

  if (!login || !request.body.code) {
    return reply.status(400).send({ error: 'invalid_login_verify_request' });
  }

  const result = await store.verifyExternalLoginCode(login, request.body.code);

  if (!result) {
    return reply.status(401).send({ error: 'invalid_or_expired_code' });
  }

  app.log.info(businessLog('external_login_verified', { login: result.login, user_id: result.userId }), 'external login verified');
  return result;
});

const close = async () => {
  await app.close();
  await store.close();
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

app.log.info('initializing data service');
await store.init();
app.log.info({ port, host }, 'starting data service');
await app.listen({ port, host });

function normalizeLoginInput(login: unknown): string | undefined {
  if (typeof login !== 'string') {
    return undefined;
  }

  const normalized = login.trim().toLowerCase();
  return /^[a-z0-9._@-]{3,80}$/.test(normalized) ? normalized : undefined;
}

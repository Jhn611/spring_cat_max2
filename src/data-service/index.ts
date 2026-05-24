import 'dotenv/config';
import Fastify from 'fastify';
import { DatabaseStore } from './database.js';
import type { Registration, Role, StoredUser } from '../shared/types.js';

const port = Number(process.env.DATA_SERVICE_PORT ?? 3060);
const host = process.env.DATA_SERVICE_HOST ?? '0.0.0.0';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://springcat:springcat@localhost:5432/springcat';
const store = new DatabaseStore(databaseUrl);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'data-service'
    }
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({ error: 'internal_error' });
});

app.get('/health', async () => {
  return { ok: true };
});

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

app.get<{ Querystring: { universityId?: string } }>('/events', async (request) => {
  return store.listEvents(request.query.universityId);
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

app.get<{ Params: { eventId: string } }>('/events/:eventId/free-seats', async (request) => {
  return { freeSeats: await store.freeSeats(request.params.eventId) };
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
    return store.setUserRole(Number(request.params.userId), request.body.role, request.body.universityId);
  }
);

app.get<{ Querystring: { eventId?: string; userId?: string } }>('/registrations', async (request) => {
  const userId = request.query.userId ? Number(request.query.userId) : undefined;
  return store.listRegistrations(request.query.eventId, userId);
});

app.post<{ Body: Registration }>('/registrations', async (request, reply) => {
  await store.createRegistration(request.body);
  return reply.status(201).send(request.body);
});

app.patch<{ Params: { registrationId: string }; Body: Partial<Registration> }>(
  '/registrations/:registrationId',
  async (request, reply) => {
    const updated = await store.updateRegistration(request.params.registrationId, request.body);

    if (!updated) {
      return reply.status(404).send({ error: 'not_found' });
    }

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

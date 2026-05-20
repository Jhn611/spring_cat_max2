import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseStore } from './database.js';
import type { Registration, Role, StoredUser } from '../shared/types.js';

const port = Number(process.env.DATA_SERVICE_PORT ?? 3060);
const dbPath = process.env.DATABASE_PATH ?? join(process.cwd(), 'data', 'springcat.sqlite');
const store = new DatabaseStore(dbPath);

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    await route(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

const route: Handler = async (req, res, url) => {
  const path = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && path === '/events') return sendJson(res, 200, store.listEvents());
  if (req.method === 'GET' && path === '/events/manageable') {
    const userId = Number(url.searchParams.get('userId'));
    const role = (url.searchParams.get('role') ?? 'applicant') as Role;
    return sendJson(res, 200, store.listManageableEvents(userId, role));
  }

  const eventMatch = path.match(/^\/events\/([^/]+)$/);
  if (req.method === 'GET' && eventMatch) {
    const event = store.getEvent(eventMatch[1]);
    return event ? sendJson(res, 200, event) : sendJson(res, 404, { error: 'not_found' });
  }

  const freeSeatsMatch = path.match(/^\/events\/([^/]+)\/free-seats$/);
  if (req.method === 'GET' && freeSeatsMatch) return sendJson(res, 200, { freeSeats: store.freeSeats(freeSeatsMatch[1]) });

  const userMatch = path.match(/^\/users\/(\d+)$/);
  if (req.method === 'GET' && userMatch) {
    const user = store.getUser(Number(userMatch[1]));
    return user ? sendJson(res, 200, user) : sendJson(res, 404, { error: 'not_found' });
  }

  if (req.method === 'POST' && path === '/users/upsert') {
    const body = await readJson<Omit<StoredUser, 'updatedAt'>>(req);
    return sendJson(res, 200, store.upsertUser(body));
  }

  const roleMatch = path.match(/^\/users\/(\d+)\/role$/);
  if (req.method === 'PATCH' && roleMatch) {
    const body = await readJson<{ role: Role }>(req);
    store.setUserRole(Number(roleMatch[1]), body.role);
    return sendJson(res, 204, null);
  }

  if (req.method === 'GET' && path === '/registrations') {
    const eventId = url.searchParams.get('eventId') ?? undefined;
    const userIdRaw = url.searchParams.get('userId');
    const userId = userIdRaw ? Number(userIdRaw) : undefined;
    return sendJson(res, 200, store.listRegistrations(eventId, userId));
  }

  if (req.method === 'POST' && path === '/registrations') {
    const body = await readJson<Registration>(req);
    store.createRegistration(body);
    return sendJson(res, 201, body);
  }

  const registrationMatch = path.match(/^\/registrations\/([^/]+)$/);
  if (req.method === 'PATCH' && registrationMatch) {
    const body = await readJson<Partial<Registration>>(req);
    const updated = store.updateRegistration(registrationMatch[1], body);
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: 'not_found' });
  }

  const codeMatch = path.match(/^\/registrations\/code\/([^/]+)$/);
  if (req.method === 'GET' && codeMatch) {
    const registration = store.findRegistrationByCode(codeMatch[1]);
    return registration ? sendJson(res, 200, registration) : sendJson(res, 404, { error: 'not_found' });
  }

  if (req.method === 'GET' && path === '/registrations/active') {
    const userId = Number(url.searchParams.get('userId'));
    const eventId = url.searchParams.get('eventId');

    if (!eventId) return sendJson(res, 400, { error: 'eventId_required' });

    const registration = store.activeRegistration(userId, eventId);
    return registration ? sendJson(res, 200, registration) : sendJson(res, 404, { error: 'not_found' });
  }

  sendJson(res, 404, { error: 'not_found' });
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;

  if (status === 204) {
    res.end();
    return;
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

server.listen(port, () => {
  console.log(`Data service listening on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});

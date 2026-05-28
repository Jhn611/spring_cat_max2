import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { getBotPublicKey, getClientJwtSecret } from '../shared/auth.js';
import type { EventCard, ExternalLoginStartResult, ExternalLoginVerifyResult, NotificationJobResult, Role, StoredUser } from '../shared/types.js';

type AuthPayload = {
  user_id: number;
  client?: 'bot' | 'web';
  login?: string;
};

const port = Number(process.env.API_GATEWAY_PORT ?? 3050);
const host = process.env.API_GATEWAY_HOST ?? '0.0.0.0';
const dataServiceUrl = process.env.DATA_SERVICE_URL ?? 'http://localhost:3060';
const taskServiceUrl = process.env.TASK_SERVICE_URL ?? 'http://localhost:3070';
const corsOrigin = process.env.API_GATEWAY_CORS_ORIGIN === undefined || process.env.API_GATEWAY_CORS_ORIGIN === 'true'
  ? true
  : process.env.API_GATEWAY_CORS_ORIGIN;
const botNick = normalizeBotNick(process.env.BOT_NICK) ?? 'spring_cat40_bot';
const botDeeplinkBase = process.env.BOT_DEEPLINK_BASE ?? `https://max.ru/${botNick}`;

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'api-gateway',
      log_type: 'technical'
    }
  }
});

await app.register(cors, {
  origin: corsOrigin,
  credentials: true
});

await app.register(fastifyJwt, {
  namespace: 'bot',
  secret: {
    public: getBotPublicKey()
  },
  verify: {
    algorithms: ['RS256']
  }
});

await app.register(fastifyJwt, {
  namespace: 'client',
  secret: getClientJwtSecret(),
  sign: {
    algorithm: 'HS256',
    expiresIn: '15m'
  },
  verify: {
    algorithms: ['HS256']
  }
});

app.setErrorHandler((error, _request, reply) => {
  const fastifyError = error as { statusCode?: number; code?: string };

  app.log.error(error);
  reply.status(fastifyError.statusCode ?? 500).send({ error: fastifyError.code ?? 'internal_error' });
});

app.get('/health', async () => {
  const [dataService, taskService] = await Promise.all([
    checkHealth(dataServiceUrl),
    checkHealth(taskServiceUrl)
  ]);

  return {
    ok: dataService && taskService,
    services: {
      dataService,
      taskService
    }
  };
});

app.post<{ Body: { login: string } }>('/auth/login/start', async (request, reply) => {
  const login = normalizeLogin(request.body.login);

  if (!login) {
    return reply.status(400).send({ error: 'login_required' });
  }

  const result = await requestJson<ExternalLoginStartResult>(dataServiceUrl, '/auth/external/start', {
    method: 'POST',
    body: { login }
  });

  if (result.linked && result.userId && result.code) {
    await requestJson<NotificationJobResult>(taskServiceUrl, '/notifications', {
      method: 'POST',
      body: {
        recipients: [result.userId],
        text: [`Код входа для логина ${result.login}: ${result.code}`, 'Код действует 10 минут.'].join('\n')
      }
    });

    return {
      login: result.login,
      linked: true,
      delivery: 'bot_message',
      expiresAt: result.expiresAt
    };
  }

  return {
    login: result.login,
    linked: false,
    deeplink: buildLoginDeeplink(result.login),
    qrPayload: buildLoginDeeplink(result.login)
  };
});

app.post<{ Body: { login: string; code: string } }>('/auth/login/verify', async (request, reply) => {
  const login = normalizeLogin(request.body.login);

  if (!login || !request.body.code) {
    return reply.status(400).send({ error: 'invalid_login_verify_request' });
  }

  const result = await requestJson<ExternalLoginVerifyResult>(dataServiceUrl, '/auth/external/verify', {
    method: 'POST',
    body: { login, code: request.body.code }
  });

  const accessToken = await (reply as FastifyReply & { clientJwtSign: (payload: object) => Promise<string> }).clientJwtSign({
    sub: String(result.userId),
    user_id: result.userId,
    login: result.login,
    client: 'web'
  });

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    userId: result.userId,
    login: result.login
  };
});

// Gateway держит внешний контракт единым: клиенты не знают внутренние адреса
// data-service и task-service. Перед проксированием запрос обязан пройти JWT.
app.route({
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
  url: '/tasks/*',
  handler: async (request, reply) => {
  const auth = await authenticate(request, reply);

  if (!auth) {
    return;
  }

  return proxy(request, reply, taskServiceUrl, request.url.replace(/^\/tasks/, ''), auth);
  }
});

app.route({
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
  url: '/*',
  handler: async (request, reply) => {
  const auth = await authenticate(request, reply);

  if (!auth) {
    return;
  }

  if (request.url.startsWith('/auth/external/') && auth.client !== 'bot') {
    return reply.status(403).send({ error: 'bot_token_required' });
  }

  const allowed = await authorizeDataRequest(request, reply, auth);

  if (!allowed) {
    return;
  }

  return proxy(request, reply, dataServiceUrl, request.url, auth);
  }
});

const close = async () => {
  await app.close();
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

app.log.info({ port, host, dataServiceUrl, taskServiceUrl }, 'starting api gateway');
await app.listen({ port, host });

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPayload | undefined> {
  const botVerify = (request as FastifyRequest & { botJwtVerify: () => Promise<AuthPayload> }).botJwtVerify;
  const clientVerify = (request as FastifyRequest & { clientJwtVerify: () => Promise<AuthPayload> }).clientJwtVerify;

  try {
    const payload = await botVerify.call(request);

    if (isValidAuthPayload(payload)) {
      return { ...payload, client: 'bot' };
    }
  } catch {
    // If bot auth fails, try client auth below. A final 401 is sent only once.
  }

  try {
    const payload = await clientVerify.call(request);

    if (isValidAuthPayload(payload)) {
      return { ...payload, client: 'web' };
    }
  } catch {
    reply.status(401).send({ error: 'unauthorized' });
    return undefined;
  }

  reply.status(401).send({ error: 'invalid_token_payload' });
  return undefined;
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', baseUrl));
    return response.ok;
  } catch {
    return false;
  }
}

async function proxy(request: FastifyRequest, reply: FastifyReply, baseUrl: string, path: string, auth: AuthPayload) {
  const upstream = buildUpstreamRequest(request, path, auth);
  const response = await fetch(new URL(upstream.path || '/', baseUrl), {
    method: upstream.method,
    headers: buildHeaders(request, auth),
    body: upstream.body
  });

  const text = await response.text();
  reply.status(response.status);

  const contentType = response.headers.get('content-type');

  if (contentType) {
    reply.header('content-type', contentType);
  }

  return text;
}

function buildUpstreamRequest(
  request: FastifyRequest,
  path: string,
  auth: AuthPayload
): { method: string; path: string; body?: string } {
  const method = request.method;
  const normalizedPath = normalizeCurrentUserPath(path, auth);
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : JSON.stringify(normalizeCurrentUserBody(path, request.body, auth));

  return { method, path: normalizedPath, body };
}

function normalizeCurrentUserPath(path: string, auth: AuthPayload): string {
  const url = new URL(path || '/', 'http://internal.local');

  if (url.pathname === '/events/manageable' || url.pathname === '/registrations/active') {
    url.searchParams.set('userId', String(auth.user_id));
  }

  if (url.pathname === '/registrations' && url.searchParams.has('userId')) {
    url.searchParams.set('userId', String(auth.user_id));
  }

  return `${url.pathname}${url.search}`;
}

function normalizeCurrentUserBody(path: string, body: unknown, auth: AuthPayload): unknown {
  if (!body || typeof body !== 'object') {
    return body ?? {};
  }

  const url = new URL(path || '/', 'http://internal.local');

  if (url.pathname === '/users/upsert') {
    return { ...(body as Record<string, unknown>), id: auth.user_id };
  }

  if (url.pathname === '/registrations' || url.pathname === '/auth/external/code') {
    return { ...(body as Record<string, unknown>), userId: auth.user_id };
  }

  if (/^\/events\/[^/]+\/registrars$/.test(url.pathname)) {
    return { ...(body as Record<string, unknown>), assignedBy: auth.user_id };
  }

  return body;
}

async function requestJson<T>(baseUrl: string, path: string, options: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw Object.assign(new Error(await response.text()), { statusCode: response.status, code: 'upstream_error' });
  }

  return (await response.json()) as T;
}

async function authorizeDataRequest(request: FastifyRequest, reply: FastifyReply, auth: AuthPayload): Promise<boolean> {
  if (auth.client !== 'web') {
    return true;
  }

  const currentUser = await fetchCurrentUser(auth.user_id);

  if (!currentUser) {
    reply.status(403).send({ error: 'user_not_registered' });
    return false;
  }

  const url = new URL(request.url || '/', 'http://internal.local');
  const method = request.method;

  if (currentUser.role === 'tech_admin') {
    return true;
  }

  if (method === 'GET' || method === 'HEAD') {
    return authorizeWebRead(url, currentUser, reply);
  }

  if (method === 'POST' && url.pathname === '/events') {
    return authorizeUniversityBody(request.body, currentUser, reply);
  }

  const eventMatch = url.pathname.match(/^\/events\/([^/]+)(?:\/(restore|registrars))?$/);

  if (eventMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    return authorizeEventMutation(eventMatch[1], currentUser, reply, request.body);
  }

  const registrarMatch = url.pathname.match(/^\/events\/([^/]+)\/registrars\/[^/]+$/);

  if (registrarMatch && method === 'DELETE') {
    return authorizeEventMutation(registrarMatch[1], currentUser, reply, request.body);
  }

  const roleMatch = url.pathname.match(/^\/users\/(\d+)\/role$/);

  if (roleMatch && method === 'PATCH') {
    return authorizeRoleMutation(request.body, currentUser, reply);
  }

  if (url.pathname.startsWith('/auth/external/')) {
    reply.status(403).send({ error: 'bot_token_required' });
    return false;
  }

  reply.status(403).send({ error: 'insufficient_permissions' });
  return false;
}

function authorizeWebRead(url: URL, currentUser: StoredUser, reply: FastifyReply): boolean {
  if (url.pathname === '/users' && currentUser.role === 'admin') {
    const requestedUniversity = url.searchParams.get('universityId');

    if (requestedUniversity !== currentUser.universityId) {
      reply.status(403).send({ error: 'university_scope_required' });
      return false;
    }
  }

  if (url.pathname === '/users' && currentUser.role !== 'admin') {
    reply.status(403).send({ error: 'insufficient_permissions' });
    return false;
  }

  return true;
}

async function authorizeEventMutation(eventId: string, currentUser: StoredUser, reply: FastifyReply, body?: unknown): Promise<boolean> {
  if (currentUser.role !== 'admin' && currentUser.role !== 'organizer') {
    reply.status(403).send({ error: 'insufficient_permissions' });
    return false;
  }

  const event = await fetchEvent(eventId);

  if (!event) {
    reply.status(404).send({ error: 'not_found' });
    return false;
  }

  if (!currentUser.universityId || event.universityId !== currentUser.universityId) {
    reply.status(403).send({ error: 'university_scope_required' });
    return false;
  }

  const payloadUniversityId = typeof body === 'object' && body ? (body as { universityId?: unknown }).universityId : undefined;

  if (payloadUniversityId !== undefined && payloadUniversityId !== currentUser.universityId) {
    reply.status(403).send({ error: 'university_scope_required' });
    return false;
  }

  return true;
}

function authorizeUniversityBody(body: unknown, currentUser: StoredUser, reply: FastifyReply): boolean {
  if (currentUser.role !== 'admin' && currentUser.role !== 'organizer') {
    reply.status(403).send({ error: 'insufficient_permissions' });
    return false;
  }

  const universityId = typeof body === 'object' && body ? (body as { universityId?: unknown }).universityId : undefined;

  if (typeof universityId !== 'string' || !currentUser.universityId || universityId !== currentUser.universityId) {
    reply.status(403).send({ error: 'university_scope_required' });
    return false;
  }

  return true;
}

function authorizeRoleMutation(body: unknown, currentUser: StoredUser, reply: FastifyReply): boolean {
  if (currentUser.role !== 'admin') {
    reply.status(403).send({ error: 'insufficient_permissions' });
    return false;
  }

  const payload = typeof body === 'object' && body ? (body as { role?: Role; universityId?: string | null }) : {};
  const allowedRole = payload.role === 'organizer' || payload.role === 'applicant';
  const sameUniversity = payload.role === 'applicant' || payload.universityId === currentUser.universityId;

  if (!allowedRole || !sameUniversity) {
    reply.status(403).send({ error: 'insufficient_permissions' });
    return false;
  }

  return true;
}

async function fetchCurrentUser(userId: number): Promise<StoredUser | undefined> {
  try {
    return await requestJson<StoredUser>(dataServiceUrl, `/users/${userId}`, { method: 'GET' });
  } catch {
    return undefined;
  }
}

async function fetchEvent(eventId: string): Promise<EventCard | undefined> {
  try {
    return await requestJson<EventCard>(dataServiceUrl, `/events/${eventId}`, { method: 'GET' });
  } catch {
    return undefined;
  }
}

function buildHeaders(request: FastifyRequest, auth: AuthPayload): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    const normalizedKey = key.toLowerCase();

    if (['host', 'expect', 'content-length', 'authorization'].includes(normalizedKey) || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, String(value));
  }

  headers.set('x-auth-user-id', String(auth.user_id));
  headers.set('x-auth-client', auth.client ?? 'unknown');

  if (auth.login) {
    headers.set('x-auth-login', auth.login);
  }

  if (request.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return headers;
}

function normalizeLogin(login: unknown): string | undefined {
  if (typeof login !== 'string') {
    return undefined;
  }

  const normalized = login.trim().toLowerCase();
  return /^[a-z0-9._@-]{3,80}$/.test(normalized) ? normalized : undefined;
}

function buildLoginDeeplink(login: string): string {
  const separator = botDeeplinkBase.includes('?') ? '&' : '?';
  return `${botDeeplinkBase}${separator}start=${encodeURIComponent(encodeLoginPayload(login))}`;
}

function encodeLoginPayload(login: string): string {
  return `login.${Buffer.from(login, 'utf8').toString('base64url')}`;
}

function normalizeBotNick(nick: unknown): string | undefined {
  if (typeof nick !== 'string') {
    return undefined;
  }

  const normalized = nick.trim().replace(/^@/, '');
  return /^[a-zA-Z0-9_]{3,80}$/.test(normalized) ? normalized : undefined;
}

function isValidAuthPayload(payload: AuthPayload): boolean {
  return Number.isSafeInteger(payload.user_id) && payload.user_id >= 0;
}

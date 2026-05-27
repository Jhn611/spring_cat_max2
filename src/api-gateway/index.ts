import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

const port = Number(process.env.API_GATEWAY_PORT ?? 3050);
const host = process.env.API_GATEWAY_HOST ?? '0.0.0.0';
const dataServiceUrl = process.env.DATA_SERVICE_URL ?? 'http://localhost:3060';
const taskServiceUrl = process.env.TASK_SERVICE_URL ?? 'http://localhost:3070';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'api-gateway'
    }
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

app.all('/tasks/*', async (request, reply) => {
  return proxy(request, reply, taskServiceUrl, request.url.replace(/^\/tasks/, ''));
});

app.all('/*', async (request, reply) => {
  return proxy(request, reply, dataServiceUrl, request.url);
});

const close = async () => {
  await app.close();
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

app.log.info({ port, host, dataServiceUrl, taskServiceUrl }, 'starting api gateway');
await app.listen({ port, host });

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', baseUrl));
    return response.ok;
  } catch {
    return false;
  }
}

async function proxy(request: FastifyRequest, reply: FastifyReply, baseUrl: string, path: string) {
  const response = await fetch(new URL(path || '/', baseUrl), {
    method: request.method,
    headers: buildHeaders(request),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body ?? {})
  });

  const text = await response.text();
  reply.status(response.status);

  const contentType = response.headers.get('content-type');

  if (contentType) {
    reply.header('content-type', contentType);
  }

  return text;
}

function buildHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    const normalizedKey = key.toLowerCase();

    if (['host', 'expect', 'content-length'].includes(normalizedKey) || value === undefined) {
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

  if (request.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return headers;
}

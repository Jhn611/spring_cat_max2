import 'dotenv/config';
import Fastify from 'fastify';
import { Queue, Worker } from 'bullmq';
import { Bot } from '@maxhub/max-bot-api';
import type { NotificationJobInput } from '../shared/types.js';

const port = Number(process.env.TASK_SERVICE_PORT ?? 3070);
const host = process.env.TASK_SERVICE_HOST ?? '0.0.0.0';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const token = process.env.MAX_BOT_TOKEN;

const connection = { url: redisUrl };
const queue = new Queue<NotificationJobInput>('notifications', { connection });
const bot = token ? new Bot(token) : undefined;

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'task-service'
    }
  }
});

const worker = new Worker<NotificationJobInput>(
  'notifications',
  async (job) => {
    if (!bot) {
      throw new Error('MAX_BOT_TOKEN is required for notification jobs');
    }

    for (const recipient of job.data.recipients) {
      await bot.api.sendMessageToUser(recipient, job.data.text);
    }

    return { sent: job.data.recipients.length };
  },
  {
    connection,
    concurrency: Number(process.env.NOTIFICATION_WORKER_CONCURRENCY ?? 3)
  }
);

worker.on('completed', (job, result) => {
  app.log.info({ jobId: job.id, result }, 'notification job completed');
});

worker.on('failed', (job, error) => {
  app.log.error({ jobId: job?.id, err: error }, 'notification job failed');
});

app.setErrorHandler((error, _request, reply) => {
  const fastifyError = error as { statusCode?: number; code?: string };

  app.log.error(error);
  reply.status(fastifyError.statusCode ?? 500).send({ error: fastifyError.code ?? 'internal_error' });
});

app.get('/health', async () => {
  return { ok: true };
});

app.post<{ Body: NotificationJobInput }>('/notifications', async (request, reply) => {
  const recipients = [...new Set(request.body.recipients)].filter(Number.isFinite);

  if (recipients.length === 0 || !request.body.text.trim()) {
    return reply.status(400).send({ error: 'invalid_notification_job' });
  }

  const job = await queue.add(
    'send',
    {
      recipients,
      text: request.body.text
    },
    {
      attempts: Number(process.env.NOTIFICATION_JOB_ATTEMPTS ?? 3),
      backoff: {
        type: 'exponential',
        delay: 3000
      },
      removeOnComplete: 1000,
      removeOnFail: 1000
    }
  );

  app.log.info({ jobId: job.id, recipients: recipients.length }, 'notification job enqueued');
  return reply.status(202).send({ jobId: String(job.id), recipients: recipients.length });
});

const close = async () => {
  await app.close();
  await worker.close();
  await queue.close();
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

app.log.info({ port, host, redisUrl }, 'starting task service');
await app.listen({ port, host });

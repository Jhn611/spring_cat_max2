import pino from 'pino';

// Логгер бота пишет структурированные JSON-логи в stdout контейнера. Поля service
// и log_type нужны Fluent Bit, Loki и Grafana для фильтрации технических событий.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'bot',
    log_type: 'technical'
  }
});

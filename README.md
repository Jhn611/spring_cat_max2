# Весенний_код_40

MAX-бот для записи абитуриентов и студентов на мероприятия вузов.

Подробная документация: [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md).

## Возможности

- каталог вузов и мероприятий;
- запись пользователя на слот мероприятия;
- просмотр и отмена личных активных записей;
- роли `applicant`, `organizer`, `admin`, `tech_admin`;
- JWT-аутентификация на API-шлюзе;
- привязка логина внешнего клиента к MAX ID через бота и одноразовый код;
- SPA-панель управления для техадминов, админов и организаторов;
- регистраторы мероприятий для учета посещаемости;
- управление мероприятиями в рамках вуза для организаторов и админов;
- назначение админов и организаторов техническим админом;
- фоновые уведомления через очередь задач;
- JSON-логи с отправкой в Loki и просмотром в Grafana.

## Стек

- TypeScript;
- Fastify;
- MAX Bot API client;
- PostgreSQL;
- Drizzle ORM;
- Redis;
- BullMQ;
- Fastify JWT;
- React;
- Vite;
- MAX UI;
- Pino;
- Fluent Bit, Loki, Grafana;
- Docker Compose.

## Быстрый запуск

```bash
copy .env.example .env
docker compose up --build
```

Остановка:

```bash
docker compose down
```

Проверка сервисов:

```bash
curl http://localhost:3050/health
curl http://localhost:3060/health
curl http://localhost:3070/health
```

SPA-панель управления доступна на `http://localhost:3080`.
Для организаторов, админов и техадминов ссылка также показывается в боте кнопкой `Веб-панель`.

Вход в SPA:

1. Откройте панель и введите логин.
2. Если логин еще не привязан к MAX ID, панель покажет QR и deeplink в бота.
3. После привязки или при повторном входе бот отправит одноразовый код в MAX.
4. Код вводится в SPA, после чего gateway выдаёт web JWT.

Если клиент MAX открылся по QR/deeplink, но не передал payload в чат, можно написать боту вручную: `/login ваш_логин`.

## Локальная разработка

```bash
npm install
npm run dev:service
npm run dev:gateway
npm run dev:tasks
npm run dev:bot
```

SPA-панель запускается из своей папки:

```bash
cd src/admin-spa
npm install
npm run dev
```

Для локального запуска нужны PostgreSQL и Redis по адресам из `.env`.

## Основные переменные окружения

```env
MAX_BOT_TOKEN=полный_токен_бота
API_GATEWAY_URL=http://localhost:3050
DATA_SERVICE_URL=http://localhost:3060
TASK_SERVICE_URL=http://localhost:3070
DATABASE_URL=postgres://springcat:springcat@localhost:5432/springcat
REDIS_URL=redis://localhost:6379
LOG_LEVEL=info
TECH_ADMIN_MAX_IDS=ваш_max_id
LEGAL_DOC_VERSION=hackathon-2026-05-14
BOT_DISPLAY_NAME=Весенний_код_40
BOT_NICK=spring_cat40_bot
BOT_DEEPLINK_BASE=https://max.ru/spring_cat40_bot
ADMIN_SPA_URL=http://localhost:3080
BOT_JWT_PRIVATE_KEY_BASE64=
BOT_JWT_PUBLIC_KEY_BASE64=
CLIENT_JWT_SECRET=change-me-for-web-clients
```

В Docker внутренние адреса сервисов задаются в `docker-compose.yml`.
Для локального запуска есть dev fallback RSA-ключей, в production нужно задать собственные `BOT_JWT_*` и `CLIENT_JWT_SECRET`.

## Команды бота

- `/start` - главное меню;
- `/events` - каталог мероприятий;
- `/my` - мои активные записи;
- `/org` - мероприятия организатора;
- `/org_create` - создание мероприятия;
- `/org_edit` - изменение мероприятия;
- `/admin` - админ-панель;
- `/login ЛОГИН` - код входа для внешнего клиента;
- `/registrar_add event_id MAX_ID` - назначить регистратора мероприятия;
- `/registrar_remove event_id MAX_ID` - снять регистратора мероприятия;
- `/whoami` - MAX ID текущего пользователя.

## Сервисы

- `bot` - диалоги MAX и пользовательские сценарии;
- `api-gateway` - единая входная точка для клиентов;
- `src/admin-spa` - React + TS панель управления для браузера;
- `data-service` - данные, роли, мероприятия, записи и PostgreSQL;
- `task-service` - фоновые задачи и уведомления;
- `postgres` - основная БД;
- `redis` - очередь BullMQ;
- `fluent-bit`, `loki`, `grafana` - логирование и наблюдаемость.

## Логи

```bash
docker compose logs -f bot
docker compose logs -f api-gateway
docker compose logs -f data-service
docker compose logs -f task-service
```

Grafana доступна на `http://localhost:3000`, Loki на `http://localhost:3100`.

## Сборка

```bash
npm run build
```

## Миграции БД

Схема PostgreSQL описана в `src/data-service/schema.ts`, миграции лежат в `drizzle/`.

```bash
npm run db:generate
npm run db:migrate
```

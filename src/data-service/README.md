# Data service module

HTTP API and database owner.

Responsibilities:

- expose events, users, registrations, free seats and organizer operations;
- own Postgres access through `database.ts`;
- seed demo events from `seed-events.ts`;
- hide persistence details from the bot.

Configuration:

- `DATABASE_URL` - Postgres connection string.
- `DATA_SERVICE_PORT` - HTTP port, default `3060`.

Runtime entrypoint: `src/data-service/index.ts`.

# Data service module

HTTP API and database owner.

Responsibilities:

- expose universities, events, users, registrations, free seats and organizer operations;
- own Postgres access through `database.ts`;
- keep universities, events and slots in normalized Postgres tables;
- bootstrap demo rows directly into Postgres when the database is empty;
- hide persistence details from the bot.

Configuration:

- `DATABASE_URL` - Postgres connection string.
- `DATA_SERVICE_PORT` - HTTP port, default `3060`.

Runtime entrypoint: `src/data-service/index.ts`.

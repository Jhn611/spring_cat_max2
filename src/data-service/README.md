# Data service module

HTTP API and database owner.

Responsibilities:

- expose events, users, registrations, free seats and organizer operations;
- own SQLite access through `database.ts`;
- seed demo events from `seed-events.ts`;
- hide persistence details from the bot.

Runtime entrypoint: `src/data-service/index.ts`.

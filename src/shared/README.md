# Shared module

Stable contract used by both runtime modules.

Responsibilities:

- shared TypeScript types;
- small domain helpers that do not depend on MAX, HTTP or the database.

Keep this module infrastructure-free so it can later become a separate package if the bot and data service are split into different repositories or containers.

# Bot module

MAX-facing process.

Responsibilities:

- receive MAX updates and callback payloads;
- render user and organizer dialogs;
- call the data service through `data-service-client.ts`;
- never read or write the database directly.

Runtime entrypoint: `src/bot/index.ts`.

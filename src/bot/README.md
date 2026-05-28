# Bot module

MAX-facing process.

Responsibilities:

- receive MAX updates and callback payloads;
- render user and organizer dialogs;
- keep short in-memory flows for multi-step actions like event creation and editing;
- show calendar and slot-time pickers while still accepting manual text input where it helps;
- keep user-facing texts explicit and mark important states with one visual marker: success, warning, error, cancellation or neutral info;
- call the API gateway through `api-client.ts`;
- never read or write the database directly.

Runtime entrypoint: `src/bot/index.ts`.

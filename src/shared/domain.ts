import type { RegistrationStatus } from './types.js';

// Доменные помощники лежат в shared, чтобы бот, data-service и будущие клиенты
// одинаково трактовали статусы записей и другие бизнес-правила.
export function isActiveStatus(status: RegistrationStatus): boolean {
  return status === 'confirmed' || status === 'attended';
}

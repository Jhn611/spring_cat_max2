import type { RegistrationStatus } from './types.js';

export function isActiveStatus(status: RegistrationStatus): boolean {
  return status === 'confirmed' || status === 'attended';
}

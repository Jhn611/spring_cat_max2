import type { Role } from './types';

// Константы фронтенда отделены от компонентов, чтобы подписи ролей и правила
// допуска в панель были едиными для экрана входа, навигации и админского раздела.
export const SESSION_KEY = 'springcat.admin.session';

export const roleLabels: Record<Role, string> = {
  applicant: 'Участник',
  organizer: 'Организатор',
  admin: 'Админ вуза',
  tech_admin: 'Техадмин'
};

export function isStaffRole(role: Role | undefined): boolean {
  return role === 'organizer' || role === 'admin' || role === 'tech_admin';
}

export function canUseAdminTools(role: Role | undefined): boolean {
  return role === 'admin' || role === 'tech_admin';
}

// Типы SPA повторяют публичный контракт gateway и data-service. Это помогает
// компонентам работать с предсказуемыми структурами без знания серверной схемы БД.
export type Role = 'applicant' | 'organizer' | 'admin' | 'tech_admin';
export type EventFormat = 'online' | 'offline';
export type RegistrationStatus = 'confirmed' | 'attended' | 'cancelled_by_user' | 'cancelled_by_organizer' | 'late_cancelled';

export type University = {
  id: string;
  title: string;
  shortTitle: string;
  city: string;
  description: string;
};

export type EventSlot = {
  id: string;
  label: string;
  startsAt: string;
};

export type EventCard = {
  id: string;
  universityId: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  format: EventFormat;
  capacity: number;
  organizerIds: number[];
  description: string;
  requirements: string;
  locationOrUrl: string;
  cancelPolicy: string;
  registrationClosed: boolean;
  lateCancelAllowed: boolean;
  slots: EventSlot[];
  registrarIds: number[];
  deletedAt?: string;
};

export type EventInput = {
  universityId: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  format: EventFormat;
  capacity: number;
  description: string;
  requirements: string;
  locationOrUrl: string;
  cancelPolicy: string;
  registrationClosed?: boolean;
  lateCancelAllowed?: boolean;
  slots?: EventSlot[];
};

export type StoredUser = {
  id: number;
  name: string;
  username?: string;
  role: Role;
  universityId?: string;
  updatedAt: string;
};

export type Registration = {
  id: string;
  code: string;
  eventId: string;
  slotId?: string;
  userId: number;
  userName: string;
  status: RegistrationStatus;
  notificationsEnabled: boolean;
  attendedAt?: string;
  attendedBy?: number;
  createdAt: string;
  updatedAt: string;
};

export type EventRegistrar = {
  eventId: string;
  userId: number;
  assignedBy: number;
  assignedAt: string;
};

export type Session = {
  accessToken: string;
  userId: number;
  login: string;
};

export type View = 'events' | 'admins';

export type EventFormState = {
  id?: string;
  universityId: string;
  title: string;
  date: string;
  durationMinutes: string;
  format: EventFormat;
  capacity: string;
  description: string;
  requirements: string;
  locationOrUrl: string;
  cancelPolicy: string;
  registrationClosed: boolean;
  lateCancelAllowed: boolean;
  slotStart: string;
  slots: EventSlot[];
};

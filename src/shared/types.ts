export type Role = 'applicant' | 'organizer' | 'admin' | 'tech_admin';

export type EventFormat = 'online' | 'offline';

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
  deletedAt?: string;
};

export type CreateEventInput = {
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

export type UpdateEventInput = Partial<Omit<CreateEventInput, 'universityId' | 'slots'>> & {
  universityId?: string;
};

export type DeleteEventResult = 'deleted' | 'not_found';

export type RegistrationStatus =
  | 'confirmed'
  | 'attended'
  | 'cancelled_by_user'
  | 'cancelled_by_organizer'
  | 'late_cancelled';

export type Registration = {
  id: string;
  code: string;
  eventId: string;
  slotId?: string;
  userId: number;
  userName: string;
  status: RegistrationStatus;
  notificationsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserConsent = {
  profile: boolean;
  documentVersion: string;
  acceptedAt: string;
};

export type StoredUser = {
  id: number;
  name: string;
  username?: string;
  role: Role;
  universityId?: string;
  consent?: UserConsent;
  updatedAt: string;
};

export type StoreState = {
  users: StoredUser[];
  registrations: Registration[];
};

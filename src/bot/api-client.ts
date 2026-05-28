import type {
  CreateEventInput,
  EventCard,
  EventRegistrar,
  ExternalLoginCodeResult,
  NotificationJobInput,
  NotificationJobResult,
  Registration,
  Role,
  StoredUser,
  UpdateEventInput,
  University
} from '../shared/types.js';
import { signBotJwt } from '../shared/auth.js';

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  listUniversities(): Promise<University[]> {
    return this.request('/universities');
  }

  getUniversity(universityId: string): Promise<University | undefined> {
    return this.requestOrUndefined(`/universities/${encodeURIComponent(universityId)}`);
  }

  listEvents(universityId?: string): Promise<EventCard[]> {
    const query = universityId ? `?universityId=${encodeURIComponent(universityId)}` : '';
    return this.request(`/events${query}`);
  }

  getEvent(eventId: string): Promise<EventCard | undefined> {
    return this.requestOrUndefined(`/events/${encodeURIComponent(eventId)}`);
  }

  createEvent(input: CreateEventInput): Promise<EventCard> {
    return this.request('/events', { method: 'POST', body: input });
  }

  updateEvent(eventId: string, patch: UpdateEventInput): Promise<EventCard | undefined> {
    return this.requestOrUndefined(`/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: patch });
  }

  async deleteEvent(eventId: string): Promise<'deleted' | 'not_found'> {
    const response = await this.fetch(`/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });

    if (response.status === 204) {
      return 'deleted';
    }

    if (response.status === 404) {
      return 'not_found';
    }

    return this.parse(response);
  }

  restoreEvent(eventId: string): Promise<EventCard | undefined> {
    return this.requestOrUndefined(`/events/${encodeURIComponent(eventId)}/restore`, { method: 'POST' });
  }

  listEventRegistrars(eventId: string, authUserId?: number): Promise<EventRegistrar[]> {
    return this.request(`/events/${encodeURIComponent(eventId)}/registrars`, { authUserId });
  }

  assignEventRegistrar(eventId: string, userId: number, assignedBy: number): Promise<EventRegistrar> {
    return this.request(`/events/${encodeURIComponent(eventId)}/registrars`, {
      method: 'POST',
      body: { userId, assignedBy },
      authUserId: assignedBy
    });
  }

  async removeEventRegistrar(eventId: string, userId: number, authUserId: number): Promise<'removed' | 'not_found'> {
    const response = await this.fetch(`/events/${encodeURIComponent(eventId)}/registrars/${userId}`, {
      method: 'DELETE',
      authUserId
    });

    if (response.status === 204) {
      return 'removed';
    }

    if (response.status === 404) {
      return 'not_found';
    }

    return this.parse(response);
  }

  listManageableEvents(userId: number, role: Role): Promise<EventCard[]> {
    return this.request(`/events/manageable?userId=${userId}&role=${encodeURIComponent(role)}`, { authUserId: userId });
  }

  async freeSeats(eventId: string): Promise<number> {
    const result = await this.request<{ freeSeats: number }>(`/events/${encodeURIComponent(eventId)}/free-seats`);
    return result.freeSeats;
  }

  getUser(userId: number, authUserId = userId): Promise<StoredUser | undefined> {
    return this.requestOrUndefined(`/users/${userId}`, { authUserId });
  }

  listUsers(role?: Role, universityId?: string, authUserId?: number): Promise<StoredUser[]> {
    const params = new URLSearchParams();
    if (role) params.set('role', role);
    if (universityId) params.set('universityId', universityId);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/users${query}`, { authUserId });
  }

  upsertUser(user: Omit<StoredUser, 'updatedAt'>): Promise<StoredUser> {
    return this.request('/users/upsert', { method: 'POST', body: user, authUserId: user.id });
  }

  setUserRole(userId: number, role: Role, universityId?: string | null, authUserId = userId): Promise<StoredUser> {
    return this.request(`/users/${userId}/role`, { method: 'PATCH', body: { role, universityId }, authUserId });
  }

  createRegistration(registration: Registration): Promise<Registration> {
    return this.request('/registrations', { method: 'POST', body: registration, authUserId: registration.userId });
  }

  updateRegistration(id: string, patch: Partial<Registration>, authUserId?: number): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, authUserId });
  }

  listRegistrations(eventId?: string, userId?: number, authUserId?: number): Promise<Registration[]> {
    const params = new URLSearchParams();
    if (eventId) params.set('eventId', eventId);
    if (userId !== undefined) params.set('userId', String(userId));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/registrations${query}`, { authUserId: authUserId ?? userId });
  }

  findRegistrationByCode(code: string): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/code/${encodeURIComponent(code.trim().toUpperCase())}`);
  }

  activeRegistration(userId: number, eventId: string): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/active?userId=${userId}&eventId=${encodeURIComponent(eventId)}`, { authUserId: userId });
  }

  enqueueNotification(input: NotificationJobInput): Promise<NotificationJobResult> {
    return this.request('/tasks/notifications', { method: 'POST', body: input });
  }

  issueExternalLoginCode(login: string, userId: number): Promise<ExternalLoginCodeResult> {
    return this.request('/auth/external/code', { method: 'POST', body: { login, userId }, authUserId: userId });
  }

  private async requestOrUndefined<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const response = await this.fetch(path, options);

    if (response.status === 404) {
      return undefined;
    }

    return this.parse<T>(response);
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.parse<T>(await this.fetch(path, options));
  }

  private fetch(path: string, options: RequestOptions): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${signBotJwt(options.authUserId ?? inferAuthUserId(options.body) ?? 0)}`
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  }

  private async parse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`API gateway error ${response.status}: ${message}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  authUserId?: number;
};

function inferAuthUserId(body: unknown): number | undefined {
  if (body && typeof body === 'object' && 'userId' in body) {
    const userId = Number((body as { userId?: unknown }).userId);
    return Number.isSafeInteger(userId) ? userId : undefined;
  }

  return undefined;
}

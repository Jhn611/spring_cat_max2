import type { CreateEventInput, EventCard, Registration, Role, StoredUser, UpdateEventInput, University } from '../shared/types.js';

export class DataServiceClient {
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

  listManageableEvents(userId: number, role: Role): Promise<EventCard[]> {
    return this.request(`/events/manageable?userId=${userId}&role=${encodeURIComponent(role)}`);
  }

  async freeSeats(eventId: string): Promise<number> {
    const result = await this.request<{ freeSeats: number }>(`/events/${encodeURIComponent(eventId)}/free-seats`);
    return result.freeSeats;
  }

  getUser(userId: number): Promise<StoredUser | undefined> {
    return this.requestOrUndefined(`/users/${userId}`);
  }

  listUsers(role?: Role, universityId?: string): Promise<StoredUser[]> {
    const params = new URLSearchParams();
    if (role) params.set('role', role);
    if (universityId) params.set('universityId', universityId);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/users${query}`);
  }

  upsertUser(user: Omit<StoredUser, 'updatedAt'>): Promise<StoredUser> {
    return this.request('/users/upsert', { method: 'POST', body: user });
  }

  setUserRole(userId: number, role: Role, universityId?: string | null): Promise<StoredUser> {
    return this.request(`/users/${userId}/role`, { method: 'PATCH', body: { role, universityId } });
  }

  createRegistration(registration: Registration): Promise<Registration> {
    return this.request('/registrations', { method: 'POST', body: registration });
  }

  updateRegistration(id: string, patch: Partial<Registration>): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  }

  listRegistrations(eventId?: string, userId?: number): Promise<Registration[]> {
    const params = new URLSearchParams();
    if (eventId) params.set('eventId', eventId);
    if (userId !== undefined) params.set('userId', String(userId));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/registrations${query}`);
  }

  findRegistrationByCode(code: string): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/code/${encodeURIComponent(code.trim().toUpperCase())}`);
  }

  activeRegistration(userId: number, eventId: string): Promise<Registration | undefined> {
    return this.requestOrUndefined(`/registrations/active?userId=${userId}&eventId=${encodeURIComponent(eventId)}`);
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
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  }

  private async parse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Data service error ${response.status}: ${message}`);
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
};

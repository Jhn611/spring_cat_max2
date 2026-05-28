import type { EventCard, EventInput, EventRegistrar, Registration, Role, Session, StoredUser, University } from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3050';

type LoginStartResponse =
  | { login: string; linked: true; delivery: 'bot_message'; expiresAt: string }
  | { login: string; linked: false; deeplink: string; qrPayload: string };

type LoginVerifyResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userId: number;
  login: string;
};

export class ApiClient {
  constructor(private readonly session?: Session) {}

  async startLogin(login: string): Promise<LoginStartResponse> {
    return this.request('/auth/login/start', { method: 'POST', body: { login }, anonymous: true });
  }

  async verifyLogin(login: string, code: string): Promise<LoginVerifyResponse> {
    return this.request('/auth/login/verify', { method: 'POST', body: { login, code }, anonymous: true });
  }

  async currentUser(userId: number): Promise<StoredUser> {
    return this.request(`/users/${userId}`);
  }

  async universities(): Promise<University[]> {
    return this.request('/universities');
  }

  async manageableEvents(): Promise<EventCard[]> {
    return this.request('/events/manageable');
  }

  async createEvent(input: EventInput): Promise<EventCard> {
    return this.request('/events', { method: 'POST', body: input });
  }

  async updateEvent(eventId: string, input: Partial<EventInput>): Promise<EventCard> {
    return this.request(`/events/${eventId}`, { method: 'PATCH', body: input });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.request(`/events/${eventId}`, { method: 'DELETE', empty: true });
  }

  async restoreEvent(eventId: string): Promise<EventCard> {
    return this.request(`/events/${eventId}/restore`, { method: 'POST', body: {} });
  }

  async registrations(eventId: string): Promise<Registration[]> {
    return this.request(`/registrations?eventId=${encodeURIComponent(eventId)}`);
  }

  async findRegistration(code: string): Promise<Registration> {
    return this.request(`/registrations/code/${encodeURIComponent(code)}`);
  }

  async markAttended(registration: Registration, userId: number): Promise<Registration> {
    return this.request(`/registrations/${registration.id}`, {
      method: 'PATCH',
      body: {
        status: 'attended',
        attendedAt: new Date().toISOString(),
        attendedBy: userId
      }
    });
  }

  async registrars(eventId: string): Promise<EventRegistrar[]> {
    return this.request(`/events/${eventId}/registrars`);
  }

  async addRegistrar(eventId: string, userId: number): Promise<EventRegistrar> {
    return this.request(`/events/${eventId}/registrars`, { method: 'POST', body: { userId } });
  }

  async removeRegistrar(eventId: string, userId: number): Promise<void> {
    await this.request(`/events/${eventId}/registrars/${userId}`, { method: 'DELETE', empty: true });
  }

  async users(role?: Role, universityId?: string): Promise<StoredUser[]> {
    const params = new URLSearchParams();
    if (role) params.set('role', role);
    if (universityId) params.set('universityId', universityId);
    const suffix = params.toString() ? `?${params}` : '';
    return this.request(`/users${suffix}`);
  }

  async setRole(userId: number, role: Role, universityId?: string | null): Promise<StoredUser> {
    return this.request(`/users/${userId}/role`, { method: 'PATCH', body: { role, universityId } });
  }

  // Браузерная панель обращается только к публичному gateway. Он проверяет JWT,
  // ограничивает запрос ролью и вузом, а затем проксирует его во внутренний сервис.
  private async request<T>(path: string, options: { method?: string; body?: unknown; anonymous?: boolean; empty?: boolean } = {}): Promise<T> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (!options.anonymous && this.session) headers.set('authorization', `Bearer ${this.session.accessToken}`);

    const response = await fetch(new URL(path, API_BASE_URL), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    if (options.empty || response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export function api(session?: Session): ApiClient {
  return new ApiClient(session);
}

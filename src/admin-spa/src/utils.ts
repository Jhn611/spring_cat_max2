import type { EventCard, EventFormState, EventInput, EventSlot, Session, StoredUser, University } from './types';
import { SESSION_KEY } from './constants';
import type { api } from './api';

export function emptyEventForm(universityId = ''): EventFormState {
  return {
    universityId,
    title: '',
    date: toInputDate(new Date().toISOString()),
    durationMinutes: '60',
    format: 'offline',
    capacity: '20',
    description: '',
    requirements: '',
    locationOrUrl: '',
    cancelPolicy: 'Отмена доступна до начала мероприятия.',
    registrationClosed: false,
    lateCancelAllowed: false,
    slotStart: '10:00',
    slots: []
  };
}

export function loadSession(): Session | undefined {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return undefined;
  }
}

export function persistSession(session: Session | undefined): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export async function submitEventForm(client: ReturnType<typeof api>, form: EventFormState): Promise<void> {
  const payload: EventInput = {
    universityId: form.universityId,
    title: form.title.trim(),
    startsAt: combineDateTime(form.date, firstSlotStart(form) ?? '10:00'),
    durationMinutes: Number(form.durationMinutes),
    format: form.format,
    capacity: Number(form.capacity),
    description: form.description.trim(),
    requirements: form.requirements.trim(),
    locationOrUrl: form.locationOrUrl.trim(),
    cancelPolicy: form.cancelPolicy.trim(),
    registrationClosed: form.registrationClosed,
    lateCancelAllowed: form.lateCancelAllowed,
    slots: form.slots
  };

  if (form.id) await client.updateEvent(form.id, payload);
  else await client.createEvent(payload);
}

export function formFromEvent(event: EventCard): EventFormState {
  return {
    ...emptyEventForm(event.universityId),
    id: event.id,
    title: event.title,
    date: toInputDate(event.startsAt),
    durationMinutes: String(event.durationMinutes),
    format: event.format,
    capacity: String(event.capacity),
    description: event.description,
    requirements: event.requirements,
    locationOrUrl: event.locationOrUrl,
    cancelPolicy: event.cancelPolicy,
    registrationClosed: event.registrationClosed,
    lateCancelAllowed: event.lateCancelAllowed,
    slotStart: event.slots[0]?.label.slice(0, 5) ?? '10:00',
    slots: event.slots
  };
}

export function defaultUniversityId(user: StoredUser | undefined, universities: University[]): string {
  return user?.role === 'tech_admin' ? universities[0]?.id ?? '' : user?.universityId ?? universities[0]?.id ?? '';
}

export function isValidEventForm(form: EventFormState): boolean {
  return Boolean(
    form.universityId &&
      form.title.trim() &&
      form.date &&
      positiveNumber(form.capacity) &&
      positiveNumber(form.durationMinutes) &&
      form.description.trim() &&
      form.locationOrUrl.trim() &&
      form.slots.length
  );
}

export function createSlot(dateRaw: string, startRaw: string, durationMinutesRaw: string, existing: EventSlot[]): EventSlot | undefined {
  const start = parseTime(startRaw);
  const duration = Number(durationMinutesRaw);
  if (!start || !Number.isSafeInteger(duration) || duration <= 0) return undefined;

  const end = new Date(start.getTime() + duration * 60_000);
  const label = `${hhmm(start)}-${hhmm(end)}`;
  return {
    id: label,
    label,
    startsAt: combineDateTime(dateRaw, startRaw)
  };
}

export function firstSlotStart(form: EventFormState): string | undefined {
  return form.slots[0]?.label.slice(0, 5);
}

export function combineDateTime(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

export function toInputDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function parseTime(value: string): Date | undefined {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

export function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function universityName(universities: University[], universityId: string): string {
  return universities.find((item) => item.id === universityId)?.shortTitle ?? universityId;
}

export function positiveNumber(value: string): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка';
}

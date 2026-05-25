import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Bot, Keyboard, type Context } from '@maxhub/max-bot-api';
import { DataServiceClient } from './data-service-client.js';
import { logger } from './logger.js';
import { isActiveStatus } from '../shared/domain.js';
import type {
  CreateEventInput,
  EventCard,
  EventFormat,
  Registration,
  RegistrationStatus,
  Role,
  StoredUser,
  UpdateEventInput,
  University
} from '../shared/types.js';

const token = process.env.MAX_BOT_TOKEN;

if (!token) {
  throw new Error('MAX_BOT_TOKEN is required. Copy .env.example to .env and set the bot token.');
}

const bot = new Bot(token);
const store = new DataServiceClient(process.env.DATA_SERVICE_URL ?? 'http://localhost:3060');
const legalDocVersion = process.env.LEGAL_DOC_VERSION ?? 'hackathon-2026-05-14';
const adminIds = parseIdSet(process.env.ADMIN_MAX_IDS);
const techAdminIds = parseIdSet(process.env.TECH_ADMIN_MAX_IDS ?? process.env.MAIN_ADMIN_MAX_IDS);
const bootstrapAdminUniversityId = process.env.ADMIN_UNIVERSITY_ID ?? process.env.DEFAULT_UNIVERSITY_ID;

logger.info(
  {
    dataServiceUrl: process.env.DATA_SERVICE_URL ?? 'http://localhost:3060',
    legalDocVersion,
    adminIdsCount: adminIds.size,
    techAdminIdsCount: techAdminIds.size
  },
  'initializing bot'
);

type AnyContext = Context<any>;
type ReplyExtra = Parameters<AnyContext['reply']>[1];

const screenMessages = new Map<string, string[]>();

const statusLabels: Record<RegistrationStatus, string> = {
  confirmed: 'Подтверждена',
  attended: 'Участник пришел',
  cancelled_by_user: 'Отменена пользователем',
  cancelled_by_organizer: 'Отменена организатором',
  late_cancelled: 'Поздняя отмена'
};

const roleLabels: Record<Role, string> = {
  applicant: 'Абитуриент',
  organizer: 'Организатор',
  admin: 'Админ',
  tech_admin: 'Техадмин'
};

const notificationTemplates = {
  day: 'Напоминание: мероприятие состоится завтра. Проверьте код записи и детали в боте.',
  hour: 'Напоминание: мероприятие начнется примерно через час.',
  time: 'Обновление по мероприятию: время изменилось. Проверьте актуальную информацию у организатора.',
  room: 'Обновление по мероприятию: изменилась аудитория или место сбора.',
  link: 'Обновление по мероприятию: ссылка на подключение будет отправлена организатором отдельно.',
  details: 'Обновление по мероприятию: изменились детали мероприятия. Проверьте актуальную информацию в боте.'
} as const;

function rows(buttons: ReturnType<typeof Keyboard.button.callback>[][]) {
  return { attachments: [Keyboard.inlineKeyboard(buttons)] };
}

function button(text: string, payload: string, intent: 'default' | 'positive' | 'negative' = 'default') {
  return Keyboard.button.callback(text, payload, { intent });
}

function messageId(message: Awaited<ReturnType<AnyContext['reply']>>): string {
  return message.body.mid;
}

function screenKey(ctx: AnyContext): string | undefined {
  const sender = getSender(ctx);
  const chatId = ctx.chatId ?? ctx.message?.recipient.chat_id;

  if (chatId !== undefined && chatId !== null) {
    return `chat:${chatId}`;
  }

  return sender ? `user:${sender.user_id}` : undefined;
}

async function deleteTrackedScreen(ctx: AnyContext, keepIds: string[] = []): Promise<void> {
  const key = screenKey(ctx);

  if (!key) {
    return;
  }

  const keep = new Set(keepIds);
  const ids = screenMessages.get(key) ?? [];

  for (const id of ids) {
    if (keep.has(id)) {
      continue;
    }

    try {
      await ctx.api.deleteMessage(id);
    } catch {
      // The message may already be gone or unavailable for deletion.
    }
  }

  screenMessages.set(key, keepIds);
}

function rememberScreen(ctx: AnyContext, ids: string[]): void {
  const key = screenKey(ctx);

  if (key) {
    screenMessages.set(key, ids);
  }
}

async function sendScreenMessage(ctx: AnyContext, text: string, extra?: ReplyExtra): Promise<string> {
  return messageId(await ctx.reply(text, extra));
}

async function renderSingle(ctx: AnyContext, text: string, extra?: ReplyExtra): Promise<void> {
  const currentId = ctx.messageId;

  if (currentId && ctx.callback) {
    await deleteTrackedScreen(ctx, [currentId]);

    try {
      await ctx.editMessage({ text, ...extra });
      rememberScreen(ctx, [currentId]);
      return;
    } catch {
      // Some callback messages cannot be edited; fall back to a fresh screen.
    }
  }

  await deleteTrackedScreen(ctx);
  rememberScreen(ctx, [await sendScreenMessage(ctx, text, extra)]);
}

async function renderMany(
  ctx: AnyContext,
  messages: Array<{ text: string; extra?: ReplyExtra }>
): Promise<void> {
  await deleteTrackedScreen(ctx);
  const ids: string[] = [];

  for (const message of messages) {
    ids.push(await sendScreenMessage(ctx, message.text, message.extra));
  }

  rememberScreen(ctx, ids);
}

function parseIdSet(raw?: string): Set<number> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter(Number.isFinite)
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow'
  }).format(new Date(iso));
}

function formatDuration(minutes: number): string {
  return `${minutes} мин.`;
}

function formatEvent(event: EventCard, freeSeats: number, university?: University): string {
  const format = event.format === 'online' ? 'онлайн' : 'очно';
  const seats = event.registrationClosed ? 'регистрация закрыта' : freeSeats > 0 ? `свободно мест: ${freeSeats}` : 'мест нет';

  return [
    event.title,
    ...(event.deletedAt ? ['Статус: удалено, скрыто из каталога'] : []),
    `Вуз: ${university?.shortTitle ?? event.universityId}`,
    `Дата: ${formatDate(event.startsAt)}`,
    `Длительность: ${formatDuration(event.durationMinutes)}`,
    `Формат: ${format}`,
    `Статус: ${seats}`
  ].join('\n');
}

function eventById(eventId: string): Promise<EventCard | undefined> {
  return store.getEvent(eventId);
}

function slotLabel(event: EventCard, slotId?: string): string {
  if (!slotId) {
    return 'без отдельного слота';
  }

  return event.slots.find((slot) => slot.id === slotId)?.label ?? slotId;
}

async function freeSeats(event: EventCard): Promise<number> {
  return store.freeSeats(event.id);
}

function getSender(ctx: AnyContext) {
  return ctx.user ?? ctx.message?.sender ?? ctx.callback?.user;
}

function logContext(ctx: AnyContext) {
  const sender = getSender(ctx);

  return {
    userId: sender?.user_id,
    chatId: ctx.chatId ?? ctx.message?.recipient.chat_id,
    messageId: ctx.messageId,
    callbackPayload: ctx.callback?.payload
  };
}

function roleFor(userId: number, saved?: StoredUser): Role {
  if (techAdminIds.has(userId)) {
    return 'tech_admin';
  }

  if (adminIds.has(userId)) {
    return 'admin';
  }

  return saved?.role ?? 'applicant';
}

function universityFor(userId: number, saved?: StoredUser): string | undefined {
  if (techAdminIds.has(userId)) {
    return undefined;
  }

  if (adminIds.has(userId)) {
    return saved?.universityId ?? bootstrapAdminUniversityId;
  }

  return saved?.universityId;
}

async function rememberUser(ctx: AnyContext): Promise<StoredUser | undefined> {
  const sender = getSender(ctx);
  if (!sender) {
    return undefined;
  }

  const saved = await store.getUser(sender.user_id);
  return store.upsertUser({
    id: sender.user_id,
    name: sender.name,
    username: sender.username ?? undefined,
    role: roleFor(sender.user_id, saved),
    universityId: universityFor(sender.user_id, saved),
    consent: saved?.consent
  });
}

async function requireConsent(ctx: AnyContext): Promise<StoredUser | undefined> {
  const user = await rememberUser(ctx);

  if (!user) {
    await ctx.reply('Не удалось определить пользователя. Попробуйте открыть диалог с ботом напрямую.');
    return undefined;
  }

  if (!user.consent?.profile) {
    await showWelcome(ctx);
    return undefined;
  }

  return user;
}

async function showWelcome(ctx: AnyContext) {
  await renderSingle(
    ctx,
    [
      'Весенний_код_40 помогает записаться на мероприятия университета: дни открытых дверей, экскурсии, консультации и пробные занятия.',
      '',
      'Сервис разработан командой хакатона университета и не является официальной функцией платформы MAX.',
      '',
      `Для записи бот хранит только MAX ID, отображаемое имя, код записи, выбранное мероприятие и статус. Телефон не запрашивается. Версия документов: ${legalDocVersion}.`
    ].join('\n'),
    rows([[button('Согласен, продолжить', 'consent:accept', 'positive')]])
  );
}

async function showMainMenu(ctx: AnyContext, user?: StoredUser) {
  const current = user ?? (await requireConsent(ctx));

  if (!current) {
    return;
  }

  const menu = [
    [button('Все мероприятия', 'catalog')],
    [button('Выбрать вуз', 'universities')],
    [button('Мои записи', 'my')]
  ];

  if (current.role === 'organizer' || current.role === 'admin') {
    menu.push([button('Меню организатора', 'org')]);
  }

  if (current.role === 'tech_admin') {
    menu.push([button('Меню организатора', 'org')]);
  }

  if (current.role === 'admin' || current.role === 'tech_admin') {
    menu.push([button('Админ-панель', 'admin')]);
  }

  await renderSingle(ctx, 'Выберите действие:', rows(menu));
}

async function showCatalog(ctx: AnyContext, universityId?: string) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();
  const universitiesById = new Map(universities.map((university) => [university.id, university]));
  const events = await store.listEvents(universityId);

  if (events.length === 0) {
    await renderSingle(ctx, 'Мероприятий пока нет.', rows([[button('Выбрать вуз', 'universities')], [button('Назад', 'menu')]]));
    return;
  }

  const header = universityId
    ? `Мероприятия выбранного вуза: ${universitiesById.get(universityId)?.shortTitle ?? universityId}`
    : 'Все ближайшие мероприятия';
  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: header,
      extra: rows([
        [button('Выбрать вуз', 'universities')],
        [button('Главное меню', 'menu')]
      ])
    }
  ];

  for (const event of events) {
    const seats = await freeSeats(event);
    const buttons = [[button('Подробнее', `event:${event.id}`)]];

    if (!event.registrationClosed && seats > 0) {
      buttons[0].push(button('Записаться', `enroll:${event.id}`, 'positive'));
    }

    messages.push({ text: formatEvent(event, seats, universitiesById.get(event.universityId)), extra: rows(buttons) });
  }

  await renderMany(ctx, messages);
}

async function showUniversities(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();

  if (universities.length === 0) {
    await renderSingle(ctx, 'Список вузов пока пуст.', rows([[button('Назад', 'menu')]]));
    return;
  }

  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: 'Выберите вуз:',
      extra: rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]])
    }
  ];

  for (const university of universities) {
    messages.push({
      text: [
        university.title,
        `Город: ${university.city}`,
        university.description
      ].join('\n'),
      extra: rows([
        [button('Мероприятия вуза', `university:events:${university.id}`, 'positive')]
      ])
    });
  }

  await renderMany(ctx, messages);
}

async function showEventDetails(ctx: AnyContext, eventId: string) {
  const event = await eventById(eventId);

  if (!event) {
    await renderSingle(ctx, 'Мероприятие не найдено.', rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, 'Мероприятие сейчас недоступно.', rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]]));
    return;
  }

  const seats = await freeSeats(event);
  const university = await store.getUniversity(event.universityId);
  const text = [
    formatEvent(event, seats, university),
    '',
    event.description,
    '',
    `Требования: ${event.requirements}`,
    `Адрес/ссылка: ${event.locationOrUrl}`,
    `Отмена: ${event.cancelPolicy}`
  ].join('\n');

  const actions = [[button('К мероприятиям вуза', `university:events:${event.universityId}`), button('Все мероприятия', 'catalog')]];

  if (!event.registrationClosed && seats > 0) {
    actions.unshift([button('Записаться', `enroll:${event.id}`, 'positive')]);
  }

  await renderSingle(ctx, text, rows(actions));
}

async function startEnrollment(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || event.deletedAt) {
    await renderSingle(ctx, 'Не удалось начать запись.', rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await renderSingle(ctx, 'Запись на это мероприятие сейчас недоступна.', rows([[button('Назад', `event:${event.id}`)]]));
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await renderSingle(ctx, `Вы уже записаны. Код записи: ${existing.code}`, rows([[button('Мои записи', 'my')], [button('Назад', `event:${event.id}`)]]));
    return;
  }

  if (event.slots.length > 0) {
    await renderSingle(
      ctx,
      'Выберите слот:',
      rows([
        ...event.slots.map((slot) => [button(slot.label, `slot:${event.id}:${slot.id}`, 'positive')]),
        [button('Назад', `event:${event.id}`)]
      ])
    );
    return;
  }

  await showEnrollmentSummary(ctx, event.id);
}

async function showEnrollmentSummary(ctx: AnyContext, eventId: string, slotId?: string) {
  const event = await eventById(eventId);

  if (!event) {
    await renderSingle(ctx, 'Мероприятие не найдено.', rows([[button('Назад', 'catalog')]]));
    return;
  }

  await renderSingle(
    ctx,
    [
      'Проверьте запись:',
      `Мероприятие: ${event.title}`,
      `Дата: ${formatDate(event.startsAt)}`,
      `Слот: ${slotLabel(event, slotId)}`,
      `Формат: ${event.format === 'online' ? 'онлайн' : 'очно'}`,
      '',
      'Запись можно отменить до начала мероприятия, чтобы освободить место.'
    ].join('\n'),
    rows([
      [button('Подтвердить', `confirm:${event.id}:${slotId ?? '-'}`, 'positive')],
      [button('Назад', `enroll:${event.id}`)]
    ])
  );
}

async function confirmEnrollment(ctx: AnyContext, eventId: string, slotIdRaw: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);
  const slotId = slotIdRaw === '-' ? undefined : slotIdRaw;

  if (!user || !event) {
    await renderSingle(ctx, 'Не удалось создать запись.', rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await renderSingle(ctx, 'Свободных мест уже нет или регистрация закрыта.', rows([[button('Назад', `event:${event.id}`)]]));
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await renderSingle(ctx, `Вы уже записаны. Код записи: ${existing.code}`, rows([[button('Мои записи', 'my')]]));
    return;
  }

  const now = new Date().toISOString();
  const registration: Registration = {
    id: randomBytes(8).toString('hex'),
    code: makeCode(),
    eventId: event.id,
    slotId,
    userId: user.id,
    userName: user.name,
    status: 'confirmed',
    notificationsEnabled: true,
    createdAt: now,
    updatedAt: now
  };

  await store.createRegistration(registration);
  await renderSingle(
    ctx,
    [
      'Запись подтверждена.',
      `Код записи: ${registration.code}`,
      `Мероприятие: ${event.title}`,
      `Слот: ${slotLabel(event, slotId)}`
    ].join('\n'),
    rows([
      [button('Мои записи', 'my')],
      [button('Отключить уведомления', `mute:${registration.id}`, 'negative')]
    ])
  );
}

async function showMyRegistrations(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const registrations = (await store.listRegistrations()).filter((item) => item.userId === user.id);

  if (registrations.length === 0) {
    await renderSingle(ctx, 'У вас пока нет записей.', rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]]));
    return;
  }

  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: 'Мои записи',
      extra: rows([[button('Главное меню', 'menu')]])
    }
  ];

  for (const registration of registrations) {
    const event = await eventById(registration.eventId);

    if (!event) {
      continue;
    }

    messages.push({
      text: [
        event.title,
        `Код: ${registration.code}`,
        `Статус: ${statusLabels[registration.status]}`,
        `Дата: ${formatDate(event.startsAt)}`,
        `Слот: ${slotLabel(event, registration.slotId)}`,
        `Уведомления: ${registration.notificationsEnabled ? 'включены' : 'отключены'}`
      ].join('\n'),
      extra: rows([
        [
          registration.notificationsEnabled
            ? button('Отключить уведомления', `mute:${registration.id}`, 'negative')
            : button('Включить уведомления', `unmute:${registration.id}`, 'positive')
        ],
        [button('Отменить запись', `cancel:${registration.id}`, 'negative')]
      ])
    });
  }

  await renderMany(ctx, messages);
}

async function cancelRegistration(ctx: AnyContext, registrationId: string) {
  const user = await requireConsent(ctx);
  const registrations = await store.listRegistrations();
  const registration = registrations.find((item) => item.id === registrationId);

  if (!user || !registration || registration.userId !== user.id) {
    await renderSingle(ctx, 'Запись не найдена.', rows([[button('Мои записи', 'my')]]));
    return;
  }

  if (!isActiveStatus(registration.status)) {
    await renderSingle(ctx, 'Эта запись уже не активна.', rows([[button('Мои записи', 'my')]]));
    return;
  }

  const event = await eventById(registration.eventId);

  if (!event) {
    await renderSingle(ctx, 'Мероприятие не найдено.', rows([[button('Мои записи', 'my')]]));
    return;
  }

  const started = Date.now() >= new Date(event.startsAt).getTime();
  const status: RegistrationStatus = started && event.lateCancelAllowed ? 'late_cancelled' : 'cancelled_by_user';

  if (started && !event.lateCancelAllowed) {
    await renderSingle(ctx, 'Мероприятие уже началось, отмена по правилам этого мероприятия недоступна.', rows([[button('Мои записи', 'my')]]));
    return;
  }

  await store.updateRegistration(registration.id, { status });
  await renderSingle(ctx, 'Запись отменена. Место возвращено в пул доступных.', rows([[button('Все мероприятия', 'catalog')], [button('Мои записи', 'my')]]));
}

async function toggleNotifications(ctx: AnyContext, registrationId: string, enabled: boolean) {
  const user = await requireConsent(ctx);
  const registrations = await store.listRegistrations();
  const registration = registrations.find((item) => item.id === registrationId);

  if (!user || !registration || registration.userId !== user.id) {
    await renderSingle(ctx, 'Запись не найдена.', rows([[button('Мои записи', 'my')]]));
    return;
  }

  await store.updateRegistration(registration.id, { notificationsEnabled: enabled });
  await renderSingle(ctx, enabled ? 'Уведомления по мероприятию включены.' : 'Уведомления по мероприятию отключены.', rows([[button('Мои записи', 'my')]]));
}

function canManage(user: StoredUser, event: EventCard): boolean {
  if (user.role === 'tech_admin') {
    return true;
  }

  return (user.role === 'admin' || user.role === 'organizer') && user.universityId === event.universityId;
}

function canCreateEvent(user: StoredUser): boolean {
  return user.role === 'organizer' || user.role === 'admin' || user.role === 'tech_admin';
}

function canEditEvent(user: StoredUser, event: EventCard): boolean {
  if (user.role === 'tech_admin') {
    return true;
  }

  return (user.role === 'organizer' || user.role === 'admin') && user.universityId === event.universityId;
}

function canDeleteEvent(user: StoredUser, event: EventCard): boolean {
  if (user.role === 'tech_admin') {
    return true;
  }

  return (user.role === 'organizer' || user.role === 'admin') && user.universityId === event.universityId;
}

function eventCreateHelp(universityId?: string): string {
  return [
    'Создание мероприятия',
    '',
    'Отправьте команду в формате:',
    '/org_create Название | 2026-06-15 15:00 | 60 | offline | 30 | Место или ссылка | Описание',
    '',
    'Формат: online или offline.',
    `Вуз: ${universityId ?? 'для техадмина укажите university_id последним полем'}`,
    '',
    'Для техадмина:',
    '/org_create Название | 2026-06-15 15:00 | 60 | online | 30 | Ссылка | Описание | university_id'
  ].join('\n');
}

function eventEditHelp(eventId?: string): string {
  const prefix = eventId ?? 'event_id';

  return [
    'Изменение мероприятия',
    '',
    'Отправьте команду:',
    `/org_edit ${prefix} | поле | новое значение`,
    '',
    'Поля:',
    'title, date, duration, format, capacity, place, description, requirements, cancelPolicy, registrationClosed, lateCancelAllowed',
    '',
    'Пример:',
    `/org_edit ${prefix} | place | Главный корпус, аудитория 305`
  ].join('\n');
}

function parseEventDate(raw: string): string | undefined {
  const normalized = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/, '$1T$2:00+03:00');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseCreateEventInput(raw: string, user: StoredUser): CreateEventInput | string {
  const parts = raw.split('|').map((part) => part.trim());
  const [title, startsAtRaw, durationRaw, formatRaw, capacityRaw, locationOrUrl, description, universityIdRaw] = parts;
  const universityId = user.role === 'tech_admin' ? universityIdRaw : user.universityId;

  if (!title || !startsAtRaw || !durationRaw || !formatRaw || !capacityRaw || !locationOrUrl || !description) {
    return 'Не хватает полей. Проверьте шаблон команды.';
  }

  if (!universityId) {
    return 'Не удалось определить вуз. Для техадмина укажите university_id последним полем.';
  }

  const format = formatRaw.toLowerCase() as EventFormat;

  if (format !== 'online' && format !== 'offline') {
    return 'Формат должен быть online или offline.';
  }

  const startsAt = parseEventDate(startsAtRaw);

  if (!startsAt) {
    return 'Дата не распознана. Используйте формат 2026-06-15 15:00.';
  }

  const durationMinutes = Number(durationRaw);
  const capacity = Number(capacityRaw);

  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return 'Длительность должна быть целым числом минут больше нуля.';
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    return 'Лимит мест должен быть целым числом больше нуля.';
  }

  return {
    universityId,
    title,
    startsAt,
    durationMinutes,
    format,
    capacity,
    locationOrUrl,
    description,
    requirements: 'Подтверждение записи с кодом.',
    cancelPolicy: 'Отмена доступна до начала мероприятия.',
    registrationClosed: false,
    lateCancelAllowed: false,
    slots: []
  };
}

function parseBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();

  if (['true', 'yes', 'да', '1', 'on'].includes(value)) {
    return true;
  }

  if (['false', 'no', 'нет', '0', 'off'].includes(value)) {
    return false;
  }

  return undefined;
}

function parseEditEventInput(raw: string): { eventId: string; patch: UpdateEventInput; label: string } | string {
  const [eventId = '', fieldRaw = '', ...valueParts] = raw.split('|').map((part) => part.trim());
  const value = valueParts.join('|').trim();
  const field = fieldRaw.toLowerCase();

  if (!eventId || !field || !value) {
    return 'Не хватает полей. Используйте: /org_edit event_id | поле | новое значение';
  }

  if (field === 'title') return { eventId, patch: { title: value }, label: 'название' };
  if (field === 'description') return { eventId, patch: { description: value }, label: 'описание' };
  if (field === 'requirements') return { eventId, patch: { requirements: value }, label: 'требования' };
  if (field === 'cancelpolicy') return { eventId, patch: { cancelPolicy: value }, label: 'правила отмены' };
  if (field === 'place' || field === 'location' || field === 'url') return { eventId, patch: { locationOrUrl: value }, label: 'место или ссылка' };

  if (field === 'date' || field === 'startsat') {
    const startsAt = parseEventDate(value);
    return startsAt ? { eventId, patch: { startsAt }, label: 'дата и время' } : 'Дата не распознана. Используйте формат 2026-06-15 15:00.';
  }

  if (field === 'duration') {
    const durationMinutes = Number(value);
    return Number.isInteger(durationMinutes) && durationMinutes > 0
      ? { eventId, patch: { durationMinutes }, label: 'длительность' }
      : 'Длительность должна быть целым числом минут больше нуля.';
  }

  if (field === 'capacity') {
    const capacity = Number(value);
    return Number.isInteger(capacity) && capacity > 0 ? { eventId, patch: { capacity }, label: 'лимит мест' } : 'Лимит мест должен быть целым числом больше нуля.';
  }

  if (field === 'format') {
    const format = value.toLowerCase() as EventFormat;
    return format === 'online' || format === 'offline' ? { eventId, patch: { format }, label: 'формат' } : 'Формат должен быть online или offline.';
  }

  if (field === 'registrationclosed') {
    const registrationClosed = parseBoolean(value);
    return registrationClosed === undefined ? 'Значение должно быть true/false или да/нет.' : { eventId, patch: { registrationClosed }, label: 'статус регистрации' };
  }

  if (field === 'latecancelallowed') {
    const lateCancelAllowed = parseBoolean(value);
    return lateCancelAllowed === undefined ? 'Значение должно быть true/false или да/нет.' : { eventId, patch: { lateCancelAllowed }, label: 'поздняя отмена' };
  }

  return `Поле "${fieldRaw}" не поддерживается.`;
}

function changeNotificationKind(patch: UpdateEventInput): keyof typeof notificationTemplates {
  if (patch.startsAt) return 'time';
  if (patch.locationOrUrl) return patch.locationOrUrl.startsWith('http') ? 'link' : 'room';
  return 'details';
}

async function showOrganizerMenu(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user || (user.role !== 'admin' && user.role !== 'tech_admin' && user.role !== 'organizer')) {
    await renderSingle(ctx, 'Меню организатора доступно только организатору или администратору.', rows([[button('Главное меню', 'menu')]]));
    return;
  }

  const manageable = await store.listManageableEvents(user.id, user.role);

  if (manageable.length === 0) {
    await renderSingle(
      ctx,
      ['За вами пока не закреплены мероприятия.', '', canCreateEvent(user) ? eventCreateHelp(user.universityId) : 'Доступных мероприятий пока нет.'].join('\n'),
      rows([...(canCreateEvent(user) ? [[button('Создать мероприятие', 'org:create')]] : []), [button('Главное меню', 'menu')]])
    );
    return;
  }

  await renderSingle(
    ctx,
    ['Ваши мероприятия:', '', canCreateEvent(user) ? 'Создать новое можно командой /org_create. Изменить можно командой /org_edit.' : 'Доступные действия откроются в карточке мероприятия.'].join('\n'),
    rows([
      ...(canCreateEvent(user) ? [[button('Создать мероприятие', 'org:create')]] : []),
      ...manageable.map((event) => [button(`${event.deletedAt ? '[Удалено] ' : ''}${event.title}`, `org:event:${event.id}`)]),
      [button('Назад', 'menu')]
    ])
  );
}

async function showCreateEventHelp(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user || !canCreateEvent(user)) {
    await renderSingle(ctx, 'Создание мероприятий доступно только организатору, админу своего вуза или техадмину.', rows([[button('Назад', 'org')]]));
    return;
  }

  await renderSingle(ctx, eventCreateHelp(user.universityId), rows([[button('Назад', 'org')]]));
}

async function createEventFromOrganizerCommand(ctx: AnyContext, raw: string) {
  const user = await requireConsent(ctx);

  if (!user || !canCreateEvent(user)) {
    await renderSingle(ctx, 'Создание мероприятий доступно только организатору, админу своего вуза или техадмину.', rows([[button('Главное меню', 'menu')]]));
    return;
  }

  const input = parseCreateEventInput(raw, user);

  if (typeof input === 'string') {
    await renderSingle(ctx, [input, '', eventCreateHelp(user.universityId)].join('\n'), rows([[button('Назад', 'org')]]));
    return;
  }

  const university = await store.getUniversity(input.universityId);

  if (!university) {
    await renderSingle(ctx, `Вуз ${input.universityId} не найден.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const event = await store.createEvent(input);
  logger.info({ eventId: event.id, userId: user.id, universityId: event.universityId }, 'event created by organizer');
  await renderSingle(ctx, `Мероприятие создано:\n${formatEvent(event, event.capacity, university)}`, rows([[button('Открыть', `org:event:${event.id}`)], [button('Назад', 'org')]]));
}

async function showOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || (!canEditEvent(user, event) && !canDeleteEvent(user, event))) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const registrations = await store.listRegistrations(event.id);
  const active = registrations.filter((item) => isActiveStatus(item.status)).length;

  await renderSingle(
    ctx,
    [
      event.title,
      event.deletedAt ? `Статус: удалено ${formatDate(event.deletedAt)}` : 'Статус: активно',
      `Лимит: ${event.capacity}`,
      `Активных записей: ${active}`,
      `Свободно: ${Math.max(event.capacity - active, 0)}`,
      '',
      'Для поиска отправьте: /find КОД'
    ].join('\n'),
    rows([
      ...(canEditEvent(user, event) ? [[button('Список записей', `org:regs:${event.id}`)]] : []),
      ...(canEditEvent(user, event) && !event.deletedAt ? [[button('Уведомления', `org:notify:${event.id}`)]] : []),
      ...(canEditEvent(user, event) && !event.deletedAt ? [[button('Изменить мероприятие', `org:edit:${event.id}`)]] : []),
      ...(event.deletedAt && canDeleteEvent(user, event) ? [[button('Восстановить мероприятие', `org:restore:${event.id}`, 'positive')]] : []),
      ...(!event.deletedAt && canDeleteEvent(user, event) ? [[button('Удалить мероприятие', `org:delete:${event.id}`, 'negative')]] : []),
      [button('Назад', 'org')]
    ])
  );
}

async function showEditEventHelp(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Изменение доступно только организатору или админу своего вуза, а также техадмину.', rows([[button('Назад', `org:event:${eventId}`)]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, 'Удаленное мероприятие сначала нужно восстановить.', rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  await renderSingle(ctx, eventEditHelp(event.id), rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function updateEventFromOrganizerCommand(ctx: AnyContext, raw: string) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const parsed = parseEditEventInput(raw);

  if (typeof parsed === 'string') {
    await renderSingle(ctx, [parsed, '', eventEditHelp()].join('\n'), rows([[button('Назад', 'org')]]));
    return;
  }

  const event = await eventById(parsed.eventId);

  if (!event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Мероприятие не найдено или нет доступа на изменение.', rows([[button('Назад', 'org')]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, 'Удаленное мероприятие сначала нужно восстановить.', rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const updated = await store.updateEvent(event.id, parsed.patch);

  if (!updated) {
    await renderSingle(ctx, 'Не удалось изменить мероприятие.', rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const notified = await sendAutomaticEventChangeNotification(updated, changeNotificationKind(parsed.patch), parsed.label);
  logger.info({ eventId: updated.id, userId: user.id, universityId: updated.universityId, notified }, 'event updated by organizer');
  await renderSingle(ctx, `Мероприятие изменено: ${parsed.label}.\nУведомлений отправлено: ${notified}.`, rows([[button('Открыть', `org:event:${updated.id}`)], [button('Назад', 'org')]]));
}

async function confirmDeleteOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const active = (await store.listRegistrations(event.id)).filter((registration) => isActiveStatus(registration.status)).length;

  await renderSingle(
    ctx,
    [
      `Удалить мероприятие "${event.title}"?`,
      `Активных записей: ${active}`,
      active > 0 ? 'Записи сохранятся. Мероприятие будет скрыто из каталога и помечено удаленным.' : 'Мероприятие будет скрыто из каталога и помечено удаленным.'
    ].join('\n'),
    rows([
      [button('Да, удалить', `org:delete-confirm:${event.id}`, 'negative')],
      [button('Назад', `org:event:${event.id}`)]
    ])
  );
}

async function deleteOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canDeleteEvent(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const result = await store.deleteEvent(event.id);

  if (result === 'not_found') {
    await renderSingle(ctx, 'Мероприятие уже удалено.', rows([[button('Назад', 'org')]]));
    return;
  }

  logger.info({ eventId: event.id, userId: user.id, universityId: event.universityId }, 'event deleted by organizer');
  await renderSingle(ctx, `Мероприятие "${event.title}" помечено удаленным. Записи участников сохранены.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
}

async function restoreOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canDeleteEvent(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const restored = await store.restoreEvent(event.id);

  if (!restored) {
    await renderSingle(ctx, 'Мероприятие не найдено.', rows([[button('Назад', 'org')]]));
    return;
  }

  logger.info({ eventId: restored.id, userId: user.id, universityId: restored.universityId }, 'event restored by organizer');
  await renderSingle(ctx, `Мероприятие "${restored.title}" восстановлено.`, rows([[button('Открыть', `org:event:${restored.id}`)], [button('Назад', 'org')]]));
}

async function showOrganizerRegistrations(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const registrations = await store.listRegistrations(event.id);

  if (registrations.length === 0) {
    await renderSingle(ctx, 'Записей пока нет.', rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const lines = registrations.slice(0, 20).map((item) => {
    return `${item.code} - ${item.userName} - ${statusLabels[item.status]} - ${slotLabel(event, item.slotId)}`;
  });

  await renderSingle(ctx, ['Записи:', ...lines, '', 'Для карточки записи отправьте /find КОД'].join('\n'), rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function findRegistration(ctx: AnyContext, code: string) {
  const user = await requireConsent(ctx);
  const registration = await store.findRegistrationByCode(code);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Запись не найдена или нет доступа.', rows([[button('Назад', 'org')]]));
    return;
  }

  await renderSingle(
    ctx,
    [
      `Код: ${registration.code}`,
      `Мероприятие: ${event.title}`,
      `Участник: ${registration.userName}`,
      `Статус: ${statusLabels[registration.status]}`,
      `Слот: ${slotLabel(event, registration.slotId)}`
    ].join('\n'),
    rows([
      [button('Подтверждена', `org:status:${registration.id}:confirmed`, 'positive')],
      [button('Пришел', `org:status:${registration.id}:attended`, 'positive')],
      [button('Отменить организатором', `org:status:${registration.id}:cancelled_by_organizer`, 'negative')],
      [button('Назад', `org:event:${event.id}`)]
    ])
  );
}

async function setOrganizerStatus(ctx: AnyContext, registrationId: string, status: RegistrationStatus) {
  const user = await requireConsent(ctx);
  const registration = (await store.listRegistrations()).find((item) => item.id === registrationId);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Запись не найдена или нет доступа.', rows([[button('Назад', 'org')]]));
    return;
  }

  const updated = await store.updateRegistration(registration.id, { status });
  await renderSingle(ctx, `Статус записи ${updated?.code ?? registration.code}: ${statusLabels[status]}`, rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function showNotifyMenu(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  await renderSingle(
    ctx,
    'Выберите тип уведомления. Оно уйдет только активным участникам этого мероприятия, у которых уведомления включены.',
    rows([
      [button('За сутки', `org:send:${event.id}:day`)],
      [button('За час', `org:send:${event.id}:hour`)],
      [button('Перенос времени', `org:send:${event.id}:time`)],
      [button('Изменение аудитории', `org:send:${event.id}:room`)],
      [button('Ссылка на подключение', `org:send:${event.id}:link`)],
      [button('Назад', `org:event:${event.id}`)]
    ])
  );
}

async function sendEventNotification(ctx: AnyContext, eventId: string, kind: keyof typeof notificationTemplates) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, 'Нет доступа к этому мероприятию.', rows([[button('Назад', 'org')]]));
    return;
  }

  const recipients = (await store.listRegistrations(event.id)).filter(
    (item) => isActiveStatus(item.status) && item.notificationsEnabled
  );

  for (const recipient of recipients) {
    await bot.api.sendMessageToUser(
      recipient.userId,
      [`Уведомление по мероприятию "${event.title}"`, notificationTemplates[kind]].join('\n')
    );
  }

  await renderSingle(ctx, `Уведомление отправлено. Получателей: ${recipients.length}.`, rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function sendAutomaticEventChangeNotification(
  event: EventCard,
  kind: keyof typeof notificationTemplates,
  changedLabel: string
): Promise<number> {
  const recipients = (await store.listRegistrations(event.id)).filter(
    (item) => isActiveStatus(item.status) && item.notificationsEnabled
  );

  for (const recipient of recipients) {
    await bot.api.sendMessageToUser(
      recipient.userId,
      [
        `Изменение по мероприятию "${event.title}"`,
        notificationTemplates[kind],
        `Изменено: ${changedLabel}`,
        `Дата: ${formatDate(event.startsAt)}`,
        `Адрес/ссылка: ${event.locationOrUrl}`
      ].join('\n')
    );
  }

  return recipients.length;
}

async function requireRoleAdmin(ctx: AnyContext): Promise<StoredUser | undefined> {
  const user = await requireConsent(ctx);

  if (!user) {
    return undefined;
  }

  if (user.role !== 'tech_admin' && user.role !== 'admin') {
    await renderSingle(ctx, 'Это действие доступно только администратору.', rows([[button('Главное меню', 'menu')]]));
    return undefined;
  }

  return user;
}

async function showAdminPanel(ctx: AnyContext) {
  const user = await requireRoleAdmin(ctx);

  if (!user) {
    return;
  }

  await renderSingle(
    ctx,
    [
      'Админ-панель',
      '',
      user.role === 'tech_admin' ? 'Добавить админа: /admin_add MAX_ID university_id' : 'Админ может назначать организаторов только своего вуза.',
      user.role === 'tech_admin' ? 'Добавить организатора: /admin_org MAX_ID university_id' : 'Добавить организатора: /admin_org MAX_ID',
      'Снять права: /admin_remove MAX_ID',
      user.role === 'tech_admin' ? 'Сменить вуз: /admin_university MAX_ID university_id' : '',
      'Открыть карточку: /admin_user MAX_ID',
      '',
      `Ваш вуз: ${user.universityId ?? 'все вузы'}`,
      'MAX ID пользователь может узнать командой /whoami.'
    ].join('\n'),
    rows([
      [button('Список вузов', 'admin:universities')],
      ...(user.role === 'tech_admin' ? [[button('Список админов', 'admin:list:admin')]] : []),
      [button('Список организаторов', 'admin:list:organizer')],
      ...(user.role === 'tech_admin' ? [[button('Список техадминов', 'admin:list:tech_admin')]] : []),
      [button('Назад', 'menu')]
    ])
  );
}

async function showUsersByRole(ctx: AnyContext, role: Role) {
  const user = await requireRoleAdmin(ctx);

  if (!user) {
    return;
  }

  if (user.role !== 'tech_admin' && role !== 'organizer') {
    await renderSingle(ctx, 'Админ вуза может смотреть здесь только организаторов своего вуза.', rows([[button('Назад', 'admin')]]));
    return;
  }

  const users = await store.listUsers(role, user.role === 'tech_admin' ? undefined : user.universityId);

  if (users.length === 0) {
    await renderSingle(ctx, `Пользователей с ролью "${roleLabels[role]}" пока нет.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const lines = users.slice(0, 30).map((item) => formatUserLine(item));
  await renderSingle(ctx, [`Роль: ${roleLabels[role]}`, ...lines].join('\n'), rows([[button('Назад', 'admin')]]));
}

async function showAdminUserCard(ctx: AnyContext, userIdRaw: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);

  if (!user || !targetId) {
    await renderSingle(ctx, 'Укажите MAX ID числом. Например: /admin_user 123456789', rows([[button('Назад', 'admin')]]));
    return;
  }

  const target = await store.getUser(targetId);
  const canManageTarget = user.role === 'tech_admin' || target?.universityId === user.universityId || !target;

  if (!canManageTarget) {
    await renderSingle(ctx, 'Нельзя управлять пользователем из другого вуза.', rows([[button('Назад', 'admin')]]));
    return;
  }

  const universityId = target?.universityId ?? user.universityId;
  const roleButtons = user.role === 'tech_admin'
    ? [
        [button('Сделать админом', `admin:role:${targetId}:admin:${universityId ?? '-'}`, 'positive')],
        [button('Сделать организатором', `admin:role:${targetId}:organizer:${universityId ?? '-'}`, 'positive')],
        [button('Сделать техадмином', `admin:role:${targetId}:tech_admin:-`, 'positive')],
        [button('Сделать обычным', `admin:role:${targetId}:applicant:-`, 'negative')]
      ]
    : [
        [button('Сделать организатором', `admin:role:${targetId}:organizer:${user.universityId ?? '-'}`, 'positive')],
        [button('Сделать обычным', `admin:role:${targetId}:applicant:-`, 'negative')]
      ];

  await renderSingle(
    ctx,
    [
      target ? formatUserLine(target) : `MAX ID ${targetId}`,
      '',
      target ? 'Выберите действие:' : 'Пользователь еще не писал боту, но роль можно назначить заранее.'
    ].join('\n'),
    rows(roleButtons)
  );
}

async function setRoleFromAdmin(ctx: AnyContext, userIdRaw: string, role: Role, universityIdRaw?: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);

  if (!user || !targetId) {
    await renderSingle(ctx, 'Укажите MAX ID числом.', rows([[button('Назад', 'admin')]]));
    return;
  }

  if (targetId === user.id && role !== 'tech_admin') {
    await renderSingle(ctx, 'Нельзя снять технические права у самого себя через бота.', rows([[button('Назад', 'admin')]]));
    return;
  }

  const universityId = normalizeUniversityId(universityIdRaw) ?? user.universityId;

  if (!canAssignRole(user, role, universityId)) {
    await renderSingle(ctx, 'Недостаточно прав для назначения этой роли или вуза.', rows([[button('Назад', 'admin')]]));
    return;
  }

  if ((role === 'admin' || role === 'organizer') && !universityId) {
    await renderSingle(ctx, 'Для роли админа или организатора нужно указать вуз. Например: /admin_add 123 rtu-mirea', rows([[button('Список вузов', 'admin:universities')], [button('Назад', 'admin')]]));
    return;
  }

  const updated = await store.setUserRole(targetId, role, role === 'admin' || role === 'organizer' ? universityId : null);
  await renderSingle(ctx, `Готово: ${formatUserLine(updated)}`, rows([[button('Назад', 'admin')]]));
}

async function changeUserUniversity(ctx: AnyContext, userIdRaw: string, universityIdRaw: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);
  const universityId = normalizeUniversityId(universityIdRaw);

  if (!user || !targetId || !universityId) {
    await renderSingle(ctx, 'Формат: /admin_university MAX_ID university_id', rows([[button('Список вузов', 'admin:universities')], [button('Назад', 'admin')]]));
    return;
  }

  const target = await store.getUser(targetId);

  if (!target || (target.role !== 'admin' && target.role !== 'organizer')) {
    await renderSingle(ctx, 'Вуз можно менять только админам и организаторам.', rows([[button('Назад', 'admin')]]));
    return;
  }

  if (!canAssignRole(user, target.role, universityId)) {
    await renderSingle(ctx, 'Недостаточно прав для назначения этого вуза.', rows([[button('Назад', 'admin')]]));
    return;
  }

  const updated = await store.setUserRole(targetId, target.role, universityId);
  await renderSingle(ctx, `Вуз обновлен: ${formatUserLine(updated)}`, rows([[button('Назад', 'admin')]]));
}

async function showUniversitiesForAdmin(ctx: AnyContext) {
  const user = await requireRoleAdmin(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();
  const lines = universities.map((university) => `${university.id} - ${university.shortTitle} - ${university.city}`);
  await renderSingle(ctx, ['Вузы:', ...lines].join('\n'), rows([[button('Назад', 'admin')]]));
}

function canAssignRole(actor: StoredUser, role: Role, universityId?: string): boolean {
  if (actor.role === 'tech_admin') {
    return true;
  }

  return role === 'organizer' && !!actor.universityId && actor.universityId === universityId;
}

function normalizeUniversityId(raw?: string): string | undefined {
  const value = raw?.trim();
  return value && value !== '-' ? value : undefined;
}

function splitAdminArgs(raw: string): [string, string?] {
  const [userId = '', universityId] = raw.trim().split(/\s+/, 2);
  return [userId, universityId];
}

function parseUserId(raw: string): number | undefined {
  const normalized = raw.trim().replace(/[^\d]/g, '');
  const id = Number(normalized);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function formatUserLine(user: StoredUser): string {
  const username = user.username ? ` @${user.username}` : '';
  const university = user.universityId ? ` - вуз: ${user.universityId}` : '';
  return `${user.id} - ${user.name}${username} - ${roleLabels[user.role]}${university}`;
}

function makeCode(): string {
  return `SC40-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function answerCallback(ctx: AnyContext) {
  try {
    await ctx.answerOnCallback({ notification: null });
  } catch {
    // Callback may already be answered by the platform; user-facing reply is more important.
  }
}

await bot.api.setMyCommands([
  { name: 'start', description: 'Главное меню' },
  { name: 'events', description: 'Каталог мероприятий' },
  { name: 'my', description: 'Мои записи' },
  { name: 'org', description: 'Меню организатора' },
  { name: 'org_create', description: 'Создать мероприятие' },
  { name: 'org_edit', description: 'Изменить мероприятие' },
  { name: 'admin', description: 'Админ-панель' },
  { name: 'admin_add', description: 'Назначить админа по MAX ID' },
  { name: 'admin_org', description: 'Назначить организатора по MAX ID' },
  { name: 'admin_remove', description: 'Снять права по MAX ID' },
  { name: 'admin_university', description: 'Сменить вуз админа или организатора' },
  { name: 'find', description: 'Найти запись по коду' },
  { name: 'whoami', description: 'Показать ваш MAX ID' }
]);

bot.on('bot_started', async (ctx) => {
  logger.info(logContext(ctx), 'bot started conversation');
  await rememberUser(ctx);
  await showWelcome(ctx);
});

bot.command('start', async (ctx) => {
  logger.info(logContext(ctx), 'command start');
  await showMainMenu(ctx);
});
bot.command('events', async (ctx) => {
  logger.info(logContext(ctx), 'command events');
  await showCatalog(ctx);
});
bot.command('my', async (ctx) => {
  logger.info(logContext(ctx), 'command my');
  await showMyRegistrations(ctx);
});
bot.command('org', async (ctx) => {
  logger.info(logContext(ctx), 'command org');
  await showOrganizerMenu(ctx);
});
bot.command('org_create', async (ctx) => {
  logger.info(logContext(ctx), 'command org_create');
  const raw = ctx.message.body.text?.replace(/^\/org_create(?:@\S+)?\s*/i, '').trim() ?? '';

  if (raw) {
    await createEventFromOrganizerCommand(ctx, raw);
    return;
  }

  await showCreateEventHelp(ctx);
});
bot.command('org_edit', async (ctx) => {
  logger.info(logContext(ctx), 'command org_edit');
  const raw = ctx.message.body.text?.replace(/^\/org_edit(?:@\S+)?\s*/i, '').trim() ?? '';

  if (raw) {
    await updateEventFromOrganizerCommand(ctx, raw);
    return;
  }

  await renderSingle(ctx, eventEditHelp(), rows([[button('Назад', 'org')]]));
});
bot.command('admin', async (ctx) => {
  logger.info(logContext(ctx), 'command admin');
  await showAdminPanel(ctx);
});
bot.command('whoami', async (ctx) => {
  logger.info(logContext(ctx), 'command whoami');
  const user = await rememberUser(ctx);
  await ctx.reply(user ? `Ваш MAX ID: ${user.id}` : 'Не удалось определить MAX ID.');
});

bot.hears(/^\/admin_add\s+(.+)/i, async (ctx) => {
  const [userId, universityId] = splitAdminArgs(ctx.match?.[1] ?? '');
  await setRoleFromAdmin(ctx, userId, 'admin', universityId);
});

bot.hears(/^\/admin_org\s+(.+)/i, async (ctx) => {
  const [userId, universityId] = splitAdminArgs(ctx.match?.[1] ?? '');
  await setRoleFromAdmin(ctx, userId, 'organizer', universityId);
});

bot.hears(/^\/admin_remove\s+(.+)/i, async (ctx) => {
  await setRoleFromAdmin(ctx, ctx.match?.[1] ?? '', 'applicant');
});

bot.hears(/^\/admin_tech\s+(.+)/i, async (ctx) => {
  await setRoleFromAdmin(ctx, ctx.match?.[1] ?? '', 'tech_admin');
});

bot.hears(/^\/admin_university\s+(.+)/i, async (ctx) => {
  const [userId, universityId] = splitAdminArgs(ctx.match?.[1] ?? '');
  await changeUserUniversity(ctx, userId, universityId ?? '');
});

bot.hears(/^\/admin_user\s+(.+)/i, async (ctx) => {
  await showAdminUserCard(ctx, ctx.match?.[1] ?? '');
});

bot.hears(/^\/find\s+(.+)/i, async (ctx) => {
  await findRegistration(ctx, ctx.match?.[1] ?? '');
});

bot.action(/.*/, async (ctx) => {
  await answerCallback(ctx);
  await rememberUser(ctx);

  const payload = ctx.callback?.payload ?? '';
  logger.info({ ...logContext(ctx), payloadScope: payload.split(':')[0] }, 'callback action');
  const [scope, a, b, c, d] = payload.split(':');

  if (payload === 'consent:accept') {
    const sender = getSender(ctx);

    if (!sender) {
      await ctx.reply('Не удалось сохранить согласие.');
      return;
    }

    const saved = await store.getUser(sender.user_id);
    const user = await store.upsertUser({
      id: sender.user_id,
      name: sender.name,
      username: sender.username ?? undefined,
      role: roleFor(sender.user_id, saved),
      universityId: universityFor(sender.user_id, saved),
      consent: {
        profile: true,
        documentVersion: legalDocVersion,
        acceptedAt: new Date().toISOString()
      }
    });

    await ctx.reply('Согласие сохранено.');
    await showMainMenu(ctx, user);
    return;
  }

  if (payload === 'catalog') return showCatalog(ctx);
  if (payload === 'menu') return showMainMenu(ctx);
  if (payload === 'universities') return showUniversities(ctx);
  if (payload === 'my') return showMyRegistrations(ctx);
  if (payload === 'org') return showOrganizerMenu(ctx);
  if (scope === 'org' && a === 'create') return showCreateEventHelp(ctx);
  if (payload === 'admin') return showAdminPanel(ctx);
  if (scope === 'event') return showEventDetails(ctx, a);
  if (scope === 'university' && a === 'events') return showCatalog(ctx, b);
  if (scope === 'enroll') return startEnrollment(ctx, a);
  if (scope === 'slot') return showEnrollmentSummary(ctx, a, b);
  if (scope === 'confirm') return confirmEnrollment(ctx, a, b);
  if (scope === 'cancel') return cancelRegistration(ctx, a);
  if (scope === 'mute') return toggleNotifications(ctx, a, false);
  if (scope === 'unmute') return toggleNotifications(ctx, a, true);

  if (scope === 'org' && a === 'event') return showOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'edit') return showEditEventHelp(ctx, b);
  if (scope === 'org' && a === 'regs') return showOrganizerRegistrations(ctx, b);
  if (scope === 'org' && a === 'notify') return showNotifyMenu(ctx, b);
  if (scope === 'org' && a === 'delete') return confirmDeleteOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'delete-confirm') return deleteOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'restore') return restoreOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'status') return setOrganizerStatus(ctx, b, c as RegistrationStatus);
  if (scope === 'org' && a === 'send') return sendEventNotification(ctx, b, c as keyof typeof notificationTemplates);
  if (scope === 'admin' && a === 'list') return showUsersByRole(ctx, b as Role);
  if (scope === 'admin' && a === 'universities') return showUniversitiesForAdmin(ctx);
  if (scope === 'admin' && a === 'role') return setRoleFromAdmin(ctx, b, c as Role, d);

  await ctx.reply('Неизвестное действие. Откройте /start.');
});

bot.on('message_created', async (ctx) => {
  const text = ctx.message.body.text?.trim() ?? '';

  if (text.startsWith('/')) {
    return;
  }

  logger.info(logContext(ctx), 'plain message received');
  await showMainMenu(ctx);
});

bot.catch((error) => {
  logger.error({ err: error }, 'bot handler failed');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exitCode = 1;
});

logger.info('starting bot polling');
await bot.start();

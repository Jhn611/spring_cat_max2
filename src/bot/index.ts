import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Bot, Keyboard, type Context } from '@maxhub/max-bot-api';
import { ApiClient } from './api-client.js';
import { logger } from './logger.js';
import { isActiveStatus } from '../shared/domain.js';
import type {
  CreateEventInput,
  EventCard,
  EventFormat,
  EventSlot,
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
const store = new ApiClient(process.env.API_GATEWAY_URL ?? process.env.DATA_SERVICE_URL ?? 'http://localhost:3050');
const legalDocVersion = process.env.LEGAL_DOC_VERSION ?? 'hackathon-2026-05-14';
const adminIds = parseIdSet(process.env.ADMIN_MAX_IDS);
const techAdminIds = parseIdSet(process.env.TECH_ADMIN_MAX_IDS ?? process.env.MAIN_ADMIN_MAX_IDS);
const bootstrapAdminUniversityId = process.env.ADMIN_UNIVERSITY_ID ?? process.env.DEFAULT_UNIVERSITY_ID;
const adminSpaUrl = process.env.ADMIN_SPA_URL ?? 'http://localhost:3080';

logger.info(
  {
    apiGatewayUrl: process.env.API_GATEWAY_URL ?? process.env.DATA_SERVICE_URL ?? 'http://localhost:3050',
    legalDocVersion,
    adminIdsCount: adminIds.size,
    techAdminIdsCount: techAdminIds.size
  },
  'initializing bot'
);

type AnyContext = Context<any>;
type ReplyExtra = Parameters<AnyContext['reply']>[1];

const screenMessages = new Map<string, string[]>();
const pageSize = 3;

const ui = {
  ok: '✅',
  error: '❌',
  warn: '⚠️',
  cancel: '🚫',
  info: 'ℹ️',
  search: '🔎',
  calendar: '📅',
  time: '🕒',
  list: '📋',
  admin: '🛠️'
} as const;

// In-memory сценарии нужны для пошаговых действий в MAX: создание и изменение
// мероприятия занимают несколько сообщений, поэтому бот помнит, какой ответ ждёт.
type EventDraft = Partial<CreateEventInput> & {
  date?: string;
  time?: string;
};

type FlowState =
  | {
      kind: 'create_event';
      step: CreateEventStep;
      draft: EventDraft;
    }
  | {
      kind: 'edit_event';
      step: EditEventStep;
      eventId?: string;
      field?: EditableEventField;
      draftSlots?: EventSlot[];
    }
  | {
      kind: 'registrar';
      action: 'add' | 'remove';
      eventId: string;
    }
  | {
      kind: 'admin_role';
      role: Role;
      universityId?: string;
    };

type CreateEventStep =
  | 'university'
  | 'title'
  | 'date'
  | 'duration'
  | 'format'
  | 'capacity'
  | 'location'
  | 'description'
  | 'requirements'
  | 'cancelPolicy'
  | 'lateCancelAllowed'
  | 'slots'
  | 'confirm';

type EditEventStep = 'eventId' | 'field' | 'value';

type EditableEventField =
  | 'title'
  | 'date'
  | 'time'
  | 'duration'
  | 'format'
  | 'capacity'
  | 'location'
  | 'description'
  | 'requirements'
  | 'cancelPolicy'
  | 'registrationClosed'
  | 'lateCancelAllowed'
  | 'slots';

const flowStates = new Map<string, FlowState>();
const pendingExternalLogins = new Map<number, string>();

const statusLabels: Record<RegistrationStatus, string> = {
  confirmed: 'Подтверждена',
  attended: 'Участник пришел',
  cancelled_by_user: 'Отменена пользователем',
  cancelled_by_organizer: 'Отменена организатором',
  late_cancelled: 'Поздняя отмена'
};

function businessLog(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    log_type: 'business',
    event,
    ...fields
  };
}

const roleLabels: Record<Role, string> = {
  applicant: 'Абитуриент',
  organizer: 'Организатор',
  admin: 'Админ',
  tech_admin: 'Техадмин'
};

const notificationTemplates = {
  day: 'ℹ️ Напоминание: мероприятие состоится завтра. Проверьте код записи и детали в боте.',
  hour: 'ℹ️ Напоминание: мероприятие начнётся примерно через час.',
  time: '⚠️ Обновление по мероприятию: время изменилось. Проверьте актуальную информацию у организатора.',
  room: '⚠️ Обновление по мероприятию: изменилась аудитория или место сбора.',
  link: '⚠️ Обновление по мероприятию: ссылка на подключение будет отправлена организатором отдельно.',
  details: '⚠️ Обновление по мероприятию: изменились детали мероприятия. Проверьте актуальную информацию в боте.'
} as const;

function rows(buttons: ReturnType<typeof Keyboard.button.callback>[][]) {
  return { attachments: [Keyboard.inlineKeyboard(buttons)] };
}

function button(text: string, payload: string, intent: 'default' | 'positive' | 'negative' = 'default') {
  return Keyboard.button.callback(text, payload, { intent });
}

function parsePage(raw?: string): number {
  const page = Number(raw);
  return Number.isInteger(page) && page >= 0 ? page : 0;
}

function pageCount(total: number): number {
  return Math.max(Math.ceil(total / pageSize), 1);
}

function clampPage(page: number, total: number): number {
  return Math.min(Math.max(page, 0), pageCount(total) - 1);
}

function pageSlice<T>(items: T[], page: number): T[] {
  return items.slice(page * pageSize, page * pageSize + pageSize);
}

function paginationButtons(page: number, total: number, payloadForPage: (page: number) => string): ReturnType<typeof Keyboard.button.callback>[] {
  const totalPages = pageCount(total);
  const buttons: ReturnType<typeof Keyboard.button.callback>[] = [];

  if (page > 0) {
    buttons.push(button('Назад', payloadForPage(page - 1)));
  }

  buttons.push(button(`${page + 1}/${totalPages}`, 'flow:noop'));

  if (page + 1 < totalPages) {
    buttons.push(button('Вперёд', payloadForPage(page + 1)));
  }

  return buttons;
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

// Обычные экраны можно редактировать/пересоздавать, чтобы не спамить чат.
// Для пошаговых сценариев ниже используется sendNewMessage: там новые сообщения удобнее.
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
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow'
  }).format(new Date(iso));
}

// MAX callback payload лучше держать коротким, поэтому дату и время кодируем
// компактно, а человеку показываем привычный формат ДД.ММ.ГГГГ и ЧЧ:ММ.
function formatDateOnly(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow'
  }).format(date);
}

function compactDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow'
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

function dateFromCompact(value: string): string | undefined {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (!match) {
    return undefined;
  }

  return `${match[3]}.${match[2]}.${match[1]}`;
}

function timeFromCompact(value: string): string | undefined {
  const match = value.match(/^(\d{2})(\d{2})$/);

  if (!match) {
    return undefined;
  }

  return `${match[1]}:${match[2]}`;
}

function currentMoscowYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Europe/Moscow'
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return { year: Number(part('year')), month: Number(part('month')) };
}

function yearMonthFromCompact(value?: string): { year: number; month: number } {
  const match = value?.match(/^(\d{4})(\d{2})$/);

  if (!match) {
    return currentMoscowYearMonth();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  return month >= 1 && month <= 12 ? clampCalendarMonth(year, month) : currentMoscowYearMonth();
}

function compactYearMonth(year: number, month: number): string {
  return `${year}${String(month).padStart(2, '0')}`;
}

function shiftYearMonth(year: number, month: number, offset: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function monthIndex(year: number, month: number): number {
  return year * 12 + month;
}

function clampCalendarMonth(year: number, month: number): { year: number; month: number } {
  const current = currentMoscowYearMonth();
  const max = shiftYearMonth(current.year, current.month, 6);
  const valueIndex = monthIndex(year, month);

  if (valueIndex < monthIndex(current.year, current.month)) {
    return current;
  }

  if (valueIndex > monthIndex(max.year, max.month)) {
    return max;
  }

  return { year, month };
}

function userFlowKey(ctx: AnyContext): string | undefined {
  const sender = getSender(ctx);
  return sender ? `user:${sender.user_id}` : undefined;
}

async function sendNewMessage(ctx: AnyContext, text: string, extra?: ReplyExtra): Promise<void> {
  await ctx.reply(text, extra);
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
    await ctx.reply(`${ui.error} Не удалось определить пользователя. Откройте диалог с ботом напрямую и попробуйте ещё раз.`);
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
      `${ui.info} Весенний_код_40 помогает записаться на мероприятия университета: дни открытых дверей, экскурсии, консультации и пробные занятия.`,
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

  const manageable = await store.listManageableEvents(current.id, current.role);
  const menu = [
    [button('Все мероприятия', 'catalog')],
    [button('Выбрать вуз', 'universities')],
    [button('Мои записи на мероприятия', 'my')]
  ];

  if (manageable.length > 0 || current.role === 'organizer' || current.role === 'admin' || current.role === 'tech_admin') {
    menu.push([button('Управление мероприятиями', 'org')]);
  }

  if (current.role === 'admin' || current.role === 'tech_admin') {
    menu.push([button('Админ-панель', 'admin')]);
  }

  if (current.role === 'organizer' || current.role === 'admin' || current.role === 'tech_admin') {
    menu.push([button('Веб-панель', 'web-panel', 'positive')]);
  }

  await renderSingle(ctx, `${ui.info} Главное меню. Выберите, что хотите сделать.`, rows(menu));
}

async function showWebPanelInfo(ctx: AnyContext): Promise<void> {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  if (user.role !== 'organizer' && user.role !== 'admin' && user.role !== 'tech_admin') {
    await renderSingle(ctx, `${ui.warn} Веб-панель доступна только организаторам, админам и техадминам.`, rows([[button('Главное меню', 'menu')]]));
    return;
  }

  await renderSingle(
    ctx,
    [
      `${ui.admin} Веб-панель управления:`,
      adminSpaUrl,
      '',
      'Откройте ссылку, введите любой удобный логин, затем подтвердите вход кодом из MAX.',
      'Если логин ещё не привязан, на странице появится QR и deeplink для привязки.'
    ].join('\n'),
    rows([[button('Главное меню', 'menu')]])
  );
}

async function handleExternalLogin(ctx: AnyContext, loginRaw: string): Promise<void> {
  const sender = getSender(ctx);
  const login = normalizeExternalLogin(loginRaw);

  if (!sender || !login) {
    await ctx.reply(`${ui.error} Логин не распознан. Откройте ссылку входа ещё раз или введите /login ваш_логин.`);
    return;
  }

  const user = await requireConsent(ctx);

  if (!user) {
    pendingExternalLogins.set(sender.user_id, login);
    await ctx.reply(`${ui.info} После согласия я отправлю код входа для логина ${login}.`);
    return;
  }

  await issueExternalLoginCode(ctx, user, login);
}

async function issueExternalLoginCode(ctx: AnyContext, user: StoredUser, login: string): Promise<void> {
  const result = await store.issueExternalLoginCode(login, user.id);
  await ctx.reply(
    [
      `${ui.ok} Код входа для логина ${result.login}: ${result.code}`,
      'Введите этот код в приложении рядом с вашим логином.',
      'Код действует 10 минут.'
    ].join('\n')
  );
}

async function showCatalog(ctx: AnyContext, universityId?: string, pageRaw = 0) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();
  const universitiesById = new Map(universities.map((university) => [university.id, university]));
  const events = await store.listEvents(universityId);
  const page = clampPage(pageRaw, events.length);

  if (events.length === 0) {
    await renderSingle(ctx, `${ui.info} Мероприятий пока нет. Можно выбрать другой вуз или вернуться в главное меню.`, rows([[button('Выбрать вуз', 'universities')], [button('Назад', 'menu')]]));
    return;
  }

  const header = universityId
    ? `${ui.list} Мероприятия выбранного вуза: ${universitiesById.get(universityId)?.shortTitle ?? universityId}`
    : `${ui.list} Все ближайшие мероприятия`;
  const pagePayload = (nextPage: number) => universityId ? `catalog:uni:${universityId}:${nextPage}` : `catalog:page:${nextPage}`;
  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: `${header}\nСтраница ${page + 1} из ${pageCount(events.length)}.`,
      extra: rows([
        ...(events.length > pageSize ? [paginationButtons(page, events.length, pagePayload)] : []),
        [button('Выбрать вуз', 'universities')],
        [button('Главное меню', 'menu')]
      ])
    }
  ];

  for (const event of pageSlice(events, page)) {
    const seats = await freeSeats(event);
    const buttons = [[button('Подробнее', `event:${event.id}`)]];

    if (!event.registrationClosed && seats > 0) {
      buttons[0].push(button('Записаться', `enroll:${event.id}`, 'positive'));
    }

    messages.push({ text: formatEvent(event, seats, universitiesById.get(event.universityId)), extra: rows(buttons) });
  }

  await renderMany(ctx, messages);
}

async function showUniversities(ctx: AnyContext, pageRaw = 0) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();
  const page = clampPage(pageRaw, universities.length);

  if (universities.length === 0) {
    await renderSingle(ctx, `${ui.info} Список вузов пока пуст. Попробуйте позже.`, rows([[button('Назад', 'menu')]]));
    return;
  }

  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: `${ui.info} Выберите вуз. После выбора покажу только его мероприятия.\nСтраница ${page + 1} из ${pageCount(universities.length)}.`,
      extra: rows([
        ...(universities.length > pageSize ? [paginationButtons(page, universities.length, (nextPage) => `universities:page:${nextPage}`)] : []),
        [button('Все мероприятия', 'catalog')],
        [button('Главное меню', 'menu')]
      ])
    }
  ];

  for (const university of pageSlice(universities, page)) {
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
    await renderSingle(ctx, `${ui.error} Мероприятие не найдено. Возможно, оно было удалено или изменено.`, rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, `${ui.warn} Мероприятие сейчас недоступно: оно скрыто из каталога.`, rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]]));
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
    await renderSingle(ctx, `${ui.error} Не удалось начать запись. Мероприятие недоступно или уже удалено.`, rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await renderSingle(ctx, `${ui.warn} Запись на это мероприятие сейчас недоступна: регистрация закрыта или свободных мест нет.`, rows([[button('Назад', `event:${event.id}`)]]));
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await renderSingle(ctx, `${ui.ok} Вы уже записаны на это мероприятие.\nКод записи: ${existing.code}`, rows([[button('Мои записи на мероприятия', 'my')], [button('Назад', `event:${event.id}`)]]));
    return;
  }

  if (event.slots.length > 0) {
    await renderSingle(
      ctx,
      `${ui.time} Выберите удобный слот. После этого я покажу итог перед подтверждением.`,
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
    await renderSingle(ctx, `${ui.error} Мероприятие не найдено. Вернитесь в каталог и выберите другое.`, rows([[button('Назад', 'catalog')]]));
    return;
  }

  await renderSingle(
    ctx,
    [
      `${ui.info} Проверьте запись перед подтверждением:`,
      `Мероприятие: ${event.title}`,
      `Дата: ${formatDate(event.startsAt)}`,
      `Слот: ${slotLabel(event, slotId)}`,
      `Формат: ${event.format === 'online' ? 'онлайн' : 'очно'}`,
      '',
      `${ui.info} Запись можно отменить до начала мероприятия, чтобы освободить место.`
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
    await renderSingle(ctx, `${ui.error} Не удалось создать запись. Попробуйте выбрать мероприятие заново.`, rows([[button('Назад', 'catalog')]]));
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await renderSingle(ctx, `${ui.warn} Свободных мест уже нет или регистрация закрыта.`, rows([[button('Назад', `event:${event.id}`)]]));
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await renderSingle(ctx, `${ui.ok} Вы уже записаны.\nКод записи: ${existing.code}`, rows([[button('Мои записи на мероприятия', 'my')]]));
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
  logger.info(
    businessLog('registration_confirmed', {
      registration_id: registration.id,
      registration_code: registration.code,
      event_id: event.id,
      university_id: event.universityId,
      user_id: user.id,
      slot_id: slotId
    }),
    'registration confirmed'
  );
  await renderSingle(
    ctx,
    [
      `${ui.ok} Запись подтверждена.`,
      `Код записи: ${registration.code}`,
      `Мероприятие: ${event.title}`,
      `Слот: ${slotLabel(event, slotId)}`
    ].join('\n'),
    rows([
      [button('Мои записи на мероприятия', 'my')],
      [button('Главное меню', 'menu')],
      [button('Отключить уведомления', `mute:${registration.id}`, 'negative')]
    ])
  );
}

async function showMyRegistrations(ctx: AnyContext, pageRaw = 0) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const registrations = (await store.listRegistrations(undefined, user.id)).filter((item) => isActiveStatus(item.status));
  const page = clampPage(pageRaw, registrations.length);

  if (registrations.length === 0) {
    await renderSingle(ctx, `${ui.info} У вас пока нет активных записей. Можно открыть каталог и выбрать мероприятие.`, rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]]));
    return;
  }

  const messages: Array<{ text: string; extra?: ReplyExtra }> = [
    {
      text: `${ui.list} Мои активные записи на мероприятия\nСтраница ${page + 1} из ${pageCount(registrations.length)}.`,
      extra: rows([
        ...(registrations.length > pageSize ? [paginationButtons(page, registrations.length, (nextPage) => `my:page:${nextPage}`)] : []),
        [button('Главное меню', 'menu')]
      ])
    }
  ];

  for (const registration of pageSlice(registrations, page)) {
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

  if (!user) {
    return;
  }

  const registrations = await store.listRegistrations(undefined, user.id);
  const registration = registrations.find((item) => item.id === registrationId);

  if (!registration || registration.userId !== user.id) {
    await renderSingle(ctx, `${ui.error} Запись не найдена. Возможно, она уже была изменена.`, rows([[button('Мои записи на мероприятия', 'my')]]));
    return;
  }

  if (!isActiveStatus(registration.status)) {
    await renderSingle(ctx, `${ui.info} Эта запись уже не активна.`, rows([[button('Мои записи на мероприятия', 'my')]]));
    return;
  }

  const event = await eventById(registration.eventId);

  if (!event) {
    await renderSingle(ctx, `${ui.error} Мероприятие по этой записи не найдено.`, rows([[button('Мои записи на мероприятия', 'my')]]));
    return;
  }

  const started = Date.now() >= new Date(event.startsAt).getTime();
  const status: RegistrationStatus = started && event.lateCancelAllowed ? 'late_cancelled' : 'cancelled_by_user';

  if (started && !event.lateCancelAllowed) {
    await renderSingle(ctx, `${ui.warn} Мероприятие уже началось, поэтому отмена по его правилам недоступна.`, rows([[button('Мои записи на мероприятия', 'my')]]));
    return;
  }

  await store.updateRegistration(registration.id, { status }, user.id);
  logger.info(
    businessLog('registration_cancelled_by_user', {
      registration_id: registration.id,
      registration_code: registration.code,
      event_id: event.id,
      university_id: event.universityId,
      user_id: user.id,
      status
    }),
    'registration cancelled by user'
  );
  await renderSingle(ctx, `${ui.cancel} Запись отменена. Она больше не будет показываться в активных записях.`, rows([[button('Все мероприятия', 'catalog')], [button('Главное меню', 'menu')]]));
}

async function toggleNotifications(ctx: AnyContext, registrationId: string, enabled: boolean) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const registrations = await store.listRegistrations(undefined, user.id);
  const registration = registrations.find((item) => item.id === registrationId);

  if (!registration || registration.userId !== user.id) {
    await renderSingle(ctx, `${ui.error} Запись не найдена. Откройте список своих записей и попробуйте ещё раз.`, rows([[button('Мои записи на мероприятия', 'my')]]));
    return;
  }

  await store.updateRegistration(registration.id, { notificationsEnabled: enabled }, user.id);
  logger.info(
    businessLog(enabled ? 'registration_notifications_enabled' : 'registration_notifications_disabled', {
      registration_id: registration.id,
      registration_code: registration.code,
      event_id: registration.eventId,
      user_id: user.id
    }),
    'registration notification preference changed'
  );
  await renderSingle(ctx, enabled ? `${ui.ok} Уведомления по мероприятию включены.` : `${ui.cancel} Уведомления по мероприятию отключены.`, rows([[button('Мои записи на мероприятия', 'my')]]));
}

function canManage(user: StoredUser, event: EventCard): boolean {
  if (user.role === 'tech_admin') {
    return true;
  }

  return canEditEvent(user, event) || isEventRegistrar(user, event);
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

function isEventRegistrar(user: StoredUser, event: EventCard): boolean {
  return event.registrarIds.includes(user.id);
}

function canMarkAttendance(user: StoredUser, event: EventCard): boolean {
  return canEditEvent(user, event) || isEventRegistrar(user, event);
}

function eventCreateHelp(universityId?: string): string {
  return [
    'Создание мероприятия',
    '',
    'Бот будет спрашивать поля по очереди.',
    `Вуз: ${universityId ?? 'нужно будет указать university_id'}`,
    'Дата вводится в формате ДД.ММ.ГГГГ, время - ЧЧ:ММ.',
    'Слоты можно будет добавить отдельным шагом.'
  ].join('\n');
}

function eventEditHelp(eventId?: string): string {
  const prefix = eventId ?? 'event_id';

  return [
    'Изменение мероприятия',
    '',
    'Бот спросит мероприятие, поле и новое значение по шагам.',
    '',
    'Поля:',
    'title, date, duration, format, capacity, place, description, requirements, cancelPolicy, registrationClosed, lateCancelAllowed, slots',
    '',
    'Пример:',
    `/org_edit ${prefix} | place | Главный корпус, аудитория 305`
  ].join('\n');
}

function parseEventDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  const ruMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);

  if (ruMatch) {
    const [, day, month, year, hour = '00', minute = '00'] = ruMatch;
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+03:00`);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    const parts = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Moscow'
    }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;

    if (part('day') !== day || part('month') !== month || part('year') !== year || part('hour') !== hour || part('minute') !== minute) {
      return undefined;
    }

    return date.toISOString();
  }

  const normalized = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/, '$1T$2:00+03:00');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseEventDateTime(dateRaw: string, timeRaw: string): string | undefined {
  return parseEventDate(`${dateRaw.trim()} ${timeRaw.trim()}`);
}

function normalizeDateInput(raw: string): string | undefined {
  const match = raw.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+\d{1,2}:\d{2})?$/);

  if (!match) {
    return undefined;
  }

  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3];
  const normalized = `${day}.${month}.${year}`;

  return parseEventDate(normalized) ? normalized : undefined;
}

function normalizeTimeInput(raw: string): string | undefined {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return undefined;
  }

  const normalized = `${match[1].padStart(2, '0')}:${match[2]}`;
  return parseClockTime(normalized) ? normalized : undefined;
}

function parseClockTime(raw: string): { hour: number; minute: number } | undefined {
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  return { hour, minute };
}

function minutesOfDay(time: { hour: number; minute: number }): number {
  return time.hour * 60 + time.minute;
}

function slotInterval(label: string): { start: number; end: number } | undefined {
  const match = label.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);

  if (!match) {
    return undefined;
  }

  const start = parseClockTime(`${match[1]}:${match[2]}`);
  const end = parseClockTime(`${match[3]}:${match[4]}`);

  if (!start || !end) {
    return undefined;
  }

  return { start: minutesOfDay(start), end: minutesOfDay(end) };
}

function slotsOverlap(left: EventSlot, right: EventSlot): boolean {
  const leftInterval = slotInterval(left.label);
  const rightInterval = slotInterval(right.label);
  return !!leftInterval && !!rightInterval && leftInterval.start < rightInterval.end && rightInterval.start < leftInterval.end;
}

function timeFromMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function slotIdFromLabel(label: string): string {
  return label.replace(/[^0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    return 'Дата не распознана. Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ.';
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
    return 'Не хватает полей. Лучше запустите пошаговый режим командой /org_edit.';
  }

  if (field === 'title') return { eventId, patch: { title: value }, label: 'название' };
  if (field === 'description') return { eventId, patch: { description: value }, label: 'описание' };
  if (field === 'requirements') return { eventId, patch: { requirements: value }, label: 'требования' };
  if (field === 'cancelpolicy') return { eventId, patch: { cancelPolicy: value }, label: 'правила отмены' };
  if (field === 'place' || field === 'location' || field === 'url') return { eventId, patch: { locationOrUrl: value }, label: 'место или ссылка' };

  if (field === 'date' || field === 'startsat') {
    const startsAt = parseEventDate(value);
    return startsAt ? { eventId, patch: { startsAt }, label: 'дата и время' } : 'Дата не распознана. Используйте формат ДД.ММ.ГГГГ ЧЧ:ММ.';
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

  if (field === 'slots') {
    return 'Слоты меняются только через пошаговый режим /org_edit, чтобы взять дату из выбранного мероприятия.';
  }

  return `Поле "${fieldRaw}" не поддерживается.`;
}

function changeNotificationKind(patch: UpdateEventInput): keyof typeof notificationTemplates {
  if (patch.startsAt) return 'time';
  if (patch.locationOrUrl) return patch.locationOrUrl.startsWith('http') ? 'link' : 'room';
  return 'details';
}

function nextCreateEventStep(step: CreateEventStep): CreateEventStep {
  const steps: CreateEventStep[] = [
    'university',
    'title',
    'date',
    'duration',
    'format',
    'capacity',
    'location',
    'description',
    'requirements',
    'cancelPolicy',
    'lateCancelAllowed',
    'slots',
    'confirm'
  ];
  return steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)];
}

function createEventPrompt(step: CreateEventStep): string {
  const prompts: Record<CreateEventStep, string> = {
    university: `${ui.info} Введите university_id вуза, для которого создаётся мероприятие. Например: rtu-mirea`,
    title: `${ui.info} Введите название мероприятия. Оно будет видно участникам в каталоге.`,
    date: `${ui.calendar} Выберите дату в календаре на ближайшие 6 месяцев или введите вручную в формате ДД.ММ.ГГГГ. Например: 15.06.2026`,
    duration: `${ui.info} Введите длительность одного слота в минутах. Например: 60`,
    format: `${ui.info} Введите формат мероприятия: online или offline.`,
    capacity: `${ui.info} Введите лимит мест числом. Например: 30`,
    location: `${ui.info} Введите место проведения или ссылку для подключения.`,
    description: `${ui.info} Введите описание мероприятия: что будет происходить и кому это полезно.`,
    requirements: `${ui.info} Введите требования к участнику. Если требований нет, отправьте "-".`,
    cancelPolicy: `${ui.info} Введите правила отмены. Если подходят стандартные, отправьте "-".`,
    lateCancelAllowed: `${ui.info} Разрешить позднюю отмену после старта? Ответьте да или нет.`,
    slots: `${ui.time} Добавьте хотя бы один слот кнопками ниже. Можно также отправить слоты текстом через запятую: 15:00-16:00, 17:00-18:00.`,
    confirm: `${ui.info} Проверьте данные. Отправьте "да", чтобы создать мероприятие, или "нет", чтобы отменить.`
  };
  return prompts[step];
}

function createStepExtra(step: CreateEventStep, draft?: EventDraft): ReplyExtra | undefined {
  if (step === 'date') {
    return createDateKeyboard('create');
  }

  if (step === 'slots') {
    return createSlotBuilderKeyboard('create', draft?.slots?.length ?? 0);
  }

  return rows([[button('Отмена', 'flow:cancel')]]);
}

function editValueExtra(field: EditableEventField): ReplyExtra {
  if (field === 'date') {
    return createDateKeyboard('edit');
  }

  if (field === 'time') {
    return createHourKeyboard('edit');
  }

  if (field === 'slots') {
    return createSlotBuilderKeyboard('edit', 0);
  }

  return rows([[button('Отмена', 'flow:cancel')]]);
}

function callbackPrefix(mode: 'create' | 'edit', action: 'date' | 'month' | 'hour' | 'minute' | 'slot-hour' | 'slot-minute' | 'slot-finish' | 'slot-clear'): string {
  return `flow:${mode}-${action}`;
}

// Календарь сделан настоящей сеткой по дням недели: так меньше ошибок при
// выборе даты, а ручной ввод всё равно остаётся для нестандартных случаев.
function createDateKeyboard(mode: 'create' | 'edit', monthRaw?: string): ReplyExtra {
  const { year, month } = yearMonthFromCompact(monthRaw);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
  const current = currentMoscowYearMonth();
  const max = shiftYearMonth(current.year, current.month, 6);
  const canGoPrevious = monthIndex(year, month) > monthIndex(current.year, current.month);
  const canGoNext = monthIndex(year, month) < monthIndex(max.year, max.month);
  const todayCompact = compactDate(new Date());
  const monthTitle = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(firstDay);
  const dateRows: ReturnType<typeof Keyboard.button.callback>[][] = [];
  const previousMonth = shiftYearMonth(year, month, -1);
  const nextMonth = shiftYearMonth(year, month, 1);

  dateRows.push([button(monthTitle, 'flow:noop')]);
  dateRows.push(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => button(day, 'flow:noop')));

  for (let cursor = 1 - mondayOffset; cursor <= daysInMonth; cursor += 7) {
    const week: ReturnType<typeof Keyboard.button.callback>[] = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = cursor + weekday;

      if (day < 1 || day > daysInMonth) {
        week.push(button('.', 'flow:noop'));
        continue;
      }

      const date = new Date(Date.UTC(year, month - 1, day));
      const compact = compactDate(date);
      week.push(button(String(day).padStart(2, '0'), compact < todayCompact ? 'flow:noop' : `${callbackPrefix(mode, 'date')}:${compact}`));
    }

    dateRows.push(week);
  }

  dateRows.push([
    button('Пред. месяц', canGoPrevious ? `${callbackPrefix(mode, 'month')}:${compactYearMonth(previousMonth.year, previousMonth.month)}` : 'flow:noop'),
    button('След. месяц', canGoNext ? `${callbackPrefix(mode, 'month')}:${compactYearMonth(nextMonth.year, nextMonth.month)}` : 'flow:noop')
  ]);
  dateRows.push([button('Отмена', 'flow:cancel')]);
  return rows(dateRows);
}

function createHourKeyboard(mode: 'create' | 'edit'): ReplyExtra {
  const hourRows: ReturnType<typeof Keyboard.button.callback>[][] = [];

  for (let hour = 0; hour < 24; hour += 4) {
    hourRows.push(
      Array.from({ length: 4 }, (_, index) => {
        const value = String(hour + index).padStart(2, '0');
        return button(value, `${callbackPrefix(mode, 'hour')}:${value}`);
      })
    );
  }

  hourRows.push([button('Отмена', 'flow:cancel')]);
  return rows(hourRows);
}

function createMinuteKeyboard(mode: 'create' | 'edit', hour: string): ReplyExtra {
  const minuteRows: ReturnType<typeof Keyboard.button.callback>[][] = [];

  for (let minute = 0; minute < 60; minute += 20) {
    minuteRows.push(
      Array.from({ length: 4 }, (_, index) => {
        const value = String(minute + index * 5).padStart(2, '0');
        return button(value, `${callbackPrefix(mode, 'minute')}:${hour}${value}`);
      })
    );
  }

  minuteRows.push([button('Назад к часам', `${callbackPrefix(mode, 'hour')}:back`)]);
  minuteRows.push([button('Отмена', 'flow:cancel')]);
  return rows(minuteRows);
}

function createSlotBuilderKeyboard(mode: 'create' | 'edit', count: number): ReplyExtra {
  return rows([
    [button('Добавить слот', `${callbackPrefix(mode, 'slot-hour')}:start`, 'positive')],
    ...(count > 0 ? [[button('Готово, сохранить слоты', `${callbackPrefix(mode, 'slot-finish')}:save`, 'positive')]] : []),
    ...(count > 0 ? [[button('Очистить слоты', `${callbackPrefix(mode, 'slot-clear')}:all`, 'negative')]] : []),
    [button('Отмена', 'flow:cancel')]
  ]);
}

function createSlotHourKeyboard(mode: 'create' | 'edit'): ReplyExtra {
  const hourRows: ReturnType<typeof Keyboard.button.callback>[][] = [];

  for (let hour = 0; hour < 24; hour += 4) {
    hourRows.push(
      Array.from({ length: 4 }, (_, index) => {
        const value = String(hour + index).padStart(2, '0');
        return button(value, `${callbackPrefix(mode, 'slot-hour')}:${value}`);
      })
    );
  }

  hourRows.push([button('Назад к слотам', `${callbackPrefix(mode, 'slot-hour')}:back`)]);
  hourRows.push([button('Отмена', 'flow:cancel')]);
  return rows(hourRows);
}

function createSlotMinuteKeyboard(mode: 'create' | 'edit', hour: string): ReplyExtra {
  const minuteRows: ReturnType<typeof Keyboard.button.callback>[][] = [];

  for (let minute = 0; minute < 60; minute += 20) {
    minuteRows.push(
      Array.from({ length: 4 }, (_, index) => {
        const value = String(minute + index * 5).padStart(2, '0');
        return button(value, `${callbackPrefix(mode, 'slot-minute')}:${hour}${value}`);
      })
    );
  }

  minuteRows.push([button('Назад к часам', `${callbackPrefix(mode, 'slot-hour')}:start`)]);
  minuteRows.push([button('Отмена', 'flow:cancel')]);
  return rows(minuteRows);
}

function createSlotFromStart(dateRaw: string, startRaw: string, durationMinutes: number, existing: EventSlot[] = []): EventSlot | string {
  const start = parseClockTime(startRaw);

  if (!start) {
    return 'Время начала слота не распознано.';
  }

  const startTotal = minutesOfDay(start);
  const endTotal = startTotal + durationMinutes;

  if (endTotal > 24 * 60) {
    return 'Слот не должен переходить на следующий день. Выберите более раннее время или уменьшите длительность.';
  }

  const label = `${startRaw}-${timeFromMinutes(endTotal)}`;

  if (existing.some((slot) => slot.label === label || slot.id === slotIdFromLabel(label))) {
    return `Слот ${label} уже добавлен.`;
  }

  const candidate: EventSlot = {
    id: slotIdFromLabel(label),
    label,
    startsAt: ''
  };

  if (existing.some((slot) => slotsOverlap(candidate, slot))) {
    return `Слот ${label} пересекается с уже добавленным слотом. Выберите другое время.`;
  }

  const startsAt = parseEventDate(`${dateRaw} ${startRaw}`);

  if (!startsAt) {
    return 'Не удалось собрать дату и время слота.';
  }

  return {
    id: candidate.id,
    label,
    startsAt
  };
}

function formatSlotBuilderText(slots: EventSlot[] = []): string {
  return [
    `${ui.time} Слоты мероприятия`,
    slots.length > 0 ? `Добавлено: ${slots.map((slot) => slot.label).join(', ')}` : 'Пока нет слотов. Добавьте хотя бы один.',
    '',
    'Первый слот будет временем начала мероприятия. Участник при записи выберет один из этих слотов.'
  ].join('\n');
}

function buildEventInputFromDraft(draft: EventDraft): CreateEventInput | string {
  if (!draft.universityId || !draft.title || !draft.date || !draft.durationMinutes || !draft.format || !draft.capacity || !draft.locationOrUrl || !draft.description) {
    return 'Черновик неполный. Начните создание заново.';
  }

  if (!draft.slots?.length) {
    return 'Добавьте хотя бы один слот. По первому слоту бот определит время начала мероприятия.';
  }

  const [firstSlot] = [...draft.slots].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
  const startsAt = firstSlot.startsAt;

  if (!startsAt) {
    return 'Дата или время не распознаны. Начните создание заново.';
  }

  return {
    universityId: draft.universityId,
    title: draft.title,
    startsAt,
    durationMinutes: draft.durationMinutes,
    format: draft.format,
    capacity: draft.capacity,
    locationOrUrl: draft.locationOrUrl,
    description: draft.description,
    requirements: draft.requirements ?? 'Подтверждение записи с кодом.',
    cancelPolicy: draft.cancelPolicy ?? 'Отмена доступна до начала мероприятия.',
    registrationClosed: false,
    lateCancelAllowed: draft.lateCancelAllowed ?? false,
    slots: draft.slots ?? []
  };
}

function formatEventDraft(draft: EventDraft): string {
  const firstSlot = draft.slots?.length
    ? [...draft.slots].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())[0]
    : undefined;

  return [
    `Вуз: ${draft.universityId ?? '-'}`,
    `Название: ${draft.title ?? '-'}`,
    `Дата: ${draft.date ?? '-'}`,
    `Время начала: ${firstSlot ? firstSlot.label.split('-')[0] : '-'}`,
    `Длительность слота: ${draft.durationMinutes ?? '-'} мин.`,
    `Формат: ${draft.format ?? '-'}`,
    `Лимит: ${draft.capacity ?? '-'}`,
    `Место/ссылка: ${draft.locationOrUrl ?? '-'}`,
    `Описание: ${draft.description ?? '-'}`,
    `Требования: ${draft.requirements ?? 'стандартные'}`,
    `Правила отмены: ${draft.cancelPolicy ?? 'стандартные'}`,
    `Поздняя отмена: ${draft.lateCancelAllowed ? 'да' : 'нет'}`,
    `Слоты: ${draft.slots?.length ? draft.slots.map((slot) => slot.label).join(', ') : 'без слотов'}`
  ].join('\n');
}

function parseSlots(raw: string, dateRaw: string): EventSlot[] {
  if (raw.trim() === '-') {
    return [];
  }

  const slots = raw.split(',').map((part) => part.trim()).map((label) => {
    const match = label.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);

    if (!match) {
      throw new Error(`Слот "${label}" должен быть в формате ЧЧ:ММ-ЧЧ:ММ.`);
    }

    const startTime = parseClockTime(`${match[1]}:${match[2]}`);
    const endTime = parseClockTime(`${match[3]}:${match[4]}`);

    if (!startTime || !endTime) {
      throw new Error(`В слоте "${label}" часы должны быть 00-23, минуты 00-59.`);
    }

    if (minutesOfDay(endTime) <= minutesOfDay(startTime)) {
      throw new Error(`В слоте "${label}" время окончания должно быть позже начала.`);
    }

    const startsAt = parseEventDate(`${dateRaw} ${match[1]}:${match[2]}`);

    if (!startsAt) {
      throw new Error(`Не удалось разобрать время слота "${label}".`);
    }

    return {
      id: slotIdFromLabel(label),
      label,
      startsAt
    };
  });

  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      if (slotsOverlap(slots[left], slots[right])) {
        throw new Error(`Слоты "${slots[left].label}" и "${slots[right].label}" пересекаются.`);
      }
    }
  }

  return slots;
}

function editableFieldLabels(): Record<EditableEventField, string> {
  return {
    title: 'название',
    date: 'дату',
    time: 'время',
    duration: 'длительность',
    format: 'формат',
    capacity: 'лимит мест',
    location: 'место или ссылку',
    description: 'описание',
    requirements: 'требования',
    cancelPolicy: 'правила отмены',
    registrationClosed: 'статус регистрации',
    lateCancelAllowed: 'позднюю отмену',
    slots: 'слоты'
  };
}

function eventFieldKeyboard(eventId: string) {
  return rows([
    [button('Название', `flow:edit-field:${eventId}:title`), button('Дата', `flow:edit-field:${eventId}:date`)],
    [button('Время', `flow:edit-field:${eventId}:time`), button('Длительность', `flow:edit-field:${eventId}:duration`)],
    [button('Формат', `flow:edit-field:${eventId}:format`), button('Лимит', `flow:edit-field:${eventId}:capacity`)],
    [button('Место/ссылка', `flow:edit-field:${eventId}:location`)],
    [button('Описание', `flow:edit-field:${eventId}:description`)],
    [button('Требования', `flow:edit-field:${eventId}:requirements`)],
    [button('Правила отмены', `flow:edit-field:${eventId}:cancelPolicy`)],
    [button('Регистрация открыта/закрыта', `flow:edit-field:${eventId}:registrationClosed`)],
    [button('Поздняя отмена', `flow:edit-field:${eventId}:lateCancelAllowed`)],
    [button('Слоты', `flow:edit-field:${eventId}:slots`)],
    [button('Отмена', 'flow:cancel')]
  ]);
}

function editValuePrompt(field: EditableEventField): string {
  const labels = editableFieldLabels();
  const hints: Partial<Record<EditableEventField, string>> = {
    date: `${ui.calendar} Выберите новую дату в календаре на ближайшие 6 месяцев или введите ДД.ММ.ГГГГ. Например: 15.06.2026`,
    time: `${ui.time} Выберите час, затем минуты, или введите новое время в формате ЧЧ:ММ. Например: 15:00`,
    duration: `${ui.info} Введите новую длительность в минутах.`,
    format: `${ui.info} Введите формат: online или offline.`,
    capacity: `${ui.info} Введите новый лимит мест числом.`,
    registrationClosed: `${ui.info} Закрыть регистрацию? Ответьте да или нет.`,
    lateCancelAllowed: `${ui.info} Разрешить позднюю отмену? Ответьте да или нет.`,
    slots: `${ui.time} Добавьте слоты кнопками ниже. Можно также отправить слоты текстом через запятую: 15:00-16:00, 17:00-18:00. Слоты не должны пересекаться.`
  };

  return hints[field] ?? `${ui.info} Введите новое значение для поля "${labels[field]}".`;
}

function buildEditPatch(event: EventCard, field: EditableEventField, raw: string): { patch: UpdateEventInput; label: string } | string {
  const value = raw.trim();
  const labels = editableFieldLabels();

  if (!value) {
    return 'Значение не должно быть пустым.';
  }

  switch (field) {
    case 'title':
      return { patch: { title: value }, label: labels[field] };
    case 'description':
      return { patch: { description: value }, label: labels[field] };
    case 'requirements':
      return { patch: { requirements: value === '-' ? 'Подтверждение записи с кодом.' : value }, label: labels[field] };
    case 'cancelPolicy':
      return { patch: { cancelPolicy: value === '-' ? 'Отмена доступна до начала мероприятия.' : value }, label: labels[field] };
    case 'location':
      return { patch: { locationOrUrl: value }, label: labels[field] };
    case 'date': {
      const date = normalizeDateInput(value);
      if (!date) {
        return 'Дата не распознана. Используйте ДД.ММ.ГГГГ.';
      }
      const currentTime = new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Moscow'
      }).format(new Date(event.startsAt));
      const startsAt = parseEventDateTime(date, currentTime);
      return startsAt ? { patch: { startsAt }, label: labels[field] } : 'Дата не распознана. Используйте ДД.ММ.ГГГГ.';
    }
    case 'time': {
      const time = normalizeTimeInput(value);
      if (!time) {
        return 'Время не распознано. Используйте ЧЧ:ММ.';
      }
      const currentDate = new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Europe/Moscow'
      }).format(new Date(event.startsAt));
      const startsAt = parseEventDateTime(currentDate, time);
      return startsAt ? { patch: { startsAt }, label: labels[field] } : 'Время не распознано. Используйте ЧЧ:ММ.';
    }
    case 'duration': {
      const durationMinutes = Number(value);
      return Number.isInteger(durationMinutes) && durationMinutes > 0 ? { patch: { durationMinutes }, label: labels[field] } : 'Длительность должна быть целым числом больше нуля.';
    }
    case 'format': {
      const format = value.toLowerCase() as EventFormat;
      return format === 'online' || format === 'offline' ? { patch: { format }, label: labels[field] } : 'Формат должен быть online или offline.';
    }
    case 'capacity': {
      const capacity = Number(value);
      return Number.isInteger(capacity) && capacity > 0 ? { patch: { capacity }, label: labels[field] } : 'Лимит должен быть целым числом больше нуля.';
    }
    case 'registrationClosed': {
      const answer = parseBoolean(value);
      return answer === undefined ? 'Ответьте да или нет.' : { patch: { registrationClosed: answer }, label: labels[field] };
    }
    case 'lateCancelAllowed': {
      const answer = parseBoolean(value);
      return answer === undefined ? 'Ответьте да или нет.' : { patch: { lateCancelAllowed: answer }, label: labels[field] };
    }
    case 'slots': {
      const currentDate = new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Europe/Moscow'
      }).format(new Date(event.startsAt));

      try {
        const slots = parseSlots(value, currentDate);
        const startsAt = slots.length > 0 ? [...slots].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())[0].startsAt : event.startsAt;
        return { patch: { startsAt, slots }, label: labels[field] };
      } catch (error) {
        return error instanceof Error ? error.message : 'Не удалось разобрать слоты.';
      }
    }
  }
}

async function showOrganizerMenu(ctx: AnyContext, pageRaw = 0) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const manageable = await store.listManageableEvents(user.id, user.role);

  if (manageable.length === 0 && user.role !== 'admin' && user.role !== 'tech_admin' && user.role !== 'organizer') {
    await renderSingle(ctx, `${ui.warn} Управление мероприятиями доступно организаторам, администраторам и назначенным регистраторам.`, rows([[button('Главное меню', 'menu')]]));
    return;
  }

  const page = clampPage(pageRaw, manageable.length);

  if (manageable.length === 0) {
    await renderSingle(
      ctx,
      [`${ui.info} За вами пока не закреплены мероприятия.`, '', canCreateEvent(user) ? eventCreateHelp(user.universityId) : 'Доступных мероприятий пока нет.'].join('\n'),
      rows([...(canCreateEvent(user) ? [[button('Создать мероприятие', 'org:create')]] : []), [button('Главное меню', 'menu')]])
    );
    return;
  }

  await renderSingle(
    ctx,
      [`${ui.list} Управление мероприятиями:`, `Страница ${page + 1} из ${pageCount(manageable.length)}.`, '', 'Здесь показаны мероприятия, которыми вы управляете или где назначены регистратором. Личные записи на мероприятия находятся в отдельном пункте "Мои записи на мероприятия".', '', canCreateEvent(user) ? 'Создание и изменение проходят пошагово через /org_create и /org_edit.' : 'Доступные действия откроются в карточке мероприятия.'].join('\n'),
    rows([
      ...(manageable.length > pageSize ? [paginationButtons(page, manageable.length, (nextPage) => `org:page:${nextPage}`)] : []),
      ...(canCreateEvent(user) ? [[button('Создать мероприятие', 'org:create')]] : []),
      ...pageSlice(manageable, page).map((event) => [button(`${event.deletedAt ? '[Удалено] ' : ''}${event.title}`, `org:event:${event.id}`)]),
      [button('Назад', 'menu')]
    ])
  );
}

async function showCreateEventHelp(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user || !canCreateEvent(user)) {
    await renderSingle(ctx, `${ui.warn} Создание мероприятий доступно только организатору, админу своего вуза или техадмину.`, rows([[button('Назад', 'org')]]));
    return;
  }

  await startCreateEventFlow(ctx, user);
}

async function createEventFromOrganizerCommand(ctx: AnyContext, raw: string) {
  const user = await requireConsent(ctx);

  if (!user || !canCreateEvent(user)) {
    await renderSingle(ctx, `${ui.warn} Создание мероприятий доступно только организатору, админу своего вуза или техадмину.`, rows([[button('Главное меню', 'menu')]]));
    return;
  }

  if (!raw) {
    await startCreateEventFlow(ctx, user);
    return;
  }

  const input = parseCreateEventInput(raw, user);

  if (typeof input === 'string') {
    await renderSingle(ctx, [`${ui.error} ${input}`, '', eventCreateHelp(user.universityId)].join('\n'), rows([[button('Назад', 'org')]]));
    return;
  }

  const university = await store.getUniversity(input.universityId);

  if (!university) {
    await renderSingle(ctx, `${ui.error} Вуз ${input.universityId} не найден. Проверьте university_id.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const event = await store.createEvent(input);
  logger.info(businessLog('event_created', { event_id: event.id, user_id: user.id, university_id: event.universityId, source: 'command' }), 'event created by organizer');
  await renderSingle(ctx, `${ui.ok} Мероприятие создано:\n${formatEvent(event, event.capacity, university)}`, rows([[button('Открыть', `org:event:${event.id}`)], [button('Назад', 'org')]]));
}

async function startCreateEventFlow(ctx: AnyContext, user: StoredUser): Promise<void> {
  const key = userFlowKey(ctx);

  if (!key) {
    await sendNewMessage(ctx, `${ui.error} Не удалось определить пользователя. Откройте диалог с ботом напрямую и попробуйте ещё раз.`);
    return;
  }

  const step: CreateEventStep = user.role === 'tech_admin' ? 'university' : 'title';
  const draft: EventDraft = user.role === 'tech_admin' ? {} : { universityId: user.universityId };

  if (!draft.universityId && user.role !== 'tech_admin') {
    await sendNewMessage(ctx, `${ui.warn} У вас не указан вуз. Обратитесь к техадмину, чтобы он привязал вас к вузу.`);
    return;
  }

  flowStates.set(key, { kind: 'create_event', step, draft });
  await sendNewMessage(ctx, [eventCreateHelp(draft.universityId), '', createEventPrompt(step)].join('\n'), createStepExtra(step, draft));
}

async function handleCreateEventFlow(ctx: AnyContext, state: Extract<FlowState, { kind: 'create_event' }>, text: string): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireConsent(ctx);

  if (!key || !user || !canCreateEvent(user)) {
    return;
  }

  const value = text.trim();
  const draft = { ...state.draft };

  try {
    switch (state.step) {
      case 'university': {
        const university = await store.getUniversity(value);
        if (!university) {
          await sendNewMessage(ctx, `${ui.error} Вуз не найден. Введите существующий university_id.`);
          return;
        }
        draft.universityId = value;
        break;
      }
      case 'title':
        draft.title = value;
        break;
      case 'date': {
        const date = normalizeDateInput(value);
        if (!date) {
          await sendNewMessage(ctx, `${ui.error} Дата не распознана. Выберите дату в календаре или введите ДД.ММ.ГГГГ, например 15.06.2026.`, createStepExtra('date', draft));
          return;
        }
        draft.date = date;
        break;
      }
      case 'duration': {
        const durationMinutes = Number(value);
        if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
          await sendNewMessage(ctx, `${ui.error} Длительность должна быть целым числом минут больше нуля.`);
          return;
        }
        draft.durationMinutes = durationMinutes;
        break;
      }
      case 'format': {
        const format = value.toLowerCase() as EventFormat;
        if (format !== 'online' && format !== 'offline') {
          await sendNewMessage(ctx, `${ui.error} Введите формат строго как online или offline.`);
          return;
        }
        draft.format = format;
        break;
      }
      case 'capacity': {
        const capacity = Number(value);
        if (!Number.isInteger(capacity) || capacity <= 0) {
          await sendNewMessage(ctx, `${ui.error} Лимит мест должен быть целым числом больше нуля.`);
          return;
        }
        draft.capacity = capacity;
        break;
      }
      case 'location':
        draft.locationOrUrl = value;
        break;
      case 'description':
        draft.description = value;
        break;
      case 'requirements':
        draft.requirements = value === '-' ? 'Подтверждение записи с кодом.' : value;
        break;
      case 'cancelPolicy':
        draft.cancelPolicy = value === '-' ? 'Отмена доступна до начала мероприятия.' : value;
        break;
      case 'lateCancelAllowed': {
        const lateCancelAllowed = parseBoolean(value);
        if (lateCancelAllowed === undefined) {
          await sendNewMessage(ctx, `${ui.error} Ответьте "да" или "нет".`);
          return;
        }
        draft.lateCancelAllowed = lateCancelAllowed;
        break;
      }
      case 'slots': {
        if (!draft.date) {
          await sendNewMessage(ctx, `${ui.warn} Дата потерялась. Начните создание мероприятия заново.`);
          flowStates.delete(key);
          return;
        }
        try {
          const slots = parseSlots(value, draft.date);
          if (slots.length === 0) {
            await sendNewMessage(ctx, `${ui.error} Добавьте хотя бы один слот.`, createStepExtra('slots', draft));
            return;
          }
          draft.slots = slots;
        } catch (error) {
          await sendNewMessage(ctx, `${ui.error} ${error instanceof Error ? error.message : 'Не удалось разобрать слоты.'}`, createStepExtra('slots', draft));
          return;
        }
        break;
      }
      case 'confirm': {
        const accepted = parseBoolean(value);
        if (accepted === false) {
          flowStates.delete(key);
          await sendNewMessage(ctx, `${ui.cancel} Создание мероприятия отменено. Черновик удалён.`, rows([[button('Назад', 'org')]]));
          return;
        }
        if (accepted !== true) {
          await sendNewMessage(ctx, `${ui.info} Отправьте "да", чтобы создать мероприятие, или "нет", чтобы отменить.`);
          return;
        }
        const input = buildEventInputFromDraft(draft);
        if (typeof input === 'string') {
          flowStates.delete(key);
          await sendNewMessage(ctx, `${ui.error} ${input}`, rows([[button('Создать заново', 'org:create')], [button('Назад', 'org')]]));
          return;
        }
        const university = await store.getUniversity(input.universityId);
        const event = await store.createEvent(input);
        flowStates.delete(key);
        logger.info(businessLog('event_created', { event_id: event.id, user_id: user.id, university_id: event.universityId, source: 'flow' }), 'event created by flow');
        await sendNewMessage(ctx, `${ui.ok} Мероприятие создано:\n${formatEvent(event, event.capacity, university)}`, rows([[button('Открыть', `org:event:${event.id}`)], [button('Назад', 'org')]]));
        return;
      }
    }
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'create event flow failed');
    await sendNewMessage(ctx, `${ui.error} Не удалось обработать ответ. Попробуйте ещё раз или отмените создание.`, rows([[button('Отмена', 'flow:cancel')]]));
    return;
  }

  const nextStep = nextCreateEventStep(state.step);
  flowStates.set(key, { kind: 'create_event', step: nextStep, draft });

  if (nextStep === 'confirm') {
    await sendNewMessage(ctx, [`${ui.info} Проверьте мероприятие:`, '', formatEventDraft(draft), '', createEventPrompt(nextStep)].join('\n'), createStepExtra(nextStep, draft));
    return;
  }

  if (nextStep === 'slots') {
    await sendNewMessage(ctx, [createEventPrompt(nextStep), '', formatSlotBuilderText(draft.slots)].join('\n'), createStepExtra(nextStep, draft));
    return;
  }

  await sendNewMessage(ctx, createEventPrompt(nextStep), createStepExtra(nextStep, draft));
}

async function applyCreateDateButton(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'date') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас этот выбор не ожидается. Запустите создание заново или продолжите текущий шаг.`, rows([[button('Создать мероприятие', 'org:create')], [button('Назад', 'org')]]));
    return;
  }

  const value = dateFromCompact(rawValue);

  if (!value) {
    await sendNewMessage(ctx, `${ui.error} Не удалось распознать выбранную дату. Попробуйте выбрать день ещё раз или введите дату вручную.`);
    return;
  }

  await handleCreateEventFlow(ctx, state, value);
}

async function showCreateDateMonth(ctx: AnyContext, monthRaw: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'date') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас календарь не ожидается. Продолжите текущий шаг или начните создание заново.`, rows([[button('Создать мероприятие', 'org:create')], [button('Назад', 'org')]]));
    return;
  }

  await sendNewMessage(ctx, createEventPrompt('date'), createDateKeyboard('create', monthRaw));
}

async function showCreateSlotHourPicker(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается. Продолжите текущий шаг или начните создание заново.`, rows([[button('Создать мероприятие', 'org:create')], [button('Назад', 'org')]]));
    return;
  }

  if (rawValue === 'back') {
    await sendNewMessage(ctx, formatSlotBuilderText(state.draft.slots), createSlotBuilderKeyboard('create', state.draft.slots?.length ?? 0));
    return;
  }

  if (rawValue === 'start') {
    await sendNewMessage(ctx, `${ui.time} Выберите час начала слота.`, createSlotHourKeyboard('create'));
    return;
  }

  if (!parseClockTime(`${rawValue}:00`)) {
    await sendNewMessage(ctx, `${ui.error} Час не распознан. Выберите час заново.`, createSlotHourKeyboard('create'));
    return;
  }

  await sendNewMessage(ctx, `${ui.time} Выбран час ${rawValue}. Теперь выберите минуты начала слота.`, createSlotMinuteKeyboard('create', rawValue));
}

async function addCreateSlotFromButton(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается. Продолжите текущий шаг или начните создание заново.`, rows([[button('Создать мероприятие', 'org:create')], [button('Назад', 'org')]]));
    return;
  }

  if (!state.draft.date || !state.draft.durationMinutes) {
    await sendNewMessage(ctx, `${ui.warn} Для слотов нужна дата и длительность. Начните создание заново.`, rows([[button('Создать мероприятие', 'org:create')], [button('Назад', 'org')]]));
    return;
  }

  const startTime = timeFromCompact(rawValue);
  const slot = startTime ? createSlotFromStart(state.draft.date, startTime, state.draft.durationMinutes, state.draft.slots) : 'Время начала слота не распознано.';

  if (typeof slot === 'string') {
    await sendNewMessage(ctx, `${ui.error} ${slot}`, createSlotHourKeyboard('create'));
    return;
  }

  const draft: EventDraft = {
    ...state.draft,
    slots: [...(state.draft.slots ?? []), slot].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())
  };

  flowStates.set(key, { ...state, draft });
  await sendNewMessage(ctx, [`${ui.ok} Слот ${slot.label} добавлен.`, '', formatSlotBuilderText(draft.slots)].join('\n'), createSlotBuilderKeyboard('create', draft.slots?.length ?? 0));
}

async function clearCreateSlots(ctx: AnyContext): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const draft: EventDraft = { ...state.draft, slots: [] };
  flowStates.set(key, { ...state, draft });
  await sendNewMessage(ctx, `${ui.cancel} Слоты очищены. Добавьте новые слоты кнопками.`, createSlotBuilderKeyboard('create', 0));
}

async function finishCreateSlots(ctx: AnyContext): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'create_event' || state.step !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (!state.draft.slots?.length) {
    await sendNewMessage(ctx, `${ui.error} Добавьте хотя бы один слот. По первому слоту будет определено время начала мероприятия.`, createSlotBuilderKeyboard('create', 0));
    return;
  }

  await handleCreateEventFlow(ctx, state, state.draft.slots.map((slot) => slot.label).join(', '));
}

async function applyEditDateButton(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'date') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас этот выбор не ожидается. Вернитесь в меню и выберите действие заново.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  const value = dateFromCompact(rawValue);

  if (!value) {
    await sendNewMessage(ctx, `${ui.error} Не удалось распознать выбранную дату. Попробуйте выбрать день ещё раз или введите дату вручную.`, editValueExtra('date'));
    return;
  }

  await handleEditEventFlow(ctx, state, value);
}

async function showEditDateMonth(ctx: AnyContext, monthRaw: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'date') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас календарь не ожидается. Вернитесь в меню и выберите действие заново.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  await sendNewMessage(ctx, editValuePrompt('date'), createDateKeyboard('edit', monthRaw));
}

async function showEditMinutePicker(ctx: AnyContext, hour: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'time') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас выбор времени не ожидается. Вернитесь в меню и выберите действие заново.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  if (hour === 'back') {
    await sendNewMessage(ctx, editValuePrompt('time'), createHourKeyboard('edit'));
    return;
  }

  if (!parseClockTime(`${hour}:00`)) {
    await sendNewMessage(ctx, `${ui.error} Час не распознан. Выберите час заново.`, createHourKeyboard('edit'));
    return;
  }

  await sendNewMessage(ctx, `${ui.time} Выбран час ${hour}. Теперь выберите минуты.`, createMinuteKeyboard('edit', hour));
}

async function applyEditMinuteButton(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'time') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас выбор времени не ожидается. Вернитесь в меню и выберите действие заново.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  const value = timeFromCompact(rawValue);

  if (!value || !parseClockTime(value)) {
    await sendNewMessage(ctx, `${ui.error} Минуты не распознаны. Выберите время заново.`, createHourKeyboard('edit'));
    return;
  }

  await handleEditEventFlow(ctx, state, value);
}

async function showEditSlotHourPicker(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'slots' || !state.eventId) {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  if (rawValue === 'back') {
    await sendNewMessage(ctx, formatSlotBuilderText(state.draftSlots), createSlotBuilderKeyboard('edit', state.draftSlots?.length ?? 0));
    return;
  }

  if (rawValue === 'start') {
    await sendNewMessage(ctx, `${ui.time} Выберите час начала слота.`, createSlotHourKeyboard('edit'));
    return;
  }

  if (!parseClockTime(`${rawValue}:00`)) {
    await sendNewMessage(ctx, `${ui.error} Час не распознан. Выберите час заново.`, createSlotHourKeyboard('edit'));
    return;
  }

  await sendNewMessage(ctx, `${ui.time} Выбран час ${rawValue}. Теперь выберите минуты начала слота.`, createSlotMinuteKeyboard('edit', rawValue));
}

async function addEditSlotFromButton(ctx: AnyContext, rawValue: string): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'slots' || !state.eventId) {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
    return;
  }

  const event = await eventById(state.eventId);

  if (!event) {
    await sendNewMessage(ctx, `${ui.error} Мероприятие не найдено.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const date = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow'
  }).format(new Date(event.startsAt));
  const startTime = timeFromCompact(rawValue);
  const slot = startTime ? createSlotFromStart(date, startTime, event.durationMinutes, state.draftSlots) : 'Время начала слота не распознано.';

  if (typeof slot === 'string') {
    await sendNewMessage(ctx, `${ui.error} ${slot}`, createSlotHourKeyboard('edit'));
    return;
  }

  const draftSlots = [...(state.draftSlots ?? []), slot].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
  flowStates.set(key, { ...state, draftSlots });
  await sendNewMessage(ctx, [`${ui.ok} Слот ${slot.label} добавлен.`, '', formatSlotBuilderText(draftSlots)].join('\n'), createSlotBuilderKeyboard('edit', draftSlots.length));
}

async function clearEditSlots(ctx: AnyContext): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')]]));
    return;
  }

  flowStates.set(key, { ...state, draftSlots: [] });
  await sendNewMessage(ctx, `${ui.cancel} Слоты очищены. Добавьте новые слоты кнопками.`, createSlotBuilderKeyboard('edit', 0));
}

async function finishEditSlots(ctx: AnyContext): Promise<void> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state || state.kind !== 'edit_event' || state.step !== 'value' || state.field !== 'slots') {
    await sendNewMessage(ctx, `${ui.warn} Сейчас конструктор слотов не ожидается.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (!state.draftSlots?.length) {
    await sendNewMessage(ctx, `${ui.error} Добавьте хотя бы один слот.`, createSlotBuilderKeyboard('edit', 0));
    return;
  }

  await handleEditEventFlow(ctx, state, state.draftSlots.map((slot) => slot.label).join(', '));
}

async function showOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || (!canManage(user, event) && !canDeleteEvent(user, event))) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const registrations = await store.listRegistrations(event.id, undefined, user.id);
  const active = registrations.filter((item) => isActiveStatus(item.status)).length;

  await renderSingle(
    ctx,
    [
      event.title,
      event.deletedAt ? `Статус: удалено ${formatDate(event.deletedAt)}` : 'Статус: активно',
      `Лимит: ${event.capacity}`,
      `Активных записей: ${active}`,
      `Свободно: ${Math.max(event.capacity - active, 0)}`,
      isEventRegistrar(user, event) && !canEditEvent(user, event) ? 'Ваша роль: регистратор мероприятия' : '',
      '',
      'Для поиска отправьте: /find КОД'
    ].join('\n'),
    rows([
      ...(canManage(user, event) ? [[button('Список записей', `org:regs:${event.id}`)]] : []),
      ...(canEditEvent(user, event) ? [[button('Регистраторы', `org:registrars:${event.id}`)]] : []),
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
    await renderSingle(ctx, `${ui.warn} Изменение доступно только организатору или админу своего вуза, а также техадмину.`, rows([[button('Назад', `org:event:${eventId}`)]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, `${ui.warn} Удалённое мероприятие сначала нужно восстановить.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  await startEditEventFlow(ctx, event);
}

async function updateEventFromOrganizerCommand(ctx: AnyContext, raw: string) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  const parsed = parseEditEventInput(raw);

  if (typeof parsed === 'string') {
    await renderSingle(ctx, [`${ui.error} ${parsed}`, '', eventEditHelp()].join('\n'), rows([[button('Назад', 'org')]]));
    return;
  }

  const event = await eventById(parsed.eventId);

  if (!event || !canEditEvent(user, event)) {
    await renderSingle(ctx, `${ui.error} Мероприятие не найдено или у вас нет доступа на изменение.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (event.deletedAt) {
    await renderSingle(ctx, `${ui.warn} Удалённое мероприятие сначала нужно восстановить.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const updated = await store.updateEvent(event.id, parsed.patch);

  if (!updated) {
    await renderSingle(ctx, `${ui.error} Не удалось изменить мероприятие. Попробуйте ещё раз.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const notified = await sendAutomaticEventChangeNotification(updated, changeNotificationKind(parsed.patch), parsed.label);
  logger.info(businessLog('event_updated', { event_id: updated.id, user_id: user.id, university_id: updated.universityId, notified, source: 'command', changed_label: parsed.label }), 'event updated by organizer');
  await renderSingle(ctx, `${ui.ok} Мероприятие изменено: ${parsed.label}.\nУведомлений отправлено: ${notified}.`, rows([[button('Открыть', `org:event:${updated.id}`)], [button('Назад', 'org')]]));
}

async function startEditEventFlow(ctx: AnyContext, event?: EventCard): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireConsent(ctx);

  if (!key || !user) {
    return;
  }

  if (event && !canEditEvent(user, event)) {
    await sendNewMessage(ctx, `${ui.warn} Нет доступа к изменению этого мероприятия.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (event?.deletedAt) {
    await sendNewMessage(ctx, `${ui.warn} Удалённое мероприятие сначала нужно восстановить.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  if (event) {
    flowStates.set(key, { kind: 'edit_event', step: 'field', eventId: event.id });
    await sendNewMessage(ctx, `${ui.info} Что изменить в мероприятии "${event.title}"?`, eventFieldKeyboard(event.id));
    return;
  }

  flowStates.set(key, { kind: 'edit_event', step: 'eventId' });
  await sendNewMessage(ctx, `${ui.info} Введите id мероприятия, которое нужно изменить. Его можно открыть из меню организатора.`, rows([[button('Отмена', 'flow:cancel')]]));
}

async function selectEditField(ctx: AnyContext, eventId: string, field: EditableEventField): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!key || !user || !event || !canEditEvent(user, event)) {
    await sendNewMessage(ctx, `${ui.error} Мероприятие не найдено или у вас нет доступа.`, rows([[button('Назад', 'org')]]));
    return;
  }

  flowStates.set(key, {
    kind: 'edit_event',
    step: 'value',
    eventId,
    field,
    draftSlots: field === 'slots' ? [...event.slots] : undefined
  });

  if (field === 'slots') {
    await sendNewMessage(ctx, [editValuePrompt(field), '', formatSlotBuilderText(event.slots)].join('\n'), createSlotBuilderKeyboard('edit', event.slots.length));
    return;
  }

  await sendNewMessage(ctx, editValuePrompt(field), editValueExtra(field));
}

async function handleEditEventFlow(ctx: AnyContext, state: Extract<FlowState, { kind: 'edit_event' }>, text: string): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireConsent(ctx);

  if (!key || !user) {
    return;
  }

  if (state.step === 'eventId') {
    const event = await eventById(text.trim());

    if (!event || !canEditEvent(user, event)) {
      await sendNewMessage(ctx, `${ui.error} Мероприятие не найдено или у вас нет доступа. Введите другой id или отмените действие.`, rows([[button('Отмена', 'flow:cancel')]]));
      return;
    }

    if (event.deletedAt) {
      await sendNewMessage(ctx, `${ui.warn} Удалённое мероприятие сначала нужно восстановить.`, rows([[button('Назад', `org:event:${event.id}`)], [button('Отмена', 'flow:cancel')]]));
      return;
    }

    flowStates.set(key, { kind: 'edit_event', step: 'field', eventId: event.id });
    await sendNewMessage(ctx, `${ui.info} Что изменить в мероприятии "${event.title}"?`, eventFieldKeyboard(event.id));
    return;
  }

  if (state.step === 'field') {
    await sendNewMessage(ctx, `${ui.info} Выберите поле кнопкой ниже.`, state.eventId ? eventFieldKeyboard(state.eventId) : rows([[button('Отмена', 'flow:cancel')]]));
    return;
  }

  if (!state.eventId || !state.field) {
    flowStates.delete(key);
    await sendNewMessage(ctx, `${ui.warn} Сценарий изменения сброшен. Начните заново.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const event = await eventById(state.eventId);

  if (!event || !canEditEvent(user, event)) {
    flowStates.delete(key);
    await sendNewMessage(ctx, `${ui.error} Мероприятие не найдено или у вас нет доступа.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const parsed = buildEditPatch(event, state.field, text);

  if (typeof parsed === 'string') {
    await sendNewMessage(ctx, `${ui.error} ${parsed}`, editValueExtra(state.field));
    return;
  }

  const updated = await store.updateEvent(event.id, parsed.patch);

  if (!updated) {
    flowStates.delete(key);
    await sendNewMessage(ctx, `${ui.error} Не удалось изменить мероприятие. Попробуйте ещё раз.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const notified = await sendAutomaticEventChangeNotification(updated, changeNotificationKind(parsed.patch), parsed.label);
  flowStates.delete(key);
  logger.info(businessLog('event_updated', { event_id: updated.id, user_id: user.id, university_id: updated.universityId, notified, source: 'flow', changed_label: parsed.label }), 'event updated by flow');
  await sendNewMessage(ctx, `${ui.ok} Мероприятие изменено: ${parsed.label}.\nУведомлений поставлено в очередь: ${notified}.`, rows([[button('Открыть', `org:event:${updated.id}`)], [button('Назад', 'org')]]));
}

async function handleFlowMessage(ctx: AnyContext, text: string): Promise<boolean> {
  const key = userFlowKey(ctx);
  const state = key ? flowStates.get(key) : undefined;

  if (!key || !state) {
    return false;
  }

  if (state.kind === 'create_event') {
    await handleCreateEventFlow(ctx, state, text);
    return true;
  }

  if (state.kind === 'registrar') {
    await handleRegistrarFlow(ctx, state, text);
    return true;
  }

  if (state.kind === 'admin_role') {
    await handleAdminRoleFlow(ctx, state, text);
    return true;
  }

  await handleEditEventFlow(ctx, state, text);
  return true;
}

async function confirmDeleteOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const active = (await store.listRegistrations(event.id, undefined, user.id)).filter((registration) => isActiveStatus(registration.status)).length;

  await renderSingle(
    ctx,
    [
      `${ui.warn} Удалить мероприятие "${event.title}"?`,
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
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const result = await store.deleteEvent(event.id);

  if (result === 'not_found') {
    await renderSingle(ctx, `${ui.info} Мероприятие уже удалено.`, rows([[button('Назад', 'org')]]));
    return;
  }

  logger.info(businessLog('event_deleted', { event_id: event.id, user_id: user.id, university_id: event.universityId }), 'event deleted by organizer');
  await renderSingle(ctx, `${ui.cancel} Мероприятие "${event.title}" помечено удалённым. Записи участников сохранены.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
}

async function restoreOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canDeleteEvent(user, event)) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const restored = await store.restoreEvent(event.id);

  if (!restored) {
    await renderSingle(ctx, `${ui.error} Мероприятие не найдено.`, rows([[button('Назад', 'org')]]));
    return;
  }

  logger.info(businessLog('event_restored', { event_id: restored.id, user_id: user.id, university_id: restored.universityId }), 'event restored by organizer');
  await renderSingle(ctx, `${ui.ok} Мероприятие "${restored.title}" восстановлено.`, rows([[button('Открыть', `org:event:${restored.id}`)], [button('Назад', 'org')]]));
}

async function showOrganizerRegistrations(ctx: AnyContext, eventId: string, pageRaw = 0) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const registrations = await store.listRegistrations(event.id, undefined, user.id);
  const page = clampPage(pageRaw, registrations.length);

  if (registrations.length === 0) {
    await renderSingle(ctx, `${ui.info} Записей пока нет. Когда участники начнут записываться, они появятся здесь.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const lines = pageSlice(registrations, page).map((item) => {
    const attendance = item.attendedAt ? 'посещение отмечено' : 'не пришел';
    return `${item.code} - ${item.userName} - ${statusLabels[item.status]} - ${attendance} - ${slotLabel(event, item.slotId)}`;
  });

  await renderSingle(
    ctx,
    [`${ui.list} Записи:`, `Страница ${page + 1} из ${pageCount(registrations.length)}.`, ...lines, '', 'Для карточки записи отправьте /find КОД'].join('\n'),
    rows([
      ...(registrations.length > pageSize ? [paginationButtons(page, registrations.length, (nextPage) => `org:regs:${event.id}:${nextPage}`)] : []),
      [button('Назад', `org:event:${event.id}`)]
    ])
  );
}

async function showEventRegistrars(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, `${ui.warn} Назначать регистраторов может только организатор или админ своего вуза.`, rows([[button('Назад', `org:event:${eventId}`)]]));
    return;
  }

  const registrars = await store.listEventRegistrars(event.id, user.id);
  const lines = await Promise.all(
    registrars.map(async (registrar) => {
      const stored = await store.getUser(registrar.userId, user.id);
      return `${registrar.userId} - ${stored?.name ?? 'пользователь ещё не писал боту'} - назначен ${formatDate(registrar.assignedAt)}`;
    })
  );

  await renderSingle(
    ctx,
    [
      `${ui.admin} Регистраторы мероприятия`,
      event.title,
      '',
      lines.length > 0 ? lines.join('\n') : 'Регистраторы пока не назначены.',
      '',
      'Можно назначить или снять регистратора кнопками ниже.'
    ].join('\n'),
    rows([
      [button('Добавить регистратора', `org:registrar-add:${event.id}`, 'positive')],
      ...(registrars.length > 0 ? [[button('Снять регистратора', `org:registrar-remove:${event.id}`, 'negative')]] : []),
      [button('Назад', `org:event:${event.id}`)]
    ])
  );
}

async function startRegistrarFlow(ctx: AnyContext, eventId: string, action: 'add' | 'remove') {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);
  const key = userFlowKey(ctx);

  if (!key || !user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к управлению регистраторами.`, rows([[button('Назад', `org:event:${eventId}`)]]));
    return;
  }

  flowStates.set(key, { kind: 'registrar', action, eventId: event.id });
  await sendNewMessage(
    ctx,
    [
      action === 'add' ? `${ui.info} Введите MAX ID пользователя, которого нужно назначить регистратором.` : `${ui.info} Введите MAX ID регистратора, которого нужно снять.`,
      `Мероприятие: ${event.title}`
    ].join('\n'),
    rows([[button('Отмена', 'flow:cancel')]])
  );
}

async function handleRegistrarFlow(ctx: AnyContext, state: Extract<FlowState, { kind: 'registrar' }>, text: string): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireConsent(ctx);
  const targetId = parseUserId(text);
  const event = await eventById(state.eventId);

  if (!key || !user || !event || !canEditEvent(user, event)) {
    if (key) flowStates.delete(key);
    await sendNewMessage(ctx, `${ui.warn} Нет доступа к управлению регистраторами.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (!targetId) {
    await sendNewMessage(ctx, `${ui.error} MAX ID должен быть числом. Попробуйте ещё раз.`, rows([[button('Отмена', 'flow:cancel')]]));
    return;
  }

  if (state.action === 'add') {
    const target = await store.getUser(targetId, user.id);

    if (target?.universityId && target.universityId !== event.universityId) {
      await sendNewMessage(ctx, `${ui.warn} Регистратор должен относиться к тому же вузу, что и мероприятие.`, rows([[button('Отмена', 'flow:cancel')]]));
      return;
    }

    const registrar = await store.assignEventRegistrar(event.id, targetId, user.id);
    flowStates.delete(key);
    logger.info(
      businessLog('event_registrar_assigned', {
        event_id: event.id,
        university_id: event.universityId,
        registrar_user_id: registrar.userId,
        actor_user_id: user.id,
        source: 'flow'
      }),
      'event registrar assigned by flow'
    );
    await sendNewMessage(ctx, `${ui.ok} Регистратор назначен: MAX ID ${registrar.userId}`, rows([[button('Регистраторы', `org:registrars:${event.id}`)], [button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const result = await store.removeEventRegistrar(event.id, targetId, user.id);
  flowStates.delete(key);
  logger.info(
    businessLog('event_registrar_removed', {
      event_id: event.id,
      university_id: event.universityId,
      registrar_user_id: targetId,
      actor_user_id: user.id,
      result,
      source: 'flow'
    }),
    'event registrar removed by flow'
  );
  await sendNewMessage(
    ctx,
    result === 'removed' ? `${ui.ok} Регистратор снят: MAX ID ${targetId}` : `${ui.info} Этот пользователь не был регистратором мероприятия.`,
    rows([[button('Регистраторы', `org:registrars:${event.id}`)], [button('Назад', `org:event:${event.id}`)]])
  );
}

async function assignRegistrarFromCommand(ctx: AnyContext, eventIdRaw: string, userIdRaw: string) {
  const actor = await requireConsent(ctx);
  const targetId = parseUserId(userIdRaw);
  const event = await eventById(eventIdRaw.trim());

  if (!actor || !targetId || !event || !canEditEvent(actor, event)) {
    await renderSingle(ctx, `${ui.warn} Не удалось назначить регистратора. Проверьте event_id, MAX ID и права на мероприятие.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const target = await store.getUser(targetId, actor.id);

  if (target?.universityId && target.universityId !== event.universityId) {
    await renderSingle(ctx, `${ui.warn} Регистратор должен относиться к тому же вузу, что и мероприятие.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const registrar = await store.assignEventRegistrar(event.id, targetId, actor.id);
  logger.info(
    businessLog('event_registrar_assigned', {
      event_id: event.id,
      university_id: event.universityId,
      registrar_user_id: registrar.userId,
      actor_user_id: actor.id
    }),
    'event registrar assigned by bot'
  );
  await renderSingle(ctx, `${ui.ok} Регистратор назначен: MAX ID ${registrar.userId}`, rows([[button('Регистраторы', `org:registrars:${event.id}`)], [button('Назад', `org:event:${event.id}`)]]));
}

async function removeRegistrarFromCommand(ctx: AnyContext, eventIdRaw: string, userIdRaw: string) {
  const actor = await requireConsent(ctx);
  const targetId = parseUserId(userIdRaw);
  const event = await eventById(eventIdRaw.trim());

  if (!actor || !targetId || !event || !canEditEvent(actor, event)) {
    await renderSingle(ctx, `${ui.warn} Не удалось снять регистратора. Проверьте event_id, MAX ID и права на мероприятие.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const result = await store.removeEventRegistrar(event.id, targetId, actor.id);
  logger.info(
    businessLog('event_registrar_removed', {
      event_id: event.id,
      university_id: event.universityId,
      registrar_user_id: targetId,
      actor_user_id: actor.id,
      result
    }),
    'event registrar removed by bot'
  );
  await renderSingle(
    ctx,
    result === 'removed' ? `${ui.ok} Регистратор снят: MAX ID ${targetId}` : `${ui.info} Этот пользователь не был регистратором мероприятия.`,
    rows([[button('Регистраторы', `org:registrars:${event.id}`)], [button('Назад', `org:event:${event.id}`)]])
  );
}

async function findRegistration(ctx: AnyContext, code: string) {
  const user = await requireConsent(ctx);
  const registration = await store.findRegistrationByCode(code);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canMarkAttendance(user, event)) {
    await renderSingle(ctx, `${ui.error} Запись не найдена или у вас нет доступа.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const actionButtons = canEditEvent(user, event)
    ? [
        [button('Подтверждена', `org:status:${registration.id}:confirmed`, 'positive')],
        [button('Пришел', `org:status:${registration.id}:attended`, 'positive')],
        [button('Отменить организатором', `org:status:${registration.id}:cancelled_by_organizer`, 'negative')]
      ]
    : [[button('Отметить пришедшим', `org:status:${registration.id}:attended`, 'positive')]];

  await renderSingle(
    ctx,
    [
      `Код: ${registration.code}`,
      `Мероприятие: ${event.title}`,
      `Участник: ${registration.userName}`,
      `Статус: ${statusLabels[registration.status]}`,
      registration.attendedAt ? `Посещение: отмечено ${formatDate(registration.attendedAt)}` : 'Посещение: не отмечено',
      `Слот: ${slotLabel(event, registration.slotId)}`
    ].join('\n'),
    rows([...actionButtons, [button('Назад', `org:event:${event.id}`)]])
  );
}

async function setOrganizerStatus(ctx: AnyContext, registrationId: string, status: RegistrationStatus) {
  const user = await requireConsent(ctx);
  const registration = (await store.listRegistrations(undefined, undefined, user?.id)).find((item) => item.id === registrationId);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canMarkAttendance(user, event)) {
    await renderSingle(ctx, `${ui.error} Запись не найдена или у вас нет доступа.`, rows([[button('Назад', 'org')]]));
    return;
  }

  if (!canEditEvent(user, event) && status !== 'attended') {
    await renderSingle(ctx, `${ui.warn} Регистратор может только отметить участника как пришедшего.`, rows([[button('Назад', `org:event:${event.id}`)]]));
    return;
  }

  const attendancePatch = status === 'attended'
    ? { attendedAt: new Date().toISOString(), attendedBy: user.id }
    : { attendedAt: undefined, attendedBy: undefined };
  const updated = await store.updateRegistration(registration.id, { status, ...attendancePatch }, user.id);
  logger.info(
    businessLog('registration_status_changed', {
      registration_id: registration.id,
      registration_code: updated?.code ?? registration.code,
      event_id: event.id,
      university_id: event.universityId,
      actor_user_id: user.id,
      status
    }),
    'registration status changed by organizer'
  );
  await renderSingle(ctx, `${ui.ok} Статус записи ${updated?.code ?? registration.code}: ${statusLabels[status]}`, rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function showNotifyMenu(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canEditEvent(user, event)) {
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  await renderSingle(
    ctx,
    `${ui.info} Выберите тип уведомления. Оно уйдёт только активным участникам этого мероприятия, у которых уведомления включены.`,
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
    await renderSingle(ctx, `${ui.warn} Нет доступа к этому мероприятию.`, rows([[button('Назад', 'org')]]));
    return;
  }

  const recipients = (await store.listRegistrations(event.id, undefined, user.id)).filter(
    (item) => isActiveStatus(item.status) && item.notificationsEnabled
  );

  if (recipients.length > 0) {
    await store.enqueueNotification({
      recipients: recipients.map((recipient) => recipient.userId),
      text: [`Уведомление по мероприятию "${event.title}"`, notificationTemplates[kind]].join('\n')
    });
  }

  logger.info(
    businessLog('notification_requested', {
      event_id: event.id,
      university_id: event.universityId,
      actor_user_id: user.id,
      notification_kind: kind,
      recipients: recipients.length
    }),
    'event notification requested'
  );
  await renderSingle(ctx, `${ui.ok} Уведомление поставлено в очередь. Получателей: ${recipients.length}.`, rows([[button('Назад', `org:event:${event.id}`)]]));
}

async function sendAutomaticEventChangeNotification(
  event: EventCard,
  kind: keyof typeof notificationTemplates,
  changedLabel: string
): Promise<number> {
  const recipients = (await store.listRegistrations(event.id)).filter(
    (item) => isActiveStatus(item.status) && item.notificationsEnabled
  );

  if (recipients.length > 0) {
    await store.enqueueNotification({
      recipients: recipients.map((recipient) => recipient.userId),
      text: [
        `Изменение по мероприятию "${event.title}"`,
        notificationTemplates[kind],
        `Изменено: ${changedLabel}`,
        `Дата: ${formatDate(event.startsAt)}`,
        `Адрес/ссылка: ${event.locationOrUrl}`
      ].join('\n')
    });
  }

  return recipients.length;
}

async function requireRoleAdmin(ctx: AnyContext): Promise<StoredUser | undefined> {
  const user = await requireConsent(ctx);

  if (!user) {
    return undefined;
  }

  if (user.role !== 'tech_admin' && user.role !== 'admin') {
    await renderSingle(ctx, `${ui.warn} Это действие доступно только администратору.`, rows([[button('Главное меню', 'menu')]]));
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
      `${ui.admin} Админ-панель`,
      '',
      user.role === 'tech_admin' ? 'Техадмин может назначать админов, организаторов, техадминов и менять вуз.' : 'Админ может назначать организаторов только своего вуза.',
      'Выберите действие кнопками ниже.',
      '',
      `Ваш вуз: ${user.universityId ?? 'все вузы'}`,
      'MAX ID пользователь может узнать командой /whoami.'
    ].join('\n'),
    rows([
      ...(user.role === 'tech_admin' ? [[button('Добавить админа', 'admin:start-role:admin')]] : []),
      [button('Добавить организатора', 'admin:start-role:organizer')],
      ...(user.role === 'tech_admin' ? [[button('Добавить техадмина', 'admin:start-role:tech_admin')]] : []),
      [button('Снять права', 'admin:start-role:applicant', 'negative')],
      [button('Список вузов', 'admin:universities')],
      ...(user.role === 'tech_admin' ? [[button('Список админов', 'admin:list:admin')]] : []),
      [button('Список организаторов', 'admin:list:organizer')],
      ...(user.role === 'tech_admin' ? [[button('Список техадминов', 'admin:list:tech_admin')]] : []),
      [button('Назад', 'menu')]
    ])
  );
}

async function showUsersByRole(ctx: AnyContext, role: Role, pageRaw = 0) {
  const user = await requireRoleAdmin(ctx);

  if (!user) {
    return;
  }

  if (user.role !== 'tech_admin' && role !== 'organizer') {
    await renderSingle(ctx, `${ui.warn} Админ вуза может смотреть здесь только организаторов своего вуза.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const users = await store.listUsers(role, user.role === 'tech_admin' ? undefined : user.universityId, user.id);
  const page = clampPage(pageRaw, users.length);

  if (users.length === 0) {
    await renderSingle(ctx, `${ui.info} Пользователей с ролью "${roleLabels[role]}" пока нет.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const lines = pageSlice(users, page).map((item) => formatUserLine(item));
  await renderSingle(
    ctx,
    [`${ui.list} Роль: ${roleLabels[role]}`, `Страница ${page + 1} из ${pageCount(users.length)}.`, ...lines].join('\n'),
    rows([
      ...(users.length > pageSize ? [paginationButtons(page, users.length, (nextPage) => `admin:list:${role}:${nextPage}`)] : []),
      [button('Назад', 'admin')]
    ])
  );
}

async function showAdminUserCard(ctx: AnyContext, userIdRaw: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);

  if (!user || !targetId) {
    await renderSingle(ctx, `${ui.error} Укажите MAX ID числом. Например: /admin_user 123456789`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const target = await store.getUser(targetId, user.id);
  const canManageTarget = user.role === 'tech_admin' || target?.universityId === user.universityId || !target;

  if (!canManageTarget) {
    await renderSingle(ctx, `${ui.warn} Нельзя управлять пользователем из другого вуза.`, rows([[button('Назад', 'admin')]]));
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
      target ? `${ui.info} Выберите действие:` : `${ui.info} Пользователь ещё не писал боту, но роль можно назначить заранее.`
    ].join('\n'),
    rows(roleButtons)
  );
}

async function startAdminRoleFlow(ctx: AnyContext, role: Role, universityIdRaw?: string) {
  const user = await requireRoleAdmin(ctx);
  const key = userFlowKey(ctx);
  const universityId = normalizeUniversityId(universityIdRaw);

  if (!key || !user) {
    return;
  }

  if (role === 'admin' && user.role !== 'tech_admin') {
    await renderSingle(ctx, `${ui.warn} Админа может назначить только техадмин.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  if (role === 'tech_admin' && user.role !== 'tech_admin') {
    await renderSingle(ctx, `${ui.warn} Техадмина может назначить только техадмин.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  if ((role === 'admin' || role === 'organizer') && user.role === 'tech_admin' && !universityId) {
    await showAdminUniversityPicker(ctx, role);
    return;
  }

  const resolvedUniversityId = role === 'admin' || role === 'organizer' ? universityId ?? user.universityId : undefined;
  flowStates.set(key, { kind: 'admin_role', role, universityId: resolvedUniversityId });
  await sendNewMessage(
    ctx,
    [
      `${ui.admin} ${adminRoleFlowTitle(role)}`,
      resolvedUniversityId ? `Вуз: ${resolvedUniversityId}` : '',
      '',
      'Введите MAX ID пользователя.'
    ].filter(Boolean).join('\n'),
    rows([[button('Отмена', 'flow:cancel')], [button('Назад', 'admin')]])
  );
}

async function showAdminUniversityPicker(ctx: AnyContext, role: Role, pageRaw = 0) {
  const user = await requireRoleAdmin(ctx);

  if (!user || user.role !== 'tech_admin' || (role !== 'admin' && role !== 'organizer')) {
    await renderSingle(ctx, `${ui.warn} Выбор вуза здесь доступен только техадмину.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const universities = await store.listUniversities();
  const page = clampPage(pageRaw, universities.length);
  const pageUniversities = pageSlice(universities, page);

  await renderSingle(
    ctx,
    [`${ui.admin} Выберите вуз для роли "${roleLabels[role]}"`, `Страница ${page + 1} из ${pageCount(universities.length)}.`].join('\n'),
    rows([
      ...(universities.length > pageSize ? [paginationButtons(page, universities.length, (nextPage) => `admin:pick-university:${role}:${nextPage}`)] : []),
      ...pageUniversities.map((university) => [button(`${university.shortTitle} - ${university.city}`, `admin:start-role:${role}:${university.id}`)]),
      [button('Назад', 'admin')]
    ])
  );
}

async function handleAdminRoleFlow(ctx: AnyContext, state: Extract<FlowState, { kind: 'admin_role' }>, text: string): Promise<void> {
  const key = userFlowKey(ctx);
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(text);

  if (!key || !user) {
    return;
  }

  if (!targetId) {
    await sendNewMessage(ctx, `${ui.error} MAX ID должен быть числом. Попробуйте ещё раз.`, rows([[button('Отмена', 'flow:cancel')]]));
    return;
  }

  if (targetId === user.id && state.role !== 'tech_admin') {
    await sendNewMessage(ctx, `${ui.warn} Нельзя снять технические права у самого себя через бота.`, rows([[button('Отмена', 'flow:cancel')]]));
    return;
  }

  const universityId = state.role === 'admin' || state.role === 'organizer' ? state.universityId ?? user.universityId : undefined;

  if (!canAssignRole(user, state.role, universityId)) {
    await sendNewMessage(ctx, `${ui.warn} Недостаточно прав для назначения этой роли или вуза.`, rows([[button('Назад', 'admin')]]));
    flowStates.delete(key);
    return;
  }

  if ((state.role === 'admin' || state.role === 'organizer') && !universityId) {
    await sendNewMessage(ctx, `${ui.info} Для роли админа или организатора нужно выбрать вуз.`, rows([[button('Назад', 'admin')]]));
    flowStates.delete(key);
    return;
  }

  const updated = await store.setUserRole(targetId, state.role, state.role === 'admin' || state.role === 'organizer' ? universityId : null, user.id);
  flowStates.delete(key);
  logger.info(
    businessLog('user_role_assigned', {
      actor_user_id: user.id,
      target_user_id: updated.id,
      target_role: updated.role,
      university_id: updated.universityId,
      source: 'flow'
    }),
    'user role assigned by flow'
  );
  await sendNewMessage(ctx, `${ui.ok} Готово: ${formatUserLine(updated)}`, rows([[button('Админ-панель', 'admin')], [button('Главное меню', 'menu')]]));
}

function adminRoleFlowTitle(role: Role): string {
  if (role === 'applicant') return 'Снять права пользователя';
  return `Назначить роль: ${roleLabels[role]}`;
}

async function setRoleFromAdmin(ctx: AnyContext, userIdRaw: string, role: Role, universityIdRaw?: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);

  if (!user || !targetId) {
    await renderSingle(ctx, `${ui.error} Укажите MAX ID числом.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  if (targetId === user.id && role !== 'tech_admin') {
    await renderSingle(ctx, `${ui.warn} Нельзя снять технические права у самого себя через бота.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const universityId = normalizeUniversityId(universityIdRaw) ?? user.universityId;

  if (!canAssignRole(user, role, universityId)) {
    await renderSingle(ctx, `${ui.warn} Недостаточно прав для назначения этой роли или вуза.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  if ((role === 'admin' || role === 'organizer') && !universityId) {
    await renderSingle(ctx, `${ui.info} Для роли админа или организатора нужно указать вуз. Например: /admin_add 123 rtu-mirea`, rows([[button('Список вузов', 'admin:universities')], [button('Назад', 'admin')]]));
    return;
  }

  const updated = await store.setUserRole(targetId, role, role === 'admin' || role === 'organizer' ? universityId : null, user.id);
  logger.info(
    businessLog('user_role_assigned', {
      actor_user_id: user.id,
      target_user_id: updated.id,
      target_role: updated.role,
      university_id: updated.universityId
    }),
    'user role assigned'
  );
  await renderSingle(ctx, `${ui.ok} Готово: ${formatUserLine(updated)}`, rows([[button('Назад', 'admin')]]));
}

async function changeUserUniversity(ctx: AnyContext, userIdRaw: string, universityIdRaw: string) {
  const user = await requireRoleAdmin(ctx);
  const targetId = parseUserId(userIdRaw);
  const universityId = normalizeUniversityId(universityIdRaw);

  if (!user || !targetId || !universityId) {
    await renderSingle(ctx, `${ui.info} Формат команды: /admin_university MAX_ID university_id`, rows([[button('Список вузов', 'admin:universities')], [button('Назад', 'admin')]]));
    return;
  }

  const target = await store.getUser(targetId, user.id);

  if (!target || (target.role !== 'admin' && target.role !== 'organizer')) {
    await renderSingle(ctx, `${ui.warn} Вуз можно менять только админам и организаторам.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  if (!canAssignRole(user, target.role, universityId)) {
    await renderSingle(ctx, `${ui.warn} Недостаточно прав для назначения этого вуза.`, rows([[button('Назад', 'admin')]]));
    return;
  }

  const updated = await store.setUserRole(targetId, target.role, universityId, user.id);
  logger.info(
    businessLog('user_university_changed', {
      actor_user_id: user.id,
      target_user_id: updated.id,
      target_role: updated.role,
      university_id: updated.universityId
    }),
    'user university changed'
  );
  await renderSingle(ctx, `${ui.ok} Вуз обновлён: ${formatUserLine(updated)}`, rows([[button('Назад', 'admin')]]));
}

async function showUniversitiesForAdmin(ctx: AnyContext, pageRaw = 0) {
  const user = await requireRoleAdmin(ctx);

  if (!user) {
    return;
  }

  const universities = await store.listUniversities();
  const page = clampPage(pageRaw, universities.length);
  const lines = pageSlice(universities, page).map((university) => `${university.id} - ${university.shortTitle} - ${university.city}`);
  await renderSingle(
    ctx,
    [`${ui.list} Вузы:`, `Страница ${page + 1} из ${pageCount(universities.length)}.`, ...lines].join('\n'),
    rows([
      ...(universities.length > pageSize ? [paginationButtons(page, universities.length, (nextPage) => `admin:universities:${nextPage}`)] : []),
      [button('Назад', 'admin')]
    ])
  );
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

function normalizeExternalLogin(raw?: string): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && /^[a-z0-9._@-]{3,80}$/.test(value) ? value : undefined;
}

function parseLoginStartPayload(payload?: string): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (payload.startsWith('login.')) {
    return decodeLoginPayload(payload.slice('login.'.length));
  }

  if (payload.startsWith('login_')) {
    return decodeURIComponent(payload.slice('login_'.length));
  }

  return undefined;
}

function decodeLoginPayload(payload: string): string | undefined {
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
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

try {
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
    { name: 'registrar_add', description: 'Назначить регистратора мероприятия' },
    { name: 'registrar_remove', description: 'Снять регистратора мероприятия' },
    { name: 'find', description: 'Найти запись по коду' },
    { name: 'login', description: 'Получить код входа для внешнего клиента' },
    { name: 'whoami', description: 'Показать ваш MAX ID' }
  ]);
} catch (error) {
  logger.warn({ err: error }, 'failed to set bot commands');
}

bot.on('bot_started', async (ctx) => {
  logger.info(logContext(ctx), 'bot started conversation');
  const startPayload = typeof ctx.startPayload === 'string' ? ctx.startPayload : undefined;

  const loginFromPayload = parseLoginStartPayload(startPayload);

  if (loginFromPayload) {
    await handleExternalLogin(ctx, loginFromPayload);
    return;
  }

  await showWelcome(ctx);
});

bot.command('start', async (ctx) => {
  logger.info(logContext(ctx), 'command start');
  const text = ctx.message?.body.text?.trim() ?? '';
  const loginMatch = text.match(/^\/start\s+login_(.+)$/i);

  if (loginMatch) {
    await handleExternalLogin(ctx, decodeURIComponent(loginMatch[1]));
    return;
  }

  await showMainMenu(ctx);
});

bot.hears(/^\/start\s+login_(.+)$/i, async (ctx) => {
  logger.info(logContext(ctx), 'deeplink login start');
  await handleExternalLogin(ctx, decodeURIComponent(ctx.match?.[1] ?? ''));
});

bot.hears(/^\/start\s+login\.(.+)$/i, async (ctx) => {
  logger.info(logContext(ctx), 'deeplink encoded login start');
  const login = decodeLoginPayload(ctx.match?.[1] ?? '');
  await handleExternalLogin(ctx, login ?? '');
});

bot.hears(/^\/login\s+(.+)$/i, async (ctx) => {
  logger.info(logContext(ctx), 'command login');
  await handleExternalLogin(ctx, ctx.match?.[1] ?? '');
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
  await answerCallback(ctx);
  await showCreateEventHelp(ctx);
});
bot.command('org_edit', async (ctx) => {
  logger.info(logContext(ctx), 'command org_edit');
  await answerCallback(ctx);
  await startEditEventFlow(ctx);
});
bot.command('admin', async (ctx) => {
  logger.info(logContext(ctx), 'command admin');
  await showAdminPanel(ctx);
});
bot.command('whoami', async (ctx) => {
  logger.info(logContext(ctx), 'command whoami');
  const user = await rememberUser(ctx);
  await ctx.reply(user ? `${ui.info} Ваш MAX ID: ${user.id}` : `${ui.error} Не удалось определить MAX ID.`);
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

bot.hears(/^\/registrar_add\s+(\S+)\s+(.+)/i, async (ctx) => {
  await assignRegistrarFromCommand(ctx, ctx.match?.[1] ?? '', ctx.match?.[2] ?? '');
});

bot.hears(/^\/registrar_remove\s+(\S+)\s+(.+)/i, async (ctx) => {
  await removeRegistrarFromCommand(ctx, ctx.match?.[1] ?? '', ctx.match?.[2] ?? '');
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
      await ctx.reply(`${ui.error} Не удалось сохранить согласие. Откройте диалог с ботом напрямую и попробуйте ещё раз.`);
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

    await ctx.reply(`${ui.ok} Согласие сохранено.`);
    const pendingLogin = pendingExternalLogins.get(sender.user_id);

    if (pendingLogin) {
      pendingExternalLogins.delete(sender.user_id);
      await issueExternalLoginCode(ctx, user, pendingLogin);
    }

    await showMainMenu(ctx, user);
    return;
  }

  if (payload === 'catalog') return showCatalog(ctx);
  if (scope === 'catalog' && a === 'page') return showCatalog(ctx, undefined, parsePage(b));
  if (scope === 'catalog' && a === 'uni') return showCatalog(ctx, b, parsePage(c));
  if (payload === 'menu') return showMainMenu(ctx);
  if (payload === 'flow:noop') return;
  if (payload === 'universities') return showUniversities(ctx);
  if (scope === 'universities' && a === 'page') return showUniversities(ctx, parsePage(b));
  if (payload === 'my') return showMyRegistrations(ctx);
  if (scope === 'my' && a === 'page') return showMyRegistrations(ctx, parsePage(b));
  if (payload === 'web-panel') return showWebPanelInfo(ctx);
  if (payload === 'org') return showOrganizerMenu(ctx);
  if (scope === 'org' && a === 'page') return showOrganizerMenu(ctx, parsePage(b));
  if (scope === 'flow' && a === 'cancel') {
    const key = userFlowKey(ctx);
    if (key) {
      flowStates.delete(key);
    }
    return sendNewMessage(ctx, `${ui.cancel} Действие отменено. Текущий сценарий закрыт.`, rows([[button('Назад', 'org')], [button('Главное меню', 'menu')]]));
  }
  if (scope === 'flow' && a === 'create-date') return applyCreateDateButton(ctx, b);
  if (scope === 'flow' && a === 'create-month') return showCreateDateMonth(ctx, b);
  if (scope === 'flow' && a === 'create-slot-hour') return showCreateSlotHourPicker(ctx, b);
  if (scope === 'flow' && a === 'create-slot-minute') return addCreateSlotFromButton(ctx, b);
  if (scope === 'flow' && a === 'create-slot-clear') return clearCreateSlots(ctx);
  if (scope === 'flow' && a === 'create-slot-finish') return finishCreateSlots(ctx);
  if (scope === 'flow' && a === 'edit-date') return applyEditDateButton(ctx, b);
  if (scope === 'flow' && a === 'edit-month') return showEditDateMonth(ctx, b);
  if (scope === 'flow' && a === 'edit-hour') return showEditMinutePicker(ctx, b);
  if (scope === 'flow' && a === 'edit-minute') return applyEditMinuteButton(ctx, b);
  if (scope === 'flow' && a === 'edit-slot-hour') return showEditSlotHourPicker(ctx, b);
  if (scope === 'flow' && a === 'edit-slot-minute') return addEditSlotFromButton(ctx, b);
  if (scope === 'flow' && a === 'edit-slot-clear') return clearEditSlots(ctx);
  if (scope === 'flow' && a === 'edit-slot-finish') return finishEditSlots(ctx);
  if (scope === 'flow' && a === 'edit-field') return selectEditField(ctx, b, c as EditableEventField);
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
  if (scope === 'org' && a === 'regs') return showOrganizerRegistrations(ctx, b, parsePage(c));
  if (scope === 'org' && a === 'registrars') return showEventRegistrars(ctx, b);
  if (scope === 'org' && a === 'registrar-add') return startRegistrarFlow(ctx, b, 'add');
  if (scope === 'org' && a === 'registrar-remove') return startRegistrarFlow(ctx, b, 'remove');
  if (scope === 'org' && a === 'notify') return showNotifyMenu(ctx, b);
  if (scope === 'org' && a === 'delete') return confirmDeleteOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'delete-confirm') return deleteOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'restore') return restoreOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'status') return setOrganizerStatus(ctx, b, c as RegistrationStatus);
  if (scope === 'org' && a === 'send') return sendEventNotification(ctx, b, c as keyof typeof notificationTemplates);
  if (scope === 'admin' && a === 'list') return showUsersByRole(ctx, b as Role, parsePage(c));
  if (scope === 'admin' && a === 'universities') return showUniversitiesForAdmin(ctx, parsePage(b));
  if (scope === 'admin' && a === 'start-role') return startAdminRoleFlow(ctx, b as Role, c);
  if (scope === 'admin' && a === 'pick-university') return showAdminUniversityPicker(ctx, b as Role, parsePage(c));
  if (scope === 'admin' && a === 'role') return setRoleFromAdmin(ctx, b, c as Role, d);

  await ctx.reply(`${ui.warn} Неизвестное действие. Откройте /start и выберите пункт из меню.`);
});

bot.on('message_created', async (ctx) => {
  const text = ctx.message.body.text?.trim() ?? '';

  if (text.startsWith('/')) {
    return;
  }

  logger.info(logContext(ctx), 'plain message received');
  if (await handleFlowMessage(ctx, text)) {
    return;
  }

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

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Bot, Keyboard, type Context } from '@maxhub/max-bot-api';
import { DataServiceClient } from './data-service-client.js';
import { isActiveStatus } from '../shared/domain.js';
import type { EventCard, Registration, RegistrationStatus, Role, StoredUser } from '../shared/types.js';

const token = process.env.MAX_BOT_TOKEN;

if (!token) {
  throw new Error('MAX_BOT_TOKEN is required. Copy .env.example to .env and set the bot token.');
}

const bot = new Bot(token);
const store = new DataServiceClient(process.env.DATA_SERVICE_URL ?? 'http://localhost:3060');
const legalDocVersion = process.env.LEGAL_DOC_VERSION ?? 'hackathon-2026-05-14';
const adminIds = new Set(
  (process.env.ADMIN_MAX_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Number.isFinite)
);

type AnyContext = Context<any>;

const statusLabels: Record<RegistrationStatus, string> = {
  confirmed: 'Подтверждена',
  attended: 'Участник пришел',
  cancelled_by_user: 'Отменена пользователем',
  cancelled_by_organizer: 'Отменена организатором',
  late_cancelled: 'Поздняя отмена'
};

const notificationTemplates = {
  day: 'Напоминание: мероприятие состоится завтра. Проверьте код записи и детали в боте.',
  hour: 'Напоминание: мероприятие начнется примерно через час.',
  time: 'Обновление по мероприятию: время изменилось. Проверьте актуальную информацию у организатора.',
  room: 'Обновление по мероприятию: изменилась аудитория или место сбора.',
  link: 'Обновление по мероприятию: ссылка на подключение будет отправлена организатором отдельно.'
} as const;

function rows(buttons: ReturnType<typeof Keyboard.button.callback>[][]) {
  return { attachments: [Keyboard.inlineKeyboard(buttons)] };
}

function button(text: string, payload: string, intent: 'default' | 'positive' | 'negative' = 'default') {
  return Keyboard.button.callback(text, payload, { intent });
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

function formatEvent(event: EventCard, freeSeats: number): string {
  const format = event.format === 'online' ? 'онлайн' : 'очно';
  const seats = event.registrationClosed ? 'регистрация закрыта' : freeSeats > 0 ? `свободно мест: ${freeSeats}` : 'мест нет';

  return [
    event.title,
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

function roleFor(userId: number, saved?: StoredUser): Role {
  if (adminIds.has(userId)) {
    return 'admin';
  }

  return saved?.role ?? 'applicant';
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
  await ctx.reply(
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
    [button('Каталог мероприятий', 'catalog')],
    [button('Мои записи', 'my')]
  ];

  if (current.role === 'organizer' || current.role === 'admin') {
    menu.push([button('Меню организатора', 'org')]);
  }

  await ctx.reply('Выберите действие:', rows(menu));
}

async function showCatalog(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user) {
    return;
  }

  for (const event of await store.listEvents()) {
    const seats = await freeSeats(event);
    const buttons = [[button('Подробнее', `event:${event.id}`)]];

    if (!event.registrationClosed && seats > 0) {
      buttons[0].push(button('Записаться', `enroll:${event.id}`, 'positive'));
    }

    await ctx.reply(formatEvent(event, seats), rows(buttons));
  }
}

async function showEventDetails(ctx: AnyContext, eventId: string) {
  const event = await eventById(eventId);

  if (!event) {
    await ctx.reply('Мероприятие не найдено.');
    return;
  }

  const seats = await freeSeats(event);
  const text = [
    formatEvent(event, seats),
    '',
    event.description,
    '',
    `Требования: ${event.requirements}`,
    `Адрес/ссылка: ${event.locationOrUrl}`,
    `Отмена: ${event.cancelPolicy}`
  ].join('\n');

  const actions = [[button('К каталогу', 'catalog')]];

  if (!event.registrationClosed && seats > 0) {
    actions[0].push(button('Записаться', `enroll:${event.id}`, 'positive'));
  }

  await ctx.reply(text, rows(actions));
}

async function startEnrollment(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event) {
    await ctx.reply('Не удалось начать запись.');
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await ctx.reply('Запись на это мероприятие сейчас недоступна.');
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await ctx.reply(`Вы уже записаны. Код записи: ${existing.code}`);
    return;
  }

  if (event.slots.length > 0) {
    await ctx.reply(
      'Выберите слот:',
      rows(event.slots.map((slot) => [button(slot.label, `slot:${event.id}:${slot.id}`, 'positive')]))
    );
    return;
  }

  await showEnrollmentSummary(ctx, event.id);
}

async function showEnrollmentSummary(ctx: AnyContext, eventId: string, slotId?: string) {
  const event = await eventById(eventId);

  if (!event) {
    await ctx.reply('Мероприятие не найдено.');
    return;
  }

  await ctx.reply(
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
    await ctx.reply('Не удалось создать запись.');
    return;
  }

  if (event.registrationClosed || (await freeSeats(event)) <= 0) {
    await ctx.reply('Свободных мест уже нет или регистрация закрыта.');
    return;
  }

  const existing = await store.activeRegistration(user.id, event.id);

  if (existing) {
    await ctx.reply(`Вы уже записаны. Код записи: ${existing.code}`);
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
  await ctx.reply(
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
    await ctx.reply('У вас пока нет записей.', rows([[button('Каталог мероприятий', 'catalog')]]));
    return;
  }

  for (const registration of registrations) {
    const event = await eventById(registration.eventId);

    if (!event) {
      continue;
    }

    await ctx.reply(
      [
        event.title,
        `Код: ${registration.code}`,
        `Статус: ${statusLabels[registration.status]}`,
        `Слот: ${slotLabel(event, registration.slotId)}`,
        `Уведомления: ${registration.notificationsEnabled ? 'включены' : 'отключены'}`
      ].join('\n'),
      rows([
        [
          registration.notificationsEnabled
            ? button('Отключить уведомления', `mute:${registration.id}`, 'negative')
            : button('Включить уведомления', `unmute:${registration.id}`, 'positive')
        ],
        [button('Отменить запись', `cancel:${registration.id}`, 'negative')]
      ])
    );
  }
}

async function cancelRegistration(ctx: AnyContext, registrationId: string) {
  const user = await requireConsent(ctx);
  const registrations = await store.listRegistrations();
  const registration = registrations.find((item) => item.id === registrationId);

  if (!user || !registration || registration.userId !== user.id) {
    await ctx.reply('Запись не найдена.');
    return;
  }

  if (!isActiveStatus(registration.status)) {
    await ctx.reply('Эта запись уже не активна.');
    return;
  }

  const event = await eventById(registration.eventId);

  if (!event) {
    await ctx.reply('Мероприятие не найдено.');
    return;
  }

  const started = Date.now() >= new Date(event.startsAt).getTime();
  const status: RegistrationStatus = started && event.lateCancelAllowed ? 'late_cancelled' : 'cancelled_by_user';

  if (started && !event.lateCancelAllowed) {
    await ctx.reply('Мероприятие уже началось, отмена по правилам этого мероприятия недоступна.');
    return;
  }

  await store.updateRegistration(registration.id, { status });
  await ctx.reply('Запись отменена. Место возвращено в пул доступных.', rows([[button('Каталог мероприятий', 'catalog')]]));
}

async function toggleNotifications(ctx: AnyContext, registrationId: string, enabled: boolean) {
  const user = await requireConsent(ctx);
  const registrations = await store.listRegistrations();
  const registration = registrations.find((item) => item.id === registrationId);

  if (!user || !registration || registration.userId !== user.id) {
    await ctx.reply('Запись не найдена.');
    return;
  }

  await store.updateRegistration(registration.id, { notificationsEnabled: enabled });
  await ctx.reply(enabled ? 'Уведомления по мероприятию включены.' : 'Уведомления по мероприятию отключены.');
}

function canManage(user: StoredUser, event: EventCard): boolean {
  return user.role === 'admin' || event.organizerIds.includes(user.id);
}

async function showOrganizerMenu(ctx: AnyContext) {
  const user = await requireConsent(ctx);

  if (!user || (user.role !== 'admin' && user.role !== 'organizer')) {
    await ctx.reply('Меню организатора доступно только организатору или администратору.');
    return;
  }

  const manageable = await store.listManageableEvents(user.id, user.role);

  if (manageable.length === 0) {
    await ctx.reply('За вами пока не закреплены мероприятия. Добавьте свой MAX ID в ADMIN_MAX_IDS или organizerIds.');
    return;
  }

  await ctx.reply(
    'Ваши мероприятия:',
    rows(manageable.map((event) => [button(event.title, `org:event:${event.id}`)]))
  );
}

async function showOrganizerEvent(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await ctx.reply('Нет доступа к этому мероприятию.');
    return;
  }

  const registrations = await store.listRegistrations(event.id);
  const active = registrations.filter((item) => isActiveStatus(item.status)).length;

  await ctx.reply(
    [
      event.title,
      `Лимит: ${event.capacity}`,
      `Активных записей: ${active}`,
      `Свободно: ${Math.max(event.capacity - active, 0)}`,
      '',
      'Для поиска отправьте: /find КОД'
    ].join('\n'),
    rows([
      [button('Список записей', `org:regs:${event.id}`)],
      [button('Уведомления', `org:notify:${event.id}`)]
    ])
  );
}

async function showOrganizerRegistrations(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await ctx.reply('Нет доступа к этому мероприятию.');
    return;
  }

  const registrations = await store.listRegistrations(event.id);

  if (registrations.length === 0) {
    await ctx.reply('Записей пока нет.');
    return;
  }

  const lines = registrations.slice(0, 20).map((item) => {
    return `${item.code} - ${item.userName} - ${statusLabels[item.status]} - ${slotLabel(event, item.slotId)}`;
  });

  await ctx.reply(['Записи:', ...lines, '', 'Для карточки записи отправьте /find КОД'].join('\n'));
}

async function findRegistration(ctx: AnyContext, code: string) {
  const user = await requireConsent(ctx);
  const registration = await store.findRegistrationByCode(code);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canManage(user, event)) {
    await ctx.reply('Запись не найдена или нет доступа.');
    return;
  }

  await ctx.reply(
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
      [button('Отменить организатором', `org:status:${registration.id}:cancelled_by_organizer`, 'negative')]
    ])
  );
}

async function setOrganizerStatus(ctx: AnyContext, registrationId: string, status: RegistrationStatus) {
  const user = await requireConsent(ctx);
  const registration = (await store.listRegistrations()).find((item) => item.id === registrationId);
  const event = registration ? await eventById(registration.eventId) : undefined;

  if (!user || !registration || !event || !canManage(user, event)) {
    await ctx.reply('Запись не найдена или нет доступа.');
    return;
  }

  const updated = await store.updateRegistration(registration.id, { status });
  await ctx.reply(`Статус записи ${updated?.code ?? registration.code}: ${statusLabels[status]}`);
}

async function showNotifyMenu(ctx: AnyContext, eventId: string) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await ctx.reply('Нет доступа к этому мероприятию.');
    return;
  }

  await ctx.reply(
    'Выберите тип уведомления. Оно уйдет только активным участникам этого мероприятия, у которых уведомления включены.',
    rows([
      [button('За сутки', `org:send:${event.id}:day`)],
      [button('За час', `org:send:${event.id}:hour`)],
      [button('Перенос времени', `org:send:${event.id}:time`)],
      [button('Изменение аудитории', `org:send:${event.id}:room`)],
      [button('Ссылка на подключение', `org:send:${event.id}:link`)]
    ])
  );
}

async function sendEventNotification(ctx: AnyContext, eventId: string, kind: keyof typeof notificationTemplates) {
  const user = await requireConsent(ctx);
  const event = await eventById(eventId);

  if (!user || !event || !canManage(user, event)) {
    await ctx.reply('Нет доступа к этому мероприятию.');
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

  await ctx.reply(`Уведомление отправлено. Получателей: ${recipients.length}.`);
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
  { name: 'find', description: 'Найти запись по коду' },
  { name: 'whoami', description: 'Показать ваш MAX ID' }
]);

bot.on('bot_started', async (ctx) => {
  await rememberUser(ctx);
  await showWelcome(ctx);
});

bot.command('start', async (ctx) => showMainMenu(ctx));
bot.command('events', async (ctx) => showCatalog(ctx));
bot.command('my', async (ctx) => showMyRegistrations(ctx));
bot.command('org', async (ctx) => showOrganizerMenu(ctx));
bot.command('whoami', async (ctx) => {
  const user = await rememberUser(ctx);
  await ctx.reply(user ? `Ваш MAX ID: ${user.id}` : 'Не удалось определить MAX ID.');
});

bot.hears(/^\/find\s+(.+)/i, async (ctx) => {
  await findRegistration(ctx, ctx.match?.[1] ?? '');
});

bot.action(/.*/, async (ctx) => {
  await answerCallback(ctx);
  await rememberUser(ctx);

  const payload = ctx.callback?.payload ?? '';
  const [scope, a, b, c] = payload.split(':');

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
  if (payload === 'my') return showMyRegistrations(ctx);
  if (payload === 'org') return showOrganizerMenu(ctx);
  if (scope === 'event') return showEventDetails(ctx, a);
  if (scope === 'enroll') return startEnrollment(ctx, a);
  if (scope === 'slot') return showEnrollmentSummary(ctx, a, b);
  if (scope === 'confirm') return confirmEnrollment(ctx, a, b);
  if (scope === 'cancel') return cancelRegistration(ctx, a);
  if (scope === 'mute') return toggleNotifications(ctx, a, false);
  if (scope === 'unmute') return toggleNotifications(ctx, a, true);

  if (scope === 'org' && a === 'event') return showOrganizerEvent(ctx, b);
  if (scope === 'org' && a === 'regs') return showOrganizerRegistrations(ctx, b);
  if (scope === 'org' && a === 'notify') return showNotifyMenu(ctx, b);
  if (scope === 'org' && a === 'status') return setOrganizerStatus(ctx, b, c as RegistrationStatus);
  if (scope === 'org' && a === 'send') return sendEventNotification(ctx, b, c as keyof typeof notificationTemplates);

  await ctx.reply('Неизвестное действие. Откройте /start.');
});

bot.on('message_created', async (ctx) => {
  const text = ctx.message.body.text?.trim() ?? '';

  if (text.startsWith('/')) {
    return;
  }

  await showMainMenu(ctx);
});

bot.catch((error) => {
  console.error(error);
});

await bot.start();

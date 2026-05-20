import type { EventCard } from '../shared/types.js';

export const events: EventCard[] = [
  {
    id: 'open-day-it',
    title: 'День открытых дверей ИТ-направлений',
    startsAt: '2026-05-28T15:00:00+03:00',
    durationMinutes: 90,
    format: 'offline',
    capacity: 40,
    organizerIds: [],
    description:
      'Встреча с приемной комиссией и кафедрами: программы, проходные баллы, проектное обучение и вопросы абитуриентов.',
    requirements: 'Возьмите документ, удостоверяющий личность. Для прохода достаточно кода записи.',
    locationOrUrl: 'Главный корпус, аудитория 214',
    cancelPolicy: 'Отмена доступна до начала мероприятия. Поздняя отмена запрещена.',
    registrationClosed: false,
    lateCancelAllowed: false,
    slots: [
      { id: '15-00', label: '15:00-16:30', startsAt: '2026-05-28T15:00:00+03:00' },
      { id: '17-00', label: '17:00-18:30', startsAt: '2026-05-28T17:00:00+03:00' }
    ]
  },
  {
    id: 'campus-tour',
    title: 'Экскурсия по кампусу',
    startsAt: '2026-05-30T12:00:00+03:00',
    durationMinutes: 60,
    format: 'offline',
    capacity: 25,
    organizerIds: [],
    description:
      'Маршрут по учебным корпусам, лабораториям, библиотеке и пространствам для студенческих проектов.',
    requirements: 'Удобная обувь и подтверждение записи с кодом.',
    locationOrUrl: 'Сбор у центрального входа',
    cancelPolicy: 'Отмена доступна до начала мероприятия. Поздняя отмена помечается отдельно.',
    registrationClosed: false,
    lateCancelAllowed: true,
    slots: []
  },
  {
    id: 'online-consulting',
    title: 'Онлайн-консультация по поступлению',
    startsAt: '2026-06-02T18:00:00+03:00',
    durationMinutes: 45,
    format: 'online',
    capacity: 80,
    organizerIds: [],
    description:
      'Короткая консультация о подаче документов, индивидуальных достижениях и сроках приемной кампании.',
    requirements: 'Стабильный интернет и возможность открыть ссылку на подключение.',
    locationOrUrl: 'Ссылка будет отправлена участникам за сутки до начала.',
    cancelPolicy: 'Отмена доступна до начала мероприятия.',
    registrationClosed: false,
    lateCancelAllowed: false,
    slots: []
  }
];

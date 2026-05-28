import { CellSimple, Panel } from '@maxhub/max-ui';
import type { EventCard, University } from '../../types';
import { formatDateTime, universityName } from '../../utils';

type EventListProps = {
  events: EventCard[];
  universities: University[];
  selectedEventId?: string;
  onSelect: (eventId: string) => void;
};

export function EventList({ events, universities, selectedEventId, onSelect }: EventListProps) {
  return (
    <div className="event-list">
      {events.map((event) => (
        <CellSimple
          key={event.id}
          className={event.id === selectedEventId ? 'event-cell event-cell--active' : 'event-cell'}
          title={event.title}
          subtitle={`${universityName(universities, event.universityId)} | ${formatDateTime(event.startsAt)} | ${event.deletedAt ? 'удалено' : 'активно'}`}
          showChevron
          onClick={() => onSelect(event.id)}
        />
      ))}
      {!events.length && <Panel className="empty-state">Для вашей роли пока нет управляемых мероприятий.</Panel>}
    </div>
  );
}

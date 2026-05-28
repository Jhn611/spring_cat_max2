import { Button, Panel } from '@maxhub/max-ui';
import type { EventCard, University } from '../../types';
import { formatDateTime, universityName } from '../../utils';

type EventDetailsProps = {
  event: EventCard;
  universities: University[];
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
};

export function EventDetails({ event, universities, onEdit, onDelete, onRestore }: EventDetailsProps) {
  return (
    <Panel className="panel-block event-detail">
      <div className="section-head">
        <div>
          <h2>{event.title}</h2>
          <p className="muted">
            {universityName(universities, event.universityId)} | {formatDateTime(event.startsAt)}
          </p>
        </div>
        <span className={event.deletedAt ? 'status status--deleted' : 'status'}>{event.deletedAt ? 'Удалено' : 'Активно'}</span>
      </div>
      <p>{event.description}</p>
      <dl className="meta-grid">
        <div>
          <dt>Формат</dt>
          <dd>{event.format === 'online' ? 'Онлайн' : 'Очно'}</dd>
        </div>
        <div>
          <dt>Место</dt>
          <dd>{event.locationOrUrl}</dd>
        </div>
        <div>
          <dt>Мест</dt>
          <dd>{event.capacity}</dd>
        </div>
        <div>
          <dt>Длительность</dt>
          <dd>{event.durationMinutes} мин.</dd>
        </div>
      </dl>
      <div className="chips">{event.slots.map((slot) => <span className="chip" key={slot.id}>{slot.label}</span>)}</div>
      <div className="button-row">
        <Button onClick={onEdit}>Изменить</Button>
        {event.deletedAt ? (
          <Button mode="secondary" onClick={onRestore}>Восстановить</Button>
        ) : (
          <Button mode="secondary" appearance="negative" onClick={onDelete}>Удалить</Button>
        )}
      </div>
    </Panel>
  );
}

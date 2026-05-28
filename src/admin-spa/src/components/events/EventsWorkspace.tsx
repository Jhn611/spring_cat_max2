import { Button, Panel } from '@maxhub/max-ui';
import type { EventCard, EventFormState, EventRegistrar, Registration, StoredUser, University } from '../../types';
import { EventDetails } from './EventDetails';
import { EventForm } from './EventForm';
import { EventList } from './EventList';
import { ParticipantsPanel } from './ParticipantsPanel';
import { RegistrarsPanel } from './RegistrarsPanel';

// Рабочая область мероприятий склеивает список, форму, детали, участников и
// регистраторов. Бизнес-действия приходят через props, поэтому компонент остаётся
// представлением и не знает деталей HTTP-запросов.
type EventsWorkspaceProps = {
  user?: StoredUser;
  universities: University[];
  events: EventCard[];
  selectedEvent?: EventCard;
  selectedEventId?: string;
  registrations: Registration[];
  registrars: EventRegistrar[];
  form?: EventFormState;
  canManageEvents: boolean;
  onSelect: (eventId: string) => void;
  onCreate: () => void;
  onEdit: (event: EventCard) => void;
  onCancelForm: () => void;
  onSubmitForm: (form: EventFormState) => Promise<void>;
  onDelete: (event: EventCard) => Promise<void>;
  onRestore: (event: EventCard) => Promise<void>;
  onAddRegistrar: (eventId: string, registrarId: number) => Promise<void>;
  onRemoveRegistrar: (eventId: string, registrarId: number) => Promise<void>;
  onMarkAttended: (registration: Registration) => Promise<void>;
  onFindCode: (code: string) => Promise<void>;
};

export function EventsWorkspace(props: EventsWorkspaceProps) {
  return (
    <div className="workspace">
      <section className="list-column">
        <div className="section-head">
          <div>
            <h2>Мероприятия</h2>
            <p className="muted">Управляемые события с учетом вашей роли и вуза.</p>
          </div>
          {props.canManageEvents && <Button onClick={props.onCreate}>Создать</Button>}
        </div>
        <EventList events={props.events} universities={props.universities} selectedEventId={props.selectedEventId} onSelect={props.onSelect} />
      </section>

      <section className="detail-column">
        {props.form ? (
          <EventForm universities={props.universities} value={props.form} user={props.user} onCancel={props.onCancelForm} onSubmit={props.onSubmitForm} />
        ) : props.selectedEvent ? (
          <>
            <EventDetails
              event={props.selectedEvent}
              universities={props.universities}
              onEdit={() => props.onEdit(props.selectedEvent!)}
              onDelete={() => props.onDelete(props.selectedEvent!)}
              onRestore={() => props.onRestore(props.selectedEvent!)}
            />
            <div className="detail-grid">
              <RegistrarsPanel eventId={props.selectedEvent.id} registrars={props.registrars} onAdd={props.onAddRegistrar} onRemove={props.onRemoveRegistrar} />
              <ParticipantsPanel registrations={props.registrations} onMarkAttended={props.onMarkAttended} onFindCode={props.onFindCode} />
            </div>
          </>
        ) : (
          <Panel className="empty-state">Выберите мероприятие слева.</Panel>
        )}
      </section>
    </div>
  );
}

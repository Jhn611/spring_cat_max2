import { useState } from 'react';
import { Button, Input, Panel } from '@maxhub/max-ui';
import type { Registration } from '../../types';

// Панель участников нужна регистратору и организатору на месте события: здесь
// виден список записей, поиск по коду и отметка фактического посещения.
type ParticipantsPanelProps = {
  registrations: Registration[];
  onMarkAttended: (registration: Registration) => Promise<void>;
  onFindCode: (code: string) => Promise<void>;
};

export function ParticipantsPanel({ registrations, onMarkAttended, onFindCode }: ParticipantsPanelProps) {
  const [code, setCode] = useState('');

  return (
    <Panel className="panel-block">
      <h3>Участники и посещаемость</h3>
      <div className="button-row">
        <Input value={code} placeholder="Код записи" onChange={(event) => setCode(event.target.value.toUpperCase())} />
        <Button onClick={() => onFindCode(code)} disabled={!code.trim()}>
          Найти
        </Button>
      </div>
      <div className="table-list">
        {registrations.map((registration) => (
          <div className="table-row" key={registration.id}>
            <div>
              <strong>{registration.userName}</strong>
              <span>{registration.code} | {registration.status}</span>
            </div>
            <Button size="small" mode={registration.status === 'attended' ? 'secondary' : 'primary'} disabled={registration.status === 'attended'} onClick={() => onMarkAttended(registration)}>
              {registration.status === 'attended' ? 'Пришел' : 'Отметить'}
            </Button>
          </div>
        ))}
        {!registrations.length && <p className="muted">Записей на мероприятие пока нет.</p>}
      </div>
    </Panel>
  );
}

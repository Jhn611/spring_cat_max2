import { useState } from 'react';
import { Button, Input, Panel } from '@maxhub/max-ui';
import type { EventRegistrar } from '../../types';
import { positiveNumber } from '../../utils';

type RegistrarsPanelProps = {
  eventId: string;
  registrars: EventRegistrar[];
  onAdd: (eventId: string, registrarId: number) => Promise<void>;
  onRemove: (eventId: string, registrarId: number) => Promise<void>;
};

export function RegistrarsPanel({ eventId, registrars, onAdd, onRemove }: RegistrarsPanelProps) {
  const [registrarId, setRegistrarId] = useState('');

  return (
    <Panel className="panel-block">
      <h3>Регистраторы</h3>
      <div className="button-row">
        <Input value={registrarId} inputMode="numeric" placeholder="MAX ID регистратора" onChange={(event) => setRegistrarId(event.target.value)} />
        <Button
          onClick={async () => {
            await onAdd(eventId, Number(registrarId));
            setRegistrarId('');
          }}
          disabled={!positiveNumber(registrarId)}
        >
          Добавить
        </Button>
      </div>
      <div className="chips">
        {registrars.map((item) => (
          <span className="chip" key={item.userId}>
            {item.userId}
            <button type="button" onClick={() => onRemove(eventId, item.userId)} aria-label="Снять регистратора">x</button>
          </span>
        ))}
        {!registrars.length && <span className="muted">Регистраторы не назначены.</span>}
      </div>
    </Panel>
  );
}

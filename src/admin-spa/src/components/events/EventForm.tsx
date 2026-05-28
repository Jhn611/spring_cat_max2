import { useState } from 'react';
import { Button, Input, Panel, Switch, Textarea } from '@maxhub/max-ui';
import type { EventFormat, EventFormState, StoredUser, University } from '../../types';
import { createSlot, isValidEventForm } from '../../utils';

type EventFormProps = {
  universities: University[];
  value: EventFormState;
  user?: StoredUser;
  onCancel: () => void;
  onSubmit: (form: EventFormState) => Promise<void>;
};

export function EventForm({ universities, value, user, onCancel, onSubmit }: EventFormProps) {
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  const availableUniversities = user?.role === 'tech_admin' ? universities : universities.filter((item) => item.id === user?.universityId);

  function update(patch: Partial<EventFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function addSlot() {
    const slot = createSlot(form.date, form.slotStart, form.durationMinutes, form.slots);
    if (!slot) return;
    update({ slots: [...form.slots.filter((item) => item.label !== slot.label), slot] });
  }

  return (
    <Panel className="panel-block">
      <div>
        <p className="eyebrow">{form.id ? 'Редактирование' : 'Создание'}</p>
        <h2>{form.id ? 'Изменение мероприятия' : 'Новое мероприятие'}</h2>
      </div>
      <div className="form-grid">
        <label>
          Вуз
          <select value={form.universityId} onChange={(event) => update({ universityId: event.target.value })}>
            {availableUniversities.map((university) => <option key={university.id} value={university.id}>{university.shortTitle}</option>)}
          </select>
        </label>
        <label>
          Название
          <Input value={form.title} onChange={(event) => update({ title: event.target.value })} />
        </label>
        <label>
          Дата
          <Input type="date" value={form.date} onChange={(event) => update({ date: event.target.value })} />
        </label>
        <label>
          Формат
          <select value={form.format} onChange={(event) => update({ format: event.target.value as EventFormat })}>
            <option value="offline">Очно</option>
            <option value="online">Онлайн</option>
          </select>
        </label>
        <label>
          Мест
          <Input value={form.capacity} inputMode="numeric" onChange={(event) => update({ capacity: event.target.value })} />
        </label>
        <label>
          Длительность слота, мин.
          <Input value={form.durationMinutes} inputMode="numeric" onChange={(event) => update({ durationMinutes: event.target.value })} />
        </label>
      </div>
      <label>
        Описание
        <Textarea value={form.description} onChange={(event) => update({ description: event.target.value })} />
      </label>
      <label>
        Требования
        <Textarea value={form.requirements} onChange={(event) => update({ requirements: event.target.value })} />
      </label>
      <label>
        Место или ссылка
        <Input value={form.locationOrUrl} onChange={(event) => update({ locationOrUrl: event.target.value })} />
      </label>
      <label>
        Правила отмены
        <Input value={form.cancelPolicy} onChange={(event) => update({ cancelPolicy: event.target.value })} />
      </label>
      <div className="toggles">
        <label><Switch checked={form.registrationClosed} onChange={(event) => update({ registrationClosed: event.target.checked })} /> Регистрация закрыта</label>
        <label><Switch checked={form.lateCancelAllowed} onChange={(event) => update({ lateCancelAllowed: event.target.checked })} /> Поздняя отмена</label>
      </div>
      <div className="slot-builder">
        <label>
          Начало слота
          <Input type="time" step={300} value={form.slotStart} onChange={(event) => update({ slotStart: event.target.value })} />
        </label>
        <Button mode="secondary" onClick={addSlot}>Добавить слот</Button>
      </div>
      <div className="chips">
        {form.slots.map((slot) => (
          <span className="chip" key={slot.id}>
            {slot.label}
            <button type="button" aria-label="Удалить слот" onClick={() => update({ slots: form.slots.filter((item) => item.id !== slot.id) })}>x</button>
          </span>
        ))}
      </div>
      <div className="button-row">
        <Button
          loading={busy}
          disabled={!isValidEventForm(form)}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(form);
            } finally {
              setBusy(false);
            }
          }}
        >
          Сохранить
        </Button>
        <Button mode="secondary" onClick={onCancel}>Отмена</Button>
      </div>
    </Panel>
  );
}

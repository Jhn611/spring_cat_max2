import { useEffect, useState } from 'react';
import { Button, Input, Panel } from '@maxhub/max-ui';
import type { api } from '../../api';
import { roleLabels } from '../../constants';
import type { Role, StoredUser, University } from '../../types';
import { positiveNumber } from '../../utils';

type AdminWorkspaceProps = {
  user?: StoredUser;
  universities: University[];
  client: ReturnType<typeof api>;
};

export function AdminWorkspace({ user, universities, client }: AdminWorkspaceProps) {
  const [targetId, setTargetId] = useState('');
  const [role, setRole] = useState<Role>('organizer');
  const [universityId, setUniversityId] = useState(user?.universityId ?? universities[0]?.id ?? '');
  const [users, setUsers] = useState<StoredUser[]>([]);
  const [filterRole, setFilterRole] = useState<Role | ''>('');
  const [message, setMessage] = useState('');

  const allowedRoles: Role[] = user?.role === 'tech_admin' ? ['admin', 'organizer', 'tech_admin', 'applicant'] : ['organizer', 'applicant'];
  const availableUniversities = user?.role === 'tech_admin' ? universities : universities.filter((item) => item.id === user?.universityId);

  async function loadUsers() {
    const result = await client.users(filterRole || undefined, user?.role === 'admin' ? user.universityId : undefined);
    setUsers(result);
  }

  async function saveRole(nextRole = role) {
    await client.setRole(Number(targetId), nextRole, nextRole === 'tech_admin' || nextRole === 'applicant' ? null : universityId);
    setMessage('Права пользователя обновлены.');
    setTargetId('');
    await loadUsers();
  }

  useEffect(() => {
    void loadUsers();
  }, [filterRole, user?.id]);

  return (
    <div className="workspace workspace--admin">
      <Panel className="panel-block access-card">
        <div>
          <p className="eyebrow">Доступы</p>
          <h2>Назначение ролей</h2>
        </div>
        <div className="form-grid form-grid--single">
          <label>
            MAX ID пользователя
            <Input value={targetId} inputMode="numeric" onChange={(event) => setTargetId(event.target.value)} />
          </label>
          <label>
            Роль
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {allowedRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
            </select>
          </label>
          {role !== 'tech_admin' && role !== 'applicant' && (
            <label>
              Вуз
              <select value={universityId} onChange={(event) => setUniversityId(event.target.value)}>
                {availableUniversities.map((university) => <option key={university.id} value={university.id}>{university.shortTitle}</option>)}
              </select>
            </label>
          )}
        </div>
        {message && <div className="notice">{message}</div>}
        <div className="button-row">
          <Button disabled={!positiveNumber(targetId)} onClick={() => saveRole()}>Сохранить роль</Button>
          <Button mode="secondary" disabled={!positiveNumber(targetId)} onClick={() => saveRole('applicant')}>Снять права</Button>
        </div>
      </Panel>

      <Panel className="panel-block">
        <div className="section-head">
          <div>
            <p className="eyebrow">Справочник</p>
            <h2>Пользователи</h2>
            <p className="muted">Для админа список ограничен своим вузом.</p>
          </div>
          <select value={filterRole} onChange={(event) => setFilterRole(event.target.value as Role | '')}>
            <option value="">Все роли</option>
            {(Object.keys(roleLabels) as Role[]).map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
          </select>
        </div>
        <div className="table-list">
          {users.map((item) => (
            <div className="table-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <span>{item.id} | {roleLabels[item.role]} | {item.universityId ?? 'без вуза'}</span>
              </div>
              <Button size="small" mode="secondary" onClick={() => setTargetId(String(item.id))}>Выбрать</Button>
            </div>
          ))}
          {!users.length && <p className="muted">Пользователи по выбранному фильтру не найдены.</p>}
        </div>
      </Panel>
    </div>
  );
}

import { Button } from '@maxhub/max-ui';
import type { ReactNode } from 'react';
import { roleLabels } from '../../constants';
import type { Role, View } from '../../types';

// Общая оболочка держит навигацию, статус сессии и служебные действия панели.
// Внутренние экраны передаются как children, чтобы layout не зависел от их логики.
type AppLayoutProps = {
  role?: Role;
  view: View;
  canAdmin: boolean;
  loading: boolean;
  notice?: string;
  children: ReactNode;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
  onLogout: () => void;
};

export function AppLayout({ role, view, canAdmin, loading, notice, children, onViewChange, onRefresh, onLogout }: AppLayoutProps) {
  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">MAX admin</p>
          <h1>Весенний_код_40</h1>
        </div>

        <nav className="sidebar-nav" aria-label="Разделы панели">
          <button className={view === 'events' ? 'nav-item nav-item--active' : 'nav-item'} type="button" onClick={() => onViewChange('events')}>
            <span>Мероприятия</span>
            <small>События, слоты, участники</small>
          </button>
          {canAdmin && (
            <button className={view === 'admins' ? 'nav-item nav-item--active' : 'nav-item'} type="button" onClick={() => onViewChange('admins')}>
              <span>Роли и доступы</span>
              <small>Админы, организаторы, вузы</small>
            </button>
          )}
        </nav>

        <div className="sidebar-footer">
          <span className="role-pill">{role ? roleLabels[role] : 'Загрузка'}</span>
          <Button mode="secondary" size="small" onClick={onLogout}>
            Выйти
          </Button>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="desktop-toolbar">
          <div>
            <p className="eyebrow">Рабочее место</p>
            <h2>{view === 'events' ? 'Управление мероприятиями' : 'Управление доступами'}</h2>
          </div>
          <Button mode="secondary" onClick={onRefresh} loading={loading}>
            Обновить
          </Button>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {children}
      </main>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@maxhub/max-ui';
import { api } from './api';
import { AdminWorkspace } from './components/admin/AdminWorkspace';
import { LoginScreen } from './components/auth/LoginScreen';
import { EventsWorkspace } from './components/events/EventsWorkspace';
import { AppLayout } from './components/layout/AppLayout';
import { canUseAdminTools, isStaffRole } from './constants';
import type { EventCard, EventFormState, EventRegistrar, Registration, Session, StoredUser, University, View } from './types';
import { defaultUniversityId, emptyEventForm, errorMessage, formFromEvent, loadSession, persistSession, submitEventForm } from './utils';

export function App() {
  const [session, setSession] = useState<Session | undefined>(() => loadSession());
  const [user, setUser] = useState<StoredUser | undefined>();
  const [universities, setUniversities] = useState<University[]>([]);
  const [events, setEvents] = useState<EventCard[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [registrars, setRegistrars] = useState<EventRegistrar[]>([]);
  const [view, setView] = useState<View>('events');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [form, setForm] = useState<EventFormState | undefined>();

  const client = useMemo(() => api(session), [session]);
  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const canAdmin = canUseAdminTools(user?.role);
  const canManageEvents = isStaffRole(user?.role);

  useEffect(() => {
    if (!session) return;
    void refreshAll();
  }, [session]);

  useEffect(() => {
    if (!selectedEvent) {
      setRegistrations([]);
      setRegistrars([]);
      return;
    }
    void refreshEventDetails(selectedEvent.id);
  }, [selectedEventId]);

  async function refreshAll() {
    if (!session) return;
    setLoading(true);
    setNotice(undefined);
    try {
      // The user record is loaded with the reference data because role and
      // university scope define which management actions the UI may expose.
      const [nextUser, nextUniversities, nextEvents] = await Promise.all([
        client.currentUser(session.userId),
        client.universities(),
        client.manageableEvents()
      ]);

      if (!isStaffRole(nextUser.role)) {
        saveSession(undefined);
        setNotice('Панель доступна только организаторам, админам и техадминам.');
        return;
      }

      setUser(nextUser);
      setUniversities(nextUniversities);
      setEvents(nextEvents);
      if (!selectedEventId && nextEvents[0]) setSelectedEventId(nextEvents[0].id);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function refreshEventDetails(eventId: string) {
    try {
      // Participants and registrars are kept separate from the event list so
      // switching cards stays cheap and the detail pane can be refreshed alone.
      const [nextRegistrations, nextRegistrars] = await Promise.all([client.registrations(eventId), client.registrars(eventId)]);
      setRegistrations(nextRegistrations);
      setRegistrars(nextRegistrars);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function saveSession(next: Session | undefined) {
    setSession(next);
    setUser(undefined);
    persistSession(next);
  }

  if (!session) {
    return <LoginScreen onLogin={saveSession} />;
  }

  return (
    <AppLayout
      role={user?.role}
      view={view}
      canAdmin={canAdmin}
      loading={loading}
      notice={notice}
      onViewChange={setView}
      onRefresh={() => void refreshAll()}
      onLogout={() => saveSession(undefined)}
    >
      {loading && (
        <div className="loader">
          <Spinner size={32} />
        </div>
      )}

      {view === 'events' && (
        <EventsWorkspace
          user={user}
          universities={universities}
          events={events}
          selectedEvent={selectedEvent}
          selectedEventId={selectedEventId}
          registrations={registrations}
          registrars={registrars}
          form={form}
          canManageEvents={canManageEvents}
          onSelect={setSelectedEventId}
          onCreate={() => setForm(emptyEventForm(defaultUniversityId(user, universities)))}
          onEdit={(event) => setForm(formFromEvent(event))}
          onCancelForm={() => setForm(undefined)}
          onSubmitForm={async (nextForm) => {
            await submitEventForm(client, nextForm);
            setForm(undefined);
            await refreshAll();
          }}
          onDelete={async (event) => {
            await client.deleteEvent(event.id);
            setNotice('Мероприятие скрыто из публичного каталога.');
            await refreshAll();
          }}
          onRestore={async (event) => {
            await client.restoreEvent(event.id);
            setNotice('Мероприятие восстановлено.');
            await refreshAll();
          }}
          onAddRegistrar={async (eventId, registrarId) => {
            await client.addRegistrar(eventId, registrarId);
            await refreshEventDetails(eventId);
          }}
          onRemoveRegistrar={async (eventId, registrarId) => {
            await client.removeRegistrar(eventId, registrarId);
            await refreshEventDetails(eventId);
          }}
          onMarkAttended={async (registration) => {
            if (!user) return;
            await client.markAttended(registration, user.id);
            await refreshEventDetails(registration.eventId);
          }}
          onFindCode={async (code) => {
            const found = await client.findRegistration(code);
            setRegistrations((items) => [found, ...items.filter((item) => item.id !== found.id)]);
            setNotice(`Запись найдена: ${found.userName}, статус ${found.status}.`);
          }}
        />
      )}

      {view === 'admins' && canAdmin && <AdminWorkspace user={user} universities={universities} client={client} />}
    </AppLayout>
  );
}

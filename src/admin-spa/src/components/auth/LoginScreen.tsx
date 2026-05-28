import { useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Input, Panel } from '@maxhub/max-ui';
import { api } from '../../api';
import { isStaffRole } from '../../constants';
import type { Session } from '../../types';
import { errorMessage } from '../../utils';

type LoginStep = 'login' | 'code' | 'link';

type LoginState = {
  step: LoginStep;
  login: string;
  code: string;
  deeplink?: string;
  message?: string;
};

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [state, setState] = useState<LoginState>({ step: 'login', login: '', code: '' });
  const [loading, setLoading] = useState(false);
  const client = useMemo(() => api(), []);

  async function start() {
    setLoading(true);
    try {
      const result = await client.startLogin(state.login);
      if (result.linked) {
        setState((current) => ({ ...current, step: 'code', message: 'Код отправлен сообщением от бота в MAX. Введите его здесь.' }));
      } else {
        setState((current) => ({
          ...current,
          step: 'link',
          deeplink: result.deeplink,
          message: 'Откройте ссылку или отсканируйте QR. В MAX бот привяжет логин и пришлет код входа.'
        }));
      }
    } catch (error) {
      setState((current) => ({ ...current, message: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setLoading(true);
    try {
      const result = await client.verifyLogin(state.login, state.code);
      const session = { accessToken: result.accessToken, userId: result.userId, login: result.login };
      // The login flow proves MAX identity; the second read checks whether this
      // identity has one of the staff roles allowed to use the management UI.
      const user = await api(session).currentUser(result.userId);

      if (!isStaffRole(user.role)) {
        setState((current) => ({
          ...current,
          message: 'Вход выполнен, но панель доступна только организаторам, админам и техадминам. Назначьте роль через бота или техадмина.'
        }));
        return;
      }

      onLogin(session);
    } catch (error) {
      setState((current) => ({ ...current, message: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-hero">
        <p className="eyebrow">Вход без пароля</p>
        <h1>Панель управления мероприятиями</h1>
        <p>
          Личность подтверждается через MAX: панель получает короткоживущий JWT только после одноразового кода от бота.
        </p>
      </section>

      <Panel className="login-panel">
        <div>
          <p className="eyebrow">Шаг {state.step === 'login' ? '1' : '2'}</p>
          <h2>{state.step === 'login' ? 'Введите логин' : 'Подтвердите код'}</h2>
        </div>
        <label className="field-label">
          Логин
          <Input value={state.login} placeholder="ivanov.admin" onChange={(event) => setState({ ...state, login: event.target.value })} />
        </label>
        {state.step !== 'login' && (
          <label className="field-label">
            Код из MAX
            <Input value={state.code} inputMode="numeric" placeholder="123456" onChange={(event) => setState({ ...state, code: event.target.value })} />
          </label>
        )}
        {state.step === 'link' && state.deeplink && (
          <div className="qr-box">
            <QRCodeSVG value={state.deeplink} size={180} />
            <Button asChild stretched>
              <a href={state.deeplink} target="_blank" rel="noreferrer">
                Открыть бота в MAX
              </a>
            </Button>
            <p className="helper-text">
              Если MAX открылся без перехода в чат, напишите боту вручную: <strong>/login {state.login}</strong>
            </p>
          </div>
        )}
        {state.message && <div className="notice">{state.message}</div>}
        <div className="button-row">
          <Button onClick={state.step === 'login' ? start : verify} loading={loading} disabled={!state.login.trim() || (state.step !== 'login' && !state.code.trim())}>
            {state.step === 'login' ? 'Получить код' : 'Войти'}
          </Button>
          {state.step !== 'login' && (
            <Button mode="secondary" onClick={() => setState({ step: 'login', login: state.login, code: '' })}>
              Назад
            </Button>
          )}
        </div>
      </Panel>
    </main>
  );
}

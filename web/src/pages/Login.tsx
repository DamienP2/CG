import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { Brand } from '../ui/Brand';
import { useState } from 'react';
import { ApiError, useApp } from '../store';
import { LANGS, pickLang, t, useLang } from '../i18n';

/** Login, or creation of the first admin account on a fresh install. */
export function Login() {
  const { auth, login, setup } = useApp();
  const firstRun = !!auth?.needsSetup;
  const [username, setUsername] = useState(firstRun ? 'admin' : '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Back from the directory with a refusal: its reason.
  const [error, setError] = useState(() => {
    const q = new URLSearchParams(location.search);
    const e = q.get('sso_error');
    if (!e) return '';
    history.replaceState(null, '', location.pathname);
    const why: Record<string, string> = {
      noGroup: t('None of your directory groups gives access to Strata.'),
      disabled: t('This account is disabled.'),
      expired: t('The sign-in took too long: try again.'),
    };
    return why[e] ?? `${t('The directory refused the sign-in:')} ${q.get('sso_detail') ?? ''}`;
  });
  const sso = !firstRun ? auth?.sso : null;
  const here = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const passwords = !sso || auth?.localAccounts !== 'none' || here;
  const [busy, setBusy] = useState(false);
  const lang = useLang((s) => s.lang);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (firstRun && password !== confirm) return setError(t('The passwords do not match.'));
    setBusy(true);
    try {
      if (firstRun) await setup(username.trim(), password, displayName.trim());
      else await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('Wrong user name or password.') : err instanceof ApiError && err.status === 429 ? t('Too many tries: wait a moment, then try again.') : err instanceof ApiError && err.status === 403 && auth?.sso ? t('Sign in with {name}', { name: auth.sso }) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="lang-switch login-lang" role="group" aria-label={t('Language')}>
        {LANGS.map((l) => (
          <button type="button" key={l.id} className={lang === l.id ? 'on' : ''} title={l.name} onClick={() => pickLang(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <Brand stacked />
          {/* The server's own name, when it has one other than the product's. */}
          {auth?.serverName && auth.serverName !== 'Strata' && <p className="muted">{auth.serverName}</p>}
        </div>
        {sso && (
          <>
            <a className="btn primary block sso-btn" href={`/api/auth/sso/start?next=${encodeURIComponent(location.pathname + location.search)}`}>
              <KeyRound size={15} /> {t('Sign in with {name}', { name: sso })}
            </a>
            {passwords && <div className="login-sep">{t('local account')}</div>}
          </>
        )}
        {firstRun ? (
          <div className="login-intro">
            <ShieldCheck size={16} />
            <span>{t('Welcome! Create the administrator account. You can add designers and operators afterwards.')}</span>
          </div>
        ) : null}
        {passwords && (
          <>
            <label className="set-field">
              <span className="set-label">{t('User name')}</span>
              <input autoFocus value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
            </label>
            {firstRun && (
              <label className="set-field">
                <span className="set-label">{t('Display name')}</span>
                <input value={displayName} placeholder={t('Optional')} onChange={(e) => setDisplayName(e.target.value)} />
              </label>
            )}
            <label className="set-field">
              <span className="set-label">{t('Password')}</span>
              <input type="password" value={password} autoComplete={firstRun ? 'new-password' : 'current-password'} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {firstRun && (
              <label className="set-field">
                <span className="set-label">{t('Repeat password')}</span>
                <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
                <span className="set-hint">{t('At least 8 characters.')}</span>
              </label>
            )}
            <button className={`btn block ${sso ? '' : 'primary'}`} disabled={busy || !username || !password}>
              <LogIn size={15} /> {firstRun ? t('Create the admin account') : t('Sign in')}
            </button>
          </>
        )}
        {error && <div className="login-error">{error}</div>}
        {firstRun && (
          <p className="set-hint">
            {t('For security this page only works on the server itself (http://localhost). Remotely, run this on the server:')} <code>strata-server user add admin</code>
          </p>
        )}
      </form>
    </div>
  );
}

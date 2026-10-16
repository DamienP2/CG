import { Clapperboard, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ApiError, useApp } from '../store';

/** Login, or creation of the first admin account on a fresh install. */
export function Login() {
  const { auth, login, setup } = useApp();
  const firstRun = !!auth?.needsSetup;
  const [username, setUsername] = useState(firstRun ? 'admin' : '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (firstRun && password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      if (firstRun) await setup(username.trim(), password, displayName.trim());
      else await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong user name or password.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand big">
          <Clapperboard size={26} />
          <span>Pulse</span>
          <em>CG</em>
        </div>
        <p className="muted">{auth?.serverName}</p>
        {firstRun ? (
          <div className="login-intro">
            <ShieldCheck size={16} />
            <span>Welcome! Create the administrator account. You can add designers and operators afterwards.</span>
          </div>
        ) : null}
        <label className="set-field">
          <span className="set-label">User name</span>
          <input autoFocus value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </label>
        {firstRun && (
          <label className="set-field">
            <span className="set-label">Display name</span>
            <input value={displayName} placeholder="Optional" onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label className="set-field">
          <span className="set-label">Password</span>
          <input type="password" value={password} autoComplete={firstRun ? 'new-password' : 'current-password'} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {firstRun && (
          <label className="set-field">
            <span className="set-label">Repeat password</span>
            <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
            <span className="set-hint">At least 8 characters.</span>
          </label>
        )}
        {error && <div className="login-error">{error}</div>}
        <button className="btn primary block" disabled={busy || !username || !password}>
          <LogIn size={15} /> {firstRun ? 'Create the admin account' : 'Sign in'}
        </button>
        {firstRun && <p className="set-hint">For security this page only works on the server itself (http://localhost). Remotely, run <code>cg-server user add admin</code> on the server.</p>}
      </form>
    </div>
  );
}

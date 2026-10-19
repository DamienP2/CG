import { CloudDownload, History, KeyRound, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';

interface Release {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  assetName: string;
  size: number;
}

interface UpdateInfo {
  current: string;
  platform: string;
  repo: string;
  hasToken: boolean;
  autoCheck: boolean;
  previous: string | null;
  history: { from: string; to: string; at: number; outcome: string } | null;
  supervised: boolean;
  status: {
    phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'error';
    progress: number;
    message: string;
    latest: Release | null;
    lastCheck: number | null;
  };
}

const key = (v: string) => v.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
export const isNewer = (a: string, b: string) => {
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleDateString();
};

/** Over-the-air updates: GitHub releases or an uploaded package, with rollback. */
export function Updates({ Card }: { Card: (p: { icon: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) => React.ReactElement }) {
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [allowOlder, setAllowOlder] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<UpdateInfo>('GET', '/api/system/update')
      .then((i) => {
        setInfo(i);
        setRepo((r) => r || i.repo);
      })
      .catch(() => {});
  useEffect(() => void load(), []);

  // Poll while something is going on.
  const busy = info && ['checking', 'downloading', 'installing', 'restarting'].includes(info.status.phase);
  useEffect(() => {
    if (!busy || waiting) return;
    const h = setInterval(load, 700);
    return () => clearInterval(h);
  }, [busy, waiting]);

  // After an install or a rollback: wait for the server to come back, then
  // reload so the web app matches the new version.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const h = setInterval(async () => {
      try {
        const r = await fetch('/api/health');
        const v = ((await r.json()) as { version: string }).version;
        if (v !== waiting) {
          clearInterval(h);
          toast(`Strata ${v} is running`, 'info');
          setTimeout(() => location.reload(), 600);
        }
      } catch {
        /* restarting */
      }
      if (Date.now() - started > 120_000) {
        clearInterval(h);
        setWaiting(null);
        toast('The server did not come back within 2 minutes: check its logs.', 'error');
      }
    }, 1000);
    return () => clearInterval(h);
  }, [waiting]);

  if (!info) return null;
  const { status } = info;
  const latest = status.latest;
  const newer = latest && isNewer(latest.version, info.current);
  const restartNote = 'The engine restarts: graphics on air are cleared and outputs stop for a few seconds.';

  const check = async () => {
    try {
      await api('POST', '/api/system/update/check');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    load();
  };
  const install = async () => {
    if (!latest || !(await confirmDialog({ title: `Install Strata ${latest.version}?`, message: restartNote, confirm: 'Install' }))) return;
    await api('POST', '/api/system/update/install').catch((e) => toast((e as Error).message, 'error'));
    load();
    // The status poll turns into the "waiting for restart" poll.
    const h = setInterval(async () => {
      const i = await api<UpdateInfo>('GET', '/api/system/update').catch(() => null);
      if (!i || i.status.phase === 'restarting') {
        clearInterval(h);
        setWaiting(info.current);
      } else if (i.status.phase === 'error') {
        clearInterval(h);
        setInfo(i);
      } else setInfo(i);
    }, 700);
  };
  const upload = async (file: File) => {
    if (!(await confirmDialog({ title: `Install the package “${file.name}”?`, message: restartNote, confirm: 'Install' }))) return;
    try {
      const res = await fetch(`/api/system/update/upload?allowOlder=${allowOlder}`, { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      const { version } = (await res.json()) as { version: string };
      toast(`Installing ${version}…`, 'info');
      setWaiting(info.current);
    } catch (e) {
      toast((e as Error).message, 'error');
      load();
    }
  };
  const rollback = async () => {
    if (!info.previous || !(await confirmDialog({ title: `Go back to version ${info.previous}?`, message: restartNote, confirm: 'Roll back', danger: true }))) return;
    try {
      await api('POST', '/api/system/update/rollback');
      setWaiting(info.current);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const saveSettings = async (patch: { token?: string | null; autoCheck?: boolean }) => {
    try {
      await api('PUT', '/api/system/update/settings', { repo, autoCheck: patch.autoCheck ?? info.autoCheck, token: patch.token ?? null });
      setToken('');
      toast('Update settings saved', 'info');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Card
      icon={<CloudDownload size={16} />}
      title="Updates"
      actions={
        <button className="btn small" disabled={!!busy || !!waiting} onClick={check}>
          <RefreshCw size={13} /> Check now
        </button>
      }
    >
      <div className="update-head">
        <div>
          <span className="set-label">Installed</span>
          <strong className="update-version">{info.current}</strong>
          <span className="muted small">{info.platform}</span>
        </div>
        <div className="update-latest">
          {waiting ? (
            <span className="update-busy">
              <RefreshCw size={14} className="spin" /> Restarting on the new version…
            </span>
          ) : busy ? (
            <span className="update-busy">
              <RefreshCw size={14} className="spin" /> {status.message || status.phase}
              {status.phase === 'downloading' && <progress max={1} value={status.progress} />}
            </span>
          ) : status.phase === 'error' ? (
            <span className="update-error">{status.message}</span>
          ) : latest ? (
            newer ? (
              <>
                <span>
                  Version <strong>{latest.version}</strong> is available{latest.publishedAt && ` (${new Date(latest.publishedAt).toLocaleDateString()})`}.
                </span>
                <button className="btn primary" onClick={install}>
                  <CloudDownload size={14} /> Install {latest.version}
                </button>
              </>
            ) : (
              <span className="muted">Up to date — latest release {latest.version}{status.lastCheck ? `, checked ${ago(status.lastCheck)}` : ''}.</span>
            )
          ) : (
            <span className="muted">Not checked yet.</span>
          )}
        </div>
      </div>
      {newer && latest?.notes && !waiting && (
        <details className="update-notes">
          <summary>What's new in {latest.version}</summary>
          <pre>{latest.notes}</pre>
        </details>
      )}
      {info.history && (
        <p className="hint">
          <History size={12} /> {info.history.outcome === 'restored automatically' ? `Version ${info.history.from} failed to start: ${info.history.to} was restored automatically` : `${info.history.from} → ${info.history.to} (${info.history.outcome})`}, {ago(info.history.at)}.
        </p>
      )}

      <div className="set-grid">
        <label className="set-field">
          <span className="set-label">GitHub repository</span>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} onBlur={() => repo !== info.repo && saveSettings({})} placeholder="owner/name" />
          <span className="set-hint">Releases are downloaded from here.</span>
        </label>
        <label className="set-field">
          <span className="set-label">Access token {info.hasToken && <span className="badge">saved</span>}</span>
          <div className="row">
            <input type="password" value={token} placeholder={info.hasToken ? '••••••••  (leave empty to keep)' : 'github_pat_…'} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
            <button className="btn small" disabled={!token} onClick={() => saveSettings({ token })} title="Save the token">
              <KeyRound size={13} />
            </button>
            {info.hasToken && (
              <button className="btn small" onClick={() => saveSettings({ token: '' })} title="Remove the token">
                ✕
              </button>
            )}
          </div>
          <span className="set-hint">Private repository: a fine-grained token with read-only “Contents” on it. Kept on the server, never shown again.</span>
        </label>
        <label className="set-field">
          <span className="set-label">Automatic check</span>
          <label className="check">
            <input type="checkbox" checked={info.autoCheck} onChange={(e) => saveSettings({ autoCheck: e.target.checked })} />
            Look for new versions every 6 hours
          </label>
          <span className="set-hint">Installing always stays a manual decision.</span>
        </label>
      </div>

      <div className="update-offline">
        <div>
          <strong>Offline update</strong>
          <span className="muted small">
            Upload the <code>pulse-cg-&lt;version&gt;-{info.platform}</code> archive from the release page — for servers without internet access.
          </span>
        </div>
        <label className="check small">
          <input type="checkbox" checked={allowOlder} onChange={(e) => setAllowOlder(e.target.checked)} />
          Allow older versions
        </label>
        <button className="btn" disabled={!!busy || !!waiting} onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Upload package
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.tgz,.zip,application/gzip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) upload(f);
          }}
        />
        {info.previous && (
          <button className="btn" disabled={!!busy || !!waiting} onClick={rollback} title="Put the previously installed version back">
            <RotateCcw size={14} /> Back to {info.previous}
          </button>
        )}
      </div>
      {!info.supervised && <p className="hint">This server runs in the foreground: it relaunches itself after an update.</p>}
    </Card>
  );
}

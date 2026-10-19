import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { User } from '../engine/types';
import { api, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';

interface ApiKey {
  id: string;
  name: string;
  userId: string;
  prefix: string;
  createdAt: number;
  lastUsed: number | null;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

/** Permanent keys for automation; the secret is shown once. */
export function ApiKeys({ users }: { users: User[] }) {
  const { auth, toast } = useApp();
  const me = auth?.user;
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [owner, setOwner] = useState(me?.id ?? '');
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const load = () => api<ApiKey[]>('GET', '/api/keys').then(setKeys).catch(() => {});
  useEffect(() => void load(), []);
  const userName = (id: string) => users.find((u) => u.id === id)?.username ?? id;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ key: ApiKey; secret: string }>('POST', '/api/keys', { name, userId: owner || undefined });
      setSecret({ name: r.key.name, value: r.secret });
      setName('');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <section className="set-card">
      <header>
        <KeyRound size={16} />
        <h2>API keys</h2>
        <div className="spacer" />
        <a className="btn small" href="/premiere/strata-premiere.zip" title="The Premiere Pro panel, set to this server (it updates itself from it)">
          Premiere panel
        </a>
        <a className="btn small" href="/api-docs">
          API documentation
        </a>
      </header>
      <div className="set-body">
        <p className="hint">
          For automation (Companion / Stream Deck, newsroom systems, scripts): send <code>Authorization: Bearer pcg_…</code>. A key acts with the rights of its user — create a dedicated operator account scoped to
          the right channels for each system.
        </p>
        {secret && (
          <div className="key-secret">
            <strong>Key “{secret.name}” created — copy it now, it will not be shown again:</strong>
            <div className="row">
              <code>{secret.value}</code>
              <button
                className="btn small"
                onClick={() => {
                  navigator.clipboard?.writeText(secret.value);
                  toast('Copied', 'info');
                }}
              >
                <Copy size={13} /> Copy
              </button>
              <button className="btn small" onClick={() => setSecret(null)}>
                Done
              </button>
            </div>
          </div>
        )}
        <form className="row key-form" onSubmit={create}>
          <input value={name} placeholder="What uses it — e.g. Companion régie A" onChange={(e) => setName(e.target.value)} />
          <select value={owner} onChange={(e) => setOwner(e.target.value)} title="The key acts as this user">
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                as {u.username} ({u.role})
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!name.trim()}>
            <Plus size={14} /> Create key
          </button>
        </form>
        <table className="user-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Acts as</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                </td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>{userName(k.userId)}</td>
                <td className="muted">{when(k.createdAt)}</td>
                <td className="muted">{when(k.lastUsed)}</td>
                <td className="row-actions">
                  <button
                    className="icon-btn ghost"
                    title="Revoke"
                    onClick={async () => {
                      if (!(await confirmDialog({ title: `Revoke the key “${k.name}”?`, message: 'Systems using it stop working at once.', confirm: 'Revoke', danger: true }))) return;
                      await api('DELETE', `/api/keys/${encodeURIComponent(k.id)}`).catch((e) => toast((e as Error).message, 'error'));
                      load();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No API key yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

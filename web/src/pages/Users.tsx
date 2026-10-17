import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Role, User } from '../engine/types';
import { api, useApp } from '../store';
import { ApiKeys } from './ApiKeys';
import { confirmDialog } from '../ui/dialogs';

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: 'admin', label: 'Admin', hint: 'Everything: users, channels, server settings.' },
  { value: 'designer', label: 'Designer', hint: 'Creates projects and templates; can also operate.' },
  { value: 'operator', label: 'Operator', hint: 'Loads projects on channels, plays graphics, edits rundown data.' },
  { value: 'viewer', label: 'Viewer', hint: 'Read-only: sees projects and program monitors.' },
];

type Draft = Omit<User, 'id'> & { id?: string; password: string };

const blank = (): Draft => ({ username: '', displayName: '', role: 'operator', projects: null, channels: null, disabled: false, password: '' });

/** "All" or a subset of ids. */
function Scope({ label, all, value, onChange }: { label: string; all: { id: string; name: string }[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  return (
    <div className="set-field">
      <span className="set-label">{label}</span>
      <label className="check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [])} />
        All, including future ones
      </label>
      {value !== null && (
        <div className="scope-list">
          {all.map((x) => (
            <label key={x.id} className="check">
              <input type="checkbox" checked={value.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((v) => v !== x.id))} />
              {x.name}
            </label>
          ))}
          {all.length === 0 && <span className="muted">None yet.</span>}
        </div>
      )}
    </div>
  );
}

function UserDialog({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: () => void }) {
  const { projects, channels, toast } = useApp();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const isNew = !initial.id;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isNew) await api('POST', '/api/users', d);
      else await api('PUT', `/api/users/${encodeURIComponent(initial.id!)}`, d);
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const scoped = d.role !== 'admin';
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <form className="modal wide" onSubmit={save} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{isNew ? 'New user' : `Edit ${initial.username}`}</h2>
          <button type="button" className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="set-grid two">
          <label className="set-field">
            <span className="set-label">User name</span>
            <input autoFocus value={d.username} autoComplete="off" onChange={(e) => setD({ ...d, username: e.target.value })} />
          </label>
          <label className="set-field">
            <span className="set-label">Display name</span>
            <input value={d.displayName} onChange={(e) => setD({ ...d, displayName: e.target.value })} />
          </label>
          <label className="set-field">
            <span className="set-label">{isNew ? 'Password' : 'New password'}</span>
            <input type="password" value={d.password} autoComplete="new-password" placeholder={isNew ? 'At least 8 characters' : 'Leave empty to keep it'} onChange={(e) => setD({ ...d, password: e.target.value })} />
          </label>
          <label className="set-field">
            <span className="set-label">Status</span>
            <label className="check">
              <input type="checkbox" checked={d.disabled} onChange={(e) => setD({ ...d, disabled: e.target.checked })} />
              Account disabled
            </label>
          </label>
        </div>
        <div className="set-field">
          <span className="set-label">Role</span>
          <div className="role-pick">
            {ROLES.map((r) => (
              <button type="button" key={r.value} className={d.role === r.value ? 'on' : ''} onClick={() => setD({ ...d, role: r.value })}>
                <strong>{r.label}</strong>
                <span>{r.hint}</span>
              </button>
            ))}
          </div>
        </div>
        {scoped && (
          <div className="set-grid two">
            <Scope label="Projects" all={projects} value={d.projects} onChange={(v) => setD({ ...d, projects: v })} />
            <Scope label="Channels" all={channels} value={d.channels} onChange={(v) => setD({ ...d, channels: v })} />
          </div>
        )}
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !d.username.trim() || (isNew && d.password.length < 8)}>
            {isNew ? <Plus size={14} /> : <KeyRound size={14} />} {isNew ? 'Create user' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function Users() {
  const { auth, projects, channels, toast } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const load = () => api<User[]>('GET', '/api/users').then(setUsers).catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => void load(), []);

  const scope = (ids: string[] | null, all: { id: string; name: string }[]) =>
    ids === null ? 'All' : ids.length === 0 ? 'None' : ids.map((id) => all.find((x) => x.id === id)?.name ?? id).join(', ');

  return (
    <div className="library">
      <div className="library-inner">
        <div className="settings-head">
          <div>
            <h1>Users & rights</h1>
            <p className="muted">Roles decide what people can do; project and channel scopes decide where.</p>
          </div>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setEditing(blank())}>
            <Plus size={14} /> New user
          </button>
        </div>
        <table className="user-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Projects</th>
              <th>Channels</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'dim' : ''}>
                <td>
                  <div className="user-cell">
                    {u.role === 'admin' ? <ShieldCheck size={16} /> : <UserRound size={16} />}
                    <div>
                      <strong>{u.displayName}</strong>
                      <span className="muted">
                        {u.username}
                        {u.id === auth?.user?.id ? ' · you' : ''}
                        {u.disabled ? ' · disabled' : ''}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`badge role-${u.role}`}>{u.role}</span>
                </td>
                <td className="muted">{u.role === 'admin' ? 'All' : scope(u.projects, projects)}</td>
                <td className="muted">{u.role === 'admin' ? 'All' : scope(u.channels, channels)}</td>
                <td className="row-actions">
                  <button className="icon-btn ghost" title="Edit" onClick={() => setEditing({ ...u, password: '' })}>
                    <Pencil size={14} />
                  </button>
                  {u.id !== auth?.user?.id && (
                    <button
                      className="icon-btn ghost"
                      title="Delete"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: `Delete the user “${u.username}”?`, confirm: 'Delete', danger: true }))) return;
                        await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`).catch((e) => toast((e as Error).message, 'error'));
                        load();
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ApiKeys users={users} />
      </div>
      {editing && <UserDialog initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

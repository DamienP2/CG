import { Newspaper } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, useApp } from '../store';

export interface MosConfig {
  enabled: boolean;
  mosId: string;
  ncsId: string;
  lowerPort: number;
  upperPort: number;
  projectId: string;
}

interface MosStatus {
  listening: boolean;
  error: string | null;
  connections: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
  runningOrders: { id: string; slug: string; projectId: string; stories: number; items: number }[];
}

type CardT = (p: { icon: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) => React.ReactElement;
type FieldT = (p: { label: string; hint?: string; children: React.ReactNode }) => React.ReactElement;

/** Newsroom system connection (MOS 2.8: Saga, iNews, ENPS, Octopus…). */
export function MosCard({ mos, onChange, Card, Field }: { mos: MosConfig; onChange: (m: MosConfig) => void; Card: CardT; Field: FieldT }) {
  const projects = useApp((s) => s.projects);
  const [status, setStatus] = useState<MosStatus | null>(null);
  useEffect(() => {
    const load = () => api<MosStatus>('GET', '/api/mos/status').then(setStatus).catch(() => {});
    load();
    const h = setInterval(load, 3000);
    return () => clearInterval(h);
  }, []);
  const set = (patch: Partial<MosConfig>) => onChange({ ...mos, ...patch });
  const base = `${location.protocol}//${location.host}`;
  return (
    <Card
      icon={<Newspaper size={16} />}
      title="Newsroom (MOS)"
      actions={
        status && mos.enabled ? (
          <span className={`badge ${status.listening ? '' : 'warn'}`}>
            {status.listening ? `listening · ${status.connections} connection(s)` : status.error ?? 'not listening'}
          </span>
        ) : undefined
      }
    >
      <p className="hint">
        Saga (Fonn Group), iNews, ENPS, Octopus… send their running orders to Strata over MOS 2.8. Each running order becomes a playlist of the project, with one item per graphic placed by the journalists
        with the plugin.
      </p>
      <div className="set-grid">
        <Field label="MOS device">
          <label className="check">
            <input type="checkbox" checked={mos.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            Accept newsroom connections
          </label>
        </Field>
        <Field label="MOS ID" hint="Declare the same ID in the newsroom system.">
          <input value={mos.mosId} onChange={(e) => set({ mosId: e.target.value })} />
        </Field>
        <Field label="NCS ID" hint="Newsroom system ID (informational).">
          <input value={mos.ncsId} placeholder="SAGA" onChange={(e) => set({ ncsId: e.target.value })} />
        </Field>
        <Field label="Lower port" hint="Profiles 0–1 (objects).">
          <input type="number" value={mos.lowerPort} onChange={(e) => set({ lowerPort: +e.target.value })} />
        </Field>
        <Field label="Upper port" hint="Profile 2 (running orders).">
          <input type="number" value={mos.upperPort} onChange={(e) => set({ upperPort: +e.target.value })} />
        </Field>
        <Field label="Project" hint="Receives the running orders. Automatic: the project of the graphics.">
          <select value={mos.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">Automatic</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mos-plugin-url">
        <strong>HTML5 plugin for the journalists</strong>
        <code>{base}/mos/plugin?key=pcg_…</code>
        <span className="set-hint">
          Register this URL as an HTML5 MOS plugin in the newsroom system, with the API key of an operator account (Users → API keys) restricted to the right projects.
        </span>
      </div>
      {status && status.runningOrders.length > 0 && (
        <table className="user-table">
          <thead>
            <tr>
              <th>Running order</th>
              <th>Project</th>
              <th>Stories</th>
              <th>Items</th>
            </tr>
          </thead>
          <tbody>
            {status.runningOrders.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.slug || r.id}</strong> <span className="muted">{r.id}</span>
                </td>
                <td>{projects.find((p) => p.id === r.projectId)?.name ?? r.projectId}</td>
                <td>{r.stories}</td>
                <td>{r.items}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {status?.lastMessage && (
        <p className="hint">
          Last message: <code>{status.lastMessage}</code> {status.lastMessageAt && new Date(status.lastMessageAt).toLocaleTimeString()}
        </p>
      )}
    </Card>
  );
}

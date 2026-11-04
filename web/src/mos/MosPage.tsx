import { Dropdown } from '../ui/Dropdown';
import { NumberField } from '../ui/fields';
import { friendlyError } from '../ui/serverError';
import { Cable, Copy, KeyRound, ListOrdered, Newspaper, Plug, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t, tn } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { navigate } from '../router';
import { Card, Field, SaveBar } from '../settings/ui';
import { useServerConfig } from '../settings/serverConfig';
import { api, useApp } from '../store';
import '../hardware/hardware.css';

export interface MosConfig {
  enabled: boolean;
  mosId: string;
  ncsId: string;
  lowerPort: number;
  upperPort: number;
  projectId: string;
  ncsHost: string;
  ncsPort: number;
}

interface MosStatus {
  listening: boolean;
  error: string | null;
  connections: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
  runningOrders: { id: string; slug: string; projectId: string; stories: number; items: number }[];
  report: { on: boolean; connected: boolean; error: string | null; sent: number; last: string | null; lastAt: number | null };
}

type Section = 'connection' | 'orders' | 'plugin';

/** Newsroom systems (MOS 2.8: Saga, iNews, ENPS, Octopus…). */
export function MosPage() {
  const { projects, toast } = useApp();
  const { cfg, edit, dirty, saving, save, discard } = useServerConfig('mos');
  const [status, setStatus] = useState<MosStatus | null>(null);
  const [section, setSection] = useState<Section>('connection');
  useEffect(() => {
    const load = () => api<MosStatus>('GET', '/api/mos/status').then(setStatus).catch(() => {});
    load();
    const h = setInterval(() => document.hidden || void load(), 3000);
    return () => clearInterval(h);
  }, []);
  if (!cfg) return <div className="loading">{t('Loading…')}</div>;

  const mos = cfg.mos;
  const set = (patch: Partial<MosConfig>) => edit((c) => void (c.mos = { ...c.mos, ...patch }));
  const base = `${location.protocol}//${location.host}`;
  const plugin = `${base}/mos/plugin?key=pcg_…`;
  const state: 'ok' | 'warn' | 'off' = !mos.enabled ? 'off' : status?.listening ? 'ok' : 'warn';
  const stateText = !mos.enabled ? t('Off') : status?.listening ? tn(status.connections, 'Listening · {n} connection', 'Listening · {n} connections') : (status?.error ? friendlyError(status.error) : t('Not listening'));
  const orders = status?.runningOrders ?? [];

  const item = (s: Section, icon: React.ReactNode, label: string, extra?: Partial<React.ComponentProps<typeof NavItem>>) => <NavItem on={section === s} icon={icon} label={label} onClick={() => setSection(s)} {...extra} />;
  const nav = (
    <>
      <NavSection>{t('Newsroom')}</NavSection>
      {item('connection', <Cable size={15} />, t('Connection'), { status: state })}
      {item('orders', <ListOrdered size={15} />, t('Running orders'), { count: orders.length })}
      {item('plugin', <Plug size={15} />, t('Journalist plugin'))}
    </>
  );

  return (
    <SidePage nav={nav}>
      <PageHead title={t('Newsroom (MOS)')} sub={stateText}>
        <span className={`mos-state ${state}`}>
          <span className={`nav-dot ${state}`} /> {!mos.enabled ? t('Off') : !status?.listening ? t('Not listening') : status.connections ? t('Connected') : t('Listening')}
        </span>
      </PageHead>

      {section === 'connection' && (
        <>
          <Card icon={<Newspaper size={16} />} title={t('MOS device')}>
            <div className="set-grid">
              <Field label={t('Connections')}>
                <label className="check">
                  <input type="checkbox" checked={mos.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                  {t('Accept newsroom connections')}
                </label>
              </Field>
              <Field label={t('MOS ID')}>
                <input value={mos.mosId} onChange={(e) => set({ mosId: e.target.value })} />
              </Field>
              <Field label={t('NCS ID')}>
                <input value={mos.ncsId} placeholder="SAGA" onChange={(e) => set({ ncsId: e.target.value })} />
              </Field>
              <Field label={t('Lower port')}>
                <NumberField value={mos.lowerPort} min={1} max={65535} onChange={(v) => set({ lowerPort: Math.round(v) })} />
              </Field>
              <Field label={t('Upper port')}>
                <NumberField value={mos.upperPort} min={1} max={65535} onChange={(v) => set({ upperPort: Math.round(v) })} />
              </Field>
              <Field label={t('Project')}>
                <Dropdown value={mos.projectId} className="fio-pick" title={t('Project')} options={[{ value: '', label: t('Automatic') }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ projectId: v })} />
              </Field>
            </div>
          </Card>
          <Card icon={<Radio size={16} />} title={t('State sent to the newsroom')}>
            <div className="set-grid">
              <Field label={t('Newsroom system address')}>
                <input value={mos.ncsHost ?? ''} placeholder="10.0.0.20" onChange={(e) => set({ ncsHost: e.target.value })} />
              </Field>
              <Field label={t('Port')}>
                <NumberField value={mos.ncsPort ?? 10541} min={1} max={65535} onChange={(v) => set({ ncsPort: Math.round(v) })} />
              </Field>
            </div>
            {mos.enabled && !!mos.ncsHost && status?.report && (
              <p className="hint">
                <span className={`nav-dot ${status.report.error ? 'warn' : status.report.connected ? 'ok' : 'off'}`} />{' '}
                {status.report.error ? friendlyError(status.report.error) : status.report.connected ? t('Connected') : t('Waiting for a first state')}
                {status.report.last && (
                  <>
                    {' · '}
                    <code>{status.report.last}</code> {status.report.lastAt && new Date(status.report.lastAt).toLocaleTimeString()}
                  </>
                )}
              </p>
            )}
          </Card>
          {status?.lastMessage && (
            <p className="hint">
              {t('Last message:')} <code>{status.lastMessage}</code> {status.lastMessageAt && new Date(status.lastMessageAt).toLocaleTimeString()}
            </p>
          )}
        </>
      )}

      {section === 'orders' &&
        (orders.length ? (
          <table className="user-table">
            <thead>
              <tr>
                <th>{t('Running order')}</th>
                <th>{t('Project')}</th>
                <th>{t('Stories')}</th>
                <th>{t('Items')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((r) => (
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
        ) : (
          <div className="empty big">
            <ListOrdered size={22} />
            <p>{mos.enabled ? t('No running order received yet.') : t('Off')}</p>
          </div>
        ))}

      {section === 'plugin' && (
        <Card icon={<Plug size={16} />} title={t('HTML5 plugin for the journalists')}>
          <div className="mos-plugin-url">
            <div className="row">
              <code className="grow">{plugin}</code>
              <button
                className="btn small"
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(plugin)
                    .then(() => toast(t('Copied'), 'info'))
                    .catch(() => toast(plugin))
                }
              >
                <Copy size={13} /> {t('Copy')}
              </button>
            </div>
          </div>
          <div>
            <button className="btn" onClick={() => navigate('/api-docs')}>
              <KeyRound size={14} /> {t('Create an API key')}
            </button>
          </div>
        </Card>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
    </SidePage>
  );
}

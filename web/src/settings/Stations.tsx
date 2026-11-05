import { Monitor, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { api, useApp } from '../store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { Card } from './ui';
import { ago } from './Updates';

interface StationView {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
}

/** The production stations: the computers whose Operator goes on air (the others simulate). */
export function StationsPage() {
  const toast = useApp((s) => s.toast);
  const here = useApp((s) => s.station);
  const [list, setList] = useState<StationView[] | null>(null);
  const load = () =>
    api<StationView[]>('GET', '/api/stations')
      .then(setList)
      .catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const declare = async () => {
    const name = await promptDialog({ title: t('Declare as production station'), label: t('Name'), placeholder: t('Control room 1'), confirm: t('Declare') });
    if (!name?.trim()) return;
    try {
      const v = await api<StationView>('POST', '/api/stations', { name: name.trim() });
      useApp.setState({ station: { id: v.id, name: v.name } });
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const rename = async (s: StationView) => {
    const name = await promptDialog({ title: t('Rename'), label: t('Name'), value: s.name, confirm: t('Rename') });
    if (!name?.trim() || name.trim() === s.name) return;
    try {
      await api('PUT', `/api/stations/${encodeURIComponent(s.id)}`, { name: name.trim() });
      if (here?.id === s.id) useApp.setState({ station: { id: s.id, name: name.trim() } });
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (s: StationView) => {
    if (!(await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), message: t('This computer no longer goes on air: its Operator simulates.'), confirm: t('Remove'), danger: true }))) return;
    try {
      await api('DELETE', `/api/stations/${encodeURIComponent(s.id)}`);
      if (here?.id === s.id) useApp.setState({ station: null });
      void load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <Card icon={<Monitor size={16} />} title={t('This computer')}>
        <div className="st-here">
          {here ? <strong>{here.name}</strong> : <span className="muted">{t('Not declared')}</span>}
          <span className="spacer" />
          {here === null && (
            <button className="btn primary" onClick={declare}>
              <Monitor size={14} /> {t('Declare as production station')}
            </button>
          )}
        </div>
      </Card>
      <Card icon={<Monitor size={16} />} title={t('Production stations')}>
        {list && !list.length ? (
          <span className="muted">{t('None')}</span>
        ) : (
          <div className="update-rows">
            {(list ?? []).map((s) => (
              <div key={s.id} className={`update-row ${here?.id === s.id ? 'here' : ''}`}>
                <Monitor size={14} className="muted" />
                <strong>{s.name}</strong>
                {here?.id === s.id && <span className="badge">{t('This computer')}</span>}
                {s.lastSeen && <span className="muted small">{t('seen {when}', { when: ago(s.lastSeen) })}</span>}
                <span className="spacer" />
                <button className="icon-btn ghost" title={t('Rename')} onClick={() => void rename(s)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn ghost" title={t('Remove')} onClick={() => void remove(s)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

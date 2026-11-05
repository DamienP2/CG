import { Cpu, RotateCcw, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { PageHead, SidePage } from '../pages/SidePage';
import { api, useApp } from '../store';
import type { HardwareInfo } from '../outputs/types';
import { Card, Field, SaveBar } from './ui';
import { useServerConfig } from './serverConfig';
import { Networks } from './Networks';
import { TimePage } from './TimePage';
import { VideoSync } from './VideoSync';
import { Updates } from './Updates';
import { LibraryUpdates } from './LibraryUpdates';
import { ShortcutsPage } from './Shortcuts';
import { SecurityPage } from './Security';

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York'];
  }
})();

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export type ServerSection = 'general' | 'network' | 'time' | 'security' | 'updates' | 'maintenance';

/** Your keyboard shortcuts (a page of their own). */
export function ShortcutsScreen() {
  return (
    <main className="library">
      <div className="library-inner">
        <ShortcutsPage />
      </div>
    </main>
  );
}

/** The server: name, clocks, network, updates and what it runs on. */
export function ServerSettings({ section }: { section: ServerSection }) {
  const toast = useApp((s) => s.toast);
  const { info, cfg, edit, dirty, saving, save, discard, reload } = useServerConfig('settings');
  const [det, setDet] = useState<HardwareInfo | null>(null);
  // Network cards and clock status (Networks, Time and sync).
  const detect = () =>
    api<HardwareInfo>('GET', '/api/hardware')
      .then(setDet)
      .catch(() => {});
  useEffect(() => {
    if (section === 'network' || section === 'time') void detect();
  }, [section]);
  if (!info || !cfg) return <div className="loading">{t('Loading settings…')}</div>;

  const restart = async () => {
    await api('POST', '/api/system/restart').catch((e) => toast((e as Error).message, 'error'));
    toast(t('Engine restarting…'), 'info');
    setTimeout(() => reload().catch(() => {}), 1500);
  };

  return (
    <SidePage nav={null}>
      {section === 'maintenance' ? (
        <PageHead title={t('Maintenance')} sub={`Strata ${info.version} · ${info.hostname} · ${info.os}/${info.arch} · ${t('up {time}', { time: uptime(info.uptimeSecs) })}`}>
          <button className="btn" onClick={restart} title={t('Restart the playout engine and outputs')}>
            <RotateCcw size={14} /> {t('Restart engine')}
          </button>
        </PageHead>
      ) : (
        <PageHead title={{ general: t('General'), network: t('Networks'), time: t('Time and sync'), security: t('Security'), updates: t('Updates') }[section]} />
      )}

      {section === 'general' && (
        <Card icon={<Server size={16} />} title={t('General')}>
          <div className="set-grid">
            <Field label={t('Server name')}>
              <input value={cfg.name} onChange={(e) => edit((c) => void (c.name = e.target.value))} />
            </Field>
            <Field label={t('HTML5 outputs')}>
              <label className="check">
                <input type="checkbox" checked={cfg.publicOutputs} onChange={(e) => edit((c) => void (c.publicOutputs = e.target.checked))} />
                {t('Public output pages')}
              </label>
            </Field>
          </div>
        </Card>
      )}

      {section === 'network' && <Networks info={info} cfg={cfg} edit={edit} det={det} />}

      {section === 'time' && (
        <>
          <TimePage cfg={cfg} edit={edit} det={det} zone={info.timezone} timezones={TIMEZONES} onRefresh={() => void detect()} />
          <VideoSync cfg={cfg} edit={edit} det={det} onRefresh={() => void detect()} />
        </>
      )}

      {section === 'security' && <SecurityPage cfg={cfg} edit={edit} />}

      {section === 'updates' && (
        <>
          <Updates Card={Card} />
          <LibraryUpdates Card={Card} />
        </>
      )}

      {section === 'maintenance' && (
        <Card icon={<Cpu size={16} />} title={t('System')}>
          <dl className="sys-list">
            <dt>{t('Version')}</dt>
            <dd>
              Strata {info.version} · {info.os}/{info.arch}
            </dd>
            <dt>{t('Machine')}</dt>
            <dd>{info.hostname}</dd>
            <dt>{t('Data folder')}</dt>
            <dd>
              <code>{info.dataDir}</code>
            </dd>
            <dt>{t('Listening on')}</dt>
            <dd>
              <code>{info.bind}</code>
            </dd>
            <dt>{t('CPU threads')}</dt>
            <dd>{info.cpus}</dd>
            <dt>{t('Running for')}</dt>
            <dd>{uptime(info.uptimeSecs)}</dd>
          </dl>
        </Card>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
    </SidePage>
  );
}

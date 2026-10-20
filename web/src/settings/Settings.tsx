import { CloudDownload, Cpu, Globe, Network, RotateCcw, Server, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { t } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { api, useApp } from '../store';
import { Card, Field, SaveBar } from './ui';
import { joinAddr, splitAddr, useServerConfig } from './serverConfig';
import { Updates } from './Updates';

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

type Section = 'general' | 'network' | 'updates' | 'system';

/** The server: name, clocks, network, updates and what it runs on. */
export function Settings() {
  const toast = useApp((s) => s.toast);
  const { info, cfg, edit, dirty, saving, save, discard, reload } = useServerConfig('settings');
  const [section, setSection] = useState<Section>('general');
  if (!info || !cfg) return <div className="loading">{t('Loading settings…')}</div>;

  const [bindIp, bindPort] = splitAddr(cfg.bind ?? info.bind);
  const ifaceOptions = [{ name: t('All interfaces'), ip: '0.0.0.0' }, ...info.interfaces];
  const base = `${location.protocol}//${location.hostname}:${splitAddr(info.bind)[1]}`;

  const restart = async () => {
    await api('POST', '/api/system/restart').catch((e) => toast((e as Error).message, 'error'));
    toast(t('Engine restarting…'), 'info');
    setTimeout(() => reload().catch(() => {}), 1500);
  };

  const item = (s: Section, icon: React.ReactNode, label: string) => <NavItem on={section === s} icon={icon} label={label} onClick={() => setSection(s)} />;
  const nav = (
    <>
      <NavSection>{t('Server')}</NavSection>
      {item('general', <SlidersHorizontal size={15} />, t('General'))}
      {item('network', <Network size={15} />, t('Network'))}
      {item('updates', <CloudDownload size={15} />, t('Updates'))}
      {item('system', <Cpu size={15} />, t('System'))}
      <div className="lib-nav-foot">
        <span className="nav-dot ok" /> {t('Up {time}', { time: uptime(info.uptimeSecs) })}
        <span className="muted">
          Strata {info.version} · {info.os}/{info.arch}
        </span>
      </div>
    </>
  );

  return (
    <SidePage nav={nav}>
      <PageHead title={info.config.name} sub={`Strata ${info.version} · ${info.hostname} · ${info.os}/${info.arch} · ${t('up {time}', { time: uptime(info.uptimeSecs) })}`}>
        <button className="btn" onClick={restart} title={t('Restart the playout engine and outputs')}>
          <RotateCcw size={14} /> {t('Restart engine')}
        </button>
      </PageHead>

      {section === 'general' && (
        <Card icon={<Server size={16} />} title={t('General')}>
          <div className="set-grid">
            <Field label={t('Server name')} hint={t('Shown in the UI and the menu bar app.')}>
              <input value={cfg.name} onChange={(e) => edit((c) => void (c.name = e.target.value))} />
            </Field>
            <Field label={t('Time zone')} hint={t('Default zone of clock widgets. Empty = server zone ({zone}).', { zone: info.timezone })}>
              <input list="tz-list" value={cfg.timezone} placeholder={info.timezone} onChange={(e) => edit((c) => void (c.timezone = e.target.value))} />
              <datalist id="tz-list">
                {TIMEZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label={t('HTML5 outputs')} hint={t('Browser sources (OBS, vMix, CasparCG) can play /output/<channel> without logging in.')}>
              <label className="check">
                <input type="checkbox" checked={cfg.publicOutputs} onChange={(e) => edit((c) => void (c.publicOutputs = e.target.checked))} />
                {t('Public output pages')}
              </label>
            </Field>
          </div>
        </Card>
      )}

      {section === 'network' && (
        <Card icon={<Network size={16} />} title={t('Network')}>
          <div className="set-grid">
            <Field label={t('Listen on')} hint={t('Network interface for the web UI and the API.')}>
              <select value={bindIp} onChange={(e) => edit((c) => void (c.bind = joinAddr(e.target.value, bindPort)))}>
                {!ifaceOptions.some((i) => i.ip === bindIp) && <option value={bindIp}>{bindIp}</option>}
                {ifaceOptions.map((i) => (
                  <option key={i.ip + i.name} value={i.ip}>
                    {i.ip === '0.0.0.0' ? i.name : `${i.name} — ${i.ip}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Port')} hint={t('The page follows the server when the port changes.')}>
              <input type="number" min={1} max={65535} value={bindPort} onChange={(e) => edit((c) => void (c.bind = joinAddr(bindIp, e.target.value)))} />
            </Field>
            <Field label={t('Web app')}>
              <a className="set-link" href={`${base}/projects`}>
                <Globe size={13} /> {base}
              </a>
            </Field>
          </div>
        </Card>
      )}

      {section === 'updates' && <Updates Card={Card} />}

      {section === 'system' && (
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

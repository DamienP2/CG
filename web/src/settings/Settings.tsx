import { Cpu, MonitorPlay, RotateCcw, Save, Server } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, useApp } from '../store';
import { Updates } from './Updates';
import { MosCard } from './Mos';

import type { ServerConfig, SystemInfo } from '../outputs/types';
import { navigate } from '../router';

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York'];
  }
})();

const splitAddr = (a?: string | null): [string, string] => {
  if (!a) return ['', ''];
  const i = a.lastIndexOf(':');
  return i < 0 ? [a, ''] : [a.slice(0, i), a.slice(i + 1)];
};
const joinAddr = (ip: string, port: string) => `${ip.trim()}:${port.trim()}`;

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function Card({ icon, title, children, actions }: { icon: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="set-card">
      <header>
        {icon}
        <h2>{title}</h2>
        <div className="spacer" />
        {actions}
      </header>
      <div className="set-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  );
}


export function Settings() {
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const i = await api<SystemInfo>('GET', '/api/system');
    setInfo(i);
    setCfg(structuredClone(i.config));
  };
  useEffect(() => {
    load().catch((e) => toast(String(e), 'error'));
    const h = setInterval(() => {
      api<SystemInfo>('GET', '/api/system')
        .then((i) => setInfo(i))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(h);
  }, []);

  const dirty = useMemo(() => info && cfg && JSON.stringify(info.config) !== JSON.stringify(cfg), [info, cfg]);
  if (!info || !cfg) return <div className="loading">Loading settings…</div>;

  const [bindIp, bindPort] = splitAddr(cfg.bind ?? info.bind);
  const ifaceOptions = [{ name: 'All interfaces', ip: '0.0.0.0' }, ...info.interfaces];
  const edit = (fn: (c: ServerConfig) => void) => {
    const next = structuredClone(cfg);
    fn(next);
    setCfg(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api('PUT', '/api/system/config', cfg);
      toast('Settings saved — the engine is restarting', 'info');
      const newPort = splitAddr(cfg.bind)[1];
      if (newPort && newPort !== (location.port || (location.protocol === 'https:' ? '443' : '80'))) {
        // The UI moves with the server.
        setTimeout(() => (location.href = `${location.protocol}//${location.hostname}:${newPort}/settings`), 2000);
        return;
      }
      setTimeout(() => load().catch(() => {}), 1500);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    await api('POST', '/api/system/restart');
    toast('Engine restarting…', 'info');
    setTimeout(() => load().catch(() => {}), 1500);
  };

  const base = `${location.protocol}//${location.hostname}:${splitAddr(info.bind)[1]}`;

  return (
    <div className="settings">
      <div className="settings-inner">
        <div className="settings-head">
          <div>
            <h1>{info.config.name}</h1>
            <p className="muted">
              Pulse CG {info.version} · {info.hostname} · {info.os}/{info.arch} · up {uptime(info.uptimeSecs)}
            </p>
          </div>
          <div className="spacer" />
          <button className="btn" onClick={restart} title="Restart the playout engine and outputs">
            <RotateCcw size={14} /> Restart engine
          </button>
        </div>

        <Card icon={<Server size={16} />} title="Server">
          <div className="set-grid">
            <Field label="Server name" hint="Shown in the UI and the menu bar app.">
              <input value={cfg.name} onChange={(e) => edit((c) => void (c.name = e.target.value))} />
            </Field>
            <Field label="Listen on" hint="Network interface for the web UI and the API.">
              <select value={bindIp} onChange={(e) => edit((c) => void (c.bind = joinAddr(e.target.value, bindPort)))}>
                {!ifaceOptions.some((i) => i.ip === bindIp) && <option value={bindIp}>{bindIp}</option>}
                {ifaceOptions.map((i) => (
                  <option key={i.ip + i.name} value={i.ip}>
                    {i.ip === '0.0.0.0' ? i.name : `${i.name} — ${i.ip}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Port">
              <input type="number" min={1} max={65535} value={bindPort} onChange={(e) => edit((c) => void (c.bind = joinAddr(bindIp, e.target.value)))} />
            </Field>
          </div>
          <div className="set-grid">
            <Field label="Time zone" hint={`Default zone of clock widgets. Empty = server zone (${info.timezone}).`}>
              <input list="tz-list" value={cfg.timezone} placeholder={info.timezone} onChange={(e) => edit((c) => void (c.timezone = e.target.value))} />
              <datalist id="tz-list">
                {TIMEZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label="HTML5 outputs" hint="Browser sources (OBS, vMix, CasparCG) can play /output/<channel> without logging in.">
              <label className="check">
                <input type="checkbox" checked={cfg.publicOutputs} onChange={(e) => edit((c) => void (c.publicOutputs = e.target.checked))} />
                Public output pages
              </label>
            </Field>
            <div />
          </div>
        </Card>

        <Card icon={<MonitorPlay size={16} />} title="Output channels">
          <p className="hint">
            Channels, their locations and their video outputs (HTML5, SDI, ST 2110, NDI) are set up on the <a href="/outputs" onClick={(e) => (e.preventDefault(), navigate('/outputs'))}>Outputs</a> page.
          </p>
        </Card>

        <MosCard mos={cfg.mos} onChange={(m) => edit((c) => void (c.mos = m))} Card={Card} Field={Field} />

        <Updates Card={Card} />

        <Card icon={<Cpu size={16} />} title="System">
          <dl className="sys-list">
            <dt>Data folder</dt>
            <dd>
              <code>{info.dataDir}</code>
            </dd>
            <dt>Listening on</dt>
            <dd>
              <code>{info.bind}</code>
            </dd>
            <dt>CPU threads</dt>
            <dd>{info.cpus}</dd>
            <dt>Web app</dt>
            <dd>
              <a href={`${base}/projects`}>{base}/projects</a>
            </dd>
            {info.config.channels.map((c) => (
              <div key={c.id} style={{ display: 'contents' }}>
                <dt>Output · {c.name}</dt>
                <dd>
                  <a href={`${base}/output/${encodeURIComponent(c.id)}`} target="_blank" rel="noreferrer">
                    {base}/output/{c.id}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <div className={`save-bar ${dirty ? 'show' : ''}`}>
        <span>You have unsaved changes.</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setCfg(structuredClone(info.config))}>
          Discard
        </button>
        <button className="btn primary" disabled={saving} onClick={save}>
          <Save size={14} /> {saving ? 'Applying…' : 'Save & apply'}
        </button>
      </div>
    </div>
  );
}

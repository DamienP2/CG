import { ChevronDown, ChevronRight, Cpu, ExternalLink, MonitorPlay, Network, Plus, RotateCcw, Save, Server, Trash2, Tv } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FrameRate } from '../engine/types';
import { api, useApp } from '../store';
import { Updates } from './Updates';

interface St2110Output {
  name: string;
  fill: string;
  key?: string | null;
  interface?: string | null;
  ttl: number;
  payloadType: number;
}

interface SdiOutput {
  name: string;
  device: number;
  externalKey: boolean;
}

interface ChannelConfig {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  projectId?: string | null;
  outputs: { st2110: St2110Output[]; sdi: SdiOutput[] };
}

interface ServerConfig {
  name: string;
  bind?: string | null;
  publicOutputs: boolean;
  timezone: string;
  channels: ChannelConfig[];
}

interface SystemInfo {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  cpus: number;
  dataDir: string;
  bind: string;
  uptimeSecs: number;
  timezone: string;
  config: ServerConfig;
  interfaces: { name: string; ip: string }[];
}

const FORMATS: { label: string; width: number; height: number; rate: FrameRate }[] = [
  { label: '1080p 50', width: 1920, height: 1080, rate: { num: 50, den: 1 } },
  { label: '1080p 25', width: 1920, height: 1080, rate: { num: 25, den: 1 } },
  { label: '1080p 59.94', width: 1920, height: 1080, rate: { num: 60000, den: 1001 } },
  { label: '1080p 29.97', width: 1920, height: 1080, rate: { num: 30000, den: 1001 } },
  { label: '1080p 60', width: 1920, height: 1080, rate: { num: 60, den: 1 } },
  { label: '720p 50', width: 1280, height: 720, rate: { num: 50, den: 1 } },
  { label: '720p 59.94', width: 1280, height: 720, rate: { num: 60000, den: 1001 } },
  { label: '2160p 50 (UHD)', width: 3840, height: 2160, rate: { num: 50, den: 1 } },
  { label: '2160p 59.94 (UHD)', width: 3840, height: 2160, rate: { num: 60000, den: 1001 } },
];

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


function SubCard({ icon, title, children, actions }: { icon: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="sub-card">
      <header>
        {icon}
        <h3>{title}</h3>
        <div className="spacer" />
        {actions}
      </header>
      {children}
    </div>
  );
}

const fmtMatch = (c: { width: number; height: number; frameRate: FrameRate }) =>
  FORMATS.findIndex((f) => f.width === c.width && f.height === c.height && f.rate.num === c.frameRate.num && f.rate.den === c.frameRate.den);

function ChannelEditor({
  channel,
  saved,
  index,
  info,
  onChange,
  onRemove,
}: {
  channel: ChannelConfig;
  saved?: ChannelConfig;
  index: number;
  info: SystemInfo;
  onChange: (c: ChannelConfig) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const projects = useApp((s) => s.projects);
  const editCh = (fn: (c: ChannelConfig) => void) => {
    const next = structuredClone(channel);
    fn(next);
    onChange(next);
  };
  const fmt = fmtMatch(channel);
  const project = projects.find((p) => p.id === channel.projectId);
  return (
    <div className={`channel-card ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <MonitorPlay size={15} />
        <strong>{channel.name || 'Unnamed channel'}</strong>
        <span className="muted">
          {channel.width}×{channel.height} · {+(channel.frameRate.num / channel.frameRate.den).toFixed(2)} fps · {channel.outputs.st2110.length + channel.outputs.sdi.length} output(s)
          {project ? ` · ${project.name}` : ''}
        </span>
        <div className="spacer" />
        {saved && (
          <a className="btn small" href={`/output/${encodeURIComponent(channel.id)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            <ExternalLink size={12} /> HTML5 output
          </a>
        )}
        {onRemove && (
          <button
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Remove channel “${channel.name}”? Its outputs stop when you save.`)) onRemove();
            }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </header>
      {open && (
        <div className="channel-body">
          <div className="set-grid">
            <Field label="Name" hint="Studio, control room…">
              <input value={channel.name} onChange={(e) => editCh((c) => void (c.name = e.target.value))} />
            </Field>
            <Field label="Identifier" hint="Used in URLs (/output/<id>) and the API.">
              <input value={channel.id} disabled={!!saved} onChange={(e) => editCh((c) => void (c.id = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')))} />
            </Field>
            <Field label="Video format" hint="Projects in another format are scaled to fit.">
              <select
                value={fmt}
                onChange={(e) => {
                  const f = FORMATS[+e.target.value];
                  if (f) editCh((c) => Object.assign(c, { width: f.width, height: f.height, frameRate: f.rate }));
                }}
              >
                {fmt < 0 && (
                  <option value={-1}>
                    Custom — {channel.width}×{channel.height} @ {+(channel.frameRate.num / channel.frameRate.den).toFixed(3)}
                  </option>
                )}
                {FORMATS.map((f, i) => (
                  <option key={f.label} value={i}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        <SubCard
            icon={<Network size={14} />}
            title="SMPTE ST 2110 outputs"
            actions={
              <button
                className="btn small"
                onClick={() =>
                  editCh((ch) => {
                    const n = ch.outputs.st2110.length + 1;
                    const g = index + 100;
                    ch.outputs.st2110.push({ name: `CG${n}`, fill: `239.${g}.${n}.1:5004`, key: `239.${g}.${n}.2:5004`, interface: null, ttl: 32, payloadType: 96 });
                  })
                }
              >
                <Plus size={13} /> Add output
              </button>
            }
          >
            {channel.outputs.st2110.length === 0 && <p className="hint">No ST 2110 output. Add one to send fill + key over IP (uncompressed, RFC 4175).</p>}
            {channel.outputs.st2110.map((o, i) => {
              const [fip, fport] = splitAddr(o.fill);
              const [kip, kport] = splitAddr(o.key);
              const set = (fn: (x: St2110Output) => void) => editCh((ch) => fn(ch.outputs.st2110[i]));
              const isSaved = (saved?.outputs.st2110 ?? []).some((x) => x.name === o.name);
              return (
                <div key={i} className="output-card">
                  <div className="set-grid">
                    <Field label="Name">
                      <input value={o.name} onChange={(e) => set((x) => void (x.name = e.target.value))} />
                    </Field>
                    <Field label="Media network interface">
                      <select value={o.interface ?? ''} onChange={(e) => set((x) => void (x.interface = e.target.value || null))}>
                        <option value="">System default</option>
                        {info.interfaces.map((n) => (
                          <option key={n.ip} value={n.ip}>
                            {n.name} — {n.ip}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="TTL">
                      <input type="number" min={1} max={255} value={o.ttl} onChange={(e) => set((x) => void (x.ttl = +e.target.value))} />
                    </Field>
                  </div>
                  <div className="set-grid">
                    <Field label="Fill — destination IP">
                      <input value={fip} placeholder="239.100.1.1" onChange={(e) => set((x) => void (x.fill = joinAddr(e.target.value, fport)))} />
                    </Field>
                    <Field label="Fill — UDP port">
                      <input type="number" value={fport} onChange={(e) => set((x) => void (x.fill = joinAddr(fip, e.target.value)))} />
                    </Field>
                    <Field label="Key stream">
                      <label className="check">
                        <input type="checkbox" checked={!!o.key} onChange={(e) => set((x) => void (x.key = e.target.checked ? joinAddr(fip.replace(/\d+$/, (d) => String(+d + 1)), fport) : null))} />
                        Send key (alpha)
                      </label>
                    </Field>
                  </div>
                  {o.key && (
                    <div className="set-grid">
                      <Field label="Key — destination IP">
                        <input value={kip} onChange={(e) => set((x) => void (x.key = joinAddr(e.target.value, kport)))} />
                      </Field>
                      <Field label="Key — UDP port">
                        <input type="number" value={kport} onChange={(e) => set((x) => void (x.key = joinAddr(kip, e.target.value)))} />
                      </Field>
                      <div />
                    </div>
                  )}
                  <div className="output-foot">
                    {isSaved ? (
                      <span className="muted">
                        SDP: <a href={`/api/channels/${encodeURIComponent(channel.id)}/outputs/${encodeURIComponent(o.name)}/fill.sdp`}>fill.sdp</a>
                        {o.key && (
                          <>
                            {' · '}
                            <a href={`/api/channels/${encodeURIComponent(channel.id)}/outputs/${encodeURIComponent(o.name)}/key.sdp`}>key.sdp</a>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="muted">Save to generate the SDP files.</span>
                    )}
                    <div className="spacer" />
                    <button className="btn small" onClick={() => editCh((ch) => void ch.outputs.st2110.splice(i, 1))}>
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </SubCard>

          <SubCard
            icon={<Tv size={14} />}
            title="SDI outputs (Blackmagic DeckLink)"
            actions={
              <button className="btn small" onClick={() => editCh((ch) => void ch.outputs.sdi.push({ name: `SDI${ch.outputs.sdi.length + 1}`, device: ch.outputs.sdi.length, externalKey: true }))}>
                <Plus size={13} /> Add output
              </button>
            }
          >
            <p className="hint">Requires Blackmagic Desktop Video and a server build with DeckLink support (coming soon).</p>
            {channel.outputs.sdi.map((o, i) => (
              <div key={i} className="output-card">
                <div className="set-grid">
                  <Field label="Name">
                    <input value={o.name} onChange={(e) => editCh((ch) => void (ch.outputs.sdi[i].name = e.target.value))} />
                  </Field>
                  <Field label="Device index">
                    <input type="number" min={0} value={o.device} onChange={(e) => editCh((ch) => void (ch.outputs.sdi[i].device = +e.target.value))} />
                  </Field>
                  <Field label="Keying">
                    <label className="check">
                      <input type="checkbox" checked={o.externalKey} onChange={(e) => editCh((ch) => void (ch.outputs.sdi[i].externalKey = e.target.checked))} />
                      External key (fill + key)
                    </label>
                  </Field>
                </div>
                <div className="output-foot">
                  <div className="spacer" />
                  <button className="btn small" onClick={() => editCh((ch) => void ch.outputs.sdi.splice(i, 1))}>
                    <Trash2 size={13} /> Remove
                  </button>
                </div>
              </div>
            ))}
          </SubCard>

        </div>
      )}
    </div>
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

        <Card
          icon={<MonitorPlay size={16} />}
          title="Output channels"
          actions={
            <button
              className="btn small"
              onClick={() =>
                edit((c) => {
                  let n = c.channels.length + 1;
                  while (c.channels.some((x) => x.id === `channel-${n}`)) n++;
                  const first = c.channels[0];
                  c.channels.push({ id: `channel-${n}`, name: `Channel ${n}`, width: first?.width ?? 1920, height: first?.height ?? 1080, frameRate: first?.frameRate ?? { num: 50, den: 1 }, projectId: null, outputs: { st2110: [], sdi: [] } });
                })
              }
            >
              <Plus size={13} /> Add channel
            </button>
          }
        >
          <p className="hint">Each channel is an independent program (one per studio or control room) with its own format, playout and outputs. Operators load a project on a channel.</p>
          {cfg.channels.map((ch, i) => (
            <ChannelEditor
              key={i}
              index={i}
              channel={ch}
              saved={info.config.channels.find((x) => x.id === ch.id)}
              info={info}
              onChange={(next) => edit((c) => void (c.channels[i] = next))}
              onRemove={cfg.channels.length > 1 ? () => edit((c) => void c.channels.splice(i, 1)) : undefined}
            />
          ))}
        </Card>

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

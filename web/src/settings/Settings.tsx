import { Cpu, Network, Plus, RotateCcw, Save, Server, Trash2, Tv, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FrameRate } from '../engine/types';
import { useApp } from '../store';

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

interface ServerConfig {
  name: string;
  bind?: string | null;
  outputs: { st2110: St2110Output[]; sdi: SdiOutput[] };
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
  const { project, saveProject, toast } = useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await fetch('/api/system');
    if (!r.ok) throw new Error(await r.text());
    const i = (await r.json()) as SystemInfo;
    setInfo(i);
    setCfg(structuredClone(i.config));
  };
  useEffect(() => {
    load().catch((e) => toast(String(e), 'error'));
    const h = setInterval(() => {
      fetch('/api/system')
        .then((r) => r.json())
        .then((i: SystemInfo) => setInfo(i))
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
      const r = await fetch('/api/system/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (!r.ok) throw new Error(await r.text());
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
    await fetch('/api/system/restart', { method: 'POST' });
    toast('Engine restarting…', 'info');
    setTimeout(() => load().catch(() => {}), 1500);
  };

  const fmtIndex = project ? FORMATS.findIndex((f) => f.width === project.width && f.height === project.height && f.rate.num === project.frameRate.num && f.rate.den === project.frameRate.den) : -1;
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
        </Card>

        {project && (
          <Card icon={<Video size={16} />} title="Video format">
            <div className="set-grid">
              <Field label="Format" hint="Applied immediately; the engine and outputs restart.">
                <select
                  value={fmtIndex}
                  onChange={(e) => {
                    const f = FORMATS[+e.target.value];
                    if (f && confirm(`Switch the channel to ${f.label}? Graphics on air will be cleared.`)) {
                      saveProject({ ...project, width: f.width, height: f.height, frameRate: f.rate });
                    }
                  }}
                >
                  {fmtIndex < 0 && (
                    <option value={-1}>
                      Custom — {project.width}×{project.height} @ {+(project.frameRate.num / project.frameRate.den).toFixed(3)}
                    </option>
                  )}
                  {FORMATS.map((f, i) => (
                    <option key={f.label} value={i}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Resolution">
                <input readOnly value={`${project.width} × ${project.height}`} />
              </Field>
              <Field label="Frame rate">
                <input readOnly value={`${+(project.frameRate.num / project.frameRate.den).toFixed(3)} fps`} />
              </Field>
            </div>
          </Card>
        )}

        <Card
          icon={<Network size={16} />}
          title="SMPTE ST 2110 outputs"
          actions={
            <button
              className="btn small"
              onClick={() =>
                edit((c) => {
                  const n = c.outputs.st2110.length + 1;
                  c.outputs.st2110.push({ name: `CG${n}`, fill: `239.100.${n}.1:5004`, key: `239.100.${n}.2:5004`, interface: null, ttl: 32, payloadType: 96 });
                })
              }
            >
              <Plus size={13} /> Add output
            </button>
          }
        >
          {cfg.outputs.st2110.length === 0 && <p className="hint">No ST 2110 output. Add one to send fill + key over IP (uncompressed, RFC 4175).</p>}
          {cfg.outputs.st2110.map((o, i) => {
            const [fip, fport] = splitAddr(o.fill);
            const [kip, kport] = splitAddr(o.key);
            const set = (fn: (x: St2110Output) => void) => edit((c) => fn(c.outputs.st2110[i]));
            const saved = info.config.outputs.st2110.some((x) => x.name === o.name);
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
                  {saved ? (
                    <span className="muted">
                      SDP: <a href={`/api/outputs/${encodeURIComponent(o.name)}/fill.sdp`}>fill.sdp</a>
                      {o.key && (
                        <>
                          {' · '}
                          <a href={`/api/outputs/${encodeURIComponent(o.name)}/key.sdp`}>key.sdp</a>
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="muted">Save to generate the SDP files.</span>
                  )}
                  <div className="spacer" />
                  <button className="btn small" onClick={() => edit((c) => void c.outputs.st2110.splice(i, 1))}>
                    <Trash2 size={13} /> Remove
                  </button>
                </div>
              </div>
            );
          })}
        </Card>

        <Card
          icon={<Tv size={16} />}
          title="SDI outputs (Blackmagic DeckLink)"
          actions={
            <button className="btn small" onClick={() => edit((c) => void c.outputs.sdi.push({ name: `SDI${c.outputs.sdi.length + 1}`, device: c.outputs.sdi.length, externalKey: true }))}>
              <Plus size={13} /> Add output
            </button>
          }
        >
          <p className="hint">Requires Blackmagic Desktop Video and a server build with DeckLink support (coming soon).</p>
          {cfg.outputs.sdi.map((o, i) => (
            <div key={i} className="output-card">
              <div className="set-grid">
                <Field label="Name">
                  <input value={o.name} onChange={(e) => edit((c) => void (c.outputs.sdi[i].name = e.target.value))} />
                </Field>
                <Field label="Device index">
                  <input type="number" min={0} value={o.device} onChange={(e) => edit((c) => void (c.outputs.sdi[i].device = +e.target.value))} />
                </Field>
                <Field label="Keying">
                  <label className="check">
                    <input type="checkbox" checked={o.externalKey} onChange={(e) => edit((c) => void (c.outputs.sdi[i].externalKey = e.target.checked))} />
                    External key (fill + key)
                  </label>
                </Field>
              </div>
              <div className="output-foot">
                <div className="spacer" />
                <button className="btn small" onClick={() => edit((c) => void c.outputs.sdi.splice(i, 1))}>
                  <Trash2 size={13} /> Remove
                </button>
              </div>
            </div>
          ))}
        </Card>

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
            <dt>Designer</dt>
            <dd>
              <a href={`${base}/designer`}>{base}/designer</a>
            </dd>
            <dt>Operator</dt>
            <dd>
              <a href={`${base}/operator`}>{base}/operator</a>
            </dd>
            <dt>HTML5 output</dt>
            <dd>
              <a href={`${base}/output`} target="_blank" rel="noreferrer">
                {base}/output
              </a>
            </dd>
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

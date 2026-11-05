import { Network, Router, TriangleAlert } from 'lucide-react';
import { t } from '../i18n';
import { hardwareOf, speedLabel } from '../hardware/model';
import { emptyNetwork, type HardwareInfo, type NetworkRoles, type Nic, type ServerConfig, type SystemInfo } from '../outputs/types';
import { Card } from './ui';
import { Dropdown, type DropOption } from '../ui/Dropdown';
import { NumberField } from '../ui/fields';
import { joinAddr, splitAddr } from './serverConfig';
import '../hardware/hardware.css';

/*
 * Settings › Networks: which network card does what (web interface and
 * API, NDI, the ST 2110 red and blue networks, MOS), then the cards of
 * the machine. Saving restarts the server on its new addresses.
 */

type RoleKey = 'control' | 'ndi' | 'tracking' | 'mediaRed' | 'mediaBlue' | 'mos' | 'ptp' | 'buttons';

const ipOf = (n?: Nic) => n?.ipv4[0]?.split('/')[0];

export function Networks({ info, cfg, edit, det }: { info: SystemInfo; cfg: ServerConfig; edit: (fn: (c: ServerConfig) => void) => void; det: HardwareInfo | null }) {
  const net: NetworkRoles = { ...emptyNetwork(), ...hardwareOf(structuredClone(cfg)).network };
  const nics = det?.nics ?? [];
  const usable = nics.filter((n) => n.ipv4.length);
  const [bindIp, bindPort] = splitAddr(cfg.bind ?? info.bind);
  const anyBind = !bindIp || bindIp === '0.0.0.0' || bindIp === '::';
  const set = (k: keyof NetworkRoles, v: string) =>
    edit((c) => {
      c.hardware = hardwareOf(c);
      c.hardware.network = { ...emptyNetwork(), ...c.hardware.network, [k]: v };
    });
  const nicOf = (name: string) => nics.find((n) => n.name === name);
  const all = usable.filter((n) => n.up !== false).map(ipOf).filter(Boolean) as string[];

  // The web interface: a card by name (the control role), or every card;
  // an address set by hand before (bind) shows as it is.
  const control = net.control || (anyBind ? '' : `ip:${bindIp}`);
  const setControl = (v: string) =>
    edit((c) => {
      c.hardware = hardwareOf(c);
      c.hardware.network = { ...emptyNetwork(), ...c.hardware.network, control: v.startsWith('ip:') ? '' : v };
      c.bind = joinAddr(v.startsWith('ip:') ? v.slice(3) : '0.0.0.0', bindPort || '8080');
    });

  const picker = (value: string, onChange: (v: string) => void, none: string, label: string, extra?: DropOption<string>) => (
    <Dropdown
      value={value}
      title={label}
      options={[
        { value: '', label: none },
        ...(extra ? [extra] : []),
        ...(value && !value.startsWith('ip:') && !usable.some((n) => n.name === value) ? [{ value, label: value, note: t('not found') }] : []),
        ...usable.map((n) => ({ value: n.name, label: n.name, note: n.speed ? speedLabel(n.speed) : ipOf(n) })),
      ]}
      onChange={onChange}
    />
  );
  const address = (name: string, every: boolean) => (name ? (ipOf(nicOf(name)) ?? '—') : every ? all.join(' · ') || '—' : '—');

  const rows: { key: RoleKey; label: string; cell: React.ReactNode; addr: string; port: React.ReactNode }[] = [
    {
      key: 'control',
      label: t('Web interface and API'),
      cell: picker(control, setControl, t('Every interface'), t('Web interface and API'), control.startsWith('ip:') ? { value: control, label: control.slice(3) } : undefined),
      addr: [...new Set([control.startsWith('ip:') ? control.slice(3) : address(net.control, true), '127.0.0.1'])].join(' · '),
      port: <NumberField value={Number(bindPort) || 8080} min={1} max={65535} title={t('Port')} onChange={(v) => edit((c) => void (c.bind = joinAddr(control.startsWith('ip:') ? control.slice(3) : '0.0.0.0', String(Math.round(v)))))} />,
    },
    { key: 'ndi', label: 'NDI', cell: picker(net.ndi, (v) => set('ndi', v), t('Every interface'), 'NDI'), addr: address(net.ndi, true), port: <span className="muted">—</span> },
    // Camera tracking (multicast joined on it), when the server has a tracking input.
    ...((cfg.inputs ?? []).some((i) => i.kind === 'tracking') ? [{ key: 'tracking' as const, label: t('Camera tracking'), cell: picker(net.tracking ?? '', (v) => set('tracking', v), t('Automatic'), t('Camera tracking')), addr: address(net.tracking ?? '', false), port: <span className="muted">—</span> }] : []),
    { key: 'mediaRed', label: t('2110 red'), cell: picker(net.mediaRed, (v) => set('mediaRed', v), t('Not set'), t('2110 red')), addr: address(net.mediaRed, false), port: <span className="muted">—</span> },
    { key: 'mediaBlue', label: t('2110 blue'), cell: picker(net.mediaBlue, (v) => set('mediaBlue', v), t('Not set'), t('2110 blue')), addr: address(net.mediaBlue, false), port: <span className="muted">—</span> },
    {
      key: 'mos',
      label: 'MOS',
      cell: picker(net.mos ?? '', (v) => set('mos', v), t('Every interface'), 'MOS'),
      addr: address(net.mos ?? '', true),
      port: (
        <span className="net-ports">
          <NumberField value={cfg.mos.lowerPort} min={1} max={65535} title={t('MOS lower port')} onChange={(v) => edit((c) => void (c.mos.lowerPort = Math.round(v)))} />
          <NumberField value={cfg.mos.upperPort} min={1} max={65535} title={t('MOS upper port')} onChange={(v) => edit((c) => void (c.mos.upperPort = Math.round(v)))} />
        </span>
      ),
    },
    {
      // OSC and TCP control of Bitfocus Buttons (API page), on every interface.
      key: 'buttons',
      label: 'OSC · TCP',
      cell: <span className="muted">{t('Every interface')}</span>,
      addr: address('', true),
      port: (
        <span className="net-ports">
          <NumberField value={cfg.control?.oscPort ?? 9000} min={1} max={65535} title={t('OSC port')} onChange={(v) => edit((c) => void (c.control = { oscEnabled: false, tcpEnabled: false, tcpPort: 9001, allow: [], ...c.control, oscPort: Math.round(v) }))} />
          <NumberField value={cfg.control?.tcpPort ?? 9001} min={1} max={65535} title={t('TCP port')} onChange={(v) => edit((c) => void (c.control = { oscEnabled: false, oscPort: 9000, tcpEnabled: false, allow: [], ...c.control, tcpPort: Math.round(v) }))} />
        </span>
      ),
    },
  ];

  /** The roles a card carries (a role on every card counts for each). */
  const rolesOf = (n: Nic) => {
    const on = n.ipv4.length > 0 && n.up !== false;
    const out: { label: string; cls: string }[] = [];
    if (net.control === n.name || (!net.control && anyBind && on)) out.push({ label: 'Web', cls: 'on' });
    if (net.ndi === n.name || (!net.ndi && on)) out.push({ label: 'NDI', cls: 'on' });
    if (cfg.mos.enabled && (net.mos === n.name || (!net.mos && on))) out.push({ label: 'MOS', cls: 'on' });
    if (net.mediaRed === n.name) out.push({ label: t('2110 red'), cls: 'red' });
    if (net.mediaBlue === n.name) out.push({ label: t('2110 blue'), cls: 'blue' });
    if (net.ptp === n.name) out.push({ label: 'PTP', cls: 'on' });
    if (net.tracking === n.name) out.push({ label: 'Tracking', cls: 'on' });
    return out;
  };

  return (
    <div className="net-page">
      {det?.ndiRestart && (
        <p className="hw-note warn hw-banner">
          <TriangleAlert size={14} /> {t('The NDI network settings changed: they apply when the server restarts (the NDI runtime reads them once).')}
        </p>
      )}
      <Card icon={<Router size={16} />} title={t('Roles')}>
        <table className="fio-table net-table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>{t('Role')}</th>
              <th>{t('Card')}</th>
              <th>{t('Address')}</th>
              <th>{t('Port')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <b>{r.label}</b>
                </td>
                <td>{r.cell}</td>
                <td className="mono">{r.addr}</td>
                <td>{r.port}</td>
              </tr>
            ))}
            <tr>
              <td>
                <b>{t('NDI machine name')}</b>
              </td>
              <td>
                <input className="net-discovery" value={net.ndiMachine ?? ''} placeholder={info.hostname ? info.hostname.toUpperCase() : undefined} spellCheck={false} aria-label={t('NDI machine name')} onChange={(e) => set('ndiMachine', e.target.value)} />
              </td>
              <td />
              <td />
            </tr>
            <tr>
              <td>
                <b>{t('NDI Discovery Server')}</b>
              </td>
              <td>
                <input className="net-discovery" value={net.ndiDiscovery} placeholder="10.0.0.2" spellCheck={false} aria-label={t('NDI Discovery Server')} onChange={(e) => set('ndiDiscovery', e.target.value)} />
              </td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
        {net.mediaRed && net.mediaRed === net.mediaBlue && (
          <p className="hw-note warn">
            <TriangleAlert size={13} /> {t('Red and blue must be two different interfaces.')}
          </p>
        )}
      </Card>

      <Card icon={<Network size={16} />} title={t('Network cards')}>
        <table className="fio-table">
          <thead>
            <tr>
              <th>{t('Card')}</th>
              <th>{t('IPv4 address')}</th>
              <th>{t('Link')}</th>
              <th>MTU</th>
              <th>MAC</th>
              <th>{t('Roles')}</th>
            </tr>
          </thead>
          <tbody>
            {!det && (
              <tr>
                <td colSpan={6} className="muted">
                  {t('Detecting…')}
                </td>
              </tr>
            )}
            {nics.map((n) => {
              const roles = rolesOf(n);
              const up = n.up !== false && n.ipv4.length > 0;
              return (
                <tr key={n.name}>
                  <td>
                    <span className="net-name">
                      <span className={`fio-dot ${up ? 'ok' : ''}`} />
                      <b className="mono">{n.name}</b>
                      <span className="muted small">{n.model ?? (n.kind === 'wifi' ? 'Wi-Fi' : n.kind === 'virtual' ? t('virtual') : n.kind === 'ethernet' ? 'Ethernet' : '')}</span>
                    </span>
                  </td>
                  <td className={`mono ${n.ipv4.length ? '' : 'muted'}`}>{n.ipv4.join(' · ') || '—'}</td>
                  <td className={n.up === false ? 'muted' : ''}>{n.up === false ? t('disconnected') : speedLabel(n.speed) || '—'}</td>
                  <td className={n.mtu ? '' : 'muted'}>{n.mtu ?? '—'}</td>
                  <td className="mono">{n.mac ?? '—'}</td>
                  <td>
                    {roles.length ? (
                      <div className="fio-chips">
                        {roles.map((r) => (
                          <span key={r.label} className={`fio-chip ${r.cls}`}>
                            {r.label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

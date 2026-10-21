import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, CircuitBoard, Clock, Info, Network, Plus, RefreshCw, Router, Trash2, TriangleAlert, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t, tc, tn } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { Card, Field, SaveBar } from '../settings/ui';
import { useServerConfig } from '../settings/serverConfig';
import { joinAddr, splitAddr, type ClockReference, type HardwareConfig, type HardwareInfo, type NetworkRoles, type SdiCard, type SdiModel, type SdiMode, type ServerConfig, type St2110Flow } from '../outputs/types';
import { api, can, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { CLOCKS, ENCODINGS, MODES, SDI_MODELS, clockLabel, deviceOf, dropUsers, hardwareOf, modelOf, portsOf, roleOf, syncUsers, usersOf, type PortCap, type Role } from './model';
import './hardware.css';

/*
 * The Hardware page (admins): the DeckLink cards of the server and what
 * each SDI connector does (output fill, output key, input), and the ST 2110
 * flows with their multicast addresses. Video streams then just picks one
 * of the SDI outputs or ST 2110 flows declared here.
 */

type Section = 'sdi' | 'st2110' | 'network' | 'sync';
const SECTIONS: Section[] = ['sdi', 'st2110', 'network', 'sync'];
const sectionOf = (hash: string): Section => SECTIONS.find((s) => `#${s}` === hash) ?? 'sdi';

/** Colours of the connector roles (SDI outputs are orange on Video streams, inputs violet). */
const ROLE: Record<Role, { label: string; color: string }> = {
  fill: { label: 'Output · Fill', color: '#f5a524' },
  key: { label: 'Output · Key', color: '#22d3ee' },
  input: { label: 'Input', color: '#a78bfa' },
  unused: { label: 'Unused', color: '#4b5070' },
};

const roleChoices = (cap: PortCap): Role[] => (cap === 'in' ? ['unused', 'input'] : cap === 'out' ? ['unused', 'fill', 'key'] : ['unused', 'fill', 'key', 'input']);

const nextId = (kind: string, taken: Iterable<string>) => {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
};

export function Hardware() {
  const user = useApp((s) => s.auth?.user);
  const toast = useApp((s) => s.toast);
  const { info, cfg, edit, dirty, saving, save, discard } = useServerConfig('hardware');
  const [det, setDet] = useState<HardwareInfo | null>(null);
  const [section, setSection] = useState<Section>(() => sectionOf(location.hash));

  useEffect(() => {
    const follow = () => setSection(sectionOf(location.hash));
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const detect = () =>
    api<HardwareInfo>('GET', '/api/hardware')
      .then(setDet)
      .catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => {
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!can.admin(user)) return <div className="loading">{t('Only administrators set up the hardware.')}</div>;
  if (!info || !cfg) return <div className="loading">{t('Loading settings…')}</div>;

  const hw = hardwareOf(cfg);
  /** Edits the hardware; the destinations and inputs using it follow. */
  const editHw = (fn: (hw: HardwareConfig, c: ServerConfig) => void) =>
    edit((c) => {
      c.hardware = hardwareOf(c);
      fn(c.hardware, c);
      syncUsers(c);
    });

  const go = (s: Section) => {
    setSection(s);
    history.replaceState(null, '', `#${s}`);
  };
  const nav = (
    <>
      <NavSection>{t('Hardware')}</NavSection>
      <NavItem on={section === 'sdi'} icon={<Tv size={15} />} label={t('SDI (DeckLink)')} count={hw.sdi.cards.length} status={det ? (det.decklinkSupport ? 'ok' : 'warn') : undefined} onClick={() => go('sdi')} />
      <NavItem on={section === 'st2110'} icon={<Network size={15} />} label="ST 2110" count={hw.st2110.flows.length} onClick={() => go('st2110')} />
      <NavItem on={section === 'network'} icon={<Router size={15} />} label={t('Network')} status={det?.ndiRestart ? 'warn' : undefined} onClick={() => go('network')} />
      <NavItem on={section === 'sync'} icon={<Clock size={15} />} label={t('Synchronisation')} status={det?.sync ? syncDot(hw, cfg, det) : undefined} onClick={() => go('sync')} />
      <p className="lib-nav-hint">{t('Declared here, used in Video streams: an SDI or ST 2110 destination picks one of these outputs.')}</p>
      {det && (
        <div className="lib-nav-foot">
          <span className={`nav-dot ${det.desktopVideo ? 'ok' : 'off'}`} /> {det.desktopVideo ? t('Desktop Video installed') : t('Desktop Video not found')}
          <span className="muted">{tn(det.interfaces.filter((i) => !i.loopback).length, '{n} network interface', '{n} network interfaces')}</span>
        </div>
      )}
    </>
  );

  return (
    <SidePage nav={nav} className="hw-page">
      <PageHead title={TITLES[section]()} sub={subtitle(section, hw, cfg)} />
      {section === 'sdi' && <SdiSection hw={hw} det={det} cfg={cfg} editHw={editHw} />}
      {section === 'st2110' && <St2110Section hw={hw} det={det} cfg={cfg} editHw={editHw} />}
      {section === 'network' && <NetworkSection hw={hw} det={det} editHw={editHw} />}
      {section === 'sync' && <SyncSection hw={hw} det={det} cfg={cfg} editHw={editHw} onRefresh={() => void detect()} />}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
    </SidePage>
  );
}

type EditHw = (fn: (hw: HardwareConfig, c: ServerConfig) => void) => void;

const TITLES: Record<Section, () => string> = {
  sdi: () => t('SDI (DeckLink)'),
  st2110: () => 'ST 2110',
  network: () => t('Network'),
  sync: () => t('Synchronisation'),
};

function subtitle(section: Section, hw: HardwareConfig, cfg: ServerConfig): string {
  const outFlows = hw.st2110.flows.filter((f) => f.direction === 'output').length;
  switch (section) {
    case 'sdi':
      return `${tn(hw.sdi.cards.length, '{n} card', '{n} cards')} · ${tn(hw.sdi.outputs.length, '{n} output', '{n} outputs')} · ${tn(hw.sdi.inputs.length, '{n} input', '{n} inputs')}`;
    case 'st2110':
      return `${tn(outFlows, '{n} output flow', '{n} output flows')} · ${tn(hw.st2110.flows.length - outFlows, '{n} input flow', '{n} input flows')}`;
    case 'network':
      return t('Which interface carries control, NDI and the ST 2110 media networks');
    case 'sync':
      return t('Default reference: {reference}', { reference: clockLabel(hw.sync!.reference) }) + (cfg.channels.some((c) => c.clock) ? ` · ${t('some channels choose their own')}` : '');
  }
}

/** The references the channels use, resolved. */
const referencesOf = (hw: HardwareConfig, cfg: ServerConfig) => new Set(cfg.channels.map((c) => c.clock ?? hw.sync!.reference));

function syncDot(hw: HardwareConfig, cfg: ServerConfig, det: HardwareInfo): 'ok' | 'warn' {
  const s = det.sync!;
  if (referencesOf(hw, cfg).has('ptp') && !s.ptp.locked) return 'warn';
  return s.ntp.synced === false ? 'warn' : 'ok';
}

/** Confirms the removal of something Video streams uses (its destinations and inputs go too). */
async function confirmUsers(cfg: ServerConfig, id: string, what: string): Promise<boolean> {
  const users = usersOf(cfg, id);
  if (!users.length) return true;
  return confirmDialog({
    title: t('Remove “{name}”?', { name: what }),
    message: `${tn(users.length, 'Used by {n} destination or input in Video streams, removed too:', 'Used by {n} destinations or inputs in Video streams, removed too:')} ${users.join(', ')}`,
    confirm: t('Remove'),
    danger: true,
  });
}

// ---------------------------------------------------------------- SDI ----

function Detection({ det }: { det: HardwareInfo | null }) {
  if (!det) return <div className="hw-detect muted small">{t('Detecting…')}</div>;
  return (
    <div className="hw-detect">
      <div className={`hw-det-item ${det.desktopVideo ? 'ok' : 'warn'}`}>
        {det.desktopVideo ? <CircleCheck size={16} /> : <CircleX size={16} />}
        <div>
          <strong>{det.desktopVideo ? t('Blackmagic Desktop Video is installed') : t('Blackmagic Desktop Video not found')}</strong>
          <span>{det.desktopVideo ? <code>{det.desktopVideoPath}</code> : t('The DeckLink driver, from blackmagicdesign.com: the cards need it.')}</span>
        </div>
      </div>
      <div className={`hw-det-item ${det.decklinkSupport ? 'ok' : 'warn'}`}>
        {det.decklinkSupport ? <CircleCheck size={16} /> : <TriangleAlert size={16} />}
        <div>
          <strong>{det.decklinkSupport ? t('This server drives DeckLink cards') : t('This server is built without DeckLink support')}</strong>
          <span>{det.decklinkSupport ? t('SDI outputs and inputs start with the engine.') : t('SDI outputs and inputs can be set up, but report “DeckLink support is not built” until a server with it is installed (Linux packages are built without it).')}</span>
        </div>
      </div>
      {det.decklinkDevices && det.decklinkDevices.length > 0 ? (
        <div className="hw-det-devices">
          <span className="set-label">{t('Devices seen by the driver')}</span>
          {det.decklinkDevices.map((d, i) => (
            <span key={i} className="chip">
              <code>{i}</code> {d}
            </span>
          ))}
        </div>
      ) : (
        <p className="hw-note">
          <Info size={13} /> {det.decklinkSupport && det.decklinkError ? det.decklinkError : t('Declare your cards below, with their model and device index (the order of Desktop Video).')}
        </p>
      )}
    </div>
  );
}

function SdiSection({ hw, det, cfg, editHw }: { hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw }) {
  const [model, setModel] = useState<SdiModel>('duo2');
  const [sel, setSel] = useState<{ card: string; connector: number } | null>(null);

  const addCard = () => {
    const m = modelOf(model);
    const id = nextId('card', hw.sdi.cards.map((c) => c.id));
    // The next free device index.
    const device = hw.sdi.cards.reduce((n, c) => Math.max(n, c.device + (modelOf(c.model).oneDevice ? 1 : c.connectors.length)), 0);
    editHw((h) => void h.sdi.cards.push({ id, name: m.id === 'other' ? t('DeckLink card') : m.label, model: m.id, device, connectors: Array.from({ length: m.ports.length || 2 }, () => ({ name: '' })) }));
  };

  const removeCard = async (c: SdiCard) => {
    const defs = [...hw.sdi.outputs.filter((o) => o.card === c.id), ...hw.sdi.inputs.filter((i) => i.card === c.id)];
    const users = defs.flatMap((d) => usersOf(cfg, d.id));
    if (!(await confirmDialog({ title: t('Remove the card “{name}”?', { name: c.name }), message: users.length ? `${tn(users.length, 'Used by {n} destination or input in Video streams, removed too:', 'Used by {n} destinations or inputs in Video streams, removed too:')} ${users.join(', ')}` : tn(defs.length, 'Its {n} SDI output or input is removed too.', 'Its {n} SDI outputs and inputs are removed too.'), confirm: t('Remove'), danger: true }))) return;
    editHw((h, all) => {
      for (const d of defs) dropUsers(all, d.id);
      h.sdi.outputs = h.sdi.outputs.filter((o) => o.card !== c.id);
      h.sdi.inputs = h.sdi.inputs.filter((i) => i.card !== c.id);
      h.sdi.cards = h.sdi.cards.filter((x) => x.id !== c.id);
    });
  };

  /** Gives a connector a role: makes or unmakes the output or input behind it. */
  const setRole = async (card: SdiCard, n: number, role: Role) => {
    const cur = roleOf(hw, card.id, n);
    if (cur.role === role) return;
    const ports = portsOf(card);
    // What goes: a fill takes its output with it.
    if (cur.role === 'fill' && cur.output && !(await confirmUsers(cfg, cur.output.id, cur.output.name))) return;
    if (cur.role === 'input' && cur.input && !(await confirmUsers(cfg, cur.input.id, cur.input.name))) return;
    if (role === 'key') {
      // The key of the output whose fill is just before, or of one without a key.
      const target = hw.sdi.outputs.find((o) => o.card === card.id && o.fill === n - 1 && (o.key == null || o.mode !== 'externalKey')) ?? hw.sdi.outputs.find((o) => o.card === card.id && (o.key == null || o.mode !== 'externalKey') && o.fill !== n);
      if (!target) return useApp.getState().toast(t('Make a connector an output fill first: the key goes with it.'), 'info');
    }
    editHw((h, all) => {
      const label = card.connectors[n]?.name.trim();
      if (cur.role === 'fill' && cur.output) {
        dropUsers(all, cur.output.id);
        h.sdi.outputs = h.sdi.outputs.filter((o) => o.id !== cur.output!.id);
      } else if (cur.role === 'key' && cur.output) {
        const o = h.sdi.outputs.find((x) => x.id === cur.output!.id)!;
        o.key = null;
        if (o.mode === 'externalKey') o.mode = 'fillOnly';
      } else if (cur.role === 'input' && cur.input) {
        dropUsers(all, cur.input.id);
        h.sdi.inputs = h.sdi.inputs.filter((i) => i.id !== cur.input!.id);
      }
      if (role === 'fill') {
        // The next connector becomes its key when it is free and can send.
        const next = n + 1;
        const keyFree = next < ports.length && ports[next] !== 'in' && roleOf(h, card.id, next).role === 'unused';
        const id = nextId('sdi-out', h.sdi.outputs.map((o) => o.id));
        h.sdi.outputs.push({ id, name: label || `SDI ${h.sdi.outputs.length + 1}`, card: card.id, fill: n, key: keyFree ? next : null, mode: keyFree ? 'externalKey' : 'fillOnly', genlock: false });
      } else if (role === 'key') {
        const o = h.sdi.outputs.find((x) => x.card === card.id && x.fill === n - 1 && (x.key == null || x.mode !== 'externalKey')) ?? h.sdi.outputs.find((x) => x.card === card.id && (x.key == null || x.mode !== 'externalKey') && x.fill !== n)!;
        o.key = n;
        o.mode = 'externalKey';
      } else if (role === 'input') {
        const id = nextId('sdi-in', h.sdi.inputs.map((i) => i.id));
        h.sdi.inputs.push({ id, name: label || `${t('SDI input')} ${h.sdi.inputs.length + 1}`, card: card.id, connector: n });
      }
    });
    setSel({ card: card.id, connector: n });
  };

  const removeOutput = async (id: string) => {
    const o = hw.sdi.outputs.find((x) => x.id === id);
    if (!o || !(await confirmUsers(cfg, id, o.name))) return;
    editHw((h, all) => {
      dropUsers(all, id);
      h.sdi.outputs = h.sdi.outputs.filter((x) => x.id !== id);
    });
  };
  const removeInput = async (id: string) => {
    const i = hw.sdi.inputs.find((x) => x.id === id);
    if (!i || !(await confirmUsers(cfg, id, i.name))) return;
    editHw((h, all) => {
      dropUsers(all, id);
      h.sdi.inputs = h.sdi.inputs.filter((x) => x.id !== id);
    });
  };

  const cardName = (id: string) => hw.sdi.cards.find((c) => c.id === id)?.name ?? '?';

  return (
    <>
      <Detection det={det} />

      {hw.sdi.cards.map((c) => {
        const m = modelOf(c.model);
        const ports = portsOf(c);
        return (
          <Card
            key={c.id}
            icon={<CircuitBoard size={16} />}
            title={c.name || m.label}
            actions={
              <button className="icon-btn ghost" title={t('Remove the card')} onClick={() => void removeCard(c)}>
                <Trash2 size={15} />
              </button>
            }
          >
            <div className="hw-card-grid">
              <label className="set-field">
                <span className="set-label">{t('Name')}</span>
                <input value={c.name} onChange={(e) => editHw((h) => void (h.sdi.cards.find((x) => x.id === c.id)!.name = e.target.value))} />
              </label>
              <label className="set-field">
                <span className="set-label">{t('Model')}</span>
                <select
                  value={c.model}
                  onChange={(e) =>
                    editHw((h) => {
                      const x = h.sdi.cards.find((y) => y.id === c.id)!;
                      const nm = modelOf(e.target.value);
                      x.model = nm.id;
                      const count = nm.ports.length || x.connectors.length;
                      x.connectors = Array.from({ length: count }, (_, i) => x.connectors[i] ?? { name: '' });
                      // Connectors the new model has not lose what they did.
                      h.sdi.outputs = h.sdi.outputs.filter((o) => o.card !== c.id || o.fill < count);
                      for (const o of h.sdi.outputs) if (o.card === c.id && o.key != null && o.key >= count) o.key = null;
                      h.sdi.inputs = h.sdi.inputs.filter((i) => i.card !== c.id || i.connector < count);
                    })
                  }
                >
                  {SDI_MODELS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.id === 'other' ? t(x.label) : x.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="set-field">
                <span className="set-label">{t('Device index')}</span>
                <input type="number" min={0} max={63} value={c.device} onChange={(e) => editHw((h) => void (h.sdi.cards.find((x) => x.id === c.id)!.device = Math.max(0, Math.round(+e.target.value) || 0)))} />
              </label>
              {c.model === 'other' && (
                <label className="set-field">
                  <span className="set-label">{t('SDI connectors')}</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={c.connectors.length}
                    onChange={(e) =>
                      editHw((h) => {
                        const x = h.sdi.cards.find((y) => y.id === c.id)!;
                        const count = Math.max(1, Math.min(16, Math.round(+e.target.value) || 1));
                        x.connectors = Array.from({ length: count }, (_, i) => x.connectors[i] ?? { name: '' });
                        h.sdi.outputs = h.sdi.outputs.filter((o) => o.card !== c.id || o.fill < count);
                        for (const o of h.sdi.outputs) if (o.card === c.id && o.key != null && o.key >= count) o.key = null;
                        h.sdi.inputs = h.sdi.inputs.filter((i) => i.card !== c.id || i.connector < count);
                      })
                    }
                  />
                </label>
              )}
            </div>
            <span className="set-hint">{m.oneDevice ? t('Index of the card in Desktop Video (0 = first).') : t('Index of its first connector in Desktop Video (0 = first): each connector is a device, {first} to {last}.', { first: c.device, last: c.device + c.connectors.length - 1 })}</span>

            <CardDrawing card={c} hw={hw} sel={sel?.card === c.id ? sel.connector : null} onPick={(n) => setSel({ card: c.id, connector: n })} />

            <div className="hw-ports">
              <div className="hw-ports-head">
                <span>{t('Connector')}</span>
                <span>{t('Wired to')}</span>
                <span>{t('Role')}</span>
                <span>{t('Used as')}</span>
              </div>
              {c.connectors.map((p, n) => {
                const r = roleOf(hw, c.id, n);
                const cap = ports[n] ?? 'both';
                return (
                  <div key={n} className={`hw-port-row ${sel?.card === c.id && sel.connector === n ? 'sel' : ''}`} style={{ ['--k' as string]: ROLE[r.role].color }} onClick={() => setSel({ card: c.id, connector: n })}>
                    <span className="hw-port-name">
                      <span className="hw-port-dot" />
                      SDI {n + 1}
                      <small>{cap === 'in' ? t('in') : cap === 'out' ? t('out') : t('in / out')}</small>
                    </span>
                    <input value={p.name} placeholder={t('e.g. Mixer key 3')} aria-label={t('Wired to')} onChange={(e) => editHw((h) => void (h.sdi.cards.find((x) => x.id === c.id)!.connectors[n].name = e.target.value))} />
                    <select value={r.role} aria-label={t('Role')} onChange={(e) => void setRole(c, n, e.target.value as Role)}>
                      {roleChoices(cap).map((x) => (
                        <option key={x} value={x}>
                          {t(ROLE[x].label)}
                        </option>
                      ))}
                    </select>
                    <span className="hw-port-use">{r.output ? `${r.output.name}${r.role === 'key' ? ` (${t('key')})` : ''}` : r.input ? r.input.name : '—'}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <div className="hw-add">
        <select value={model} onChange={(e) => setModel(e.target.value as SdiModel)} aria-label={t('Model')}>
          {SDI_MODELS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === 'other' ? t(x.label) : x.label}
              {x.ports.length ? ` · ${portSummary(x.ports)}` : ''}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={addCard}>
          <Plus size={14} /> {t('Add a card')}
        </button>
      </div>

      <Card icon={<ArrowUpFromLine size={16} />} title={t('SDI outputs')}>
        {hw.sdi.outputs.length === 0 ? (
          <p className="muted small">{t('No SDI output yet: give a connector the role “Output · Fill” (and the next one “Output · Key” for an external keyer).')}</p>
        ) : (
          <div className="hw-table">
            <div className="hw-row head out">
              <span>{t('Name')}</span>
              <span>{t('Connectors')}</span>
              <span>{t('Signal')}</span>
              <span>Genlock</span>
              <span>{t('Used by')}</span>
              <span />
            </div>
            {hw.sdi.outputs.map((o) => {
              const card = hw.sdi.cards.find((c) => c.id === o.card);
              const users = usersOf(cfg, o.id);
              const keyOptions = card ? card.connectors.map((_, n) => n).filter((n) => n !== o.fill && portsOf(card)[n] !== 'in' && (o.key === n || roleOf(hw, card.id, n).role === 'unused')) : [];
              return (
                <div key={o.id} className="hw-row out">
                  <input value={o.name} aria-label={t('Name')} onChange={(e) => editHw((h) => void (h.sdi.outputs.find((x) => x.id === o.id)!.name = e.target.value))} />
                  <span className="hw-conn">
                    {cardName(o.card)} · SDI {o.fill + 1}
                    {o.mode === 'externalKey' && (
                      <>
                        {' + '}
                        <select value={o.key ?? ''} aria-label={t('Key connector')} onChange={(e) => editHw((h) => void (h.sdi.outputs.find((x) => x.id === o.id)!.key = e.target.value === '' ? null : +e.target.value))}>
                          <option value="">{t('no key')}</option>
                          {keyOptions.map((n) => (
                            <option key={n} value={n}>
                              SDI {n + 1}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    {card && <small>{t('device {n}', { n: deviceOf(card, o.fill) })}</small>}
                  </span>
                  <select value={o.mode} aria-label={t('Signal')} onChange={(e) => editHw((h) => void (h.sdi.outputs.find((x) => x.id === o.id)!.mode = e.target.value as SdiMode))}>
                    {MODES.map((x) => (
                      <option key={x.value} value={x.value}>
                        {t(x.label)}
                      </option>
                    ))}
                  </select>
                  <label className="check">
                    <input type="checkbox" checked={o.genlock} onChange={(e) => editHw((h) => void (h.sdi.outputs.find((x) => x.id === o.id)!.genlock = e.target.checked))} />
                    {t('Reference input')}
                  </label>
                  <span className="hw-users" title={users.join('\n')}>
                    {users.length ? users.join(', ') : t('not used')}
                  </span>
                  <button className="icon-btn ghost" title={t('Remove')} onClick={() => void removeOutput(o.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <span className="set-hint">{t('External keyer: fill and key on two connectors. Internal keyer: the card keys the graphics over its SDI input. Genlock locks the output to the reference input of the card.')}</span>
      </Card>

      <Card icon={<ArrowDownToLine size={16} />} title={t('SDI inputs')}>
        {hw.sdi.inputs.length === 0 ? (
          <p className="muted small">{t('No SDI input yet: give a connector the role “Input”.')}</p>
        ) : (
          <div className="hw-table">
            <div className="hw-row head in">
              <span>{t('Name')}</span>
              <span>{t('Connector')}</span>
              <span>{t('Used by')}</span>
              <span />
            </div>
            {hw.sdi.inputs.map((i) => {
              const users = usersOf(cfg, i.id);
              const card = hw.sdi.cards.find((c) => c.id === i.card);
              return (
                <div key={i.id} className="hw-row in">
                  <input value={i.name} aria-label={t('Name')} onChange={(e) => editHw((h) => void (h.sdi.inputs.find((x) => x.id === i.id)!.name = e.target.value))} />
                  <span className="hw-conn">
                    {cardName(i.card)} · SDI {i.connector + 1}
                    {card && <small>{t('device {n}', { n: deviceOf(card, i.connector) })}</small>}
                  </span>
                  <span className="hw-users">{users.length ? users.join(', ') : t('not used')}</span>
                  <button className="icon-btn ghost" title={t('Remove')} onClick={() => void removeInput(i.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <span className="set-hint">{t('Video streams › Inputs shows them with the Video widget.')}</span>
      </Card>
    </>
  );
}

/** "1 out", "4 in / out". */
function portSummary(ports: PortCap[]): string {
  const ins = ports.filter((p) => p === 'in').length;
  const outs = ports.filter((p) => p === 'out').length;
  const both = ports.filter((p) => p === 'both').length;
  return [ins && `${ins} ${t('in')}`, outs && `${outs} ${t('out')}`, both && `${both} ${t('in / out')}`].filter(Boolean).join(' + ');
}

/**
 * The card as seen from the back of the machine: its bracket with the BNC
 * connectors, each ringed with the colour of its role; the board behind.
 */
function CardDrawing({ card, hw, sel, onPick }: { card: SdiCard; hw: HardwareConfig; sel: number | null; onPick: (n: number) => void }) {
  const n = card.connectors.length;
  const step = 76;
  const left = 70;
  const w = Math.max(420, left + n * step + 40);
  const h = 160;
  const by = 52; // bracket top
  const cy = by + 40; // connector centre
  return (
    <svg className="hw-drawing" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`${card.name}: ${n} SDI`}>
      {/* The board behind the bracket, with its gold fingers. */}
      <rect x={left - 20} y={10} width={w - left - 10} height={46} rx={4} className="hw-pcb" />
      {Array.from({ length: Math.floor((w - left - 60) / 9) }, (_, i) => (
        <rect key={i} x={left + 10 + i * 9} y={12} width={5} height={8} className="hw-finger" />
      ))}
      <rect x={w - 150} y={26} width={58} height={24} rx={3} className="hw-chip" />
      <text x={w - 121} y={42} className="hw-chip-text" textAnchor="middle">
        {modelOf(card.model).id === 'other' ? 'DeckLink' : modelOf(card.model).label.replace('DeckLink ', '')}
      </text>
      {/* The bracket. */}
      <rect x={10} y={by} width={w - 20} height={h - by - 4} rx={6} className="hw-bracket" />
      <circle cx={26} cy={by + 40} r={5} className="hw-screw" />
      <text x={left - 14} y={by + 16} className="hw-brand">
        Blackmagic
      </text>
      {card.connectors.map((p, i) => {
        const r = roleOf(hw, card.id, i);
        const x = left + 20 + i * step;
        const color = ROLE[r.role].color;
        return (
          <g key={i} className={`hw-bnc ${sel === i ? 'sel' : ''} role-${r.role}`} onClick={() => onPick(i)} style={{ cursor: 'pointer' }}>
            <title>{`SDI ${i + 1} · ${t(ROLE[r.role].label)}${p.name ? ` · ${p.name}` : ''}${r.output ? ` · ${r.output.name}` : r.input ? ` · ${r.input.name}` : ''}`}</title>
            {sel === i && <circle cx={x} cy={cy} r={27} className="hw-bnc-sel" />}
            <circle cx={x} cy={cy} r={22} fill="none" stroke={color} strokeWidth={r.role === 'unused' ? 2 : 4} />
            <polygon points={hexagon(x, cy, 16)} className="hw-bnc-nut" />
            <circle cx={x} cy={cy} r={10} className="hw-bnc-body" />
            <circle cx={x} cy={cy} r={6} className="hw-bnc-insulator" />
            <circle cx={x} cy={cy} r={2.2} className="hw-bnc-pin" />
            <rect x={x + 9} y={cy - 2} width={9} height={4} rx={1} className="hw-bnc-lug" />
            <text x={x} y={by + 77} textAnchor="middle" className="hw-bnc-label">
              SDI {i + 1}
            </text>
            <text x={x} y={by + 93} textAnchor="middle" className={`hw-bnc-role ${r.role}`}>
              {r.role === 'fill' ? 'FILL' : r.role === 'key' ? 'KEY' : r.role === 'input' ? 'IN' : '—'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const hexagon = (x: number, y: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

// ------------------------------------------------------------ ST 2110 ----

function St2110Section({ hw, det, cfg, editHw }: { hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw }) {
  const ifaces = det?.interfaces ?? [];
  const add = (direction: St2110Flow['direction']) =>
    editHw((h) => {
      const id = nextId('flow', h.st2110.flows.map((f) => f.id));
      const used = new Set(h.st2110.flows.flatMap((f) => [f.fill, f.key ?? '']));
      let k = 1;
      const base = direction === 'output' ? 100 : 200;
      while (used.has(`239.${base}.${k}.1:5004`)) k++;
      const n = h.st2110.flows.filter((f) => f.direction === direction).length + 1;
      h.st2110.flows.push({ id, name: direction === 'output' ? t('ST 2110 output {n}', { n }) : t('ST 2110 input {n}', { n }), direction, encoding: 'fillKey', fill: `239.${base}.${k}.1:5004`, key: `239.${base}.${k}.2:5004`, interface: null, ttl: 32, payloadType: 96 });
    });
  const remove = async (f: St2110Flow) => {
    if (!(await confirmUsers(cfg, f.id, f.name))) return;
    editHw((h, all) => {
      dropUsers(all, f.id);
      h.st2110.flows = h.st2110.flows.filter((x) => x.id !== f.id);
    });
  };
  const editFlow = (id: string, fn: (f: St2110Flow) => void) => editHw((h) => fn(h.st2110.flows.find((x) => x.id === id)!));

  return (
    <>
      <Card icon={<Network size={16} />} title={t('Network interfaces')}>
        {!det ? (
          <p className="muted small">{t('Detecting…')}</p>
        ) : (
          <div className="hw-ifaces">
            {ifaces.map((i) => (
              <div key={i.name + i.ip} className={`hw-iface ${i.loopback ? 'lo' : ''}`}>
                <EthernetIcon />
                <strong>{i.name}</strong>
                <code>{i.ip}</code>
                {i.loopback && <span className="chip">{t('loopback')}</span>}
                <span className="muted small">{tn(hw.st2110.flows.filter((f) => f.interface === i.ip).length, '{n} flow', '{n} flows')}</span>
              </div>
            ))}
          </div>
        )}
        <span className="set-hint">{t('ST 2110 needs a media network on its own interface, with PTP: keep this server PTP-disciplined (ptp4l + phc2sys on Linux). The Media red and blue interfaces are set in Network.')}</span>
      </Card>

      <Card
        icon={<ArrowUpFromLine size={16} />}
        title={t('Flows')}
        actions={
          <>
            <button className="btn small" onClick={() => add('output')}>
              <Plus size={13} /> {t('Output flow')}
            </button>
            <button className="btn small" onClick={() => add('input')}>
              <Plus size={13} /> {t('Input flow')}
            </button>
          </>
        }
      >
        {hw.st2110.flows.length === 0 && <p className="muted small">{t('No flow yet. An output flow is what a channel sends (fill and key multicast groups); Video streams then picks it for an ST 2110 destination.')}</p>}
        {hw.st2110.flows.map((f) => {
          const two = f.encoding === 'fillKey';
          const [fip, fport] = splitAddr(f.fill);
          const [kip, kport] = splitAddr(f.key);
          const users = usersOf(cfg, f.id);
          return (
            <div key={f.id} className={`hw-flow ${f.direction}`}>
              <div className="hw-flow-head">
                {f.direction === 'output' ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}
                <input className="hw-flow-name" value={f.name} aria-label={t('Name')} onChange={(e) => editFlow(f.id, (x) => void (x.name = e.target.value))} />
                <div className="seg">
                  {(['output', 'input'] as const).map((d) => (
                    <button key={d} type="button" className={f.direction === d ? 'on' : ''} disabled={d !== f.direction && users.length > 0} title={d !== f.direction && users.length > 0 ? t('Used in Video streams') : undefined} onClick={() => editFlow(f.id, (x) => void (x.direction = d))}>
                      {d === 'output' ? tc('flow', 'Output') : tc('flow', 'Input')}
                    </button>
                  ))}
                </div>
                <span className="hw-users" title={users.join('\n')}>
                  {users.length ? t('Used by {list}', { list: users.join(', ') }) : t('not used')}
                </span>
                <button className="icon-btn ghost" title={t('Remove')} onClick={() => void remove(f)}>
                  <Trash2 size={14} />
                </button>
              </div>
              {f.direction === 'input' && (
                <p className="hw-note warn">
                  <TriangleAlert size={13} /> {t('Receiving ST 2110 is not available yet: the flow can be defined, its input reports so.')}
                </p>
              )}
              <div className="hw-flow-grid">
                <label className="set-field wide">
                  <span className="set-label">{t('Encoding')}</span>
                  <select value={f.encoding} onChange={(e) => editFlow(f.id, (x) => void ((x.encoding = e.target.value as St2110Flow['encoding']), x.encoding === 'fillKey' && !x.key && (x.key = joinAddr(fip.replace(/\d+$/, (v) => String(+v + 1)), fport))))}>
                    {ENCODINGS.map((x) => (
                      <option key={x.value} value={x.value}>
                        {t(x.label)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="set-field wide">
                  <span className="set-label">{t('Network interface')}</span>
                  <select value={f.interface ?? ''} onChange={(e) => editFlow(f.id, (x) => void (x.interface = e.target.value || null))}>
                    <option value="">{roleDefault(hw.network!.mediaRed, ifaces)}</option>
                    {f.interface && !ifaces.some((i) => i.ip === f.interface) && <option value={f.interface}>{f.interface}</option>}
                    {ifaces.map((i) => (
                      <option key={i.ip} value={i.ip}>
                        {i.name} — {i.ip}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="set-field">
                  <span className="set-label">{two ? t('Fill — multicast') : t('Stream — multicast')}</span>
                  <input value={fip} placeholder="239.100.1.1" spellCheck={false} onChange={(e) => editFlow(f.id, (x) => void (x.fill = joinAddr(e.target.value, fport)))} />
                </label>
                <label className="set-field hw-num">
                  <span className="set-label">{t('Port')}</span>
                  <input type="number" min={1} max={65535} value={fport} onChange={(e) => editFlow(f.id, (x) => void (x.fill = joinAddr(fip, e.target.value)))} />
                </label>
                {two ? (
                  <>
                    <label className="set-field">
                      <span className="set-label">{t('Key — multicast')}</span>
                      <input value={kip} placeholder={t('none')} spellCheck={false} onChange={(e) => editFlow(f.id, (x) => void (x.key = e.target.value.trim() ? joinAddr(e.target.value, kport || '5004') : null))} />
                    </label>
                    <label className="set-field hw-num">
                      <span className="set-label">{t('Port')}</span>
                      <input type="number" min={1} max={65535} value={kport} disabled={!f.key} onChange={(e) => editFlow(f.id, (x) => void (x.key = joinAddr(kip, e.target.value)))} />
                    </label>
                  </>
                ) : (
                  <span className="hw-flow-gap" />
                )}
                <label className="set-field hw-num">
                  <span className="set-label">TTL</span>
                  <input type="number" min={1} max={255} value={f.ttl} onChange={(e) => editFlow(f.id, (x) => void (x.ttl = Math.max(1, Math.min(255, Math.round(+e.target.value) || 1))))} />
                </label>
                <label className="set-field hw-num">
                  <span className="set-label">{t('Payload type')}</span>
                  <input type="number" min={96} max={127} value={f.payloadType} onChange={(e) => editFlow(f.id, (x) => void (x.payloadType = Math.max(96, Math.min(127, Math.round(+e.target.value) || 96))))} />
                </label>
              </div>
              <label className="hw-check hw-blue-toggle">
                <input
                  type="checkbox"
                  checked={!!f.blue}
                  onChange={(e) =>
                    editFlow(f.id, (x) => {
                      if (!e.target.checked) return void (x.blue = x.blueKey = x.blueInterface = null);
                      // Blue groups default to the next /16 of the red ones (239.100.x → 239.101.x).
                      const shift = (a: string) => a.replace(/^(\d+)\.(\d+)\./, (_, a1, a2) => `${a1}.${Math.min(255, +a2 + 1)}.`);
                      x.blue = shift(x.fill);
                      x.blueKey = x.key ? shift(x.key) : null;
                    })
                  }
                />
                <span>{t('SMPTE 2022-7: also send on the blue network')}</span>
              </label>
              {f.blue && <BlueLeg f={f} two={two} ifaces={ifaces} blueRole={hw.network!.mediaBlue} editFlow={editFlow} />}
            </div>
          );
        })}
        <span className="set-hint">{t('Fill + Key: two ST 2110-20 streams, what most vision mixers and keyers expect. RGBA and YCbCrA carry the alpha in one stream, for receivers that read it.')}</span>
      </Card>
    </>
  );
}

/** The label of "no interface chosen": the network role's one, when set. */
function roleDefault(role: string, ifaces: HardwareInfo['interfaces']): string {
  if (!role) return t('System default');
  const ip = ifaces.find((i) => i.name === role)?.ip;
  return t('Network role: {iface}', { iface: ip ? `${role} — ${ip}` : role });
}

function BlueLeg({ f, two, ifaces, blueRole, editFlow }: { f: St2110Flow; two: boolean; ifaces: HardwareInfo['interfaces']; blueRole: string; editFlow: (id: string, fn: (f: St2110Flow) => void) => void }) {
  const [bip, bport] = splitAddr(f.blue);
  const [bkip, bkport] = splitAddr(f.blueKey);
  return (
    <div className="hw-blue">
      <label className="set-field wide">
        <span className="set-label">{t('Blue interface')}</span>
        <select value={f.blueInterface ?? ''} onChange={(e) => editFlow(f.id, (x) => void (x.blueInterface = e.target.value || null))}>
          <option value="">{roleDefault(blueRole, ifaces)}</option>
          {f.blueInterface && !ifaces.some((i) => i.ip === f.blueInterface) && <option value={f.blueInterface}>{f.blueInterface}</option>}
          {ifaces.map((i) => (
            <option key={i.ip} value={i.ip}>
              {i.name} — {i.ip}
            </option>
          ))}
        </select>
      </label>
      <label className="set-field">
        <span className="set-label">{two ? t('Blue fill — multicast') : t('Blue stream — multicast')}</span>
        <input value={bip} placeholder="239.101.1.1" spellCheck={false} onChange={(e) => editFlow(f.id, (x) => void (x.blue = joinAddr(e.target.value, bport)))} />
      </label>
      <label className="set-field hw-num">
        <span className="set-label">{t('Port')}</span>
        <input type="number" min={1} max={65535} value={bport} onChange={(e) => editFlow(f.id, (x) => void (x.blue = joinAddr(bip, e.target.value)))} />
      </label>
      {two && (
        <>
          <label className="set-field">
            <span className="set-label">{t('Blue key — multicast')}</span>
            <input value={bkip} placeholder="239.101.1.2" spellCheck={false} onChange={(e) => editFlow(f.id, (x) => void (x.blueKey = e.target.value.trim() ? joinAddr(e.target.value, bkport || '5004') : null))} />
          </label>
          <label className="set-field hw-num">
            <span className="set-label">{t('Port')}</span>
            <input type="number" min={1} max={65535} value={bkport} disabled={!f.blueKey} onChange={(e) => editFlow(f.id, (x) => void (x.blueKey = joinAddr(bkip, e.target.value)))} />
          </label>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------- network ----

const ROLES: { key: Exclude<keyof NetworkRoles, 'ndiDiscovery'>; label: string; hint: string; color: string }[] = [
  { key: 'control', label: 'Control', hint: 'The web interface and the API listen on this one only (and on 127.0.0.1).', color: '#9aa3c7' },
  { key: 'ndi', label: 'NDI', hint: 'NDI sends and looks for sources on this one only.', color: '#34d399' },
  { key: 'mediaRed', label: 'Media red (ST 2110)', hint: 'Primary ST 2110 network: flows without an interface of their own go out here.', color: '#f87171' },
  { key: 'mediaBlue', label: 'Media blue (ST 2110)', hint: 'Secondary network of SMPTE 2022-7 flows.', color: '#60a5fa' },
  { key: 'ptp', label: 'PTP', hint: 'The interface ptp4l runs on (its clock disciplines the system clock).', color: '#fbbf24' },
];

function NetworkSection({ hw, det, editHw }: { hw: HardwareConfig; det: HardwareInfo | null; editHw: EditHw }) {
  const net = hw.network!;
  const ifaces = (det?.interfaces ?? []).filter((i) => !i.loopback);
  const set = (k: keyof NetworkRoles, v: string) => editHw((h) => void (h.network![k] = v));
  const same = net.mediaRed && net.mediaRed === net.mediaBlue;
  return (
    <>
      {det?.ndiRestart && (
        <p className="hw-note warn hw-banner">
          <TriangleAlert size={14} /> {t('The NDI network settings changed: they apply when the server restarts (the NDI runtime reads them once).')}
        </p>
      )}
      <Card icon={<Router size={16} />} title={t('Network roles')}>
        <div className="hw-roles">
          {ROLES.map((r) => {
            const known = !net[r.key] || ifaces.some((i) => i.name === net[r.key]);
            return (
              <div key={r.key} className="hw-role">
                <span className="hw-role-dot" style={{ background: r.color }} />
                <div className="hw-role-text">
                  <strong>{t(r.label)}</strong>
                  <span>{t(r.hint)}</span>
                </div>
                <select value={net[r.key]} onChange={(e) => set(r.key, e.target.value)} aria-label={t(r.label)}>
                  <option value="">{r.key === 'control' ? t('Every interface') : t('Not set')}</option>
                  {!known && <option value={net[r.key]}>{t('{name} (not found)', { name: net[r.key] })}</option>}
                  {ifaces.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name} — {i.ip}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {same && (
          <p className="hw-note warn">
            <TriangleAlert size={13} /> {t('Red and blue must be two different interfaces.')}
          </p>
        )}
        <Field label={t('NDI Discovery Server')} hint={t('Address of an NDI Discovery Server (several: comma separated). Empty: sources are found by mDNS on the NDI network.')}>
          <input value={net.ndiDiscovery} placeholder="10.0.0.2" spellCheck={false} onChange={(e) => set('ndiDiscovery', e.target.value)} />
        </Field>
        <span className="set-hint">{t('Interfaces are named (eth1, en0…): the name stays when the address changes. Changing the control interface moves the web interface: open it again at the new address.')}</span>
      </Card>

      <Card icon={<Network size={16} />} title={t('Interfaces of this machine')}>
        {!det ? (
          <p className="muted small">{t('Detecting…')}</p>
        ) : (
          <div className="hw-ifaces">
            {ifaces.map((i) => {
              const roles = ROLES.filter((r) => net[r.key] === i.name);
              return (
                <div key={i.name + i.ip} className="hw-iface">
                  <EthernetIcon />
                  <strong>{i.name}</strong>
                  <code>{i.ip}</code>
                  <span className="hw-role-chips">
                    {roles.length === 0 && <span className="muted small">{t('no role')}</span>}
                    {roles.map((r) => (
                      <span key={r.key} className="hw-role-chip" style={{ borderColor: r.color, color: r.color }}>
                        {t(r.label)}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

// ----------------------------------------------------------------- sync ----

const CLOCK_HINTS: Record<ClockReference, string> = {
  free: 'Frames counted from when the channel starts, on the machine clock. Enough for NDI, streams and HTML5.',
  ptp: 'Frames on the SMPTE ST 2059 grid of the system clock, disciplined by PTP (ptp4l + phc2sys): every device locked to the same grandmaster shows its frames at the same instants.',
  decklink: 'The channel follows the frame boundaries of its first SDI destination, so the reference (genlock) wired to the card.',
};

function SyncSection({ hw, det, cfg, editHw, onRefresh }: { hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw; onRefresh: () => void }) {
  const sync = hw.sync!;
  const st = det?.sync;
  const used = referencesOf(hw, cfg);
  const ntpState = !st || st.ntp.synced == null ? 'unknown' : st.ntp.synced ? 'ok' : 'bad';
  const ptpState = !st ? 'unknown' : st.ptp.locked ? 'ok' : st.ptp.running ? 'bad' : used.has('ptp') ? 'bad' : 'unknown';
  return (
    <>
      <Card
        icon={<Clock size={16} />}
        title={t('Status')}
        actions={
          <button className="btn small" onClick={onRefresh}>
            <RefreshCw size={13} /> {t('Refresh')}
          </button>
        }
      >
        <div className="hw-detect">
          <div className={`hw-det-item ${ntpState === 'ok' ? 'ok' : 'warn'}`}>
            {ntpState === 'ok' ? <CircleCheck size={16} /> : ntpState === 'bad' ? <CircleX size={16} /> : <Info size={16} />}
            <div>
              <strong>{ntpState === 'ok' ? t('System clock synchronised (NTP)') : ntpState === 'bad' ? t('System clock not synchronised (NTP)') : t('NTP status unknown')}</strong>
              <span>
                {[st?.ntp.source && t('source {source}', { source: st.ntp.source }), st?.ntp.offsetMs != null && t('offset {ms} ms', { ms: st.ntp.offsetMs.toFixed(3) }), st?.ntp.tool && t('read with {tool}', { tool: st.ntp.tool })].filter(Boolean).join(' · ') ||
                  t('Not readable on this system (macOS: needs administrator rights).')}
              </span>
            </div>
          </div>
          <div className={`hw-det-item ${ptpState === 'ok' ? 'ok' : 'warn'}`}>
            {ptpState === 'ok' ? <CircleCheck size={16} /> : ptpState === 'bad' ? <CircleX size={16} /> : <Info size={16} />}
            <div>
              <strong>{st?.ptp.locked ? t('Locked to PTP (domain {domain})', { domain: st.ptp.domain }) : st?.ptp.running ? t('PTP not locked ({state})', { state: st.ptp.portState ?? '?' }) : t('No PTP')}</strong>
              <span>
                {st?.ptp.running
                  ? [st.ptp.grandmaster && t('grandmaster {id}', { id: st.ptp.grandmaster }), st.ptp.offsetNs != null && t('offset {ns} ns', { ns: Math.round(st.ptp.offsetNs) })].filter(Boolean).join(' · ')
                  : st?.ptp.message
                    ? t(st.ptp.message)
                    : t('Detecting…')}
              </span>
            </div>
          </div>
        </div>
        <span className="set-hint">{t('Strata reads the clocks every 10 s; the operating system keeps them on time (chrony, w32time; linuxptp for PTP). Do not let NTP and phc2sys both set the same clock.')}</span>
      </Card>

      <Card icon={<Clock size={16} />} title={t('Clock reference')}>
        <div className="seg hw-clock-seg">
          {CLOCKS.map((r) => (
            <button key={r} type="button" className={sync.reference === r ? 'on' : ''} onClick={() => editHw((h) => void (h.sync!.reference = r))}>
              {clockLabel(r)}
            </button>
          ))}
        </div>
        <p className="hw-clock-hint">{t(CLOCK_HINTS[sync.reference])}</p>
        <div className="hw-sync-grid">
          <label className="set-field hw-num">
            <span className="set-label">{t('PTP domain')}</span>
            <input type="number" min={0} max={127} value={sync.ptpDomain} onChange={(e) => editHw((h) => void (h.sync!.ptpDomain = Math.max(0, Math.min(127, Math.round(+e.target.value) || 0))))} />
          </label>
          <label className="set-field hw-num">
            <span className="set-label">{t('TAI − UTC (s)')}</span>
            <input type="number" min={0} max={99} value={sync.taiOffset} onChange={(e) => editHw((h) => void (h.sync!.taiOffset = Math.max(0, Math.min(99, Math.round(+e.target.value) || 0))))} />
          </label>
        </div>
        <span className="set-hint">{t('SMPTE ST 2059-2 uses PTP domain 127. TAI − UTC is 37 s since 2017: ST 2110 RTP timestamps count TAI.')}</span>
      </Card>

      <Card icon={<Tv size={16} />} title={t('Channels')}>
        <div className="hw-table">
          {cfg.channels.map((ch) => {
            const sdi = [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs)].some((o) => (o.sdi ?? []).some((d) => d.enabled !== false));
            const ref = ch.clock ?? sync.reference;
            return (
              <div key={ch.id} className="hw-row sync">
                <strong>{ch.name}</strong>
                <span>
                  {ref === 'decklink' && !sdi && (
                    <span className="hw-note warn">
                      <TriangleAlert size={13} /> {t('no SDI destination: runs free')}
                    </span>
                  )}
                </span>
                <select
                  value={ch.clock ?? ''}
                  aria-label={t('Clock reference')}
                  onChange={(e) =>
                    editHw((_, all) => {
                      const c = all.channels.find((x) => x.id === ch.id)!;
                      c.clock = (e.target.value || null) as ClockReference | null;
                    })
                  }
                >
                  <option value="">{t('Default ({reference})', { reference: clockLabel(sync.reference) })}</option>
                  {CLOCKS.map((r) => (
                    <option key={r} value={r}>
                      {clockLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

function EthernetIcon() {
  return <Network size={15} className="hw-iface-icon" />;
}

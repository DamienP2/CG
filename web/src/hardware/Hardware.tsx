import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, CircuitBoard, Info, Network, Plus, Trash2, TriangleAlert, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t, tc, tn } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { Card, SaveBar } from '../settings/ui';
import { useServerConfig } from '../settings/serverConfig';
import { joinAddr, splitAddr, type HardwareConfig, type HardwareInfo, type SdiCard, type SdiModel, type SdiMode, type ServerConfig, type St2110Flow } from '../outputs/types';
import { api, can, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { ENCODINGS, MODES, SDI_MODELS, deviceOf, dropUsers, hardwareOf, modelOf, portsOf, roleOf, syncUsers, usersOf, type PortCap, type Role } from './model';
import './hardware.css';

/*
 * The Hardware page (admins): the DeckLink cards of the server and what
 * each SDI connector does (output fill, output key, input), and the ST 2110
 * flows with their multicast addresses. Video streams then just picks one
 * of the SDI outputs or ST 2110 flows declared here.
 */

type Section = 'sdi' | 'st2110';

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
  const [section, setSection] = useState<Section>(() => (location.hash === '#st2110' ? 'st2110' : 'sdi'));

  useEffect(() => {
    const follow = () => setSection(location.hash === '#st2110' ? 'st2110' : 'sdi');
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  useEffect(() => {
    api<HardwareInfo>('GET', '/api/hardware')
      .then(setDet)
      .catch((e) => toast((e as Error).message, 'error'));
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
  const outFlows = hw.st2110.flows.filter((f) => f.direction === 'output').length;
  const nav = (
    <>
      <NavSection>{t('Hardware')}</NavSection>
      <NavItem on={section === 'sdi'} icon={<Tv size={15} />} label={t('SDI (DeckLink)')} count={hw.sdi.cards.length} status={det ? (det.decklinkSupport ? 'ok' : 'warn') : undefined} onClick={() => go('sdi')} />
      <NavItem on={section === 'st2110'} icon={<Network size={15} />} label="ST 2110" count={hw.st2110.flows.length} onClick={() => go('st2110')} />
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
      <PageHead
        title={section === 'sdi' ? t('SDI (DeckLink)') : 'ST 2110'}
        sub={
          section === 'sdi'
            ? `${tn(hw.sdi.cards.length, '{n} card', '{n} cards')} · ${tn(hw.sdi.outputs.length, '{n} output', '{n} outputs')} · ${tn(hw.sdi.inputs.length, '{n} input', '{n} inputs')}`
            : `${tn(outFlows, '{n} output flow', '{n} output flows')} · ${tn(hw.st2110.flows.length - outFlows, '{n} input flow', '{n} input flows')}`
        }
      />
      {section === 'sdi' ? <SdiSection hw={hw} det={det} cfg={cfg} editHw={editHw} /> : <St2110Section hw={hw} det={det} cfg={cfg} editHw={editHw} />}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
    </SidePage>
  );
}

type EditHw = (fn: (hw: HardwareConfig, c: ServerConfig) => void) => void;

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
          <span>{det.decklinkSupport ? t('SDI outputs and inputs start with the engine.') : t('SDI outputs and inputs can be set up, but report “DeckLink support is not built” until a server with it is installed.')}</span>
        </div>
      </div>
      <p className="hw-note">
        <Info size={13} /> {t('Cards cannot be listed without the DeckLink SDK: declare yours below, with their model and device index.')}
      </p>
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
        <span className="set-hint">{t('ST 2110 needs a media network on its own interface, with PTP: keep this server PTP-disciplined (ptp4l + phc2sys on Linux).')}</span>
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
                    <option value="">{t('System default')}</option>
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
            </div>
          );
        })}
        <span className="set-hint">{t('Fill + Key: two ST 2110-20 streams, what most vision mixers and keyers expect. RGBA and YCbCrA carry the alpha in one stream, for receivers that read it.')}</span>
      </Card>
    </>
  );
}

function EthernetIcon() {
  return <Network size={15} className="hw-iface-icon" />;
}

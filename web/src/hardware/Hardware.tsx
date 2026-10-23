import { ArrowDownToLine, ArrowUpFromLine, Network, Plus, RefreshCw, Settings as SettingsIcon, Trash2, TriangleAlert, Tv } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { t, tc, tn } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { SaveBar } from '../settings/ui';
import { useServerConfig } from '../settings/serverConfig';
import { joinAddr, splitAddr, type ChannelConfig, type DetectedCard, type HardwareConfig, type HardwareInfo, type InputConfig, type InputInfo, type Nic, type OutputState, type OutputsConfig, type SdiCard, type SdiOutputDef, type ServerConfig, type St2110Flow } from '../outputs/types';
import { navigate } from '../router';
import { api, can, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { ENCODINGS, bracketOf, speedLabel, deviceOf, dropUsers, hardwareOf, roleOf, syncUsers, usersOf, type Bracket, type Role } from './model';
import './hardware.css';

/*
 * Flux I/O (admins): the DeckLink cards of the server, detected by the
 * driver and adopted in one click, with what each SDI connector does; the
 * ST 2110 flows and PTP. Video streams destinations and inputs name the
 * SDI outputs, inputs and flows set up here.
 */

type Section = 'sdi' | 'st2110';
const sectionOf = (hash: string): Section => (hash === '#st2110' ? 'st2110' : 'sdi');

/** The colour of each connector role on the drawing (none: free). */
const RING: Record<Role | 'ref', string> = { fill: '#8fa3ff', key: '#a78bfa', input: '#22c55e', ref: '#f5c542', unused: '' };

type Statuses = { outputs: Record<string, Record<string, OutputState>>; inputs: InputInfo[] };

const nextId = (kind: string, taken: Iterable<string>) => {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
};

/** "7B10…04E". */
const shortId = (id?: string | null) => (!id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-3)}` : id);

/** "1080p50". */
const formatOf = (height: number, rate: { num: number; den: number }) => `${height}p${+(rate.num / Math.max(1, rate.den)).toFixed(2)}`;

const BUS: Record<string, string> = { pcie: 'PCIe', usb: 'USB', thunderbolt: 'Thunderbolt' };

/** "PCIe · 20000 · ID 7B10…04E". */
const placeOf = (d: DetectedCard) => [d.interface ? `${BUS[d.interface]}${d.topologicalId ? ` ${d.topologicalId}` : ''}` : d.topologicalId, `ID ${shortId(d.id)}`].filter(Boolean).join(' · ');

/** The pictures of a channel with their outputs (main, renditions, unwired). */
const picturesOf = (ch: ChannelConfig): { w: number; h: number; outputs: OutputsConfig }[] => [{ w: ch.width, h: ch.height, outputs: ch.outputs }, ...(ch.renditions ?? []).map((r) => ({ w: r.width, h: r.height, outputs: r.outputs })), ...(ch.unwired ? [{ w: ch.width, h: ch.height, outputs: ch.unwired }] : [])];

/** The first channel destination sending to a Hardware id. */
function userOf(cfg: ServerConfig, id: string) {
  for (const ch of cfg.channels)
    for (const p of picturesOf(ch)) {
      const dest = [...(p.outputs.sdi ?? []), ...(p.outputs.st2110 ?? [])].find((d) => d.hardware === id);
      if (dest) return { ch, dest, height: p.h };
    }
  return undefined;
}

/** Every destination id of a channel (they are unique across its pictures). */
const destIds = (ch: ChannelConfig) => picturesOf(ch).flatMap((p) => Object.values(p.outputs).flatMap((list) => (Array.isArray(list) ? list.map((d: { id: string }) => d.id) : [])));

const channelLabel = (cfg: ServerConfig, ch: ChannelConfig) => {
  const loc = (cfg.locations ?? []).length > 1 ? cfg.locations?.find((l) => l.id === ch.location) : undefined;
  return loc ? `${ch.name} · ${loc.name}` : ch.name;
};

export function Hardware() {
  const user = useApp((s) => s.auth?.user);
  const toast = useApp((s) => s.toast);
  const { info, cfg, edit, dirty, saving, save, discard } = useServerConfig('hardware');
  const [det, setDet] = useState<HardwareInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<Statuses>({ outputs: {}, inputs: [] });
  const [section, setSection] = useState<Section>(() => sectionOf(location.hash));

  useEffect(() => {
    const follow = () => setSection(sectionOf(location.hash));
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const detect = (manual = false) => {
    if (manual) setScanning(true);
    return api<HardwareInfo>('GET', '/api/hardware')
      .then(setDet)
      .catch((e) => manual && toast((e as Error).message, 'error'))
      .finally(() => manual && setScanning(false));
  };
  useEffect(() => {
    void detect();
    const h = setInterval(() => document.hidden || void detect(), 10000);
    let alive = true;
    const poll = () =>
      Promise.all([api<Statuses['outputs']>('GET', '/api/outputs/status'), api<InputInfo[]>('GET', '/api/inputs')])
        .then(([outputs, inputs]) => alive && setStatus({ outputs, inputs }))
        .catch(() => {});
    void poll();
    const p = setInterval(() => document.hidden || void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(h);
      clearInterval(p);
    };
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
  const ref = refState(hw, det);
  const ptp = det?.sync?.ptp;
  const ptpDot = !ptp?.running ? 'off' : ptp.locked ? 'ok' : 'warn';
  const nav = (
    <>
      <NavSection>{t('I/O')}</NavSection>
      <NavItem on={section === 'sdi'} icon={<Tv size={15} />} label="SDI · DeckLink" count={tn(hw.sdi.cards.length, '{n} card', '{n} cards')} onClick={() => go('sdi')} />
      <NavItem on={section === 'st2110'} icon={<Network size={15} />} label="SMPTE ST 2110" count={tn(hw.st2110.flows.length, '{n} flow', '{n} flows')} onClick={() => go('st2110')} />
      <NavSection>{t('Sync')}</NavSection>
      <NavItem className="fio-sync" icon={<span className={`nav-dot ${ref.dot}`} />} label={ref.label} count={ref.state} onClick={() => go('sdi')} />
      <NavItem className="fio-sync" icon={<span className={`nav-dot ${ptpDot}`} />} label={`PTP · ${t('domain {n}', { n: hw.sync!.ptpDomain })}`} count={ptp?.running ? ptpStateLabel(ptp.portState) : '—'} onClick={() => go('st2110')} />
    </>
  );

  return (
    <SidePage nav={nav} className="hw-page fio-page">
      {section === 'sdi' && (
        <>
          <PageHead title="SDI · DeckLink">
            <button className="btn" disabled={scanning} onClick={() => void detect(true)}>
              <RefreshCw size={14} className={scanning ? 'spin' : ''} /> {t('Search')}
            </button>
          </PageHead>
          <SdiView hw={hw} det={det} cfg={cfg} editHw={editHw} status={status} />
        </>
      )}
      {section === 'st2110' && <St2110View hw={hw} det={det} cfg={cfg} editHw={editHw} status={status} />}
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
    </SidePage>
  );
}

type EditHw = (fn: (hw: HardwareConfig, c: ServerConfig) => void) => void;

const PTP_STATES: Record<string, string> = { SLAVE: 'slave', MASTER: 'master', LISTENING: 'listening', PASSIVE: 'passive', UNCALIBRATED: 'uncalibrated', FAULTY: 'faulty', INITIALIZING: 'initializing', DISABLED: 'disabled' };
const ptpStateLabel = (s?: string | null) => (s ? (PTP_STATES[s] ? tc('ptp', PTP_STATES[s]) : s.toLowerCase()) : '—');

const REF_KIND = (k?: string | null) => (k === 'blackBurst' ? 'Black burst' : k === 'triLevel' ? 'Tri-level' : 'REF');

/** The reference of the adopted cards, for the nav: locked everywhere, missing somewhere, or none. */
function refState(hw: HardwareConfig, det: HardwareInfo | null) {
  const cards = hw.sdi.cards.map((c) => detectedOf(c, det?.decklinkCards ?? [])).filter((d): d is DetectedCard => !!d && d.hasReference);
  const kind = cards.find((d) => d.referenceKind)?.referenceKind;
  const label = kind === 'blackBurst' || kind === 'triLevel' ? `REF · ${REF_KIND(kind)}` : 'REF';
  if (!cards.length) return { label, dot: 'off', state: '—' };
  const locked = cards.filter((d) => d.referenceLocked).length;
  // Several cards: how many are locked, when not all.
  const state = locked === cards.length ? t('locked') : cards.length > 1 ? `${locked}/${cards.length}` : t('absent');
  return { label, dot: locked === cards.length ? 'ok' : 'warn', state };
}

/** The detected card of an adopted one: by identity, else (declared by hand) by its first device. */
function detectedOf(c: SdiCard, detected: DetectedCard[]): DetectedCard | undefined {
  if (c.persistentId) return detected.find((d) => d.id === c.persistentId);
  return detected.find((d) => d.devices[0] === c.device && (c.model === d.legacyModel || c.model === 'other'));
}

/** Confirms the removal of something Video streams uses (its destinations and inputs go too). */
async function confirmUsers(cfg: ServerConfig, ids: string[], what: string): Promise<boolean> {
  const users = ids.flatMap((id) => usersOf(cfg, id));
  if (!users.length) return true;
  return confirmDialog({
    title: t('Remove “{name}”?', { name: what }),
    message: `${tn(users.length, 'Used by {n} destination or input in Video streams, removed too:', 'Used by {n} destinations or inputs in Video streams, removed too:')} ${users.join(', ')}`,
    confirm: t('Remove'),
    danger: true,
  });
}

// ---------------------------------------------------------------- SDI ----

function SdiView({ hw, det, cfg, editHw, status }: { hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw; status: Statuses }) {
  const models = det?.decklinkModels ?? [];
  const detected = det?.decklinkCards ?? [];
  const adopted = new Set(hw.sdi.cards.map((c) => detectedOf(c, detected)?.id).filter(Boolean));
  const ignored = new Set(hw.sdi.ignored ?? []);
  const fresh = detected.filter((d) => !adopted.has(d.id) && !ignored.has(d.id));
  const left = detected.filter((d) => !adopted.has(d.id) && ignored.has(d.id));

  const adopt = (d: DetectedCard) =>
    editHw((h) => {
      const id = nextId('card', h.sdi.cards.map((c) => c.id));
      const same = h.sdi.cards.filter((c) => c.modelName === d.modelName).length;
      const modes = models.find((m) => m.name.toLowerCase() === d.modelName.toLowerCase())?.modes ?? [];
      // The mode the card is already in (its active profile).
      const mode = modes.find((m) => m.profile && m.profile === d.profile)?.id;
      h.sdi.cards.push({ id, name: same ? `${d.modelName} (${same + 1})` : d.modelName, model: d.legacyModel, device: d.devices[0] ?? 0, connectors: Array.from({ length: d.connectors }, () => ({ name: '' })), modelName: d.modelName, persistentId: d.id, devices: d.devices, ...(mode ? { mode } : {}), genlock: false, genlockOffset: 0 });
      h.sdi.ignored = (h.sdi.ignored ?? []).filter((x) => x !== d.id);
      if (!h.sdi.ignored.length) delete h.sdi.ignored;
    });
  const ignore = (d: DetectedCard) => editHw((h) => void (h.sdi.ignored = [...(h.sdi.ignored ?? []), d.id]));

  return (
    <>
      {fresh.length > 0 && (
        <section className="fio-found">
          <header>
            <span className="nav-dot warn" />
            <h3>{tn(fresh.length, '{n} card detected', '{n} cards detected')}</h3>
            <span className="muted small">{t('not used by the server yet')}</span>
          </header>
          {fresh.map((d) => (
            <div key={d.id} className="fio-found-row">
              <dl className="fio-kv">
                <dt>{t('Model')}</dt>
                <dd>
                  <b>{d.modelName}</b> · {d.connectors} × SDI{d.hasReference ? ' · REF' : ''}
                </dd>
                <dt>{tc('card', 'Location')}</dt>
                <dd>{[placeOf(d), det?.desktopVideoVersion && `Desktop Video ${det.desktopVideoVersion}`].filter(Boolean).join(' · ')}</dd>
              </dl>
              <button className="btn primary" onClick={() => adopt(d)}>
                <Plus size={14} /> {t('Adopt')}
              </button>
              <button className="btn" onClick={() => ignore(d)}>
                {t('Ignore')}
              </button>
            </div>
          ))}
        </section>
      )}

      {hw.sdi.cards.map((c) => (
        <CardPanel key={c.id} card={c} hw={hw} cfg={cfg} det={det} found={detectedOf(c, detected)} bracket={bracketOf(c, models, detectedOf(c, detected))} editHw={editHw} status={status} />
      ))}

      {!hw.sdi.cards.length && !fresh.length && (
        <section className="fio-empty">
          <Tv size={22} />
          <strong>{det ? t('No DeckLink card') : t('Detecting…')}</strong>
          {det && <span className="muted small">{!det.decklinkSupport ? t('This server is built without DeckLink support') : det.desktopVideo ? `Desktop Video ${det.desktopVideoVersion ?? ''}` : t('Desktop Video not found')}</span>}
        </section>
      )}

      {left.length > 0 && (
        <div className="fio-ignored">
          {left.map((d) => (
            <span key={d.id} className="fio-ignored-card">
              <span className="muted">{t('Ignored')}</span> {d.modelName} <span className="muted small">{placeOf(d)}</span>
              <button className="btn small" onClick={() => adopt(d)}>
                <Plus size={13} /> {t('Adopt')}
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** An adopted card: the bracket on the left, what each connector does on the right. */
function CardPanel({ card, hw, cfg, det, found, bracket, editHw, status }: { card: SdiCard; hw: HardwareConfig; cfg: ServerConfig; det: HardwareInfo | null; found?: DetectedCard; bracket: Bracket; editHw: EditHw; status: Statuses }) {
  const [sel, setSel] = useState<number | null>(null);
  const n = card.connectors.length;
  const mode = bracket.modes.find((m) => m.id === card.mode);
  const roles = new Set<string>(mode?.roles ?? ['fill', 'key', 'input']);
  // The rows in Desktop Video order (1, 5, 2, 6… on a Quad 2), the REF last.
  const rows = Array.from({ length: n }, (_, i) => i).sort((a, b) => deviceOf(card, a) - deviceOf(card, b) || a - b);
  const genlock = !!card.genlock || hw.sdi.outputs.some((o) => o.card === card.id && o.genlock);

  const removeCard = async () => {
    const defs = [...hw.sdi.outputs.filter((o) => o.card === card.id), ...hw.sdi.inputs.filter((i) => i.card === card.id)];
    const users = defs.flatMap((d) => usersOf(cfg, d.id));
    if (!(await confirmDialog({ title: t('Remove the card “{name}”?', { name: card.name }), message: users.length ? `${tn(users.length, 'Used by {n} destination or input in Video streams, removed too:', 'Used by {n} destinations or inputs in Video streams, removed too:')} ${users.join(', ')}` : undefined, confirm: t('Remove'), danger: true }))) return;
    editHw((h, all) => {
      for (const d of defs) dropUsers(all, d.id);
      h.sdi.outputs = h.sdi.outputs.filter((o) => o.card !== card.id);
      h.sdi.inputs = h.sdi.inputs.filter((i) => i.card !== card.id);
      h.sdi.cards = h.sdi.cards.filter((x) => x.id !== card.id);
    });
  };

  /** Switches the card to a mode: connectors doing what it does not allow are freed. */
  const setMode = async (id: string) => {
    const allowed = new Set(bracket.modes.find((m) => m.id === id)?.roles ?? []);
    const outs = hw.sdi.outputs.filter((o) => o.card === card.id && !allowed.has('fill'));
    const keys = hw.sdi.outputs.filter((o) => o.card === card.id && o.key != null && !allowed.has('key'));
    const ins = hw.sdi.inputs.filter((i) => i.card === card.id && !allowed.has('input'));
    if (!(await confirmUsers(cfg, [...outs, ...ins].map((d) => d.id), card.name))) return;
    editHw((h, all) => {
      for (const d of [...outs, ...ins]) dropUsers(all, d.id);
      h.sdi.outputs = h.sdi.outputs.filter((o) => !outs.some((x) => x.id === o.id));
      h.sdi.inputs = h.sdi.inputs.filter((i) => !ins.some((x) => x.id === i.id));
      for (const o of h.sdi.outputs)
        if (keys.some((k) => k.id === o.id)) {
          o.key = null;
          if (o.mode === 'externalKey') o.mode = 'fillOnly';
        }
      h.sdi.cards.find((x) => x.id === card.id)!.mode = id;
    });
  };

  const setRef = (on: boolean, offset = card.genlockOffset ?? 0) =>
    editHw((h) => {
      const c = h.sdi.cards.find((x) => x.id === card.id)!;
      c.genlock = on;
      c.genlockOffset = Math.max(-1125, Math.min(1125, Math.round(offset) || 0));
      for (const o of h.sdi.outputs) if (o.card === card.id) o.genlock = on;
    });

  /** What a connector does, as the value of its select. */
  const valueOf = (k: number): string => {
    const r = roleOf(hw, card.id, k);
    if (r.role === 'fill' && r.output) {
      const u = userOf(cfg, r.output.id);
      return u ? `fill:${u.ch.id}` : `def:${r.output.id}`;
    }
    if (r.role === 'key' && r.output) return `key:${r.output.id}`;
    if (r.role === 'input' && r.input) {
      const i = (cfg.inputs ?? []).find((x) => x.kind === 'sdi' && x.hardware === r.input!.id);
      return i ? `in:${i.id}` : `indef:${r.input.id}`;
    }
    return '';
  };
  const defLabel = (d: SdiOutputDef) => {
    const u = userOf(cfg, d.id);
    return u ? channelLabel(cfg, u.ch) : d.name;
  };

  /** Gives a connector something to do (or frees it). */
  const assign = async (k: number, value: string) => {
    const cur = roleOf(hw, card.id, k);
    if (value === valueOf(k)) return;
    const [kind, target] = [value.split(':')[0], value.slice(value.indexOf(':') + 1)];
    // What goes: an output whose fill moves elsewhere keeps its def only when it goes to another channel.
    const dropOut = cur.role === 'fill' && cur.output && kind !== 'fill' ? cur.output : undefined;
    const dropIn = cur.role === 'input' && cur.input ? cur.input : undefined;
    if (!(await confirmUsers(cfg, [dropOut?.id, dropIn?.id].filter((x): x is string => !!x), `SDI ${k + 1}`))) return;
    editHw((h, all) => {
      if (dropOut) {
        dropUsers(all, dropOut.id);
        h.sdi.outputs = h.sdi.outputs.filter((o) => o.id !== dropOut.id);
      }
      if (cur.role === 'key' && cur.output) {
        const o = h.sdi.outputs.find((x) => x.id === cur.output!.id);
        if (o) {
          o.key = null;
          o.mode = 'fillOnly';
        }
      }
      if (dropIn) {
        dropUsers(all, dropIn.id);
        h.sdi.inputs = h.sdi.inputs.filter((i) => i.id !== dropIn.id);
      }
      if (kind === 'fill') {
        const ch = all.channels.find((x) => x.id === target);
        if (!ch) return;
        // Named after the connector: unique among the outputs of a channel.
        const name = `${card.name} · SDI ${k + 1}`;
        let def = h.sdi.outputs.find((o) => o.card === card.id && o.fill === k);
        if (def) dropUsers(all, def.id);
        else {
          def = { id: nextId('sdi-out', h.sdi.outputs.map((o) => o.id)), name, card: card.id, fill: k, key: null, mode: 'fillOnly', genlock };
          h.sdi.outputs.push(def);
        }
        const id = nextId('sdi', destIds(ch));
        (ch.outputs.sdi ??= []).push({ id, name: def.name || name, hardware: def.id, device: 0, externalKey: true, fillOnly: false, genlock: false });
      } else if (kind === 'key') {
        const o = h.sdi.outputs.find((x) => x.id === target);
        if (!o) return;
        o.key = k;
        o.mode = 'externalKey';
      } else if (kind === 'in') {
        const i = target === 'new' ? undefined : (all.inputs ?? []).find((x) => x.id === target);
        const def = i && h.sdi.inputs.find((d) => d.id === i.hardware);
        if (def) {
          def.card = card.id;
          def.connector = k;
        } else {
          const name = i?.name ?? `${t('SDI input')} ${(all.inputs ?? []).filter((x) => x.kind === 'sdi').length + 1}`;
          const id = nextId('sdi-in', h.sdi.inputs.map((d) => d.id));
          h.sdi.inputs.push({ id, name, card: card.id, connector: k });
          if (i) i.hardware = id;
          else (all.inputs ??= []).push(newSdiInput(nextId('input', (all.inputs ?? []).map((x) => x.id)), name, id));
        }
      }
    });
    setSel(k);
  };

  const signal = (k: number) => {
    const r = roleOf(hw, card.id, k);
    if ((r.role === 'fill' || r.role === 'key') && r.output) {
      const u = userOf(cfg, r.output.id);
      const st = u && status.outputs[u.ch.id]?.[u.dest.id];
      if (!u || !st) return <span className="muted">—</span>;
      return st.ok ? <Sig dot="ok" text={formatOf(u.height, u.ch.frameRate)} /> : <Sig dot="err" text={st.message} />;
    }
    if (r.role === 'input' && r.input) {
      const i = (cfg.inputs ?? []).find((x) => x.kind === 'sdi' && x.hardware === r.input!.id);
      const st = i && status.inputs.find((x) => x.id === i.id);
      if (!st) return <span className="muted">—</span>;
      return st.live ? <Sig dot="ok" text={st.height ? formatOf(st.height, { num: Math.round((st.fps ?? 0) * 100), den: 100 }) : t('live')} /> : <Sig dot="err" text={t('no signal')} />;
    }
    return <span className="muted">—</span>;
  };

  const pill = !bracket.reference || !found || found.referenceLocked == null ? null : found.referenceLocked ? <span className="fio-pill ok">{`${t('REF locked')}${found.referenceFormat ? ` · ${found.referenceFormat}` : ''}`}</span> : <span className={`fio-pill ${genlock ? 'err' : 'warn'}`}>{genlock ? t('REF absent') : `${t('REF absent')} · ${t('internal clock')}`}</span>;

  return (
    <section className="fio-card">
      <header>
        <h3>{card.modelName || card.name}</h3>
        <span className="muted small">{[found ? placeOf(found) : null, found ? t('adopted') : t('not detected')].filter(Boolean).join(' · ')}</span>
        {pill}
        <div className="spacer" />
        {bracket.modes.length > 0 ? (
          <div className="seg">
            {bracket.modes.map((m) => (
              <button key={m.id} type="button" className={card.mode === m.id ? 'on' : ''} onClick={() => void setMode(m.id)}>
                {m.id === 'fillKey' ? 'Fill + Key' : m.id === 'outputs' ? tn(n, '{n} output', '{n} outputs') : m.id === 'inputs' ? tn(n, '{n} input', '{n} inputs') : m.id}
              </button>
            ))}
          </div>
        ) : (
          <div className="fio-legend">
            <span style={{ ['--c' as string]: RING.fill }}>Fill</span>
            <span style={{ ['--c' as string]: RING.key }}>Key</span>
            <span style={{ ['--c' as string]: RING.input }}>{t('Input')}</span>
            {bracket.reference && <span style={{ ['--c' as string]: RING.ref }}>REF</span>}
            <span style={{ ['--c' as string]: 'var(--line-2)' }}>{t('Free')}</span>
          </div>
        )}
        <button className="icon-btn ghost" title={t('Remove the card')} onClick={() => void removeCard()}>
          <Trash2 size={15} />
        </button>
      </header>
      <div className="fio-card-body">
        <BracketDrawing card={card} bracket={bracket} hw={hw} sel={sel} onPick={setSel} />
        <div className="fio-ports">
          {rows.map((k) => {
            const r = roleOf(hw, card.id, k);
            const port = bracket.ports[k] ?? 'both';
            const canOut = port !== 'in';
            const canIn = port !== 'out';
            const value = valueOf(k);
            const keyDefs = hw.sdi.outputs.filter((o) => o.card === card.id && o.fill !== k && o.mode !== 'internalKey' && (o.key == null || o.mode !== 'externalKey' || o.key === k));
            const sdiInputs = (cfg.inputs ?? []).filter((i) => i.kind === 'sdi');
            return (
              <div key={k} className={`fio-port ${sel === k ? 'sel' : ''}`} onClick={() => setSel(k)}>
                <b>SDI {k + 1}</b>
                <span className={`fio-tag ${r.role}`}>{r.role === 'fill' ? 'Fill' : r.role === 'key' ? 'Key' : r.role === 'input' ? t('Input') : t('Free')}</span>
                <select value={value} aria-label={`SDI ${k + 1}`} className={value ? '' : 'none'} onChange={(e) => void assign(k, e.target.value)}>
                  <option value="">—</option>
                  {canOut && roles.has('fill') && (
                    <optgroup label="Fill">
                      {cfg.channels.map((ch) => (
                        <option key={ch.id} value={`fill:${ch.id}`}>
                          {channelLabel(cfg, ch)}
                        </option>
                      ))}
                      {value.startsWith('def:') && <option value={value}>{r.output?.name}</option>}
                    </optgroup>
                  )}
                  {canOut && roles.has('key') && keyDefs.length > 0 && (
                    <optgroup label="Key">
                      {keyDefs.map((d) => (
                        <option key={d.id} value={`key:${d.id}`}>
                          {defLabel(d)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {canIn && roles.has('input') && (
                    <optgroup label={t('Input')}>
                      {sdiInputs.map((i) => (
                        <option key={i.id} value={`in:${i.id}`}>
                          {i.name}
                        </option>
                      ))}
                      {value.startsWith('indef:') && <option value={value}>{r.input?.name}</option>}
                      <option value="in:new">{t('New input')}</option>
                    </optgroup>
                  )}
                </select>
                <span className="fio-sig">{signal(k)}</span>
              </div>
            );
          })}
          {bracket.reference && (
            <div className="fio-port ref">
              <b>REF</b>
              <span className="fio-tag ref">{REF_KIND(found?.referenceKind)}</span>
              <span className="fio-ref">
                <select value={genlock ? 'genlock' : 'free'} aria-label="REF" onChange={(e) => setRef(e.target.value === 'genlock')}>
                  <option value="genlock">{tn(card.genlockOffset ?? 0, 'Genlock · {n} line', 'Genlock · {n} lines')}</option>
                  <option value="free">{t('Internal clock')}</option>
                </select>
                {genlock && <input type="number" min={-1125} max={1125} value={card.genlockOffset ?? 0} aria-label={t('Genlock offset')} onChange={(e) => setRef(true, +e.target.value)} />}
              </span>
              <span className="fio-sig">{found?.referenceLocked == null ? <span className="muted">—</span> : found.referenceLocked ? <Sig dot="ok" text={t('locked')} /> : <Sig dot="warn" text={t('absent')} />}</span>
            </div>
          )}
          {!det?.decklinkSupport && det && (
            <p className="fio-note">
              <TriangleAlert size={13} /> {t('This server is built without DeckLink support')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function newSdiInput(id: string, name: string, hardware: string): InputConfig {
  return { id, name, kind: 'sdi', url: '', listen: false, ndiSource: '', device: 0, hardware, width: 1920, height: 1080, fps: 25, buffer: 2, hwDecode: false };
}

function Sig({ dot, text }: { dot: 'ok' | 'warn' | 'err'; text: string }) {
  return (
    <span className="fio-sig">
      <span className={`fio-dot ${dot}`} />
      <span className="fio-sig-text" title={text}>
        {text}
      </span>
    </span>
  );
}

/**
 * The card's bracket, vertical and to scale (millimetres): full-height PCIe
 * bracket 120 × 18.4 mm with its screw tab on top and its tongue below; the
 * connectors from top to bottom as printed, the REF last (next to the
 * motherboard), each with its role ring and a tape label.
 */
function BracketDrawing({ card, bracket, hw, sel, onPick }: { card: SdiCard; bracket: Bracket; hw: HardwareConfig; sel: number | null; onPick: (k: number) => void }) {
  const p = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const jacks: (number | 'R')[] = [...bracket.order, ...(bracket.reference ? (['R'] as const) : [])];
  const span = 102;
  const y = (i: number) => 15 + (jacks.length > 1 ? (i * span) / (jacks.length - 1) : 0);
  const genlock = !!card.genlock || hw.sdi.outputs.some((o) => o.card === card.id && o.genlock);
  const din = bracket.jack === 'din';
  const cx = 15.2;
  const hex = (r: number, cy: number) => {
    const w = r * 0.866;
    return `${cx + w},${cy + r / 2} ${cx},${cy + r} ${cx - w},${cy + r / 2} ${cx - w},${cy - r / 2} ${cx},${cy - r} ${cx + w},${cy - r / 2}`;
  };
  return (
    <svg className="fio-bracket" viewBox="0 0 36.4 134" role="img" aria-label={card.modelName || card.name}>
      <defs>
        <filter id={`${p}blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation=".6" />
        </filter>
        <linearGradient id={`${p}steel`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7c818c" />
          <stop offset=".12" stopColor="#c3c7cf" />
          <stop offset=".4" stopColor="#e2e4e9" />
          <stop offset=".6" stopColor="#b6bac3" />
          <stop offset=".86" stopColor="#d0d3d9" />
          <stop offset="1" stopColor="#6b707a" />
        </linearGradient>
        <linearGradient id={`${p}tab`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e9ebef" />
          <stop offset="1" stopColor="#9ea3ad" />
        </linearGradient>
        <pattern id={`${p}brush`} width="18.4" height=".5" patternUnits="userSpaceOnUse">
          <rect width="18.4" height=".22" fill="rgba(255,255,255,.07)" />
        </pattern>
        <radialGradient id={`${p}gnut`} cx="38%" cy="32%" r="80%">
          <stop offset="0" stopColor="#fff0b8" />
          <stop offset=".35" stopColor="#e5b24a" />
          <stop offset=".75" stopColor="#a8761a" />
          <stop offset="1" stopColor="#6e4a0c" />
        </radialGradient>
        <radialGradient id={`${p}gbarrel`} cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffe9a8" />
          <stop offset=".6" stopColor="#c8921f" />
          <stop offset="1" stopColor="#7b5510" />
        </radialGradient>
        <radialGradient id={`${p}gins`} cx="45%" cy="40%" r="60%">
          <stop offset="0" stopColor="#f4f1e6" />
          <stop offset="1" stopColor="#b9b4a4" />
        </radialGradient>
        <radialGradient id={`${p}cnut`} cx="35%" cy="30%" r="85%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".3" stopColor="#d5d8de" />
          <stop offset=".65" stopColor="#8f949d" />
          <stop offset="1" stopColor="#5a5f68" />
        </radialGradient>
        <radialGradient id={`${p}cbarrel`} cx="38%" cy="32%" r="75%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".45" stopColor="#c7cad1" />
          <stop offset="1" stopColor="#6c717b" />
        </radialGradient>
        <radialGradient id={`${p}ptfe`} cx="45%" cy="40%" r="60%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".8" stopColor="#e2ded3" />
          <stop offset="1" stopColor="#aaa597" />
        </radialGradient>
      </defs>
      <rect x="4.4" y="1.8" width="21.6" height="4.4" rx=".8" fill={`url(#${p}tab)`} stroke="#6b707a" strokeWidth=".15" />
      <rect x="8.2" y="2.8" width="6" height="2.4" rx="1.2" fill="#262930" />
      <rect x="6" y="6" width="18.4" height="120" fill={`url(#${p}steel)`} stroke="#5d626c" strokeWidth=".2" />
      <rect x="6" y="6" width="18.4" height="120" fill={`url(#${p}brush)`} />
      <rect x="10.2" y="126" width="10" height="6" rx=".6" fill={`url(#${p}steel)`} stroke="#5d626c" strokeWidth=".15" />
      {jacks.map((j, i) => {
        const cy = y(i);
        const k = j === 'R' ? -1 : j - 1;
        const role: Role | 'ref' = j === 'R' ? 'ref' : roleOf(hw, card.id, k).role;
        const color = j === 'R' ? (genlock ? RING.ref : '') : RING[role];
        const r = din ? 4.6 : 7.9;
        return (
          <g key={String(j)} className={`fio-jack ${sel === k ? 'sel' : ''}`} onClick={() => k >= 0 && onPick(k)}>
            <title>{j === 'R' ? 'REF' : `SDI ${j}`}</title>
            {din ? (
              <>
                <ellipse cx={cx + 0.5} cy={cy + 0.9} rx="4" ry="4" fill="rgba(0,0,0,.45)" filter={`url(#${p}blur)`} />
                <polygon points={hex(4, cy)} fill={`url(#${p}gnut)`} stroke="#6b4a0a" strokeWidth=".18" />
                <circle cx={cx} cy={cy} r="2.6" fill={`url(#${p}gbarrel)`} stroke="#7a560f" strokeWidth=".15" />
                <circle cx={cx} cy={cy} r="1.75" fill="#1d1404" />
                <circle cx={cx} cy={cy} r="1.15" fill={`url(#${p}gins)`} />
                <circle cx={cx} cy={cy} r=".32" fill="#f3cf6a" />
                <path d={`M${cx - 2.2} ${cy - 1.2} A2.6 2.6 0 0 1 ${cx + 0.6} ${cy - 2.5}`} stroke="#fff4cf" strokeWidth=".35" fill="none" opacity=".75" />
              </>
            ) : (
              <>
                <ellipse cx={cx + 0.7} cy={cy + 1.2} rx="7.2" ry="7.2" fill="rgba(0,0,0,.45)" filter={`url(#${p}blur)`} />
                <polygon points={hex(7.3, cy)} fill={`url(#${p}cnut)`} stroke="#4d525b" strokeWidth=".2" />
                <circle cx={cx} cy={cy} r="4.85" fill={`url(#${p}cbarrel)`} stroke="#50555e" strokeWidth=".2" />
                <rect x={cx - 6.6} y={cy - 0.75} width="2" height="1.5" rx=".6" fill={`url(#${p}cbarrel)`} stroke="#50555e" strokeWidth=".15" />
                <rect x={cx + 4.6} y={cy - 0.75} width="2" height="1.5" rx=".6" fill={`url(#${p}cbarrel)`} stroke="#50555e" strokeWidth=".15" />
                <circle cx={cx} cy={cy} r="4.1" fill="#2a2d33" />
                <circle cx={cx} cy={cy} r="3.3" fill={`url(#${p}ptfe)`} />
                <circle cx={cx} cy={cy} r=".75" fill="#d4a83c" stroke="#80601a" strokeWidth=".12" />
                <path d={`M${cx - 4} ${cy - 2.4} A4.85 4.85 0 0 1 ${cx + 1} ${cy - 4.7}`} stroke="#fff" strokeWidth=".45" fill="none" opacity=".7" />
              </>
            )}
            {color && <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={din ? 0.55 : 0.7} />}
            {sel === k && <circle cx={cx} cy={cy} r={r + 1.1} fill="none" className="fio-jack-sel" strokeWidth=".35" strokeDasharray="1 .8" />}
            <g transform={`rotate(-2 30.6 ${cy})`}>
              <rect x="27.6" y={cy - 2.6} width="6.4" height="5.2" rx=".3" fill="#efece2" />
              <text x="30.8" y={cy + 1.6} textAnchor="middle" className="fio-tape">
                {j}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------ ST 2110 ----

const nicOf = (det: HardwareInfo | null, name: string): Nic | undefined => det?.nics?.find((n) => n.name === name);
const ipOf = (n?: Nic) => n?.ipv4[0]?.split('/')[0];

function St2110View({ hw, det, cfg, editHw, status }: { hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw; status: Statuses }) {
  const [sel, setSel] = useState<string | null>(null);
  const ptp = det?.sync?.ptp;
  const net = hw.network!;
  const sync = hw.sync!;
  const nics = (det?.nics ?? []).filter((n) => n.ipv4.length);

  const add = () => {
    const id = nextId('flow', hw.st2110.flows.map((f) => f.id));
    editHw((h) => {
      const used = new Set(h.st2110.flows.flatMap((f) => [f.fill, f.key ?? '']));
      let k = 1;
      while (used.has(`239.100.${k}.1:5004`)) k++;
      const n = h.st2110.flows.filter((f) => f.direction === 'output').length + 1;
      h.st2110.flows.push({ id, name: t('ST 2110 output {n}', { n }), direction: 'output', encoding: 'fillKey', fill: `239.100.${k}.1:5004`, key: `239.100.${k}.2:5004`, interface: null, ttl: 32, payloadType: 96 });
    });
    setSel(id);
  };

  const offset = ptp?.offsetNs;
  const media = (role: 'red' | 'blue') => {
    const name = role === 'red' ? net.mediaRed : net.mediaBlue;
    const n = nicOf(det, name);
    return (
      <div className="fio-media">
        <span className={`fio-chip ${role}`}>{role === 'red' ? t('Red') : t('Blue')}</span>
        <span className="mono">{name || '—'}</span>
        <span className="muted small">{[ipOf(n), speedLabel(n?.speed), n?.mtu && `MTU ${n.mtu}`].filter(Boolean).join(' · ')}</span>
        <div className="spacer" />
        {name && <span className={`fio-dot ${n?.up ? 'ok' : n ? 'err' : 'off'}`} />}
      </div>
    );
  };

  type Row = { f: St2110Flow; essence: 'fill' | 'key' | 'one' };
  const rows: Row[] = hw.st2110.flows.flatMap((f): Row[] => (f.encoding === 'fillKey' && f.key ? [{ f, essence: 'fill' }, { f, essence: 'key' }] : [{ f, essence: 'one' }]));
  const selected = hw.st2110.flows.find((f) => f.id === sel);

  return (
    <>
      <PageHead title="SMPTE ST 2110">
        <button className="btn" onClick={add}>
          <Plus size={14} /> {t('Flow')}
        </button>
      </PageHead>
      <div className="fio-row">
        <section className="fio-box fio-ptp">
          <header>
            <h3>PTP</h3>
            {ptp?.locked ? <span className="fio-pill ok">{`${ptpStateLabel(ptp.portState)} · ${t('locked')}`}</span> : ptp?.running ? <span className="fio-pill warn">{ptpStateLabel(ptp.portState)}</span> : <span className="fio-pill">{t('No PTP')}</span>}
          </header>
          <div className="fio-ptp-body">
            <div>
              <div className="muted small">{t('Offset')}</div>
              <div className="fio-big">{offset == null ? '—' : `${offset > 0 ? '+' : ''}${Math.round(offset)} ns`}</div>
            </div>
            <div>
              <div className="muted small">{t('Jitter')}</div>
              <div className="fio-big">{ptp?.jitterNs == null ? '—' : `±${Math.round(ptp.jitterNs)} ns`}</div>
            </div>
            <dl className="fio-kv">
              <dt>Grandmaster</dt>
              <dd className="mono">{ptp?.grandmaster ?? '—'}</dd>
              <dt>{t('Domain')}</dt>
              <dd>
                <input className="fio-num" type="number" min={0} max={127} value={sync.ptpDomain} aria-label={t('PTP domain')} onChange={(e) => editHw((h) => void (h.sync!.ptpDomain = Math.max(0, Math.min(127, Math.round(+e.target.value) || 0))))} />
                {sync.ptpDomain === 127 && <span className="muted"> · SMPTE 2059-2</span>}
              </dd>
              <dt>{t('Card')}</dt>
              <dd>
                <select value={net.ptp} aria-label={t('Card')} onChange={(e) => editHw((h) => void (h.network!.ptp = e.target.value))}>
                  <option value="">{t('Not set')}</option>
                  {net.ptp && !nics.some((n) => n.name === net.ptp) && <option value={net.ptp}>{t('{name} (not found)', { name: net.ptp })}</option>}
                  {nics.map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
                      {n.name === net.mediaRed ? ` (${t('red')})` : n.name === net.mediaBlue ? ` (${t('blue')})` : ''}
                    </option>
                  ))}
                </select>
              </dd>
              <dt>TAI − UTC</dt>
              <dd>
                <input className="fio-num" type="number" min={0} max={99} value={sync.taiOffset} aria-label={t('TAI − UTC (s)')} onChange={(e) => editHw((h) => void (h.sync!.taiOffset = Math.max(0, Math.min(99, Math.round(+e.target.value) || 0))))} /> <span className="muted">s</span>
              </dd>
            </dl>
          </div>
        </section>
        <section className="fio-box fio-media-box">
          <header>
            <h3>{t('Media network')}</h3>
            <div className="spacer" />
            <button className="icon-btn ghost" title={t('Networks')} onClick={() => navigate('/settings#network')}>
              <SettingsIcon size={14} />
            </button>
          </header>
          {media('red')}
          {media('blue')}
        </section>
      </div>

      <section className="fio-box fio-flows">
        <table className="fio-table">
          <thead>
            <tr>
              <th>{t('Flow')}</th>
              <th>{t('Channel')}</th>
              <th>Type</th>
              <th>{t('Red')}</th>
              <th>{t('Blue')}</th>
              <th>Format</th>
              <th>{t('State')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, essence }) => {
              const u = userOf(cfg, f.id);
              const st = u && status.outputs[u.ch.id]?.[u.dest.id];
              const key = essence === 'key';
              const red = key ? f.key : f.fill;
              const blue = f.blue ? (key ? f.blueKey : f.blue) : null;
              const input = f.direction === 'input';
              return (
                <tr key={f.id + essence} className={sel === f.id ? 'sel' : ''} onClick={() => setSel(sel === f.id ? null : f.id)}>
                  <td>
                    <b>{essence === 'one' ? f.name : `${f.name} · ${key ? 'Key' : 'Fill'}`}</b>
                  </td>
                  <td>{input ? t('Input') : u ? u.ch.name : <span className="muted">—</span>}</td>
                  <td>
                    <span className={`fio-tag ${input ? 'input' : key ? 'key' : 'fill'}`}>2110-20</span>
                  </td>
                  <td className="mono">{red ?? '—'}</td>
                  <td className="mono">{blue ?? '—'}</td>
                  <td>{u ? formatOf(u.height, u.ch.frameRate) : <span className="muted">—</span>}</td>
                  <td>{input ? <Sig dot="warn" text={t('not received')} /> : !st ? <span className="muted">—</span> : st.ok ? <Sig dot="ok" text={t('sent')} /> : <Sig dot="err" text={st.message} />}</td>
                  <td>
                    {u && !input ? (
                      <a className="btn small" href={`/api/channels/${encodeURIComponent(u.ch.id)}/outputs/${encodeURIComponent(u.dest.id)}/${key ? 'key' : 'fill'}.sdp`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        SDP
                      </a>
                    ) : (
                      <button className="btn small" disabled>
                        SDP
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="muted small fio-none">{t('No flow')}</p>}
      </section>

      {selected && <FlowEditor key={selected.id} f={selected} hw={hw} det={det} cfg={cfg} editHw={editHw} onGone={() => setSel(null)} />}
    </>
  );
}

function FlowEditor({ f, hw, det, cfg, editHw, onGone }: { f: St2110Flow; hw: HardwareConfig; det: HardwareInfo | null; cfg: ServerConfig; editHw: EditHw; onGone: () => void }) {
  const ifaces = (det?.interfaces ?? []).filter((i) => i.ip);
  const editFlow = (fn: (f: St2110Flow) => void) => editHw((h) => fn(h.st2110.flows.find((x) => x.id === f.id)!));
  const two = f.encoding === 'fillKey';
  const [fip, fport] = splitAddr(f.fill);
  const [kip, kport] = splitAddr(f.key);
  const users = usersOf(cfg, f.id);
  const remove = async () => {
    if (!(await confirmUsers(cfg, [f.id], f.name))) return;
    editHw((h, all) => {
      dropUsers(all, f.id);
      h.st2110.flows = h.st2110.flows.filter((x) => x.id !== f.id);
    });
    onGone();
  };
  return (
    <section className={`hw-flow fio-box ${f.direction}`}>
      <div className="hw-flow-head">
        {f.direction === 'output' ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}
        <input className="hw-flow-name" value={f.name} aria-label={t('Name')} onChange={(e) => editFlow((x) => void (x.name = e.target.value))} />
        <div className="seg">
          {(['output', 'input'] as const).map((d) => (
            <button key={d} type="button" className={f.direction === d ? 'on' : ''} disabled={d !== f.direction && users.length > 0} onClick={() => editFlow((x) => void (x.direction = d))}>
              {d === 'output' ? tc('flow', 'Output') : tc('flow', 'Input')}
            </button>
          ))}
        </div>
        <span className="hw-users" title={users.join('\n')}>
          {users.length ? t('Used by {list}', { list: users.join(', ') }) : t('not used')}
        </span>
        <button className="icon-btn ghost" title={t('Remove')} onClick={() => void remove()}>
          <Trash2 size={14} />
        </button>
      </div>
      <div className="hw-flow-grid">
        <label className="set-field wide">
          <span className="set-label">{t('Encoding')}</span>
          <select value={f.encoding} onChange={(e) => editFlow((x) => void ((x.encoding = e.target.value as St2110Flow['encoding']), x.encoding === 'fillKey' && !x.key && (x.key = joinAddr(fip.replace(/\d+$/, (v) => String(+v + 1)), fport))))}>
            {ENCODINGS.map((x) => (
              <option key={x.value} value={x.value}>
                {t(x.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="set-field wide">
          <span className="set-label">{t('Network interface')}</span>
          <select value={f.interface ?? ''} onChange={(e) => editFlow((x) => void (x.interface = e.target.value || null))}>
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
          <input value={fip} placeholder="239.100.1.1" spellCheck={false} onChange={(e) => editFlow((x) => void (x.fill = joinAddr(e.target.value, fport)))} />
        </label>
        <label className="set-field hw-num">
          <span className="set-label">{t('Port')}</span>
          <input type="number" min={1} max={65535} value={fport} onChange={(e) => editFlow((x) => void (x.fill = joinAddr(fip, e.target.value)))} />
        </label>
        {two ? (
          <>
            <label className="set-field">
              <span className="set-label">{t('Key — multicast')}</span>
              <input value={kip} placeholder={t('none')} spellCheck={false} onChange={(e) => editFlow((x) => void (x.key = e.target.value.trim() ? joinAddr(e.target.value, kport || '5004') : null))} />
            </label>
            <label className="set-field hw-num">
              <span className="set-label">{t('Port')}</span>
              <input type="number" min={1} max={65535} value={kport} disabled={!f.key} onChange={(e) => editFlow((x) => void (x.key = joinAddr(kip, e.target.value)))} />
            </label>
          </>
        ) : (
          <span className="hw-flow-gap" />
        )}
        <label className="set-field hw-num">
          <span className="set-label">TTL</span>
          <input type="number" min={1} max={255} value={f.ttl} onChange={(e) => editFlow((x) => void (x.ttl = Math.max(1, Math.min(255, Math.round(+e.target.value) || 1))))} />
        </label>
        <label className="set-field hw-num">
          <span className="set-label">{t('Payload type')}</span>
          <input type="number" min={96} max={127} value={f.payloadType} onChange={(e) => editFlow((x) => void (x.payloadType = Math.max(96, Math.min(127, Math.round(+e.target.value) || 96))))} />
        </label>
      </div>
      <label className="switch hw-blue-toggle">
        <input
          type="checkbox"
          checked={!!f.blue}
          onChange={(e) =>
            editFlow((x) => {
              if (!e.target.checked) return void (x.blue = x.blueKey = x.blueInterface = null);
              // Blue groups default to the next /16 of the red ones (239.100.x → 239.101.x).
              const shift = (a: string) => a.replace(/^(\d+)\.(\d+)\./, (_, a1, a2) => `${a1}.${Math.min(255, +a2 + 1)}.`);
              x.blue = shift(x.fill);
              x.blueKey = x.key ? shift(x.key) : null;
            })
          }
        />
        <span>SMPTE 2022-7</span>
      </label>
      {f.blue && <BlueLeg f={f} two={two} ifaces={ifaces} blueRole={hw.network!.mediaBlue} editFlow={editFlow} />}
    </section>
  );
}

/** The label of "no interface chosen": the network role's one, when set. */
function roleDefault(role: string, ifaces: HardwareInfo['interfaces']): string {
  if (!role) return t('System default');
  const ip = ifaces.find((i) => i.name === role)?.ip;
  return t('Network role: {iface}', { iface: ip ? `${role} — ${ip}` : role });
}

function BlueLeg({ f, two, ifaces, blueRole, editFlow }: { f: St2110Flow; two: boolean; ifaces: HardwareInfo['interfaces']; blueRole: string; editFlow: (fn: (f: St2110Flow) => void) => void }) {
  const [bip, bport] = splitAddr(f.blue);
  const [bkip, bkport] = splitAddr(f.blueKey);
  return (
    <div className="hw-blue">
      <label className="set-field wide">
        <span className="set-label">{t('Blue interface')}</span>
        <select value={f.blueInterface ?? ''} onChange={(e) => editFlow((x) => void (x.blueInterface = e.target.value || null))}>
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
        <input value={bip} placeholder="239.101.1.1" spellCheck={false} onChange={(e) => editFlow((x) => void (x.blue = joinAddr(e.target.value, bport)))} />
      </label>
      <label className="set-field hw-num">
        <span className="set-label">{t('Port')}</span>
        <input type="number" min={1} max={65535} value={bport} onChange={(e) => editFlow((x) => void (x.blue = joinAddr(bip, e.target.value)))} />
      </label>
      {two && (
        <>
          <label className="set-field">
            <span className="set-label">{t('Blue key — multicast')}</span>
            <input value={bkip} placeholder="239.101.1.2" spellCheck={false} onChange={(e) => editFlow((x) => void (x.blueKey = e.target.value.trim() ? joinAddr(e.target.value, bkport || '5004') : null))} />
          </label>
          <label className="set-field hw-num">
            <span className="set-label">{t('Port')}</span>
            <input type="number" min={1} max={65535} value={bkport} disabled={!f.blueKey} onChange={(e) => editFlow((x) => void (x.blueKey = joinAddr(bkip, e.target.value)))} />
          </label>
        </>
      )}
    </div>
  );
}

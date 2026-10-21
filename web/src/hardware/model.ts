import { t } from '../i18n';
import { emptyHardware, type HardwareConfig, type SdiCard, type SdiModel, type SdiMode, type SdiOutput, type SdiOutputDef, type ServerConfig, type St2110Flow, type St2110Output } from '../outputs/types';

/*
 * The video hardware of the server (Hardware page), shared with the Video
 * streams page: DeckLink card models, what each connector does, and how a
 * destination takes its settings from what Hardware declares (the server
 * does the same when it loads the settings: crates/cg-server/src/hardware.rs).
 */

/** What a connector of a model can do. */
export type PortCap = 'in' | 'out' | 'both';

export const SDI_MODELS: { id: SdiModel; label: string; ports: PortCap[]; oneDevice?: boolean }[] = [
  { id: 'miniMonitor', label: 'DeckLink Mini Monitor', ports: ['out'], oneDevice: true },
  { id: 'miniRecorder', label: 'DeckLink Mini Recorder', ports: ['in'], oneDevice: true },
  { id: 'sdi4k', label: 'DeckLink SDI 4K', ports: ['in', 'out'], oneDevice: true },
  { id: 'duo2', label: 'DeckLink Duo 2', ports: ['both', 'both', 'both', 'both'] },
  { id: 'quad2', label: 'DeckLink Quad 2', ports: Array(8).fill('both') },
  { id: '8kPro', label: 'DeckLink 8K Pro', ports: ['both', 'both', 'both', 'both'] },
  { id: 'other', label: 'Other DeckLink card', ports: [] },
];

export const modelOf = (id: string) => SDI_MODELS.find((m) => m.id === id) ?? SDI_MODELS[SDI_MODELS.length - 1];

/** What each connector of a card can do. */
export const portsOf = (c: SdiCard): PortCap[] => {
  const m = modelOf(c.model);
  return m.ports.length ? m.ports : c.connectors.map(() => 'both');
};

/** The Desktop Video device of a connector (one per connector, but on single-device cards). */
export const deviceOf = (c: SdiCard, connector: number) => (modelOf(c.model).oneDevice ? c.device : c.device + connector);

export type Role = 'unused' | 'fill' | 'key' | 'input';

/** What a connector does, and for which output or input. */
export function roleOf(hw: HardwareConfig, card: string, connector: number): { role: Role; output?: SdiOutputDef; input?: HardwareConfig['sdi']['inputs'][number] } {
  for (const o of hw.sdi.outputs) {
    if (o.card !== card) continue;
    if (o.fill === connector) return { role: 'fill', output: o };
    if (o.mode === 'externalKey' && o.key === connector) return { role: 'key', output: o };
  }
  const input = hw.sdi.inputs.find((i) => i.card === card && i.connector === connector);
  return input ? { role: 'input', input } : { role: 'unused' };
}

export const MODES: { value: SdiMode; label: string }[] = [
  { value: 'externalKey', label: 'Fill + Key (external keyer, 2 SDI)' },
  { value: 'internalKey', label: "Internal keyer (over the card's SDI input)" },
  { value: 'fillOnly', label: 'Fill only' },
];

export const ENCODINGS: { value: St2110Flow['encoding']; label: string }[] = [
  { value: 'fillKey', label: 'Fill + Key · 2 streams (YCbCr 4:2:2 10-bit + KEY)' },
  { value: 'rgba', label: 'RGBA · 1 stream (4:4:4:4 8-bit)' },
  { value: 'ycbcra', label: 'YCbCrA · 1 stream (4:2:2:4 10-bit)' },
];

export const hardwareOf = (c: ServerConfig): HardwareConfig => {
  const hw = c.hardware ?? emptyHardware();
  hw.sdi ??= { cards: [], outputs: [], inputs: [] };
  hw.sdi.cards ??= [];
  hw.sdi.outputs ??= [];
  hw.sdi.inputs ??= [];
  hw.st2110 ??= { flows: [] };
  hw.st2110.flows ??= [];
  return hw;
};

/** "Duo 2 · SDI 1 + 2". */
export function sdiOutputLabel(hw: HardwareConfig, d: SdiOutputDef): string {
  const card = hw.sdi.cards.find((c) => c.id === d.card);
  const ports = d.mode === 'externalKey' && d.key != null ? `SDI ${d.fill + 1} + ${d.key + 1}` : `SDI ${d.fill + 1}`;
  return `${card?.name ?? '?'} · ${ports}`;
}

export const modeLabel = (m: SdiMode) => (m === 'fillOnly' ? t('Fill only') : m === 'internalKey' ? t('Internal keyer') : 'Fill + Key');

/** An SDI destination takes its settings from its Hardware output. */
export function fillSdi(o: SdiOutput, hw: HardwareConfig) {
  const d = hw.sdi.outputs.find((x) => x.id === o.hardware);
  if (!d) return;
  const card = hw.sdi.cards.find((c) => c.id === d.card);
  if (card) o.device = deviceOf(card, d.fill);
  o.externalKey = d.mode !== 'internalKey';
  o.fillOnly = d.mode === 'fillOnly';
  o.genlock = d.genlock;
}

/** An ST 2110 destination takes its addresses from its Hardware flow. */
export function fillSt2110(o: St2110Output, hw: HardwareConfig) {
  const f = hw.st2110.flows.find((x) => x.id === o.hardware);
  if (!f) return;
  o.encoding = f.encoding;
  o.fill = f.fill;
  o.key = f.encoding === 'fillKey' ? (f.key ?? null) : null;
  o.interface = f.interface ?? null;
  o.ttl = f.ttl;
  o.payloadType = f.payloadType;
}

/** Ids of the Hardware outputs and flows the channels' destinations use (unwired ones aside). */
export function usedHardware(c: ServerConfig): Set<string> {
  const used = new Set<string>();
  for (const ch of c.channels)
    for (const o of [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs)]) {
      for (const d of o.sdi ?? []) if (d.hardware && d.enabled !== false) used.add(d.hardware);
      for (const d of o.st2110 ?? []) if (d.hardware && d.enabled !== false) used.add(d.hardware);
    }
  return used;
}

/** The Video streams destinations and inputs naming a Hardware id. */
export function usersOf(c: ServerConfig, id: string): string[] {
  const out: string[] = [];
  for (const ch of c.channels)
    for (const o of [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs), ...(ch.unwired ? [ch.unwired] : [])]) {
      for (const d of [...(o.sdi ?? []), ...(o.st2110 ?? [])]) if (d.hardware === id) out.push(`${ch.name} › ${d.name}`);
    }
  for (const i of c.inputs ?? []) if (i.hardware === id && (i.kind === 'sdi' || i.kind === 'st2110')) out.push(i.name);
  return out;
}

/** Removes the destinations and inputs naming a Hardware id (it is being deleted). */
export function dropUsers(c: ServerConfig, id: string) {
  for (const ch of c.channels)
    for (const o of [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs), ...(ch.unwired ? [ch.unwired] : [])]) {
      o.sdi = (o.sdi ?? []).filter((d) => d.hardware !== id);
      o.st2110 = (o.st2110 ?? []).filter((d) => d.hardware !== id);
    }
  c.inputs = (c.inputs ?? []).filter((i) => !(i.hardware === id && (i.kind === 'sdi' || i.kind === 'st2110')));
}

/** Copies the Hardware settings into every destination and input using them (what the server does on load). */
export function syncUsers(c: ServerConfig) {
  const hw = hardwareOf(c);
  for (const ch of c.channels)
    for (const o of [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs), ...(ch.unwired ? [ch.unwired] : [])]) {
      for (const d of o.sdi ?? []) fillSdi(d, hw);
      for (const d of o.st2110 ?? []) fillSt2110(d, hw);
    }
  for (const i of c.inputs ?? []) {
    const d = i.kind === 'sdi' ? hw.sdi.inputs.find((x) => x.id === i.hardware) : undefined;
    const card = d && hw.sdi.cards.find((x) => x.id === d.card);
    if (d && card) i.device = deviceOf(card, d.connector);
  }
}

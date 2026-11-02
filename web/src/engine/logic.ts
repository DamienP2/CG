// Relations between values — mirror of crates/cg-core/src/logic.rs.
import { COLOR_PROPS, type Data, type Layer, type Logic, type LogicNode, type Prop, type TextMetric } from './types';
import { parseHex, transformText, type Resolved } from './evaluate';
import { lineWidth } from './textFit';

export type LVal = number | string;

const toNum = (v: LVal) => (typeof v === 'number' ? v : parseFloat(v.trim().replace(',', '.')) || 0);
const isEmpty = (v: LVal) => (typeof v === 'number' ? v === 0 : v.trim() === '');
const numeric = (v: LVal) => typeof v === 'number' || Number.isFinite(parseFloat(v.trim().replace(',', '.')));

export type Measure = (layerId: string, values: Resolved, metric: TextMetric) => number;

export const INPUTS: Record<LogicNode['type'], string[]> = {
  layerProp: [],
  textSize: [],
  field: [],
  constant: [],
  math: ['a', 'b'],
  clamp: ['in'],
  condition: ['a', 'b', 'then', 'else'],
  target: ['in'],
  text: [],
  event: [],
  onAir: [],
  triggerIn: [],
  continue: [],
  setVar: ['when'],
  var: [],
  setField: ['in'],
  bool: ['a', 'b'],
  out: ['when'],
  resume: ['when'],
  fire: ['when'],
  nextRow: ['when'],
};

/** A value read as true: a number not 0, a text not empty, « false » or « 0 ». */
const truthy = (v: LVal | undefined) => v !== undefined && (typeof v === 'number' ? v !== 0 : !['', '0', 'false'].includes(v.trim().toLowerCase()));

class Graph {
  nodes = new Map<string, LogicNode>();
  inputs = new Map<string, string>();
  constructor(logic: Logic) {
    for (const n of logic.nodes) this.nodes.set(n.id, n);
    for (const e of logic.edges) this.inputs.set(`${e.to}|${e.port}`, e.from);
  }

  reads(id: string, seen: Set<string>, out: Set<string>) {
    if (seen.has(id)) return;
    seen.add(id);
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.type === 'layerProp') out.add(`${n.layer}|${n.prop}`);
    if (n.type === 'textSize') out.add(`${n.layer}|*`);
    for (const port of ['a', 'b', 'in', 'then', 'else', 'when']) {
      const from = this.inputs.get(`${id}|${port}`);
      if (from) this.reads(from, seen, out);
    }
  }

  eval(id: string, values: Map<string, Resolved>, data: Data, measure: Measure, depth = 0): LVal {
    const n = this.nodes.get(id);
    if (!n || depth > 64) return 0;
    const input = (port: string): LVal | undefined => {
      const from = this.inputs.get(`${id}|${port}`);
      return from === undefined ? undefined : this.eval(from, values, data, measure, depth + 1);
    };
    switch (n.type) {
      case 'layerProp': {
        const v = values.get(n.layer)?.[n.prop];
        return typeof v === 'number' ? v : 0;
      }
      case 'textSize': {
        const v = values.get(n.layer);
        return v ? measure(n.layer, v, n.metric) : 0;
      }
      case 'field':
        return data[n.key] ?? '';
      case 'constant':
        return n.value;
      case 'math': {
        const a = toNum(input('a') ?? 0);
        const b = toNum(input('b') ?? 0);
        switch (n.op) {
          case 'add':
            return a + b;
          case 'sub':
            return a - b;
          case 'mul':
            return a * b;
          case 'div':
            return b === 0 ? 0 : a / b;
          case 'min':
            return Math.min(a, b);
          case 'max':
            return Math.max(a, b);
          case 'abs':
            return Math.abs(a);
          case 'round':
            return Math.round(a);
          case 'floor':
            return Math.floor(a);
          case 'ceil':
            return Math.ceil(a);
        }
        return 0;
      }
      case 'clamp': {
        const v = toNum(input('in') ?? 0);
        return Math.min(Math.max(v, n.min), Math.max(n.max, n.min));
      }
      case 'condition': {
        const a = input('a') ?? 0;
        const b = input('b') ?? 0;
        let ok: boolean;
        switch (n.cmp) {
          case 'empty':
            ok = isEmpty(a);
            break;
          case 'notEmpty':
            ok = !isEmpty(a);
            break;
          case 'eq':
          case 'ne':
            ok = numeric(a) && numeric(b) ? toNum(a) === toNum(b) : String(a).trim() === String(b).trim();
            if (n.cmp === 'ne') ok = !ok;
            break;
          case 'gt':
            ok = toNum(a) > toNum(b);
            break;
          case 'ge':
            ok = toNum(a) >= toNum(b);
            break;
          case 'lt':
            ok = toNum(a) < toNum(b);
            break;
          default:
            ok = toNum(a) <= toNum(b);
        }
        return input(ok ? 'then' : 'else') ?? (ok ? 1 : 0);
      }
      case 'target':
        return input('in') ?? 0;
      case 'text':
        return n.value;
      // Watched on air by the server: not yet happened here.
      // As the server saw them on air (nothing in the Designer).
      case 'event':
      case 'triggerIn':
      case 'continue':
        return data[evKey(n.id)] === '1' ? 1 : 0;
      case 'var': {
        const v = data[varKey(n.name)];
        if (v === undefined) return n.test ?? 0;
        const x = parseFloat(v.replace(',', '.'));
        return Number.isFinite(x) && /^\s*-?[\d.,]+\s*$/.test(v) ? x : v;
      }
      // On air the renderer gives its presence; in the Designer, its test value.
      case 'onAir': {
        const v = parseFloat(data[onAirKey(n.template)] ?? '');
        return Number.isFinite(v) ? v : n.test ? 1 : 0;
      }
      case 'bool': {
        const a = truthy(input('a'));
        const b = truthy(input('b'));
        return (n.op === 'and' ? a && b : a || b) ? 1 : 0;
      }
      case 'out':
      case 'resume':
      case 'fire':
      case 'nextRow':
      case 'setVar':
        return input('when') ?? 0;
      case 'setField':
        return input('in') ?? '';
    }
  }
}

/** Applies the targets to `values` in dependency order (cycles skipped). */
/** A number as a text shows it: whole, or with at most 2 decimals (cg_core::logic::format_number). */
export const formatNumber = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '');

/**
 * `data` with the values the graph writes (« Set field »: a calculation shown in a text), from the
 * layers at `frame` (cg_core::logic::with_outputs); the same `data` when it writes none.
 */
export function withOutputs(t: { logic?: Logic; layers: Layer[] }, frame: number, data: Data, hold: number, resolve: (l: Layer, frame: number, data: Data, hold: number) => Resolved): Data {
  const outs = (t.logic?.nodes ?? []).filter((n): n is LogicNode & { type: 'setField' } => n.type === 'setField');
  if (!outs.length || !t.logic) return data;
  const values = new Map(t.layers.map((l) => [l.id, resolve(l, frame, data, hold)]));
  const v = nodeValues(t.logic, values, data, () => 0);
  const out = { ...data };
  for (const n of outs) {
    const x = v.get(n.id);
    out[n.key] = typeof x === 'number' ? formatNumber(x) : (x ?? '');
  }
  return out;
}

/** The data key of what an event, trigger or Continue node saw on air (cg_core::logic::event_key). */
export const evKey = (node: string) => `__ev_${node}`;
/** The data key of a variable (cg_core::logic::var_key). */
export const varKey = (name: string) => `__var_${name.trim()}`;

/** The data key of a graphic's presence on air, 0 → 1 (cg_core::logic::on_air_key). */
export const onAirKey = (template: string) => `__onair_${template}`;

/** The graphics whose presence the graph reads, with their transition (s). */
export const onAirWatched = (logic: Logic | undefined): [string, number][] => (logic?.nodes ?? []).flatMap((n) => (n.type === 'onAir' ? [[n.template, n.transition ?? 0] as [string, number]] : []));

/**
 * How much `template` is on air among `items` (cg_core::playout::presence): in over `transition` s
 * from its take, out over as many once it goes out (eased); the most present counts.
 */
export function presence(items: { templateId: string; phase: string; age?: number; frame: number }[], holdOf: (template: string) => number, template: string, transition: number, fps: number, extraSecs = 0): number {
  const ease = (k: number) => {
    const x = Math.min(1, Math.max(0, k));
    return x * x * (3 - 2 * x);
  };
  let best = 0;
  for (const i of items) {
    if (i.templateId !== template) continue;
    const going = i.phase === 'out' || i.phase === 'outHold';
    const v = transition <= 0 ? (going ? 0 : 1) : going ? 1 - ease(Math.max(0, i.frame - holdOf(template)) / fps / transition) : ease(((i.age ?? 0) / fps + extraSecs) / transition);
    best = Math.max(best, v);
  }
  return best;
}

export function applyLogic(logic: Logic | undefined, values: Map<string, Resolved>, data: Data, measure: Measure) {
  if (!logic?.nodes.length) return;
  const g = new Graph(logic);
  const targets = logic.nodes.filter((n): n is LogicNode & { type: 'target' } => n.type === 'target');
  const reads = targets.map((t) => {
    const out = new Set<string>();
    g.reads(t.id, new Set(), out);
    return out;
  });
  const n = targets.length;
  const indeg = new Array(n).fill(0);
  const after: number[][] = targets.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i !== j && (reads[j].has(`${targets[i].layer}|${targets[i].prop}`) || reads[j].has(`${targets[i].layer}|*`))) {
        after[i].push(j);
        indeg[j]++;
      }
    }
  const ready = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  const order: number[] = [];
  while (ready.length) {
    const i = ready.shift()!;
    order.push(i);
    for (const j of after[i]) if (--indeg[j] === 0) ready.push(j);
  }
  for (const i of order) {
    const t = targets[i];
    if (!g.inputs.has(`${t.id}|in`)) continue;
    const v = g.eval(t.id, values, data, measure);
    const lv = values.get(t.layer);
    if (!lv) continue;
    if (COLOR_PROPS.has(t.prop as Prop)) {
      const c = typeof v === 'string' ? parseHex(v) : undefined;
      if (c) lv[t.prop] = c;
      continue;
    }
    const cur = typeof lv[t.prop] === 'number' ? (lv[t.prop] as number) : 0;
    const x = toNum(v);
    const out = t.mode === 'add' ? cur + x : t.mode === 'multiply' ? cur * x : x;
    if (Number.isFinite(out)) lv[t.prop] = out;
  }
}

/** Value of every node (for the editor's live readouts). */
export function nodeValues(logic: Logic, values: Map<string, Resolved>, data: Data, measure: Measure): Map<string, LVal> {
  const g = new Graph(logic);
  const out = new Map<string, LVal>();
  for (const n of logic.nodes) out.set(n.id, g.eval(n.id, values, data, measure));
  return out;
}

/** Text measurement with the browser's fonts (same files as the server's). */
export function measureLayer(layers: Layer[], data: Data, interpolate: (t: string, d: Data) => string): Measure {
  return (id, v, metric) => {
    const l = layers.find((x) => x.id === id);
    if (!l || l.type !== 'text') return 0;
    let text = interpolate(l.text, data);
    text = l.uppercase ? text.toUpperCase() : transformText(text, l.transform);
    const size = typeof v.fontSize === 'number' ? v.fontSize : 0;
    const lines = text.split('\n');
    if (metric === 'lines') return lines.length;
    if (metric === 'chars') return [...text].length;
    if (metric === 'height') return text ? lines.length * size * (l.lineHeight ?? 1.2) : 0;
    if (!text) return 0;
    const font = `${l.fontWeight} ${size}px "${l.fontFamily}", Inter, system-ui, sans-serif`;
    const ls = typeof v.letterSpacing === 'number' ? v.letterSpacing : 0;
    // Measured once per font and line (lineWidth), not on each frame.
    return Math.max(...lines.map((line) => lineWidth(font, line) + Math.max(0, [...line].length - 1) * ls));
  };
}

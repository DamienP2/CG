// The Logic canvas — mirror of crates/cg-core/src/logic/mod.rs (values; the flows run on the server).
import { COLOR_PROPS, type Color, type Data, type Layer, type Logic, type LogicEdge, type LogicNode, type Prop, type TextMetric } from './types';
import { parseHex, toHex, transformText, type Resolved } from './evaluate';
import { lineWidth } from './textFit';
import { runExpr, text, toNum, truthy, type Clock, type LVal } from './expr';

export type { LVal } from './expr';

export type Measure = (layerId: string, values: Resolved, metric: TextMetric) => number;

// ── Ports ─────────────────────────────────────────────────────────────────

/** What a port carries: a flow ▶, or a value of a kind (any converts). */
export type PortType = 'flow' | 'num' | 'text' | 'color' | 'bool' | 'img' | 'list' | 'any';
export interface Port {
  id: string;
  /** English label (translated by the editor); a name or a key shows as is when `raw`. */
  label: string;
  type: PortType;
  raw?: boolean;
}

const METRIC_KEYS: Record<string, TextMetric> = { 'text.width': 'width', 'text.height': 'height', 'text.lines': 'lines', 'text.chars': 'chars' };
export const metricOf = (key: string): TextMetric | undefined => METRIC_KEYS[key];

/** The type of a Layer row. */
export function rowType(key: string): PortType {
  if (metricOf(key)) return 'num';
  if (key.startsWith('setting.')) return 'any';
  if (key === 'content.src' || key.endsWith('.src') || key === 'content.image') return 'img';
  if (key.startsWith('content.')) return key === 'content.link' || key === 'content.items' || key === 'content.csv' ? 'list' : 'text';
  return COLOR_PROPS.has(key as Prop) ? 'color' : 'num';
}

/** The output of a source (a graphic, a playlist, a layer) into a When step. */
const SRC: Port = { id: 'src', label: 'Source', type: 'any' };

/** A node's inputs (left) and outputs (right). */
export function portsOf(n: LogicNode): { ins: Port[]; outs: Port[] } {
  const named = (names: string[], type: PortType = 'any'): Port[] => names.map((id) => ({ id, label: id, type, raw: true }));
  const run: Port = { id: 'run', label: 'Run', type: 'flow' };
  const next: Port = { id: 'next', label: 'Then', type: 'flow' };
  switch (n.type) {
    case 'layer':
      return {
        ins: n.rows.filter((r) => !metricOf(r.key)).map((r) => ({ id: r.key, label: r.key, type: rowType(r.key), raw: true })),
        outs: [SRC, ...n.rows.filter((r) => !r.key.startsWith('content.')).map((r) => ({ id: r.key, label: r.key, type: rowType(r.key), raw: true }))],
      };
    case 'when':
      return { ins: [{ id: 'src', label: 'Source', type: 'any' }], outs: [{ id: 'out', label: 'Then', type: 'flow' }] };
    case 'check':
      return {
        ins: [{ id: 'run', label: 'When', type: 'flow' }, { id: 'in', label: 'Value', type: 'any' }],
        outs: [{ id: 'yes', label: 'True', type: 'flow' }, { id: 'no', label: 'False', type: 'flow' }, { id: 'out', label: 'Result', type: 'bool' }],
      };
    case 'field':
      return { ins: [], outs: [{ id: 'out', label: 'Value', type: 'any' }] };
    case 'constant':
      return { ins: [], outs: [{ id: 'out', label: 'Number', type: 'num' }] };
    case 'text':
      return { ins: [], outs: [{ id: 'out', label: 'Text', type: 'text' }] };
    case 'color':
      return { ins: [], outs: [{ id: 'out', label: 'Colour', type: 'color' }] };
    case 'flag':
      return { ins: [], outs: [{ id: 'out', label: 'Yes / no', type: 'bool' }] };
    case 'expr':
      return { ins: named(n.inputs), outs: [{ id: 'out', label: 'Result', type: 'any' }] };
    case 'if':
      return {
        ins: [{ id: 'run', label: 'When', type: 'flow' }, ...named(n.inputs)],
        outs: [...n.branches.map((_, i) => ({ id: `b${i}`, label: i ? 'Else if' : 'If', type: 'flow' as const })), { id: 'else', label: 'Else', type: 'flow' }, { id: 'out', label: 'Result', type: 'any' }],
      };
    case 'lookup':
      return { ins: [{ id: 'in', label: 'Key', type: 'any' }], outs: [{ id: 'out', label: 'Value', type: 'any' }] };
    case 'onAir':
      return { ins: [], outs: [{ id: 'out', label: 'On air', type: 'num' }] };
    case 'var':
      return { ins: [], outs: [{ id: 'out', label: 'Value', type: 'any' }] };
    case 'setField':
      return { ins: [{ id: 'in', label: 'Value', type: 'any' }], outs: [] };
    case 'event':
    case 'triggerIn':
    case 'continue':
    case 'start':
    case 'every':
      return { ins: [], outs: [{ id: 'out', label: 'When', type: 'flow' }] };
    case 'wait':
      return { ins: [run, { id: 'seconds', label: 'Seconds', type: 'num' }], outs: [next] };
    case 'counter':
      return { ins: [run, { id: 'reset', label: 'Reset', type: 'flow' }], outs: [next, { id: 'out', label: 'Counted', type: 'num' }] };
    case 'once':
      return { ins: [run, { id: 'reset', label: 'Reset', type: 'flow' }], outs: [next] };
    case 'setVar':
      return { ins: [run, { id: 'value', label: 'Value', type: 'any' }], outs: [next] };
    case 'how':
    case 'animate':
    case 'playSound':
    case 'stopSound':
    case 'out':
    case 'resume':
    case 'fire':
    case 'nextRow':
    case 'take':
    case 'widget':
    case 'resumePlaylist':
    case 'stopAuto':
    case 'clearAll':
      return { ins: [run], outs: [next] };
    // A source: its moments go through a When step, its state through an If… (or straight into a value).
    case 'template':
    case 'playlist':
      return { ins: [], outs: [{ ...SRC, type: 'bool' }] };
  }
  return { ins: [], outs: [] };
}

/** A wire from a port of type `a` can go into one of type `b`. */
export const accepts = (a: PortType, b: PortType) => a === b || a === 'any' || b === 'any' || (a !== 'flow' && b !== 'flow') || (b === 'flow' && a !== 'list') || (a === 'flow' && (b === 'num' || b === 'bool'));

/** The output of an edge. */
export const fromPortOf = (e: LogicEdge) => e.fromPort ?? 'out';

// ── Evaluation ────────────────────────────────────────────────────────────

const empty = '';

class Graph {
  nodes = new Map<string, LogicNode>();
  /** `to|port` → [from, from port]. */
  inputs = new Map<string, [string, string]>();
  /** Nodes in a frame switched off: they do not act. */
  off = new Set<string>();
  constructor(logic: Logic) {
    const offFrames = new Set((logic.frames ?? []).filter((f) => f.off).map((f) => f.id));
    for (const n of logic.nodes) {
      this.nodes.set(n.id, n);
      if (n.frame && offFrames.has(n.frame)) this.off.add(n.id);
    }
    for (const e of logic.edges) this.inputs.set(`${e.to}|${e.port}`, [e.from, fromPortOf(e)]);
  }
  acts(id: string) {
    return !this.off.has(id);
  }

  /** Layers (`layer|prop`, or `layer|*` for all) a node's input reads, upstream. */
  reads(id: string, port: string, seen: Set<string>, out: Set<string>) {
    const src = this.inputs.get(`${id}|${port}`);
    if (!src) return;
    const [from, fp] = src;
    if (seen.has(`${from}|${fp}`)) return;
    seen.add(`${from}|${fp}`);
    const n = this.nodes.get(from);
    if (!n) return;
    if (n.type === 'layer') {
      out.add(`${n.layer}|${metricOf(fp) ? '*' : fp}`);
      return;
    }
    for (const p of portsOf(n).ins) if (p.type !== 'flow') this.reads(from, p.id, seen, out);
  }

  input(id: string, port: string, cx: Cx, depth: number): LVal | undefined {
    const src = this.inputs.get(`${id}|${port}`);
    return src ? this.eval(src[0], src[1], cx, depth + 1) : undefined;
  }

  eval(id: string, port: string, cx: Cx, depth = 0): LVal {
    const n = this.nodes.get(id);
    if (!n || depth > 96) return 0;
    switch (n.type) {
      case 'layer': {
        const v = cx.values.get(n.layer);
        if (!v) return 0;
        const m = metricOf(port);
        if (m) return cx.measure(n.layer, v, m);
        const x = (v as unknown as Record<string, unknown>)[port];
        if (typeof x === 'number') return x;
        if (Array.isArray(x)) return toHex(x as Color, Math.round(Math.min(1, Math.max(0, x[3] as number)) * 255) !== 255);
        return 0;
      }
      case 'field':
        return cx.data[n.key] ?? '';
      case 'constant':
        return n.value;
      case 'text':
      case 'color':
        return n.value;
      case 'flag':
        return n.value ? 1 : 0;
      case 'expr':
        return runExpr(n.expr, (name) => this.input(id, name, cx, depth) ?? empty, cx.clock);
      case 'if': {
        const chosen = this.branch(n, cx, depth);
        if (port !== 'out') return (chosen < 0 ? 'else' : `b${chosen}`) === port ? 1 : 0;
        return this.valueExpr(id, chosen < 0 ? n.otherwise : n.branches[chosen].value, cx, depth);
      }
      case 'lookup': {
        const key = text(this.input(id, 'in', cx, depth) ?? empty).trim().toLowerCase();
        const hit = n.rows.find((r) => {
          const k = r.key.trim().toLowerCase();
          return n.contains ? !!k && key.includes(k) : k === key;
        });
        return hit ? hit.value : n.otherwise;
      }
      case 'event':
      case 'triggerIn':
      case 'continue':
      case 'when':
        return cx.data[evKey(n.id)] === '1' ? 1 : 0;
      case 'check':
        return this.holds(n, cx, depth) ? 1 : 0;
      case 'template': {
        const v = parseFloat(cx.data[onAirKey(n.template)] ?? '');
        return v > 0.5 ? 1 : 0;
      }
      case 'playlist':
        return cx.data[`__plair_${n.playlist}`] === '1' ? 1 : 0;
      case 'var': {
        const v = cx.data[varKey(n.name)];
        if (v === undefined) return n.test ?? 0;
        const x = parseFloat(v.replace(',', '.'));
        return Number.isFinite(x) && /^\s*-?[\d.,]+\s*$/.test(v) ? x : v;
      }
      case 'counter': {
        const v = parseFloat(cx.data[countKey(n.id)] ?? '');
        return Number.isFinite(v) ? v : n.start;
      }
      case 'onAir': {
        const v = parseFloat(cx.data[onAirKey(n.template)] ?? '');
        return Number.isFinite(v) ? v : n.test ? 1 : 0;
      }
      case 'setField':
        return this.input(id, 'in', cx, depth) ?? '';
    }
    return 0;
  }

  /** The phrase of an If… holds (cg_core::logic::lower). */
  holds(n: LogicNode & { type: 'check' }, cx: Cx, depth: number): boolean {
    const bit = (k: string) => parseFloat(cx.data[k] ?? '') > 0.5;
    const res = n.rows.flatMap((r, ri): [boolean, number][] => {
      const [kind, id] = r.what.split(/:(.*)/s);
      const v: LVal | undefined =
        kind === 'tpl' ? (bit(onAirKey(id)) ? 1 : 0)
        : kind === 'pl' ? (bit(['interrupted', 'notInterrupted'].includes(r.test) ? `__plint_${id}` : ['ended', 'notEnded'].includes(r.test) ? `__ended_${id}` : `__plair_${id}`) ? 1 : 0)
        : kind === 'field' ? (cx.data[id] ?? '')
        : kind === 'var' ? (cx.data[varKey(id)] ?? 0)
        : r.what === 'in' ? this.input(n.id, 'in', cx, depth) ?? ''
        : undefined;
      if (v === undefined) return [];
      const w = r.value ?? '';
      const c = compare(v, w);
      switch (r.test) {
        case 'onAir': case 'interrupted': case 'ended': case 'yes': return [[toNum(v) > 0.5, ri]];
        case 'notOnAir': case 'notInterrupted': case 'notEnded': case 'no': return [[toNum(v) < 0.5, ri]];
        case 'gt': return [[c > 0, ri]];
        case 'ge': return [[c >= 0, ri]];
        case 'lt': return [[c < 0, ri]];
        case 'le': return [[c <= 0, ri]];
        case 'eq': return [[c === 0, ri]];
        case 'ne': return [[c !== 0, ri]];
        case 'contains': return [[text(v).toLowerCase().includes(w.toLowerCase()), ri]];
        case 'empty': return [[!text(v).trim(), ri]];
        case 'notEmpty': return [[!!text(v).trim(), ri]];
      }
      return [];
    });
    if (!res.length) return false;
    // « and » binds first: groups of lines joined by « and », any group true.
    const or = (i: number) => (n.rows[i].join ?? (n.any ? 'or' : 'and')) === 'or';
    const groups: boolean[][] = [];
    res.forEach(([v, ri], i) => (i === 0 || or(ri) ? groups.push([v]) : groups[groups.length - 1].push(v)));
    return groups.some((g) => g.every(Boolean));
  }

  /** The first branch of an If whose condition holds (-1: else). */
  branch(n: LogicNode & { type: 'if' }, cx: Cx, depth: number): number {
    return n.branches.findIndex((b) => !!b.when.trim() && truthy(this.valueExpr(n.id, b.when, cx, depth)));
  }

  valueExpr(id: string, e: string, cx: Cx, depth: number): LVal {
    return runExpr(e, (name) => this.input(id, name, cx, depth) ?? empty, cx.clock);
  }
}

/** Numbers as numbers, else texts (any case), as cg_core::logic::expr::compare. */
function compare(a: LVal, b: LVal): number {
  const num = (v: LVal) => (typeof v === 'number' ? v : /^\s*-?\d+([.,]\d+)?\s*$/.test(v) ? parseFloat(v.replace(',', '.')) : NaN);
  const x = num(a);
  const y = num(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  const s = text(a).trim().toLowerCase();
  const u = text(b).trim().toLowerCase();
  return s === u ? 0 : s < u ? -1 : 1;
}

interface Cx {
  values: Map<string, Resolved>;
  data: Data;
  measure: Measure;
  clock: Clock;
}

const NO_CLOCK: Clock = { secs: 0, nowMs: 0 };

/** The time for a template at `frame` (Designer, previews): seconds since the start of its timeline. */
export const clockAt = (frame: number, fps = 50): Clock => ({ secs: frame / Math.max(1, fps), nowMs: Date.now() });

/** The data key of what an event, trigger or Continue node saw on air (cg_core::logic::event_key). */
export const evKey = (node: string) => `__ev_${node}`;
/** The data key of a variable (cg_core::logic::var_key). */
export const varKey = (name: string) => `__var_${name.trim()}`;
/** The data key of a Counter's value (cg_core::logic::count_key). */
export const countKey = (node: string) => `__cnt_${node}`;
/** The data key of a graphic's presence on air, 0 → 1 (cg_core::logic::on_air_key). */
export const onAirKey = (template: string) => `__onair_${template}`;

/** The graphics whose presence the graph reads, with their transition (s). */
export const onAirWatched = (logic: Logic | undefined): [string, number][] =>
  (logic?.nodes ?? []).flatMap((n): [string, number][] => (n.type === 'onAir' ? [[n.template, n.transition ?? 0]] : n.type === 'check' ? n.rows.filter((r) => r.what.startsWith('tpl:')).map((r) => [r.what.slice(4), 0]) : []));

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

/** The rows of Layer nodes that a wire sets: [node, layer, row key, mode]. */
function targetsOf(logic: Logic, g: Graph) {
  const out: { node: string; layer: string; key: string; mode: string }[] = [];
  for (const n of logic.nodes) {
    if (n.type !== 'layer' || !g.acts(n.id)) continue;
    for (const r of n.rows) if (!metricOf(r.key) && !r.key.includes('.') && g.inputs.has(`${n.id}|${r.key}`)) out.push({ node: n.id, layer: n.layer, key: r.key, mode: r.mode ?? 'set' });
  }
  return out;
}

/** The layers whose values the graph sets (cg_core::logic::targeted). */
export function targeted(logic: Logic | undefined): Set<string> {
  if (!logic?.nodes.length) return new Set();
  const wired = new Set(logic.edges.map((e) => `${e.to}|${e.port}`));
  const out = new Set<string>();
  for (const n of logic.nodes) if (n.type === 'layer' && n.rows.some((r) => !metricOf(r.key) && !r.key.startsWith('content.') && wired.has(`${n.id}|${r.key}`))) out.add(n.layer);
  return out;
}

/** The layers a wire sets something of (a property or a content). */
export function wiredLayers(logic: Logic | undefined): Set<string> {
  const out = new Set<string>();
  if (!logic?.nodes.length) return out;
  const wired = new Set(logic.edges.map((e) => `${e.to}|${e.port}`));
  for (const n of logic.nodes) if (n.type === 'layer' && n.rows.some((r) => wired.has(`${n.id}|${r.key}`))) out.add(n.layer);
  return out;
}

/** The properties of `layer` the graph sets (a wire into a row of one of its Layer nodes). */
export function drivenProps(logic: Logic | undefined, layer: string): Set<string> {
  const out = new Set<string>();
  if (!logic?.nodes.length) return out;
  const wired = new Set(logic.edges.map((e) => `${e.to}|${e.port}`));
  for (const n of logic.nodes) if (n.type === 'layer' && n.layer === layer) for (const r of n.rows) if (wired.has(`${n.id}|${r.key}`)) out.add(r.key);
  return out;
}

/** Applies the targets to `values` in dependency order (cycles skipped). */
export function applyLogic(logic: Logic | undefined, values: Map<string, Resolved>, data: Data, measure: Measure, clock: Clock = NO_CLOCK) {
  if (!logic?.nodes.length) return;
  const g = new Graph(logic);
  const targets = targetsOf(logic, g);
  if (!targets.length) return;
  const reads = targets.map((t) => {
    const out = new Set<string>();
    g.reads(t.node, t.key, new Set(), out);
    return out;
  });
  const n = targets.length;
  const indeg = new Array(n).fill(0);
  const after: number[][] = targets.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i !== j && (reads[j].has(`${targets[i].layer}|${targets[i].key}`) || reads[j].has(`${targets[i].layer}|*`))) {
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
  const cx: Cx = { values, data, measure, clock };
  for (const i of order) {
    const t = targets[i];
    const v = g.input(t.node, t.key, cx, 0);
    if (v === undefined) continue;
    const lv = values.get(t.layer);
    if (!lv) continue;
    const rec = lv as unknown as Record<string, unknown>;
    if (COLOR_PROPS.has(t.key as Prop)) {
      const c = parseHex(text(v));
      if (c) rec[t.key] = c;
      continue;
    }
    const cur = typeof rec[t.key] === 'number' ? (rec[t.key] as number) : 0;
    const x = toNum(v);
    const out = t.mode === 'add' ? cur + x : t.mode === 'multiply' ? cur * x : x;
    if (Number.isFinite(out)) rec[t.key] = out;
  }
}

/** Sets `path` (`a.b.c`) of `o` (as widgets/kit setPath; not imported: the widgets import the engine). */
function setPath(o: unknown, path: string, v: unknown) {
  const ks = path.split('.');
  let a = o as Record<string, unknown>;
  for (let i = 0; i < ks.length - 1; i++) {
    if (a[ks[i]] == null) a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    a = a[ks[i]] as Record<string, unknown>;
  }
  a[ks[ks.length - 1]] = v;
}

type Resolve = (l: Layer, frame: number, data: Data, hold: number) => Resolved;

/**
 * `data` with the values the graph writes (« Set field »: a calculation shown in a text), from the
 * layers at `frame` (cg_core::logic::with_outputs); the same `data` when it writes none.
 */
export function withOutputs(t: { logic?: Logic; layers: Layer[] }, frame: number, data: Data, hold: number, resolve: Resolve, clock: Clock = NO_CLOCK): Data {
  const outs = (t.logic?.nodes ?? []).filter((n): n is LogicNode & { type: 'setField' } => n.type === 'setField');
  if (!outs.length || !t.logic) return data;
  const g = new Graph(t.logic);
  const cx: Cx = { values: new Map(t.layers.map((l) => [l.id, resolve(l, frame, data, hold)])), data, measure: () => 0, clock };
  const out = { ...data };
  for (const n of outs) if (g.acts(n.id)) out[n.key] = text(g.eval(n.id, 'out', cx));
  return out;
}

/** The layers with the contents the Layer nodes set (`content.text`…, cg_core::logic::patched); the same layers when none. */
export function patchedLayers(t: { logic?: Logic; layers: Layer[] }, frame: number, data: Data, hold: number, resolve: Resolve, clock: Clock = NO_CLOCK): Layer[] {
  const logic = t.logic;
  if (!logic?.nodes.length) return t.layers;
  const g = new Graph(logic);
  const sets: [string, string, string][] = [];
  for (const n of logic.nodes) {
    if (n.type !== 'layer' || !g.acts(n.id)) continue;
    for (const r of n.rows) if (r.key.startsWith('content.') && g.inputs.has(`${n.id}|${r.key}`)) sets.push([n.id, n.layer, r.key]);
  }
  if (!sets.length) return t.layers;
  const cx: Cx = { values: new Map(t.layers.map((l) => [l.id, resolve(l, frame, data, hold)])), data, measure: () => 0, clock };
  const layers = t.layers.map((l) => (sets.some((s) => s[1] === l.id) ? (structuredClone(l) as Layer) : l));
  for (const [node, layer, key] of sets) {
    const v = g.input(node, key, cx, 0);
    const l = layers.find((x) => x.id === layer);
    if (v !== undefined && l) setPath(l, key.slice('content.'.length), text(v));
  }
  return layers;
}

/** The value of every output of every node (`id|port`), for the editors' live readouts. */
export function nodeValues(logic: Logic, values: Map<string, Resolved>, data: Data, measure: Measure, clock: Clock = NO_CLOCK): Map<string, LVal> {
  const g = new Graph(logic);
  const cx: Cx = { values, data, measure, clock };
  const out = new Map<string, LVal>();
  for (const n of logic.nodes) {
    const { ins, outs } = portsOf(n);
    for (const p of outs) if (p.type !== 'flow' || n.type === 'if') out.set(`${n.id}|${p.id}`, g.eval(n.id, p.id, cx));
    // What comes into a Layer row or an action's value.
    for (const p of ins) if (p.type !== 'flow') {
      const v = g.input(n.id, p.id, cx, 0);
      if (v !== undefined) out.set(`${n.id}|in:${p.id}`, v);
    }
    if (n.type === 'if') out.set(`${n.id}|chosen`, g.branch(n, cx, 0));
  }
  return out;
}

/** The graph's expressions use the time (they change on their own). */
export const logicUsesTime = (logic: Logic | undefined) => !!logic?.nodes.some((n) => (n.type === 'expr' && /\(/.test(n.expr) && timeRe.test(n.expr)) || (n.type === 'if' && n.branches.some((b) => timeRe.test(b.when) || timeRe.test(b.value))));
const timeRe = /\b(temps|time|heure|hour|minutes?|secondes?|seconds|osciller|osc|clignoter|blink)\s*\(/i;

/** Text measurement with the browser's fonts (same files as the server's). */
export function measureLayer(layers: Layer[], data: Data, interpolate: (t: string, d: Data) => string): Measure {
  return (id, v, metric) => {
    const l = layers.find((x) => x.id === id);
    if (!l || l.type !== 'text') return 0;
    let txt = interpolate(l.text, data);
    txt = l.uppercase ? txt.toUpperCase() : transformText(txt, l.transform);
    const size = typeof v.fontSize === 'number' ? v.fontSize : 0;
    const lines = txt.split('\n');
    if (metric === 'lines') return lines.length;
    if (metric === 'chars') return [...txt].length;
    if (metric === 'height') return txt ? lines.length * size * (l.lineHeight ?? 1.2) : 0;
    if (!txt) return 0;
    const font = `${l.fontWeight} ${size}px "${l.fontFamily}", Inter, system-ui, sans-serif`;
    const ls = typeof v.letterSpacing === 'number' ? v.letterSpacing : 0;
    // Measured once per font and line (lineWidth), not on each frame.
    return Math.max(...lines.map((line) => lineWidth(font, line) + Math.max(0, [...line].length - 1) * ls));
  };
}

import { ArrowDown, ArrowDownUp, ArrowLeft, ArrowRight, ArrowUp, Database, Filter, Hash, Image as ImageIcon, Palette, Plus, Rows3, ToggleLeft, Trash2, Type, Variable, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { isTable, pipeline, useBoundData, useData, useSources, type Stage } from '../data/dataStore';
import { col, holdFrame, interpolateText, newId, num, parseHex, resolveLayer, toHex } from '../engine/evaluate';
import { applyLogic, INPUTS, measureLayer, nodeValues } from '../engine/logic';
import { api } from '../store';
import { columnKey, rowKey, TEXT_LIKE, type CondOp, type DataSet, type RowChange, type Data, type DataFilter, type DataFlow, type DataStep, type Field, type FieldKind, type FlowNode, type Layer, type Logic, type LogicNode, type Prop, type Template } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { navigate } from '../router';
import { ResizeCorner, useCanvasView } from '../ui/canvasView';
import { findLayer, useDesigner } from './designerStore';
import { AssetPicker, fieldKey, PROP_LABELS } from './Inspector';
import { ICONS } from './LayersPanel';
import { fmt, inputLabel, KINDS, LogicNodeBody, makeNode } from './LogicEditor';
import { WidgetRunButtons } from './WidgetRun';

/*
 * Data canvas. The data goes through as tables:
 *   source (a list of its value, as rows and columns)
 *     → filter (conditions, rows, columns) → sort (keys) → transform (text)
 *     → variable (the text of the last table: a line per row)
 *     → layers' values, and the operations (math, conditions…).
 * The source → … → variable part is the template's `dataflow`, compiled into
 * each variable's binding (list + steps) at each change. Variables → layers
 * are {{key}} in a text or property bindings; the operations are the logic
 * graph, whose "field" and "set property" nodes are the variables and the
 * layers' ports here. Positions of variables and layers, and the sizes of
 * the nodes, are a per-browser layout.
 */

export const useDataCanvas = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** What a layer shows, wired by default: its text, or its picture. */
function contentOf(l: Layer): string[] {
  if (l.type === 'image') return ['src'];
  return typeof (l as { text?: unknown }).text === 'string' ? ['text'] : [];
}
const contentValue = (l: Layer, port: string) => String((l as unknown as Record<string, unknown>)[port] ?? '');
/** A {{key}} in a layer's text or picture. */
const tokensIn = (l: Layer, port: string, key: string) => contentValue(l, port).includes(`{{${key}}}`);

/** Properties a layer exposes as ports. */
function portsOf(l: Layer): string[] {
  const props: Prop[] = ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'opacity'];
  if (l.type !== 'image' && l.type !== 'slideshow') props.push('fill');
  if (l.type !== 'image' && l.type !== 'slideshow' && l.type !== 'progress' && l.type !== 'qrCode') props.push('stroke', 'strokeWidth');
  if (l.type === 'rect' || l.type === 'group' || l.type === 'progress') props.push('cornerRadius');
  if (TEXT_LIKE.has(l.type)) props.push('fontSize', 'letterSpacing');
  if (l.type === 'image') props.push('cropLeft', 'cropRight', 'cropTop', 'cropBottom');
  return props;
}
const isColor = (p: string) => p === 'fill' || p === 'stroke';

/** Text operations of a Transform node. */
const TRANSFORMS: { make: () => DataFilter; label: string }[] = [
  { make: () => ({ type: 'upper' }), label: 'Uppercase' },
  { make: () => ({ type: 'lower' }), label: 'Lowercase' },
  { make: () => ({ type: 'capitalize' }), label: 'Capitalize' },
  { make: () => ({ type: 'trim' }), label: 'Trim spaces' },
  { make: () => ({ type: 'prefix', text: '' }), label: 'Prefix' },
  { make: () => ({ type: 'suffix', text: '' }), label: 'Suffix' },
  { make: () => ({ type: 'replace', find: '', with: '' }), label: 'Replace' },
  { make: () => ({ type: 'truncate', max: 30 }), label: 'Truncate' },
  { make: () => ({ type: 'number', decimals: 0, grouping: true }), label: 'Number format' },
  { make: () => ({ type: 'math', op: 'add', value: 0 }), label: 'Calculate' },
  { make: () => ({ type: 'map', when: '', then: '' }), label: 'If equals' },
  { make: () => ({ type: 'default', text: '' }), label: 'If empty' },
  { make: () => ({ type: 'join', separator: ' · ' }), label: 'Join rows' },
];

const CONDITIONS: { op: CondOp; label: string; value: boolean }[] = [
  { op: 'eq', label: '=', value: true },
  { op: 'ne', label: '≠', value: true },
  { op: 'contains', label: 'contains', value: true },
  { op: 'notContains', label: 'does not contain', value: true },
  { op: 'startsWith', label: 'starts with', value: true },
  { op: 'gt', label: '>', value: true },
  { op: 'ge', label: '≥', value: true },
  { op: 'lt', label: '<', value: true },
  { op: 'le', label: '≤', value: true },
  { op: 'empty', label: 'is empty', value: false },
  { op: 'notEmpty', label: 'is not empty', value: false },
];

const OPERATIONS = KINDS.filter((k) => k.type !== 'field' && k.type !== 'target');

const W = { source: 360, step: 320, field: 250, logic: 210, layer: 260 };
const HEAD = 34;
const ROW = 24;
const CROW = 52;
const COLS = { source: 40, field: 1640, logic: 1940, layer: 2220 };

interface Layout {
  pos: Record<string, { x: number; y: number }>;
  size: Record<string, { w: number; h?: number }>;
  collapsed: Record<string, boolean>;
}

function loadLayout(id: string): Layout {
  const empty: Layout = { pos: {}, size: {}, collapsed: {} };
  try {
    const l = JSON.parse(localStorage.getItem(`pulse.dataCanvas.${id}`) ?? '{}');
    return { pos: l.pos ?? {}, size: l.size ?? {}, collapsed: l.collapsed ?? {} };
  } catch {
    return empty;
  }
}

const tokenOf = (key: string) => `{{${key}}}`;

type Pt = { x: number; y: number };
function curve(a: Pt, b: Pt) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

type Wire = { kind: 'flow'; id: string } | { kind: 'field'; key: string } | { kind: 'logic'; id: string };
type StepType = DataStep['type'];

const STEP: Record<StepType, { label: string; icon: typeof Filter; hint: string; make: () => DataStep }> = {
  filter: { label: 'Filter', icon: Filter, hint: 'Rows matching conditions, some rows, some columns', make: () => ({ type: 'filter', where: [], from: 0, count: 0, columns: [] }) },
  sort: { label: 'Sort', icon: ArrowDownUp, hint: 'Order the rows by one or more columns', make: () => ({ type: 'sort', keys: [] }) },
  transform: { label: 'Transform', icon: Wand2, hint: 'Uppercase, prefix, replace, number format…', make: () => ({ type: 'transform', columns: [], ops: [] }) },
};

/** The step part of a flow node (what the binding keeps). */
function stepOf(n: FlowNode): DataStep {
  const { id: _id, x: _x, y: _y, ...step } = n as FlowNode & { type: StepType };
  return step as DataStep;
}

/** Height of a data set's column row (its ports follow it). */
const DS_ROW = 28;

/** The source node and the steps leading to node `id` (included). */
function chainOf(flow: DataFlow, id: string): { source: FlowNode & { type: 'source' }; steps: DataStep[] } | null {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const steps: DataStep[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && cur.type !== 'source') {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    steps.unshift(stepOf(cur));
    const from = flow.edges.find((e) => e.to === cur!.id)?.from;
    cur = from ? byId.get(from) : undefined;
  }
  return cur?.type === 'source' ? { source: cur, steps } : null;
}

/**
 * The graph of a template made before the Data canvas worked on tables:
 * the simple paths (`a.b`, `items[0].x`, `items[*].x`), their sort and
 * filters become nodes. Others (`rows[{row}].x`…) stay as they are.
 */
function migrate(t: Template): DataFlow {
  const flow: DataFlow = { nodes: [], edges: [] };
  let y = 40;
  for (const f of t.fields) {
    const b = f.binding;
    if (!b?.source || isTable(b)) continue;
    const m = b.path.match(/^([\w.]*?)(?:\[(-?\d+|\*)\])?(?:\.?([\w.]+))?$/);
    if (!m || /length$/.test(b.path)) continue;
    const [, list = '', idx, column] = m;
    const chain: FlowNode[] = [{ id: newId(), x: COLS.source, y, type: 'source', source: b.source, list: idx === undefined ? '' : list }];
    const col = idx === undefined ? (b.path ? b.path : '') : (column ?? '');
    if (b.sort?.by && b.sort.list === list) chain.push({ id: newId(), x: 0, y, type: 'sort', keys: [{ column: b.sort.by, descending: b.sort.descending, numeric: b.sort.numeric }] });
    if (idx !== undefined || col) {
      const i = idx === undefined || idx === '*' ? 0 : +idx;
      chain.push({ id: newId(), x: 0, y, type: 'filter', where: [], from: i >= 0 && idx !== undefined && idx !== '*' ? i + 1 : i, count: idx === undefined || idx === '*' ? 0 : 1, columns: col ? [col] : [] });
    }
    if (b.filters?.length) chain.push({ id: newId(), x: 0, y, type: 'transform', columns: [], ops: b.filters });
    chain.forEach((n, i) => {
      n.x = COLS.source + i * (W.step + 50) + (i ? 40 : 0);
      flow.nodes.push(n);
      flow.edges.push({ from: n.id, to: chain[i + 1]?.id ?? `field:${f.key}` });
    });
    y += 380;
  }
  return flow;
}

/** The fields' bindings from the graph. */
function compile(t: Template, flow: DataFlow) {
  for (const f of t.fields) {
    const from = flow.edges.find((e) => e.to === `field:${f.key}`)?.from;
    if (!from) {
      if (f.binding && isTable(f.binding)) delete f.binding;
      continue;
    }
    const c = chainOf(flow, from);
    if (c) f.binding = { source: c.source.source, path: '', list: c.source.list, steps: c.steps };
    else delete f.binding;
  }
  // Data sets: the rows of the chain wired into them.
  const sets: DataSet[] = [];
  for (const n of flow.nodes) {
    if (n.type !== 'dataset') continue;
    const from = flow.edges.find((e) => e.to === n.id)?.from;
    const c = from ? chainOf(flow, from) : null;
    if (c) sets.push({ key: n.key, name: n.name, source: c.source.source, list: c.source.list, steps: c.steps, change: n.change });
  }
  if (sets.length) t.datasets = sets;
  else delete t.datasets;
  t.dataflow = flow.nodes.length ? flow : undefined;
  if (!t.dataflow) delete t.dataflow;
}

export function DataCanvas() {
  const { open, set: setOpen } = useDataCanvas();
  const template = useDesigner((s) => s.template);
  if (!open || !template) return null;
  return <Canvas key={template.id} template={template} onClose={() => setOpen(false)} />;
}

function Canvas({ template, onClose }: { template: Template; onClose: () => void }) {
  const { update, previewData, frame } = useDesigner();
  const sources = useSources();
  const bound = useBoundData(template, previewData);
  const values = useMemo(() => ({ ...previewData, ...bound }), [previewData, bound]);
  const cv = useCanvasView(`data.${template.id}`);
  const [layout, setLayoutState] = useState<Layout>(() => loadLayout(template.id));
  const [drag, setDrag] = useState<{ wire: Wire; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ label: string; x: number; y: number } | null>(null);
  // The columns each data set node shows (from its preview), by node id.
  const [dsColumns, setDsColumns] = useState<Record<string, string[]>>({});
  const logic: Logic = template.logic ?? { nodes: [], edges: [] };
  const migrated = useMemo(() => (template.dataflow ? null : migrate(template)), [template]);
  const flow: DataFlow = template.dataflow ?? migrated!;

  const setLayout = (fn: (l: Layout) => Layout) =>
    setLayoutState((cur) => {
      const next = fn(cur);
      try {
        localStorage.setItem(`pulse.dataCanvas.${template.id}`, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });

  // Values at the playhead: layer properties and logic nodes.
  const resolved = useMemo(() => {
    const hold = holdFrame(template);
    const m = new Map(template.layers.map((l) => [l.id, resolveLayer(l, frame, values, hold)]));
    applyLogic(template.logic, m, values, measureLayer(template.layers, values, interpolateText));
    return m;
  }, [template, frame, values]);
  const logicValues = useMemo(() => nodeValues(logic, resolved, values, measureLayer(template.layers, values, interpolateText)), [logic, resolved, values, template.layers]);

  // ---- What the canvas shows and where.
  const operations = logic.nodes.filter((n) => n.type !== 'field' && n.type !== 'target');
  const targets = logic.nodes.filter((n): n is LogicNode & { type: 'target' } => n.type === 'target');
  const wiredPorts = (l: Layer) =>
    new Set<string>([
      ...(Object.entries(l.bindings) as [Prop, string][]).filter(([, k]) => k).map(([p]) => p),
      ...targets.filter((t) => t.layer === l.id && logic.edges.some((e) => e.to === t.id)).map((t) => t.prop),
      ...contentOf(l).filter((c) => /\{\{\w+\}\}/.test(contentValue(l, c))),
    ]);
  /** Content ports always; properties when unfolded (or wired). */
  const ports = (l: Layer) => {
    const wired = wiredPorts(l);
    return [...contentOf(l), ...portsOf(l).filter((p) => layout.collapsed[l.id] === false || wired.has(p))];
  };
  const portTop = (l: Layer, port: string) => {
    let y = HEAD;
    for (const p of ports(l)) {
      if (p === port) return y;
      y += contentOf(l).includes(p) ? CROW : ROW;
    }
    return -1;
  };
  const layerHeight = (l: Layer) => HEAD + ports(l).reduce((h, p) => h + (contentOf(l).includes(p) ? CROW : ROW), 0) + 30 + (isTimed(l) ? 40 : 0);

  const widthOf = (id: string, def: number) => layout.size[id]?.w ?? def;
  const nodePos = new Map<string, Pt>();
  const stack = (x: number, items: [string, number][]) => {
    let y = 40;
    for (const [id, h] of items) {
      nodePos.set(id, layout.pos[id] ?? { x, y });
      y += h + 24;
    }
  };
  const fieldHeight = (f: Field) => HEAD + (f.binding ? 90 : f.kind === 'number' ? 130 : f.kind === 'image' ? 150 : 96);
  stack(COLS.field, template.fields.map((f) => [`f:${f.key}`, fieldHeight(f)]));
  stack(COLS.layer, template.layers.map((l) => [`l:${l.id}`, layerHeight(l)]));
  for (const n of flow.nodes) nodePos.set(n.id, { x: n.x, y: n.y });
  const flowWidth = (n: FlowNode) => widthOf(n.id, n.type === 'source' ? W.source : W.step);

  // Port positions.
  const outOf = (id: string, w: number) => {
    const p = nodePos.get(id)!;
    return { x: p.x + w, y: p.y + HEAD / 2 };
  };
  const inOf = (id: string) => {
    const p = nodePos.get(id)!;
    return { x: p.x, y: p.y + HEAD / 2 };
  };
  const layerIn = (l: Layer, port: string): Pt | null => {
    const p = nodePos.get(`l:${l.id}`);
    const top = portTop(l, port);
    if (!p || top < 0) return null;
    return { x: p.x, y: p.y + top + ROW / 2 };
  };
  const logicIn = (n: LogicNode, port: string) => ({ x: n.x, y: n.y + HEAD + INPUTS[n.type].indexOf(port) * ROW + ROW / 2 });
  const logicOut = (n: LogicNode) => ({ x: n.x + widthOf(n.id, W.logic), y: n.y + HEAD / 2 });

  // ---- Editing the template.
  const editLogic = (fn: (l: Logic) => void, key?: string) =>
    update((t) => {
      t.logic ??= { nodes: [], edges: [] };
      fn(t.logic);
      // Field and set-property nodes only exist through their wires.
      t.logic.nodes = t.logic.nodes.filter((n) => (n.type === 'field' ? t.logic!.edges.some((e) => e.from === n.id) : n.type === 'target' ? t.logic!.edges.some((e) => e.to === n.id) : true));
      if (!t.logic.nodes.length) delete t.logic;
    }, key);
  const setNode = (id: string, patch: Partial<LogicNode>, key?: string) =>
    editLogic((l) => {
      const n = l.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    }, key);
  /** Changes the data graph, then the bindings it gives. */
  const editFlow = (fn: (f: DataFlow) => void, key?: string) =>
    update((t) => {
      const f: DataFlow = structuredClone(t.dataflow ?? migrated ?? { nodes: [], edges: [] });
      fn(f);
      compile(t, f);
    }, key);
  const setFlowNode = (id: string, fn: (n: FlowNode) => void, key?: string) =>
    editFlow((f) => {
      const n = f.nodes.find((x) => x.id === id);
      if (n) fn(n);
    }, key);
  const editField = (key: string, fn: (f: Field) => void, coalesce?: string) => update((t) => fn(t.fields.find((f) => f.key === key)!), coalesce);
  const newField = (t: Template, label: string, kind: FieldKind, def: string): string => {
    const key = fieldKey(label, new Set(t.fields.map((f) => f.key)));
    t.fields.push({ key, label, kind, default: def });
    return key;
  };
  /** Wires `from` into `to` (its only input), unless that makes a loop. */
  const link = (f: DataFlow, from: string, to: string) => {
    let cur: string | undefined = from;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === to) return;
      seen.add(cur);
      cur = f.edges.find((e) => e.to === cur)?.from;
    }
    f.edges = f.edges.filter((e) => e.to !== to);
    f.edges.push({ from, to });
  };

  // Data set columns: where their ports are (the node reports its columns).
  const columnPorts = new Map<string, Pt>();
  for (const n of flow.nodes)
    if (n.type === 'dataset')
      (dsColumns[n.id] ?? []).forEach((c, i) => columnPorts.set(columnKey(n.key, c), { x: n.x + flowWidth(n), y: n.y + HEAD + i * DS_ROW + DS_ROW / 2 }));
  /** Where a value wired by key starts: a variable, or a data set column. */
  const keyOut = (key: string): Pt | null => (nodePos.has(`f:${key}`) ? outOf(`f:${key}`, widthOf(`f:${key}`, W.field)) : (columnPorts.get(key) ?? null));
  const wiredKey = (k: string) => template.fields.some((f) => f.key === k) || columnPorts.has(k);

  // ---- Wires of the template.
  const wires: { d: string; title: string; onClick: () => void; data?: boolean; edge?: number }[] = [];
  flow.edges.forEach((e, i) => {
    const a = flow.nodes.find((n) => n.id === e.from);
    if (!a) return;
    const to = e.to.startsWith('field:') ? (nodePos.has(`f:${e.to.slice(6)}`) ? inOf(`f:${e.to.slice(6)}`) : null) : nodePos.has(e.to) ? inOf(e.to) : null;
    if (!to) return;
    wires.push({ d: curve(outOf(a.id, flowWidth(a)), to), data: true, edge: i, title: 'Data (click to remove · drop a Filter, Sort or Transform on it)', onClick: () => editFlow((f) => void f.edges.splice(i, 1)) });
  });
  for (const l of template.layers)
    for (const port of [...contentOf(l), ...portsOf(l)]) {
      const to = layerIn(l, port);
      if (!to) continue;
      const content = contentOf(l).includes(port);
      const keys = content ? [...template.fields.map((f) => f.key), ...columnPorts.keys()].filter((k) => tokensIn(l, port, k)) : [l.bindings[port as Prop]].filter((k): k is string => !!k && wiredKey(k));
      for (const key of keys)
        wires.push({
          d: curve(keyOut(key)!, to),
          data: columnPorts.has(key),
          title: `${key} → ${l.name} ${content ? port : PROP_LABELS[port as Prop]} (click to remove)`,
          onClick: () =>
            update((t) => {
              const x = findLayer(t, l.id)! as unknown as Record<string, unknown> & Layer;
              if (content) x[port] = String(x[port] ?? '').split(tokenOf(key)).join('').replace(/ {2,}/g, ' ').trim();
              else delete x.bindings[port as Prop];
            }),
        });
    }
  const nodes = new Map(logic.nodes.map((n) => [n.id, n]));
  logic.edges.forEach((e, i) => {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) return;
    const from = a.type === 'field' ? keyOut(a.key) : logicOut(a);
    let to: Pt | null;
    if (b.type === 'target') {
      const l = template.layers.find((x) => x.id === b.layer);
      to = l ? layerIn(l, b.prop) : null;
    } else to = logicIn(b, e.port);
    if (!from || !to) return;
    wires.push({ d: curve(from, to), title: 'Click to remove', onClick: () => editLogic((l) => void l.edges.splice(i, 1)) });
  });

  // ---- Wiring with the mouse.
  const point = cv.toWorld;
  const wireStart = (w: Wire): Pt | null => {
    if (w.kind === 'flow') {
      const n = flow.nodes.find((x) => x.id === w.id);
      return n ? outOf(n.id, flowWidth(n)) : null;
    }
    if (w.kind === 'field') return keyOut(w.key);
    const n = nodes.get(w.id);
    return n ? logicOut(n) : null;
  };

  const connect = (w: Wire, target: HTMLElement | null, at: Pt) => {
    const port = target?.closest<HTMLElement>('.port.in');
    const d = port?.dataset ?? {};
    if (w.kind === 'flow') {
      const kind = kindOf(flow, w.id);
      if (d.flow) editFlow((f) => link(f, w.id, d.flow!));
      else if (d.field)
        update((t) => {
          const f: DataFlow = structuredClone(t.dataflow ?? migrated ?? { nodes: [], edges: [] });
          link(f, w.id, `field:${d.field}`);
          compile(t, f);
          // A text variable fed with pictures, numbers… takes their type.
          const x = t.fields.find((y) => y.key === d.field);
          if (x && kind && x.kind === 'text' && kind !== 'text') x.kind = kind;
        });
      else if (!target?.closest('.dc-node')) {
        // Dropped on empty space: a new variable fed from here.
        let made = '';
        update((t) => {
          made = newField(t, `Field ${t.fields.length + 1}`, kind ?? 'text', '');
          const f: DataFlow = structuredClone(t.dataflow ?? migrated ?? { nodes: [], edges: [] });
          link(f, w.id, `field:${made}`);
          compile(t, f);
        });
        setLayout((l) => ({ ...l, pos: { ...l.pos, [`f:${made}`]: { x: at.x, y: at.y - HEAD / 2 } } }));
      }
      return;
    }
    // Into an operation's input.
    if (d.logic && d.port) {
      editLogic((l) => {
        let from = w.kind === 'logic' ? w.id : '';
        if (w.kind === 'field') {
          const fp = keyOut(w.key) ?? { x: 0, y: 0 };
          from = l.nodes.find((n) => n.type === 'field' && n.key === w.key)?.id ?? '';
          if (!from) {
            from = newId();
            l.nodes.push({ id: from, type: 'field', key: w.key, x: fp.x, y: fp.y });
          }
        }
        if (!from || from === d.logic) return;
        l.edges = l.edges.filter((e) => !(e.to === d.logic && e.port === d.port));
        l.edges.push({ from, to: d.logic!, port: d.port! });
      });
      return;
    }
    // Into a layer's port.
    const layerId = d.layer;
    const p = d.port;
    if (!layerId || !p) return;
    if (w.kind === 'field') {
      update((t) => {
        const l = findLayer(t, layerId)! as unknown as Record<string, unknown> & Layer;
        if (p === 'src') l.src = tokenOf(w.key);
        else if (p === 'text') {
          const cur = String(l.text ?? '');
          if (!cur.includes(tokenOf(w.key))) l.text = cur.trim() && /\{\{\w+\}\}/.test(cur) ? `${cur} ${tokenOf(w.key)}` : tokenOf(w.key);
        } else l.bindings[p as Prop] = w.key;
      });
    } else if (w.kind === 'logic' && p !== 'text' && p !== 'src') {
      editLogic((l) => {
        let to = l.nodes.find((n) => n.type === 'target' && n.layer === layerId && n.prop === p)?.id;
        if (!to) {
          to = newId();
          const lp = nodePos.get(`l:${layerId}`)!;
          l.nodes.push({ id: to, type: 'target', layer: layerId, prop: p as Prop, mode: 'set', x: lp.x, y: lp.y });
        }
        l.edges = l.edges.filter((e) => !(e.to === to && e.port === 'in'));
        l.edges.push({ from: w.id, to, port: 'in' });
      });
    }
  };

  const startWire = (e: React.PointerEvent, wire: Wire) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({ wire, ...point(e.clientX, e.clientY) });
    const move = (ev: PointerEvent) => setDrag({ wire, ...point(ev.clientX, ev.clientY) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      connect(wire, document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null, point(ev.clientX, ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Drags a node: of the layout, of the data graph, or of the logic graph. */
  const dragNode = (e: React.PointerEvent, id: string, kind: 'layout' | 'flow' | 'logic') => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('select, input, button, .port, textarea, label, [data-scroll], .cv-resize')) return;
    e.preventDefault();
    const start = point(e.clientX, e.clientY);
    const base = nodePos.get(id) ?? { x: nodes.get(id)!.x, y: nodes.get(id)!.y };
    useDesigner.setState({ lastCoalesce: null });
    document.body.classList.add('cv-moving');
    const move = (ev: PointerEvent) => {
      const p = point(ev.clientX, ev.clientY);
      const at = { x: Math.round(base.x + p.x - start.x), y: Math.round(base.y + p.y - start.y) };
      if (kind === 'logic') setNode(id, at, `data-move-${id}`);
      else if (kind === 'flow') setFlowNode(id, (n) => void Object.assign(n, at), `flow-move-${id}`);
      else setLayout((l) => ({ ...l, pos: { ...l.pos, [id]: at } }));
    };
    const up = () => {
      document.body.classList.remove('cv-moving');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resizer = (id: string, height = true) => (
    <ResizeCorner onPointerDown={(e) => cv.resize(e, (w, h) => setLayout((l) => ({ ...l, size: { ...l.size, [id]: height ? { w, h } : { w } } })))} />
  );
  const sizeStyle = (id: string, def: number) => ({ width: widthOf(id, def), height: layout.size[id]?.h });

  /** Somewhere free in view, for a node added with a click. */
  const inView = () => {
    const v = cv.visible();
    return { x: Math.round(v.x + v.w / 2 - 160), y: Math.round(v.y + 80 + ((flow.nodes.length * 30) % 200)) };
  };
  /**
   * Adds a node from the palette: a click puts it in view, a drag where it
   * is dropped — on a data wire, it goes in between.
   */
  const fromPalette = (e: React.PointerEvent, label: string, add: (at: Pt, edge?: number) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved ||= Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5;
      if (moved) setGhost({ label, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!moved) return add(inView());
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null;
      if (!el?.closest('.logic-canvas')) return;
      const edge = el.closest('[data-edge]')?.getAttribute('data-edge');
      const p = point(ev.clientX, ev.clientY);
      add({ x: Math.round(p.x - 30), y: Math.round(p.y - HEAD / 2) }, edge != null ? +edge : undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const addStep = (type: StepType) => (at: Pt, edge?: number) => {
    if (edge === undefined) return editFlow((f) => void f.nodes.push({ id: newId(), ...at, ...STEP[type].make() } as FlowNode));
    // On a wire: in between, and what is on its right moves aside to make room.
    const shift = W.step + 60;
    const x0 = at.x - 20;
    update((t) => {
      const f: DataFlow = structuredClone(t.dataflow ?? migrated ?? { nodes: [], edges: [] });
      for (const n of f.nodes) if (n.x >= x0) n.x += shift;
      for (const n of t.logic?.nodes ?? []) if (n.x >= x0) n.x += shift;
      const n = { id: newId(), ...at, ...STEP[type].make() } as FlowNode;
      f.nodes.push(n);
      const e = f.edges[edge];
      if (e) f.edges.splice(edge, 1, { from: e.from, to: n.id }, { from: n.id, to: e.to });
      compile(t, f);
    });
    const moved: Layout['pos'] = {};
    for (const [id, p] of nodePos) if ((id.startsWith('f:') || id.startsWith('l:')) && p.x >= x0) moved[id] = { x: p.x + shift, y: p.y };
    setLayout((l) => ({ ...l, pos: { ...l.pos, ...moved } }));
  };
  const addDataset = (at: Pt, edge?: number) => {
    const taken = new Set([...template.fields.map((f) => f.key), ...flow.nodes.flatMap((n) => (n.type === 'dataset' ? [n.key] : []))]);
    const name = `Data set ${flow.nodes.filter((n) => n.type === 'dataset').length + 1}`;
    editFlow((f) => {
      const n: FlowNode = { id: newId(), ...at, type: 'dataset', key: fieldKey(name, taken), name, change: 'outIn' };
      f.nodes.push(n);
      // Dropped on a wire: fed from where it starts.
      const e = edge !== undefined ? f.edges[edge] : undefined;
      if (e) f.edges.push({ from: e.from, to: n.id });
    });
  };
  const addSource = (source: string) => (at: Pt) => editFlow((f) => void f.nodes.push({ id: newId(), ...at, type: 'source', source, list: '' }));

  const dragFrom = drag && wireStart(drag.wire);
  const removeFlowNode = (id: string) =>
    editFlow((f) => {
      // The wires through it are kept: what fed it feeds what it fed.
      const into = f.edges.find((e) => e.to === id)?.from;
      const outs = f.edges.filter((e) => e.from === id).map((e) => e.to);
      f.nodes = f.nodes.filter((n) => n.id !== id);
      f.edges = f.edges.filter((e) => e.from !== id && e.to !== id);
      if (into) for (const to of outs) f.edges.push({ from: into, to });
    });

  return (
    <div className="logic-editor data-canvas" onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <Database size={16} />
        <h2>Data — {template.name}</h2>
        <span className="muted small">Source → Filter / Sort / Transform → variable → layer. Drag from a dot on the right to a dot on the left; click a wire to remove it.</span>
        <div className="spacer" />
        <button className="icon-btn ghost" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </header>
      <div className="logic-body">
        <aside className="logic-palette">
          <button
            className="kind-field"
            onPointerDown={(e) =>
              fromPalette(e, 'Variable', (at) => {
                let made = '';
                update((t) => void (made = newField(t, `Field ${t.fields.length + 1}`, 'text', '')));
                setLayout((l) => ({ ...l, pos: { ...l.pos, [`f:${made}`]: at } }));
              })
            }
          >
            <Variable size={14} />
            <span>
              <strong>Variable</strong>
              <em>Typed by the operator, or fed by the data</em>
            </span>
          </button>

          <div className="dc-pal-title">Data sources</div>
          {sources.map((s) => (
            <button key={s.id} className="kind-source" onPointerDown={(e) => fromPalette(e, s.name, addSource(s.id))}>
              <Database size={14} />
              <span>
                <strong>{s.name}</strong>
                <em>{s.type.toUpperCase()}</em>
              </span>
            </button>
          ))}
          {!sources.length && (
            <p className="hint">
              No source yet:{' '}
              <a href="/data" onClick={(e) => (e.preventDefault(), navigate('/data'))}>
                add one in Data
              </a>
              .
            </p>
          )}

          <div className="dc-pal-title">On the way · drag onto a wire</div>
          {(['filter', 'sort', 'transform'] as StepType[]).map((type) => {
            const k = STEP[type];
            return (
              <button key={type} className={`kind-${type}`} onPointerDown={(e) => fromPalette(e, k.label, addStep(type))}>
                <k.icon size={14} />
                <span>
                  <strong>{k.label}</strong>
                  <em>{k.hint}</em>
                </span>
              </button>
            );
          })}

          <div className="dc-pal-title">Into the graphic</div>
          <button className="kind-dataset" onPointerDown={(e) => fromPalette(e, 'Data set', addDataset)}>
            <Rows3 size={14} />
            <span>
              <strong>Data set</strong>
              <em>Rows the operator steps through · a port per column</em>
            </span>
          </button>

          <div className="dc-pal-title">Operations</div>
          {OPERATIONS.map((k) => (
            <button key={k.type} className={`kind-${k.type}`} onPointerDown={(e) => fromPalette(e, k.label, (at) => editLogic((l) => void l.nodes.push(makeNode(k.type, template, at.x, at.y))))}>
              <k.icon size={14} />
              <span>
                <strong>{k.label}</strong>
                <em>{k.hint}</em>
              </span>
            </button>
          ))}
        </aside>

        <div {...cv.viewport} className={`logic-canvas ${cv.viewport.className}`}>
          <div className="logic-space" data-canvas-void style={cv.spaceStyle}>
            <svg className="logic-wires">
              {wires.map((w, i) => (
                <g key={i} className="wire-g">
                  <path d={w.d} className={`wire ${w.data ? 'data' : ''}`} />
                  {/* A wider line to click, or to drop a step on. */}
                  <path d={w.d} data-edge={w.edge} className="wire-hit" onPointerDown={(e) => (e.stopPropagation(), w.onClick())}>
                    <title>{w.title}</title>
                  </path>
                </g>
              ))}
              {drag && dragFrom && <path d={curve(dragFrom, drag)} className="wire live" />}
            </svg>

            {/* The data graph: sources and steps */}
            {flow.nodes.map((n) => {
              const chain = chainOf(flow, n.id);
              if (n.type === 'source') {
                const s = sources.find((x) => x.id === n.source);
                const used = flow.edges.some((e) => e.from === n.id);
                return (
                  <div key={n.id} className={`logic-node dc-node kind-source ${layout.size[n.id]?.h ? 'sized' : ''}`} style={{ left: n.x, top: n.y, ...sizeStyle(n.id, W.source) }} onPointerDown={(e) => dragNode(e, n.id, 'flow')}>
                    <div className="ln-head" style={{ height: HEAD }}>
                      <Database size={12} />
                      <span>{s?.name ?? `Missing: ${n.source}`}</span>
                      <button className="ln-del" title={used ? 'Remove (and its wires)' : 'Remove'} onClick={() => removeFlowNode(n.id)}>
                        <Trash2 size={11} />
                      </button>
                      <span className="port out" title="Drag to a filter, a sort, a transform or a variable" onPointerDown={(e) => startWire(e, { kind: 'flow', id: n.id })} />
                    </div>
                    <div className="ln-body">
                      <span className="dc-meta">
                        <span className={`live-dot ${s?.error ? 'err' : ''}`} /> {s ? `${s.type.toUpperCase()} · every ${s.interval} s` : 'not found'}
                      </span>
                      <SourceBody node={n} version={s?.updatedAt ?? 0} data={values} onList={(list) => setFlowNode(n.id, (x) => void ((x as { list: string }).list = list))} />
                    </div>
                    {resizer(n.id)}
                  </div>
                );
              }
              if (n.type === 'dataset') {
                const into = flow.edges.find((e) => e.to === n.id)?.from;
                return (
                  <div key={n.id} className="logic-node dc-node kind-dataset" style={{ left: n.x, top: n.y, width: widthOf(n.id, W.source) }} onPointerDown={(e) => dragNode(e, n.id, 'flow')}>
                    <div className="ln-head" style={{ height: HEAD }}>
                      <span className="port in" data-flow={n.id} title="Drop a source or a step here" />
                      <Rows3 size={12} />
                      <input className="dc-title" value={n.name} onChange={(e) => setFlowNode(n.id, (x) => void ((x as { name: string }).name = e.target.value), `ds-name-${n.id}`)} title={`Key: ${n.key}`} />
                      <button className="ln-del" title="Remove" onClick={() => removeFlowNode(n.id)}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <DataSetBody
                      node={n}
                      chain={into ? chainOf(flow, into) : null}
                      data={values}
                      onColumns={(cols) => setDsColumns((m) => (m[n.id]?.join('\n') === cols.join('\n') ? m : { ...m, [n.id]: cols }))}
                      onRow={(row) => useDesigner.setState((st) => ({ previewData: { ...st.previewData, [rowKey(n.key)]: String(row) } }))}
                      onChange={(change) => setFlowNode(n.id, (x) => void ((x as { change: RowChange }).change = change))}
                      startWire={(e, key) => startWire(e, { kind: 'field', key })}
                    />
                    {resizer(n.id, false)}
                  </div>
                );
              }
              const k = STEP[n.type];
              return (
                <div key={n.id} className={`logic-node dc-node kind-${n.type} ${layout.size[n.id]?.h ? 'sized' : ''}`} style={{ left: n.x, top: n.y, ...sizeStyle(n.id, W.step) }} onPointerDown={(e) => dragNode(e, n.id, 'flow')}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <span className="port in" data-flow={n.id} title="Drop a source or a step here" />
                    <k.icon size={12} />
                    <span>{k.label}</span>
                    <button className="ln-del" title="Remove (the wires go through)" onClick={() => removeFlowNode(n.id)}>
                      <Trash2 size={11} />
                    </button>
                    <span className="port out" title="Drag to a step or a variable" onPointerDown={(e) => startWire(e, { kind: 'flow', id: n.id })} />
                  </div>
                  <div className="ln-body">
                    {chain ? (
                      <StepBody
                        source={chain.source}
                        steps={chain.steps}
                        data={values}
                        node={n as FlowNode & DataStep}
                        onChange={(fn) => setFlowNode(n.id, fn as (x: FlowNode) => void, `flow-${n.id}`)}
                      />
                    ) : (
                      <span className="dc-meta">Wire a source (or a step) into it.</span>
                    )}
                  </div>
                  {resizer(n.id)}
                </div>
              );
            })}

            {/* Variables */}
            {template.fields.map((f) => {
              const p = nodePos.get(`f:${f.key}`)!;
              const v = values[f.key] ?? '';
              const fed = flow.edges.some((e) => e.to === `field:${f.key}`);
              const legacy = f.binding && !isTable(f.binding) && !fed;
              return (
                <div key={f.key} className="logic-node dc-node kind-field" style={{ left: p.x, top: p.y, ...sizeStyle(`f:${f.key}`, W.field) }} onPointerDown={(e) => dragNode(e, `f:${f.key}`, 'layout')}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <span className="port in" data-field={f.key} title="Drop a source or a step here" />
                    <Variable size={12} />
                    <input className="dc-title" value={f.label} onChange={(e) => editField(f.key, (x) => void (x.label = e.target.value), `label-${f.key}`)} title={`Key: ${f.key}`} />
                    <button
                      className="ln-del"
                      title="Delete the variable"
                      onClick={() =>
                        update((t) => {
                          t.fields = t.fields.filter((x) => x.key !== f.key);
                          for (const l of t.layers) for (const [prop, k] of Object.entries(l.bindings)) if (k === f.key) delete l.bindings[prop as Prop];
                          if (t.logic) {
                            const gone = new Set(t.logic.nodes.filter((n) => n.type === 'field' && n.key === f.key).map((n) => n.id));
                            t.logic.nodes = t.logic.nodes.filter((n) => !gone.has(n.id));
                            t.logic.edges = t.logic.edges.filter((e) => !gone.has(e.from));
                          }
                          if (t.dataflow) {
                            t.dataflow.edges = t.dataflow.edges.filter((e) => e.to !== `field:${f.key}`);
                          }
                        })
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                    <span className="port out" title="Drag to a layer's value or to an operation" onPointerDown={(e) => startWire(e, { kind: 'field', key: f.key })} />
                  </div>
                  <div className="ln-body">
                    <div className="row">
                      <select value={f.kind} onChange={(e) => editField(f.key, (x) => void (x.kind = e.target.value as FieldKind))}>
                        {(['text', 'multiline', 'number', 'color', 'image', 'boolean'] as FieldKind[]).map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                      <code className="dc-key" title="Key (API, MOS)">{f.key}</code>
                    </div>
                    {f.binding ? (
                      <>
                        {cellType(v) === 'image' ? (
                          <span className="dc-result img" title={v}>
                            <img src={v} alt="" />
                          </span>
                        ) : (
                          <span className="dc-result" title={v}>
                            {v === '' ? <em>(empty)</em> : v}
                          </span>
                        )}
                        {legacy && (
                          <span className="dc-meta" title="Made before the tables: unlink it and wire the data again to change it">
                            Path {f.binding.path}
                            <button className="dc-addfilter" onClick={() => update((t) => void delete t.fields.find((x) => x.key === f.key)!.binding)}>
                              Unlink
                            </button>
                          </span>
                        )}
                      </>
                    ) : (
                      <DefaultEditor field={f} onChange={(fn, key) => editField(f.key, fn, key)} />
                    )}
                  </div>
                  {resizer(`f:${f.key}`, false)}
                </div>
              );
            })}

            {/* Operations (the logic graph) */}
            {operations.map((n) => {
              const k = KINDS.find((x) => x.type === n.type)!;
              return (
                <div key={n.id} className={`logic-node dc-node kind-${n.type}`} style={{ left: n.x, top: n.y, width: widthOf(n.id, W.logic) }} onPointerDown={(e) => dragNode(e, n.id, 'logic')}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <k.icon size={12} />
                    <span>{k.label}</span>
                    <span className="ln-value">{fmt(logicValues.get(n.id))}</span>
                    <button
                      className="ln-del"
                      title="Delete"
                      onClick={() =>
                        editLogic((l) => {
                          l.nodes = l.nodes.filter((x) => x.id !== n.id);
                          l.edges = l.edges.filter((x) => x.from !== n.id && x.to !== n.id);
                        })
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                    <span className="port out" title="Drag to an input or a layer's value" onPointerDown={(e) => startWire(e, { kind: 'logic', id: n.id })} />
                  </div>
                  {INPUTS[n.type].map((port) => (
                    <div key={port} className="ln-input" style={{ height: ROW }}>
                      <span className="port in" data-logic={n.id} data-port={port} />
                      <span>{inputLabel(n, port)}</span>
                    </div>
                  ))}
                  <div className="ln-body">
                    <LogicNodeBody n={n} template={template} setNode={setNode} />
                  </div>
                  {resizer(n.id, false)}
                </div>
              );
            })}

            {/* Layers: what they show (text, picture); their properties folded */}
            {template.layers.map((l) => {
              const p = nodePos.get(`l:${l.id}`)!;
              const Icon = ICONS[l.type];
              const wired = wiredPorts(l);
              const r = resolved.get(l.id);
              const hidden = portsOf(l).filter((x) => !ports(l).includes(x)).length;
              return (
                <div key={l.id} className="logic-node dc-node kind-layer" style={{ left: p.x, top: p.y, width: widthOf(`l:${l.id}`, W.layer) }} onPointerDown={(e) => dragNode(e, `l:${l.id}`, 'layout')}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <Icon size={12} />
                    <span>{l.name}</span>
                  </div>
                  {ports(l).map((port) => {
                    const content = contentOf(l).includes(port);
                    if (content) {
                      const raw = contentValue(l, port);
                      const isWired = wired.has(port);
                      const result = interpolateText(raw, values);
                      return (
                        <div key={port} className={`ln-content ${isWired ? 'wired' : ''}`} style={{ height: CROW }}>
                          <div className="ln-input" style={{ height: ROW }}>
                            <span className="port in" data-layer={l.id} data-port={port} title="Drop a variable here" />
                            {port === 'src' ? <ImageIcon size={11} /> : <Type size={11} />} {port === 'src' ? 'Picture' : 'Text'}
                            {isWired && <span className="dc-from">from data</span>}
                          </div>
                          {isWired && port === 'src' && cellType(result) === 'image' ? (
                            <span className="dc-value live dc-pic" title={result}>
                              <img src={result} alt="" /> {result.split('/').pop()}
                            </span>
                          ) : isWired ? (
                            <span className="dc-value live" title={`Result: ${result}`}>
                              {result === '' ? '(empty)' : result.length > 60 ? `${result.slice(0, 60)}…` : result.replace(/\n/g, ' ⏎ ')}
                            </span>
                          ) : (
                            <input
                              className="dc-content-input"
                              value={raw}
                              title="Default value (until a variable is wired)"
                              onChange={(e) => update((t) => void ((findLayer(t, l.id) as unknown as Record<string, unknown>)[port] = e.target.value), `content-${l.id}`)}
                            />
                          )}
                        </div>
                      );
                    }
                    const v = r ? r[port as Prop] : undefined;
                    return (
                      <div key={port} className={`ln-input ${wired.has(port) ? 'wired' : ''}`} style={{ height: ROW }}>
                        <span className="port in" data-layer={l.id} data-port={port} title="Drop a variable or an operation here" />
                        <span>{PROP_LABELS[port as Prop]}</span>
                        <span className={`dc-port-value ${wired.has(port) ? 'live' : ''}`} title={wired.has(port) ? 'Value it gets from the data' : 'Value in Properties'}>
                          {v === undefined ? '' : isColor(port) ? <span className="dc-swatch" style={{ background: toHex(col(v), true) }} /> : +num(v).toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                  <button
                    className="dc-props-toggle"
                    onClick={() => setLayout((x) => ({ ...x, collapsed: { ...x.collapsed, [l.id]: x.collapsed[l.id] === false ? true : false } }))}
                    title="Position, size, colours… (Properties)"
                  >
                    {hidden ? `+ ${hidden} properties` : '− Fold the properties'}
                  </button>
                  {isTimed(l) && (
                    <div className="ln-body">
                      <WidgetRunButtons layer={l} compact />
                    </div>
                  )}
                  {resizer(`l:${l.id}`, false)}
                </div>
              );
            })}
          </div>
          {cv.controls}
        </div>
      </div>
      {ghost && (
        <div className="cv-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.label}
        </div>
      )}
    </div>
  );
}

/** Latest value of a data source, for the tables and the sort's lists. */
const sourceValues = new Map<string, { version: number; value: unknown }>();
function useSourceValue(id: string, version: number): unknown {
  const [value, setValue] = useState<unknown>(sourceValues.get(id)?.value);
  useEffect(() => {
    const cached = sourceValues.get(id);
    if (cached && cached.version === version) return setValue(cached.value);
    let live = true;
    api('GET', `/api/data/sources/${encodeURIComponent(id)}/value`)
      .then((v) => {
        sourceValues.set(id, { version, value: v });
        if (live) setValue(v);
      })
      .catch(() => live && setValue(null));
    return () => {
      live = false;
    };
  }, [id, version]);
  return value;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Dotted paths of the lists in a value (the rows a source node can read), the root first. */
function listsIn(v: unknown, path = '', depth = 0, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    if (v.length) out.push(path);
  } else if (isObj(v) && depth < 4) {
    for (const [k, x] of Object.entries(v)) listsIn(x, path ? `${path}.${k}` : k, depth + 1, out);
  }
  return out;
}


/** The tables of a pipeline (each stage), refreshed when the source changes. */
const stageCache = new Map<string, { stages: Stage[]; text: string } | null>();
function useStages(source: string, list: string, steps: DataStep[], data: Data) {
  const version = useData((s) => s.versions[source] ?? 0);
  // Only the values its conditions read count.
  const used = JSON.stringify(steps).match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? [];
  const sub = Object.fromEntries(used.map((k) => [k, data[k] ?? '']));
  const key = JSON.stringify([source, list, steps, sub, version]);
  const [res, setRes] = useState(() => stageCache.get(key));
  useEffect(() => {
    if (stageCache.has(key)) return setRes(stageCache.get(key));
    let live = true;
    const h = setTimeout(
      () =>
        pipeline(source, list, steps, sub).then((r) => {
          stageCache.set(key, r);
          if (live) setRes(r);
        }),
      120,
    );
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return res;
}

/** What a cell holds: a picture (uploaded or on the web), a colour, a number… */
export type CellType = 'number' | 'image' | 'color' | 'boolean' | 'text';
const IMAGE = /^(data:image\/|(https?:\/\/|\/)\S+\.(png|jpe?g|gif|webp|svg|avif|bmp)([?#]\S*)?$)/i;
export function cellType(v: string): CellType | null {
  const t = v.trim();
  if (!t) return null;
  if (IMAGE.test(t)) return 'image';
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^rgba?\(/i.test(t)) return 'color';
  if (/^-?\d+([.,]\d+)?$/.test(t)) return 'number';
  if (/^(true|false)$/i.test(t)) return 'boolean';
  return 'text';
}
/** The type of each column: the one most of its cells have. */
function columnTypes(stage: Stage): CellType[] {
  return stage.columns.map((_, i) => {
    const n: Partial<Record<CellType, number>> = {};
    for (const r of stage.rows.slice(0, 50)) {
      const t = cellType(r[i] ?? '');
      if (t) n[t] = (n[t] ?? 0) + 1;
    }
    return ((Object.entries(n) as [CellType, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'text') as CellType;
  });
}
const TYPE_ICON: Record<CellType, typeof Type> = { text: Type, number: Hash, image: ImageIcon, color: Palette, boolean: ToggleLeft };

/** A cell as it reads: the picture, the colour, or the text. */
export function Cell({ v }: { v: string }) {
  const t = cellType(v);
  if (t === 'image') return <img className="dc-thumb" src={v} alt="" loading="lazy" />;
  if (t === 'color')
    return (
      <>
        <span className="dc-swatch" style={{ background: v }} /> {v}
      </>
    );
  return <>{v}</>;
}

/** The variable kind fitting the result of node `id`, from its last preview. */
function kindOf(flow: DataFlow, id: string): FieldKind | null {
  const c = chainOf(flow, id);
  if (!c) return null;
  const prefix = JSON.stringify([c.source.source, c.source.list, c.steps]).slice(0, -1) + ',';
  const hit = [...stageCache.entries()].find(([k, v]) => k.startsWith(prefix) && v)?.[1];
  const last = hit?.stages[hit.stages.length - 1];
  if (!last || last.columns.length !== 1) return null;
  const t = columnTypes(last)[0];
  return t === 'image' ? 'image' : t === 'number' ? 'number' : t === 'color' ? 'color' : t === 'boolean' ? 'boolean' : last.total > 1 ? 'multiline' : 'text';
}

/** A table, 10 rows in view (more when the node is taller), scrolling. */
function StageTable({ stage, title }: { stage: Stage | undefined; title?: string }) {
  if (!stage) return <span className="dc-meta">Loading the data…</span>;
  const types = columnTypes(stage);
  return (
    <div className="dc-table-wrap">
      <div className="dc-table-title">
        {title && <strong>{title}</strong>}
        {stage.total} row{stage.total === 1 ? '' : 's'} · {stage.columns.length} column{stage.columns.length === 1 ? '' : 's'}
      </div>
      <div className="dc-table-scroll" data-scroll>
        <table className="dc-table">
          <thead>
            <tr>
              <th>#</th>
              {stage.columns.map((c, i) => {
                const Icon = TYPE_ICON[types[i]];
                return (
                  <th key={c} title={`${c} · ${types[i]}`}>
                    <Icon size={10} className={`dc-type t-${types[i]}`} /> {c}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {stage.rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j} title={c} className={types[j] === 'image' ? 'img' : ''}>
                    <Cell v={c} />
                  </td>
                ))}
              </tr>
            ))}
            {!stage.rows.length && (
              <tr>
                <td colSpan={stage.columns.length + 1} className="dc-none">
                  No row
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A source: which list of its value is the table, and the table. */
function SourceBody({ node, version, data, onList }: { node: FlowNode & { type: 'source' }; version: number; data: Data; onList: (list: string) => void }) {
  const value = useSourceValue(node.source, version);
  const res = useStages(node.source, node.list, [], data);
  const lists = value ? ['', ...listsIn(value).filter(Boolean)] : [''];
  return (
    <>
      <label className="dc-inline">
        Rows
        <select value={node.list} onChange={(e) => onList(e.target.value)}>
          {!lists.includes(node.list) && <option value={node.list}>{node.list}</option>}
          {lists.map((l) => (
            <option key={l} value={l}>
              {l === '' ? (Array.isArray(value) ? 'The list' : 'The whole value') : l}
            </option>
          ))}
        </select>
      </label>
      {res === null ? <span className="dc-meta">No data at this place.</span> : <StageTable stage={res?.stages[0]} />}
    </>
  );
}

/** A filter, a sort or a transform: its settings on the columns it gets, then its result. */
function StepBody({ source, steps, data, node, onChange }: { source: FlowNode & { type: 'source' }; steps: DataStep[]; data: Data; node: FlowNode & DataStep; onChange: (fn: (n: DataStep) => void) => void }) {
  const res = useStages(source.source, source.list, steps, data);
  const input = res?.stages[res.stages.length - 2];
  const out = res?.stages[res.stages.length - 1];
  const columns = input?.columns ?? [];
  const colSelect = (value: string, set: (c: string) => void) => (
    <select value={value} onChange={(e) => set(e.target.value)}>
      {!columns.includes(value) && <option value={value}>{value || '— column —'}</option>}
      {columns.map((c) => (
        <option key={c}>{c}</option>
      ))}
    </select>
  );
  let settings: React.ReactNode = null;
  if (node.type === 'filter') {
    settings = (
      <>
        <div className="dc-sec">
          <span className="dc-sec-title">
            Rows where
            {node.where.length > 1 && (
              <span className="seg tiny">
                <button className={node.any ? '' : 'on'} onClick={() => onChange((n) => void ((n as typeof node).any = false))}>
                  all
                </button>
                <button className={node.any ? 'on' : ''} onClick={() => onChange((n) => void ((n as typeof node).any = true))}>
                  any
                </button>
              </span>
            )}
          </span>
          {node.where.map((c, i) => {
            const op = CONDITIONS.find((x) => x.op === c.op)!;
            const set = (patch: Partial<typeof c>) => onChange((n) => void Object.assign((n as typeof node).where[i], patch));
            return (
              <div key={i} className="dc-cond">
                {colSelect(c.column, (column) => set({ column }))}
                <select value={c.op} onChange={(e) => set({ op: e.target.value as CondOp })}>
                  {CONDITIONS.map((x) => (
                    <option key={x.op} value={x.op}>
                      {x.label}
                    </option>
                  ))}
                </select>
                {op.value && <input value={c.value} placeholder="value or {key}" onChange={(e) => set({ value: e.target.value })} />}
                <button className="icon-btn ghost" title="Remove" onClick={() => onChange((n) => void (n as typeof node).where.splice(i, 1))}>
                  <X size={11} />
                </button>
              </div>
            );
          })}
          <button className="dc-addfilter" onClick={() => onChange((n) => void (n as typeof node).where.push({ column: columns[0] ?? '', op: 'eq', value: '' }))}>
            <Plus size={11} /> Condition
          </button>
        </div>
        <div className="dc-sec">
          <span className="dc-sec-title">Rows</span>
          <div className="row">
            <label className="dc-inline" title="1 = the first, −1 = the last; 0 = from the first">
              From <input type="number" value={node.from} onChange={(e) => onChange((n) => void ((n as typeof node).from = +e.target.value))} />
            </label>
            <label className="dc-inline" title="0 = all">
              Count <input type="number" min={0} value={node.count} onChange={(e) => onChange((n) => void ((n as typeof node).count = Math.max(0, +e.target.value)))} />
            </label>
          </div>
        </div>
        <div className="dc-sec">
          <span className="dc-sec-title">Columns {node.columns.length ? '' : <em>all</em>}</span>
          <ColumnChips columns={columns} selected={node.columns} onChange={(cols) => onChange((n) => void ((n as typeof node).columns = cols))} />
        </div>
      </>
    );
  } else if (node.type === 'sort') {
    settings = (
      <div className="dc-sec">
        <span className="dc-sec-title">By</span>
        {node.keys.map((k, i) => {
          const set = (patch: Partial<typeof k>) => onChange((n) => void Object.assign((n as typeof node).keys[i], patch));
          return (
            <div key={i} className="dc-cond">
              <span className="dc-step-n">{i + 1}</span>
              {colSelect(k.column, (column) => set({ column }))}
              <button className={`btn small ${k.descending ? '' : 'on'}`} title="Smallest first" onClick={() => set({ descending: false })}>
                <ArrowUp size={12} />
              </button>
              <button className={`btn small ${k.descending ? 'on' : ''}`} title="Largest first" onClick={() => set({ descending: true })}>
                <ArrowDown size={12} />
              </button>
              <button className={`btn small ${k.numeric ? 'on' : ''}`} title="Compare as numbers (else as text)" onClick={() => set({ numeric: !k.numeric })}>
                123
              </button>
              <button className="icon-btn ghost" title="Remove" onClick={() => onChange((n) => void (n as typeof node).keys.splice(i, 1))}>
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button className="dc-addfilter" onClick={() => onChange((n) => void (n as typeof node).keys.push({ column: columns[0] ?? '', descending: true, numeric: true }))}>
          <Plus size={11} /> {node.keys.length ? 'Then by' : 'Column'}
        </button>
      </div>
    );
  } else {
    settings = (
      <>
        <div className="dc-sec">
          <span className="dc-sec-title">On the columns {node.columns.length ? '' : <em>all</em>}</span>
          <ColumnChips columns={columns} selected={node.columns} onChange={(cols) => onChange((n) => void ((n as typeof node).columns = cols))} />
        </div>
        <div className="dc-sec">
          <span className="dc-sec-title">Operations, in order</span>
          <TransformSteps steps={node.ops} onChange={(ops) => onChange((n) => void ((n as typeof node).ops = ops))} />
        </div>
      </>
    );
  }
  return (
    <>
      {settings}
      {res === null ? <span className="dc-meta">No data at this place.</span> : <StageTable stage={out} title="Result" />}
    </>
  );
}

/** Columns to keep (or work on), in the order picked; none = all. */
function ColumnChips({ columns, selected, onChange }: { columns: string[]; selected: string[]; onChange: (c: string[]) => void }) {
  const all = [...columns, ...selected.filter((c) => !columns.includes(c))];
  return (
    <div className="dc-chips">
      {all.map((c) => {
        const i = selected.indexOf(c);
        return (
          <button key={c} className={`dc-chip ${i >= 0 ? 'on' : ''} ${columns.includes(c) ? '' : 'missing'}`} onClick={() => onChange(i >= 0 ? selected.filter((x) => x !== c) : [...selected, c])}>
            {i >= 0 && <span className="dc-chip-n">{i + 1}</span>}
            {c}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button className="dc-chip clear" onClick={() => onChange([])} title="Every column">
          All
        </button>
      )}
    </div>
  );
}

const CHANGES: { value: RowChange; label: string; hint: string }[] = [
  { value: 'outIn', label: 'Out › In', hint: 'The graphic goes out, then comes in with the new row' },
  { value: 'fade', label: 'Crossfade', hint: 'The new row fades over the old one' },
  { value: 'cut', label: 'Cut', hint: 'The values change at once' },
];

/**
 * A data set: its columns (a port each, with the value of the row shown),
 * the row previewed in the Designer, and how the graphic on air goes from
 * one row to the next.
 */
function DataSetBody({
  node,
  chain,
  data,
  onColumns,
  onRow,
  onChange,
  startWire,
}: {
  node: FlowNode & { type: 'dataset' };
  chain: ReturnType<typeof chainOf>;
  data: Data;
  onColumns: (cols: string[]) => void;
  onRow: (row: number) => void;
  onChange: (c: RowChange) => void;
  startWire: (e: React.PointerEvent, key: string) => void;
}) {
  const res = useStages(chain?.source.source ?? '', chain?.source.list ?? '', chain?.steps ?? [], data);
  const t = chain ? res?.stages[res.stages.length - 1] : undefined;
  const cols = t?.columns ?? [];
  useEffect(() => onColumns(cols), [cols.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  const types = t ? columnTypes(t) : [];
  const total = t?.total ?? 0;
  const row = Math.min(Math.max(1, parseInt(data[rowKey(node.key)] ?? '1', 10) || 1), Math.max(1, total));
  return (
    <>
      {cols.map((c, i) => {
        const Icon = TYPE_ICON[types[i]];
        const v = t?.rows[row - 1]?.[i] ?? '';
        return (
          <div key={c} className="ds-col" style={{ height: DS_ROW }}>
            <Icon size={11} className={`dc-type t-${types[i]}`} />
            <span className="ds-name">{c}</span>
            <span className="ds-val" title={v}>
              <Cell v={v} />
            </span>
            <span className="port out" title={`Drag ${c} to a layer's value (key ${columnKey(node.key, c)})`} onPointerDown={(e) => startWire(e, columnKey(node.key, c))} />
          </div>
        );
      })}
      <div className="ln-body">
        {!chain && <span className="dc-meta">Wire a source (or a step) into it.</span>}
        {chain && res === null && <span className="dc-meta">No data at this place.</span>}
        {chain && t && (
          <div className="ds-cursor">
            <span className="dc-meta">Row</span>
            <b>
              {total ? row : 0} / {total}
            </b>
            <span className="dc-meta ds-first">{t.rows[row - 1]?.find((x) => x && cellType(x) === 'text') ?? ''}</span>
            <button className="icon-btn ghost" title="Previous row (preview)" disabled={row <= 1} onClick={() => onRow(row - 1)}>
              <ArrowLeft size={12} />
            </button>
            <button className="icon-btn ghost" title="Next row (preview)" disabled={row >= total} onClick={() => onRow(row + 1)}>
              <ArrowRight size={12} />
            </button>
          </div>
        )}
        <div className="ds-opt">
          <span className="dc-meta">On change</span>
          <div className="seg ds-seg">
            {CHANGES.map((c) => (
              <button key={c.value} className={node.change === c.value ? 'on' : ''} title={c.hint} onClick={() => onChange(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <span className="dc-meta">The operator steps through the rows; the values follow the source live.</span>
      </div>
    </>
  );
}

/** The operations of a transform, applied one after the other. */
function TransformSteps({ steps, onChange }: { steps: DataFilter[]; onChange: (s: DataFilter[]) => void }) {
  const set = (i: number, f: DataFilter) => onChange(steps.map((x, k) => (k === i ? f : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="dc-steps">
      {steps.map((f, i) => (
        <div key={i} className="dc-step">
          <div className="row">
            <span className="dc-step-n">{i + 1}</span>
            <select value={f.type} onChange={(e) => set(i, TRANSFORMS.find((x) => x.make().type === e.target.value)!.make())}>
              {TRANSFORMS.map((x) => (
                <option key={x.label} value={x.make().type}>
                  {x.label}
                </option>
              ))}
              {!TRANSFORMS.some((x) => x.make().type === f.type) && <option value={f.type}>{f.type}</option>}
            </select>
            <button className="icon-btn ghost" title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={11} />
            </button>
            <button className="icon-btn ghost" title="Later" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={11} />
            </button>
            <button className="icon-btn ghost" title="Remove" onClick={() => onChange(steps.filter((_, k) => k !== i))}>
              <X size={11} />
            </button>
          </div>
          <FilterBody filter={f} onChange={(nf) => set(i, nf)} />
        </div>
      ))}
      <button className="dc-addfilter" onClick={() => onChange([...steps, { type: 'upper' }])}>
        <Plus size={11} /> Operation
      </button>
    </div>
  );
}

/** The settings of a filter. */
function FilterBody({ filter: f, onChange }: { filter: DataFilter; onChange: (f: DataFilter) => void }) {
  const text = (key: string, placeholder: string) => <input placeholder={placeholder} value={String((f as Record<string, unknown>)[key] ?? '')} onChange={(e) => onChange({ ...f, [key]: e.target.value } as DataFilter)} />;
  const number = (key: string, title: string, min?: number) => (
    <input type="number" title={title} min={min} value={Number((f as Record<string, unknown>)[key] ?? 0)} onChange={(e) => onChange({ ...f, [key]: +e.target.value } as DataFilter)} />
  );
  let body: React.ReactNode = null;
  switch (f.type) {
    case 'prefix':
    case 'suffix':
      body = text('text', f.type === 'prefix' ? 'Text before' : 'Text after');
      break;
    case 'default':
      body = text('text', 'Text when empty');
      break;
    case 'replace':
      body = (
        <>
          {text('find', 'Find')}
          {text('with', 'Replace with')}
        </>
      );
      break;
    case 'map':
      body = (
        <>
          {text('when', 'When the value is')}
          {text('then', 'Show')}
        </>
      );
      break;
    case 'truncate':
      body = (
        <label className="dc-inline">
          Max {number('max', 'Characters', 1)}
        </label>
      );
      break;
    case 'lines':
      body = (
        <div className="row">
          <label className="dc-inline">From {number('from', 'First line (1 = first, −1 = last)')}</label>
          <label className="dc-inline">Count {number('count', '0 = all', 0)}</label>
        </div>
      );
      break;
    case 'join':
      body = text('separator', 'Separator');
      break;
    case 'number':
      body = (
        <div className="row">
          <label className="dc-inline">Decimals {number('decimals', 'Decimals', 0)}</label>
          <label className="dc-inline">
            <input type="checkbox" checked={f.grouping} onChange={(e) => onChange({ ...f, grouping: e.target.checked })} /> 1 000
          </label>
        </div>
      );
      break;
    case 'math':
      body = (
        <div className="row">
          <select value={f.op} onChange={(e) => onChange({ ...f, op: e.target.value as typeof f.op })}>
            <option value="add">+</option>
            <option value="sub">−</option>
            <option value="mul">×</option>
            <option value="div">÷</option>
          </select>
          {number('value', 'Value')}
        </div>
      );
      break;
  }
  return body ? <div className="dc-step-body">{body}</div> : null;
}

/** The default value of a variable, with an editor fitting its kind. */
function DefaultEditor({ field: f, onChange }: { field: Field; onChange: (fn: (f: Field) => void, key?: string) => void }) {
  const set = (v: string) => onChange((x) => void (x.default = v), `default-${f.key}`);
  switch (f.kind) {
    case 'multiline':
      return <textarea rows={3} placeholder="Default value" value={f.default} onChange={(e) => set(e.target.value)} />;
    case 'number': {
      const min = f.min ?? 0;
      const max = f.max ?? 100;
      return (
        <>
          <div className="row">
            <input type="range" min={min} max={max} step={(max - min) / 200 || 1} value={parseFloat(f.default) || 0} onChange={(e) => set(e.target.value)} />
            <input type="number" className="dc-num" value={f.default} onChange={(e) => set(e.target.value)} />
          </div>
          <div className="row dc-range">
            <label className="dc-inline">
              Min <input type="number" value={min} onChange={(e) => onChange((x) => void (x.min = +e.target.value), `min-${f.key}`)} />
            </label>
            <label className="dc-inline">
              Max <input type="number" value={max} onChange={(e) => onChange((x) => void (x.max = +e.target.value), `max-${f.key}`)} />
            </label>
          </div>
        </>
      );
    }
    case 'color': {
      const c = parseHex(f.default) ?? [1, 1, 1, 1];
      return (
        <div className="row">
          <input type="color" value={toHex(c).slice(0, 7)} onChange={(e) => set(e.target.value)} />
          <input className="mono" value={f.default} placeholder="#ffffff" onChange={(e) => set(e.target.value)} />
        </div>
      );
    }
    case 'image':
      return <AssetPicker value={f.default} onChange={set} />;
    case 'boolean':
      return (
        <label className="switch">
          <input type="checkbox" checked={f.default === 'true'} onChange={(e) => set(e.target.checked ? 'true' : 'false')} />
          <span>{f.default === 'true' ? 'On' : 'Off'}</span>
        </label>
      );
    default:
      return <input placeholder="Default value" title="Value until the operator types another one" value={f.default} onChange={(e) => set(e.target.value)} />;
  }
}

export function DataCanvasButton({ className = 'btn small' }: { className?: string }) {
  const open = useDataCanvas((s) => s.set);
  return (
    <button className={className} onClick={() => open(true)} title="Sources, filters, variables, operations and the layers' values, on a canvas">
      <Database size={13} /> Data
    </button>
  );
}

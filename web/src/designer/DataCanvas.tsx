import { ArrowDown, ArrowDownUp, ArrowUp, Database, Filter, Image as ImageIcon, ListTree, Plus, Trash2, Type, Variable, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { PickDialog } from '../data/BindingEditor';
import { useBoundData, useSources } from '../data/dataStore';
import { col, holdFrame, interpolateText, newId, num, parseHex, resolveLayer, toHex } from '../engine/evaluate';
import { applyLogic, INPUTS, measureLayer, nodeValues } from '../engine/logic';
import { api } from '../store';
import { TEXT_LIKE, type DataFilter, type DataSort, type Field, type FieldKind, type Layer, type Logic, type LogicNode, type Prop, type Template } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { navigate } from '../router';
import { findLayer, useDesigner } from './designerStore';
import { AssetPicker, fieldKey, PROP_LABELS } from './Inspector';
import { ICONS } from './LayersPanel';
import { fmt, inputLabel, KINDS, LogicNodeBody, makeNode } from './LogicEditor';
import { WidgetRunButtons } from './WidgetRun';

/*
 * Data canvas: data sources → filters → variables → operations → layers,
 * wired with the mouse. Every wire is the template's own data:
 *   source → variable          the field's binding (path, then its filters)
 *   variable → layer           a {{key}} in a text, or a property binding
 *   variable / operation → …   the template's logic graph (math, conditions…),
 *                              whose "field" and "set property" nodes are the
 *                              variables and the layers' ports here.
 * Node positions of sources, filters, variables and layers are a per-browser
 * layout; operations keep their position in the logic graph.
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

const FILTERS: { make: () => DataFilter; label: string; hint: string }[] = [
  { make: () => ({ type: 'trim' }), label: 'Trim', hint: 'Spaces around' },
  { make: () => ({ type: 'upper' }), label: 'Uppercase', hint: 'ABC' },
  { make: () => ({ type: 'lower' }), label: 'Lowercase', hint: 'abc' },
  { make: () => ({ type: 'capitalize' }), label: 'Capitalize', hint: 'Each Word' },
  { make: () => ({ type: 'prefix', text: '' }), label: 'Prefix', hint: 'Text before' },
  { make: () => ({ type: 'suffix', text: '' }), label: 'Suffix', hint: 'Text after' },
  { make: () => ({ type: 'replace', find: '', with: '' }), label: 'Replace', hint: 'Find → replace' },
  { make: () => ({ type: 'truncate', max: 30 }), label: 'Truncate', hint: 'At most N characters' },
  { make: () => ({ type: 'lines', from: 1, count: 1 }), label: 'Lines', hint: 'Keep some lines of a list' },
  { make: () => ({ type: 'join', separator: ' · ' }), label: 'Join', hint: 'A list on one line' },
  { make: () => ({ type: 'number', decimals: 0, grouping: true }), label: 'Number format', hint: '1 234,5' },
  { make: () => ({ type: 'math', op: 'add', value: 0 }), label: 'Calculate', hint: '+ − × ÷ a number' },
  { make: () => ({ type: 'map', when: '', then: '' }), label: 'If equals', hint: 'A value → another' },
  { make: () => ({ type: 'default', text: '' }), label: 'If empty', hint: 'Fallback text' },
];

const OPERATIONS = KINDS.filter((k) => k.type !== 'field' && k.type !== 'target');

const W = { source: 320, filter: 210, field: 250, logic: 210, layer: 260 };
const HEAD = 34;
const ROW = 24;
const COLS = { source: 40, filter: 400, field: 900, logic: 1200, layer: 1480 };

interface Layout {
  pos: Record<string, { x: number; y: number }>;
  sources: string[];
  collapsed: Record<string, boolean>;
}

function loadLayout(id: string): Layout {
  const empty: Layout = { pos: {}, sources: [], collapsed: {} };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(`pulse.dataCanvas.${id}`) ?? '{}') };
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

type Wire = { kind: 'source'; id: string } | { kind: 'field'; key: string } | { kind: 'logic'; id: string };

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
  const canvasRef = useRef<HTMLDivElement>(null);
  const [layout, setLayoutState] = useState<Layout>(() => loadLayout(template.id));
  const [drag, setDrag] = useState<{ wire: Wire; x: number; y: number } | null>(null);
  const [picking, setPicking] = useState<Field | null>(null);
  const [armed, setArmed] = useState<'filter' | 'sort' | null>(null);
  const logic: Logic = template.logic ?? { nodes: [], edges: [] };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    // What the operations set, too: the layers' values as they will be.
    applyLogic(template.logic, m, values, measureLayer(template.layers, values, interpolateText));
    return m;
  }, [template, frame, values]);
  const logicValues = useMemo(() => nodeValues(logic, resolved, values, measureLayer(template.layers, values, interpolateText)), [logic, resolved, values, template.layers]);

  // ---- What the canvas shows and where.
  const sourceIds = [...new Set([...template.fields.map((f) => f.binding?.source).filter((s): s is string => !!s), ...layout.sources])];
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
  const CROW = 52;
  const portTop = (l: Layer, port: string) => {
    let y = HEAD;
    for (const p of ports(l)) {
      if (p === port) return y;
      y += contentOf(l).includes(p) ? CROW : ROW;
    }
    return -1;
  };
  const layerHeight = (l: Layer) => HEAD + ports(l).reduce((h, p) => h + (contentOf(l).includes(p) ? CROW : ROW), 0) + 30 + (isTimed(l) ? 40 : 0);

  const nodePos = new Map<string, Pt>();
  const stack = (col: keyof typeof COLS, items: [string, number][]) => {
    let y = 40;
    for (const [id, h] of items) {
      nodePos.set(id, layout.pos[id] ?? { x: COLS[col], y });
      y += h + 24;
    }
  };
  const fieldHeight = (f: Field) => HEAD + (f.binding ? 120 : f.kind === 'number' ? 130 : f.kind === 'image' ? 150 : 96);
  stack('source', sourceIds.map((s) => [`s:${s}`, HEAD + 300]));
  stack('field', template.fields.map((f) => [`f:${f.key}`, fieldHeight(f)]));
  stack('layer', template.layers.map((l) => [`l:${l.id}`, layerHeight(l)]));
  // Sort and filter nodes sit on the way from the source to their variable.
  for (const f of template.fields) {
    const fp = nodePos.get(`f:${f.key}`)!;
    if (f.binding?.sort) nodePos.set(`o:${f.key}`, layout.pos[`o:${f.key}`] ?? { x: COLS.filter - 20, y: fp.y });
    if (f.binding?.filters?.length) nodePos.set(`x:${f.key}`, layout.pos[`x:${f.key}`] ?? { x: COLS.filter + (f.binding.sort ? 230 : 0), y: fp.y + 10 });
  }
  const space = { w: Math.max(2200, ...[...nodePos.values()].map((p) => p.x + 400), ...operations.map((n) => n.x + 400)), h: Math.max(1400, ...[...nodePos.values()].map((p) => p.y + 600), ...operations.map((n) => n.y + 400)) };

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
  const logicOut = (n: LogicNode) => ({ x: n.x + W.logic, y: n.y + HEAD / 2 });

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
  const editField = (key: string, fn: (f: Field) => void, coalesce?: string) => update((t) => fn(t.fields.find((f) => f.key === key)!), coalesce);
  const editFilters = (key: string, fn: (fs: DataFilter[]) => void, coalesce?: string) =>
    editField(
      key,
      (f) => {
        if (!f.binding) return;
        const fs = [...(f.binding.filters ?? [])];
        fn(fs);
        f.binding = { ...f.binding, filters: fs.length ? fs : undefined };
        if (!fs.length) delete f.binding.filters;
      },
      coalesce,
    );
  const newField = (t: Template, label: string, kind: FieldKind, def: string): string => {
    const key = fieldKey(label, new Set(t.fields.map((f) => f.key)));
    t.fields.push({ key, label, kind, default: def });
    return key;
  };

  // ---- Wires of the template.
  const wires: { d: string; title: string; onClick: () => void; data?: boolean }[] = [];
  for (const f of template.fields) {
    if (!f.binding?.source || !nodePos.has(`s:${f.binding.source}`)) continue;
    const chain = [outOf(`s:${f.binding.source}`, W.source)];
    for (const id of [`o:${f.key}`, `x:${f.key}`])
      if (nodePos.has(id)) {
        chain.push(inOf(id));
        chain.push(outOf(id, W.filter));
      }
    chain.push(inOf(`f:${f.key}`));
    for (let i = 0; i + 1 < chain.length; i += 2) {
      wires.push({
        d: curve(chain[i], chain[i + 1]),
        data: true,
        title: armed ? `Add a ${armed} here` : `${f.label} from the source (click to unlink)`,
        onClick: () => {
          if (armed === 'filter') editFilters(f.key, (x) => void (x.length || x.push({ type: 'trim' })));
          else if (armed === 'sort') editField(f.key, (x) => void (x.binding && (x.binding.sort ??= { list: '', by: '', descending: true, numeric: true })));
          else update((t) => void delete t.fields.find((x) => x.key === f.key)!.binding);
          setArmed(null);
        },
      });
    }
  }
  for (const l of template.layers)
    for (const port of [...contentOf(l), ...portsOf(l)]) {
      const to = layerIn(l, port);
      if (!to) continue;
      const content = contentOf(l).includes(port);
      const keys = content ? template.fields.filter((f) => tokensIn(l, port, f.key)).map((f) => f.key) : [l.bindings[port as Prop]].filter((k): k is string => !!k && template.fields.some((f) => f.key === k));
      for (const key of keys)
        wires.push({
          d: curve(outOf(`f:${key}`, W.field), to),
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
    const from = a.type === 'field' ? (nodePos.has(`f:${a.key}`) ? outOf(`f:${a.key}`, W.field) : null) : logicOut(a);
    let to: Pt | null;
    if (b.type === 'target') {
      const l = template.layers.find((x) => x.id === b.layer);
      to = l ? layerIn(l, b.prop) : null;
    } else to = logicIn(b, e.port);
    if (!from || !to) return;
    wires.push({ d: curve(from, to), title: 'Click to remove', onClick: () => editLogic((l) => void l.edges.splice(i, 1)) });
  });

  // ---- Wiring with the mouse.
  const point = (clientX: number, clientY: number) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };
  const wireStart = (w: Wire): Pt | null => {
    if (w.kind === 'source') return nodePos.has(`s:${w.id}`) ? outOf(`s:${w.id}`, W.source) : null;
    if (w.kind === 'field') return nodePos.has(`f:${w.key}`) ? outOf(`f:${w.key}`, W.field) : null;
    const n = nodes.get(w.id);
    return n ? logicOut(n) : null;
  };

  const connect = (w: Wire, target: HTMLElement | null, at: Pt) => {
    const port = target?.closest<HTMLElement>('.port.in');
    const d = port?.dataset ?? {};
    if (w.kind === 'source') {
      if (d.field) {
        update((t) => {
          const f = t.fields.find((x) => x.key === d.field)!;
          f.binding = f.binding?.source === w.id ? f.binding : { source: w.id, path: '' };
        });
      } else if (!target?.closest('.dc-node')) {
        // Dropped on empty space: a new variable fed by this source.
        let made = '';
        update((t) => {
          made = newField(t, `Field ${t.fields.length + 1}`, 'text', '');
          t.fields.find((x) => x.key === made)!.binding = { source: w.id, path: '' };
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
          const fp = nodePos.get(`f:${w.key}`)!;
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

  /** Drags a node: a layout node (`id`) or an operation of the logic graph. */
  const dragNode = (e: React.PointerEvent, id: string, logicId?: string) => {
    if ((e.target as HTMLElement).closest('select, input, button, .port, textarea, label')) return;
    e.preventDefault();
    const start = point(e.clientX, e.clientY);
    const base = logicId ? { x: nodes.get(logicId)!.x, y: nodes.get(logicId)!.y } : nodePos.get(id)!;
    useDesigner.setState({ lastCoalesce: null });
    const move = (ev: PointerEvent) => {
      const p = point(ev.clientX, ev.clientY);
      const at = { x: Math.max(0, Math.round(base.x + p.x - start.x)), y: Math.max(0, Math.round(base.y + p.y - start.y)) };
      if (logicId) setNode(logicId, at, `data-move-${logicId}`);
      else setLayout((l) => ({ ...l, pos: { ...l.pos, [id]: at } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const visibleTop = () => (canvasRef.current?.scrollTop ?? 0) + 60;
  const hiddenSources = sources.filter((s) => !sourceIds.includes(s.id));
  const dragFrom = drag && wireStart(drag.wire);

  return (
    <div className="logic-editor data-canvas" onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <Database size={16} />
        <h2>Data — {template.name}</h2>
        <span className="muted small">Drag from a dot on the right to a dot on the left. Click a wire to remove it.</span>
        <div className="spacer" />
        <button className="icon-btn ghost" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </header>
      {armed && (
        <div className="dc-armed">
          {armed === 'sort' ? <ArrowDownUp size={13} /> : <Filter size={13} />} Click a data wire (source → variable) to add a <strong>{armed}</strong> there.
          <button className="btn small" onClick={() => setArmed(null)}>
            Cancel (Esc)
          </button>
        </div>
      )}
      <div className="logic-body">
        <aside className="logic-palette">
          <button
            className="kind-field"
            onClick={() => {
              let made = '';
              update((t) => void (made = newField(t, `Field ${t.fields.length + 1}`, 'text', '')));
              setLayout((l) => ({ ...l, pos: { ...l.pos, [`f:${made}`]: { x: COLS.field, y: visibleTop() } } }));
            }}
          >
            <Variable size={14} />
            <span>
              <strong>Variable</strong>
              <em>Typed by the operator, or fed by a source</em>
            </span>
          </button>

          <div className="dc-pal-title">Data sources</div>
          {hiddenSources.map((s) => (
            <button key={s.id} className="kind-source" onClick={() => setLayout((l) => ({ ...l, sources: [...l.sources, s.id] }))}>
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
          {sources.length > 0 && !hiddenSources.length && <p className="hint">All the sources are on the canvas.</p>}

          <div className="dc-pal-title">On the way</div>
          <button className={`kind-sort ${armed === 'sort' ? 'on' : ''}`} title="Then click a data wire" onClick={() => setArmed('sort')}>
            <ArrowDownUp size={14} />
            <span>
              <strong>Sort</strong>
              <em>Order a list before reading it</em>
            </span>
          </button>
          <button className={`kind-filter ${armed === 'filter' ? 'on' : ''}`} title="Then click a data wire" onClick={() => setArmed('filter')}>
            <Filter size={14} />
            <span>
              <strong>Filter</strong>
              <em>Steps on the text read: case, replace, format, lines…</em>
            </span>
          </button>

          <div className="dc-pal-title">Operations</div>
          {OPERATIONS.map((k) => (
            <button
              key={k.type}
              className={`kind-${k.type}`}
              onClick={() => {
                const n = makeNode(k.type, template, COLS.logic, visibleTop() + ((logic.nodes.length * 40) % 240));
                editLogic((l) => void l.nodes.push(n));
              }}
            >
              <k.icon size={14} />
              <span>
                <strong>{k.label}</strong>
                <em>{k.hint}</em>
              </span>
            </button>
          ))}
        </aside>

        <div className={`logic-canvas ${armed ? 'arming' : ''}`} ref={canvasRef}>
          <div className="logic-space" style={{ width: space.w, height: space.h }}>
            <svg className="logic-wires">
              {wires.map((w, i) => (
                <path key={i} d={w.d} className={`wire ${w.data ? 'data' : ''}`} onPointerDown={(e) => (e.stopPropagation(), w.onClick())}>
                  <title>{w.title}</title>
                </path>
              ))}
              {drag && dragFrom && <path d={curve(dragFrom, drag)} className="wire live" />}
            </svg>

            {/* Sources */}
            {sourceIds.map((id) => {
              const s = sources.find((x) => x.id === id);
              const p = nodePos.get(`s:${id}`)!;
              const used = template.fields.filter((f) => f.binding?.source === id).length;
              return (
                <div key={id} className="logic-node dc-node kind-source" style={{ left: p.x, top: p.y, width: W.source }} onPointerDown={(e) => dragNode(e, `s:${id}`)}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <Database size={12} />
                    <span>{s?.name ?? `Missing: ${id}`}</span>
                    {!used && (
                      <button className="ln-del" title="Remove from the canvas" onClick={() => setLayout((l) => ({ ...l, sources: l.sources.filter((x) => x !== id) }))}>
                        <X size={11} />
                      </button>
                    )}
                    <span className="port out" title="Drag to a variable (or to empty space for a new one)" onPointerDown={(e) => startWire(e, { kind: 'source', id })} />
                  </div>
                  <div className="ln-body">
                    <span className="dc-meta">
                      <span className={`live-dot ${s?.error ? 'err' : ''}`} /> {s ? `${s.type.toUpperCase()} · every ${s.interval} s` : 'not found'}
                    </span>
                    <span className="dc-meta">{used ? `Feeds ${used} variable${used > 1 ? 's' : ''}` : 'Feeds nothing yet'}</span>
                    <SourceTable id={id} version={s?.updatedAt ?? 0} />
                  </div>
                </div>
              );
            })}

            {/* Sort and filter, on the way from a source to a variable */}
            {template.fields.flatMap((f) => {
              const out: React.ReactNode[] = [];
              const b = f.binding;
              if (b?.sort) {
                const p = nodePos.get(`o:${f.key}`)!;
                out.push(
                  <div key={`o:${f.key}`} className="logic-node dc-node kind-sort" style={{ left: p.x, top: p.y, width: W.filter }} onPointerDown={(e) => dragNode(e, `o:${f.key}`)}>
                    <div className="ln-head" style={{ height: HEAD }}>
                      <span className="port in fixed" />
                      <ArrowDownUp size={12} />
                      <span>Sort</span>
                      <button className="ln-del" title="Remove the sort" onClick={() => editField(f.key, (x) => void (x.binding && delete x.binding.sort))}>
                        <Trash2 size={11} />
                      </button>
                      <span className="port out fixed" />
                    </div>
                    <SortBody source={b.source} sort={b.sort} onChange={(srt) => editField(f.key, (x) => void (x.binding && (x.binding.sort = srt)), `sort-${f.key}`)} />
                  </div>,
                );
              }
              if (b?.filters?.length) {
                const p = nodePos.get(`x:${f.key}`)!;
                out.push(
                  <div key={`x:${f.key}`} className="logic-node dc-node kind-filter" style={{ left: p.x, top: p.y, width: W.filter }} onPointerDown={(e) => dragNode(e, `x:${f.key}`)}>
                    <div className="ln-head" style={{ height: HEAD }}>
                      <span className="port in fixed" />
                      <Filter size={12} />
                      <span>Filter · {b.filters.length}</span>
                      <button className="ln-del" title="Remove the filter" onClick={() => editFilters(f.key, (x) => void x.splice(0))}>
                        <Trash2 size={11} />
                      </button>
                      <span className="port out fixed" />
                    </div>
                    <FilterSteps steps={b.filters} onChange={(fs) => editFilters(f.key, (x) => void x.splice(0, x.length, ...fs), `filter-${f.key}`)} />
                  </div>,
                );
              }
              return out;
            })}

            {/* Variables */}
            {template.fields.map((f) => {
              const p = nodePos.get(`f:${f.key}`)!;
              const v = values[f.key] ?? '';
              return (
                <div key={f.key} className="logic-node dc-node kind-field" style={{ left: p.x, top: p.y, width: W.field }} onPointerDown={(e) => dragNode(e, `f:${f.key}`)}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <span className="port in" data-field={f.key} title="Drop a source here" />
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
                        <div className="row">
                          <input className="mono" placeholder="path, e.g. items[0].title" value={f.binding.path} onChange={(e) => editField(f.key, (x) => void (x.binding = { ...x.binding!, path: e.target.value }), `path-${f.key}`)} />
                          <button className="icon-btn ghost" title="Pick in the source's value" onClick={() => setPicking(f)}>
                            <ListTree size={13} />
                          </button>
                        </div>
                        <span className="dc-value live" title="Value from the source now, after the filters">
                          {v === '' ? '(no value at this path)' : v.length > 40 ? `${v.slice(0, 40)}…` : v}
                        </span>
                        <span className="row">
                          {!f.binding.sort && (
                            <button className="dc-addfilter" onClick={() => editField(f.key, (x) => void (x.binding && (x.binding.sort = { list: '', by: '', descending: true, numeric: true })))}>
                              <Plus size={11} /> Sort
                            </button>
                          )}
                          {!f.binding.filters?.length && (
                            <button className="dc-addfilter" onClick={() => editFilters(f.key, (x) => void x.push({ type: 'trim' }))}>
                              <Plus size={11} /> Filter
                            </button>
                          )}
                        </span>
                      </>
                    ) : (
                      <DefaultEditor field={f} onChange={(fn, key) => editField(f.key, fn, key)} />
                    )}
                  </div>
                </div>
              );
            })}

            {/* Operations (the logic graph) */}
            {operations.map((n) => {
              const k = KINDS.find((x) => x.type === n.type)!;
              return (
                <div key={n.id} className={`logic-node dc-node kind-${n.type}`} style={{ left: n.x, top: n.y, width: W.logic }} onPointerDown={(e) => dragNode(e, n.id, n.id)}>
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
                <div key={l.id} className="logic-node dc-node kind-layer" style={{ left: p.x, top: p.y, width: W.layer }} onPointerDown={(e) => dragNode(e, `l:${l.id}`)}>
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
                          {isWired ? (
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
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {picking?.binding && (
        <PickDialog
          source={picking.binding.source}
          path={picking.binding.path}
          onPick={(path) => {
            editField(picking.key, (x) => void (x.binding = { ...x.binding!, path }));
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
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
const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : String(v));

/** Dotted paths of the lists of objects in a value (for the sort), the root first. */
function listsIn(v: unknown, path = '', depth = 0, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    if (v.some(isObj)) out.push(path);
  } else if (isObj(v) && depth < 4) {
    for (const [k, x] of Object.entries(v)) listsIn(x, path ? `${path}.${k}` : k, depth + 1, out);
  }
  return out;
}
const at = (v: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : Array.isArray(cur) ? cur[+k] : undefined), v);

/** A source's data as a readable table: its first list of rows, or its keys and values (10 rows, scrolls). */
function SourceTable({ id, version }: { id: string; version: number }) {
  const value = useSourceValue(id, version);
  if (value === undefined) return <span className="dc-meta">Loading the data…</span>;
  if (value === null) return <span className="dc-meta">No data yet.</span>;
  const list = listsIn(value)[0];
  const rows = list !== undefined ? (at(value, list) as unknown[]) : null;
  if (rows) {
    const objs = rows.filter(isObj);
    const cols = [...new Set(objs.slice(0, 20).flatMap((o) => Object.keys(o)))].slice(0, 8);
    return (
      <div className="dc-table-wrap" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div className="dc-table-title">
          {list || 'root'} · {rows.length} rows
        </div>
        <div className="dc-table-scroll">
          <table className="dc-table">
            <thead>
              <tr>
                <th>#</th>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {objs.map((o, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  {cols.map((c) => (
                    <td key={c}>{cell(o[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  const entries = isObj(value) ? Object.entries(value) : [['value', value]];
  return (
    <div className="dc-table-wrap" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="dc-table-scroll">
        <table className="dc-table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={String(k)}>
                <th>{String(k)}</th>
                <td>{cell(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Which list to sort, by which key, in which order. */
function SortBody({ source, sort, onChange }: { source: string; sort: DataSort; onChange: (s: DataSort) => void }) {
  const value = useSourceValue(source, 0);
  const lists = value ? listsIn(value) : [];
  const rows = (lists.includes(sort.list) ? (at(value, sort.list) as unknown[]) : []).filter(isObj);
  const keys = [...new Set(rows.slice(0, 20).flatMap((o) => Object.keys(o)))];
  return (
    <div className="ln-body">
      <label className="dc-inline">
        List
        <select value={sort.list} onChange={(e) => onChange({ ...sort, list: e.target.value })}>
          {!lists.includes(sort.list) && <option value={sort.list}>{sort.list || '— choose —'}</option>}
          {lists.map((l) => (
            <option key={l} value={l}>
              {l || '(root)'}
            </option>
          ))}
        </select>
      </label>
      <label className="dc-inline">
        By
        <select value={sort.by} onChange={(e) => onChange({ ...sort, by: e.target.value })}>
          {!keys.includes(sort.by) && <option value={sort.by}>{sort.by || '— key —'}</option>}
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button className={`btn small ${sort.descending ? '' : 'on'}`} title="Smallest first" onClick={() => onChange({ ...sort, descending: false })}>
          <ArrowUp size={12} /> Asc
        </button>
        <button className={`btn small ${sort.descending ? 'on' : ''}`} title="Largest first" onClick={() => onChange({ ...sort, descending: true })}>
          <ArrowDown size={12} /> Desc
        </button>
        <label className="dc-inline" title="Compare as numbers (else as text)">
          <input type="checkbox" checked={!!sort.numeric} onChange={(e) => onChange({ ...sort, numeric: e.target.checked })} /> 123
        </label>
      </div>
    </div>
  );
}

/** One filter node: its steps, applied one after the other. */
function FilterSteps({ steps, onChange }: { steps: DataFilter[]; onChange: (s: DataFilter[]) => void }) {
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
            <select value={f.type} onChange={(e) => set(i, FILTERS.find((x) => x.make().type === e.target.value)!.make())}>
              {FILTERS.map((x) => (
                <option key={x.label} value={x.make().type}>
                  {x.label}
                </option>
              ))}
            </select>
            <button className="icon-btn ghost" title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={11} />
            </button>
            <button className="icon-btn ghost" title="Later" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={11} />
            </button>
            <button className="icon-btn ghost" title="Remove the step" onClick={() => onChange(steps.filter((_, k) => k !== i))}>
              <X size={11} />
            </button>
          </div>
          <FilterBody filter={f} onChange={(nf) => set(i, nf)} />
        </div>
      ))}
      <button className="dc-addfilter" onClick={() => onChange([...steps, { type: 'trim' }])}>
        <Plus size={11} /> Step
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

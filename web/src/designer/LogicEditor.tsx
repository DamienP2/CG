import { Calculator, Crosshair, Hash, Link2, Ruler, Split, Target, TextCursorInput, Trash2, Wand2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { holdFrame, interpolateText, newId, resolveLayer } from '../engine/evaluate';
import { INPUTS, measureLayer, nodeValues, type LVal } from '../engine/logic';
import { PROPS, type Cmp, type Logic, type LogicNode, type MathOp, type Prop, type Template, type TextMetric } from '../engine/types';
import { ResizeCorner, useCanvasView } from '../ui/canvasView';
import { PROP_LABELS } from './Inspector';
import { useDesigner } from './designerStore';

/*
 * Relations editor (MXMZ-style logic): sources → operations → targets,
 * wired on a canvas. Values update live at the playhead with the preview
 * data, and the same graph runs in the Rust renderer.
 */

const NODE_W = 210;
const HEAD = 30;
const ROW = 24;

export const KINDS: { type: LogicNode['type']; label: string; hint: string; icon: typeof Hash }[] = [
  { type: 'layerProp', label: 'Layer property', hint: 'x, width, opacity… of a layer', icon: Crosshair },
  { type: 'textSize', label: 'Text size', hint: 'Measured width / height of a text', icon: Ruler },
  { type: 'field', label: 'Data field', hint: 'What the operator types', icon: TextCursorInput },
  { type: 'constant', label: 'Number', hint: 'A fixed value', icon: Hash },
  { type: 'math', label: 'Math', hint: '+ − × ÷ min max…', icon: Calculator },
  { type: 'clamp', label: 'Clamp', hint: 'Keep between min and max', icon: Split },
  { type: 'condition', label: 'Condition', hint: 'If A > B then … else …', icon: Split },
  { type: 'target', label: 'Set property', hint: 'Drives a layer property', icon: Target },
];

const MATH: { value: MathOp; label: string }[] = [
  { value: 'add', label: 'A + B' },
  { value: 'sub', label: 'A − B' },
  { value: 'mul', label: 'A × B' },
  { value: 'div', label: 'A ÷ B' },
  { value: 'min', label: 'min(A, B)' },
  { value: 'max', label: 'max(A, B)' },
  { value: 'abs', label: '|A|' },
  { value: 'round', label: 'round(A)' },
  { value: 'floor', label: 'floor(A)' },
  { value: 'ceil', label: 'ceil(A)' },
];

const CMP: { value: Cmp; label: string }[] = [
  { value: 'gt', label: 'A > B' },
  { value: 'ge', label: 'A ≥ B' },
  { value: 'lt', label: 'A < B' },
  { value: 'le', label: 'A ≤ B' },
  { value: 'eq', label: 'A = B' },
  { value: 'ne', label: 'A ≠ B' },
  { value: 'empty', label: 'A is empty' },
  { value: 'notEmpty', label: 'A is not empty' },
];

const NUMERIC_PROPS = PROPS.filter((p) => p !== 'fill' && p !== 'stroke');

export function makeNode(type: LogicNode['type'], t: Template, x: number, y: number): LogicNode {
  const first = t.layers[0]?.id ?? '';
  const text = t.layers.find((l) => l.type === 'text')?.id ?? first;
  const base = { id: newId(), x, y };
  switch (type) {
    case 'layerProp':
      return { ...base, type, layer: first, prop: 'width' };
    case 'textSize':
      return { ...base, type, layer: text, metric: 'width' };
    case 'field':
      return { ...base, type, key: t.fields[0]?.key ?? '' };
    case 'constant':
      return { ...base, type, value: 0 };
    case 'math':
      return { ...base, type, op: 'add' };
    case 'clamp':
      return { ...base, type, min: 0, max: 1920 };
    case 'condition':
      return { ...base, type, cmp: 'gt' };
    case 'target':
      return { ...base, type, layer: first, prop: 'width', mode: 'set' };
  }
}

const portIn = (n: LogicNode, port: string) => ({ x: n.x, y: n.y + HEAD + INPUTS[n.type].indexOf(port) * ROW + ROW / 2 });
const portOut = (n: LogicNode, w = NODE_W) => ({ x: n.x + w, y: n.y + HEAD / 2 });

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export const fmt = (v: LVal | undefined) => (v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(2)) : `“${v.length > 18 ? `${v.slice(0, 18)}…` : v}”`);

/** "Fit a box to a text": text width + 2 × padding → box width. */
function FitPreset({ template, onCreate, onClose }: { template: Template; onCreate: (nodes: LogicNode[], edges: Logic['edges']) => void; onClose: () => void }) {
  const texts = template.layers.filter((l) => l.type === 'text');
  const boxes = template.layers.filter((l) => l.type !== 'text');
  const [text, setText] = useState(texts[0]?.id ?? '');
  const [box, setBox] = useState(boxes[0]?.id ?? '');
  const [padding, setPadding] = useState(30);
  const [min, setMin] = useState(0);
  const create = () => {
    const tw = { id: newId(), type: 'textSize' as const, layer: text, metric: 'width' as TextMetric, x: 40, y: 60 };
    const pad = { id: newId(), type: 'constant' as const, value: padding * 2, x: 40, y: 200 };
    const add = { id: newId(), type: 'math' as const, op: 'add' as MathOp, x: 320, y: 100 };
    const mn = { id: newId(), type: 'constant' as const, value: min, x: 320, y: 260 };
    const mx = { id: newId(), type: 'math' as const, op: 'max' as MathOp, x: 600, y: 140 };
    const target = { id: newId(), type: 'target' as const, layer: box, prop: 'width' as Prop, mode: 'set' as const, x: 880, y: 140 };
    onCreate(
      [tw, pad, add, mn, mx, target],
      [
        { from: tw.id, to: add.id, port: 'a' },
        { from: pad.id, to: add.id, port: 'b' },
        { from: add.id, to: mx.id, port: 'a' },
        { from: mn.id, to: mx.id, port: 'b' },
        { from: mx.id, to: target.id, port: 'in' },
      ],
    );
    onClose();
  };
  return (
    <div className="logic-preset" onPointerDown={(e) => e.stopPropagation()}>
      <strong>Fit a box to a text</strong>
      <label>
        Text
        <select value={text} onChange={(e) => setText(e.target.value)}>
          {texts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Box
        <select value={box} onChange={(e) => setBox(e.target.value)}>
          {boxes.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Padding (each side)
        <input type="number" value={padding} onChange={(e) => setPadding(+e.target.value)} />
      </label>
      <label>
        Minimum width
        <input type="number" value={min} onChange={(e) => setMin(+e.target.value)} />
      </label>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!text || !box} onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}

/** Settings of a logic node (layer, property, operation…), shared by the Logic and Data editors. */
export function LogicNodeBody({ n, template, setNode }: { n: LogicNode; template: Template; setNode: (id: string, patch: Partial<LogicNode>, key?: string) => void }) {
  const layerSelect = (n: LogicNode & { layer: string }, filter?: (type: string) => boolean) => (
    <select value={n.layer} onChange={(e) => setNode(n.id, { layer: e.target.value } as Partial<LogicNode>)}>
      {template.layers
        .filter((l) => !filter || filter(l.type))
        .map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
    </select>
  );
  const propSelect = (n: LogicNode & { prop: Prop }, list: readonly Prop[]) => (
    <select value={n.prop} onChange={(e) => setNode(n.id, { prop: e.target.value as Prop } as Partial<LogicNode>)}>
      {list.map((p) => (
        <option key={p} value={p}>
          {PROP_LABELS[p] ?? p}
        </option>
      ))}
    </select>
  );

  switch (n.type) {
    case 'layerProp':
      return (
        <>
          {layerSelect(n)}
          {propSelect(n, NUMERIC_PROPS)}
        </>
      );
    case 'textSize':
      return (
        <>
          {layerSelect(n, (t) => t === 'text')}
          <select value={n.metric} onChange={(e) => setNode(n.id, { metric: e.target.value as TextMetric })}>
            <option value="width">Width</option>
            <option value="height">Height</option>
            <option value="lines">Lines</option>
            <option value="chars">Characters</option>
          </select>
        </>
      );
    case 'field':
      return (
        <select value={n.key} onChange={(e) => setNode(n.id, { key: e.target.value })}>
          {!template.fields.some((f) => f.key === n.key) && <option value={n.key}>{n.key || '—'}</option>}
          {template.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      );
    case 'constant':
      return <input type="number" value={n.value} onChange={(e) => setNode(n.id, { value: +e.target.value }, `logic-v-${n.id}`)} />;
    case 'math':
      return (
        <select value={n.op} onChange={(e) => setNode(n.id, { op: e.target.value as MathOp })}>
          {MATH.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      );
    case 'clamp':
      return (
        <div className="row">
          <input type="number" value={n.min} title="Min" onChange={(e) => setNode(n.id, { min: +e.target.value }, `logic-v-${n.id}`)} />
          <input type="number" value={n.max} title="Max" onChange={(e) => setNode(n.id, { max: +e.target.value }, `logic-v-${n.id}`)} />
        </div>
      );
    case 'condition':
      return (
        <select value={n.cmp} onChange={(e) => setNode(n.id, { cmp: e.target.value as Cmp })}>
          {CMP.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'target':
      return (
        <>
          {layerSelect(n)}
          {propSelect(n, PROPS)}
          <select value={n.mode} onChange={(e) => setNode(n.id, { mode: e.target.value as 'set' })}>
            <option value="set">Set to</option>
            <option value="add">Add to the animation</option>
            <option value="multiply">Multiply the animation</option>
          </select>
        </>
      );
  }
}

export const inputLabel = (n: LogicNode, port: string) => (n.type === 'condition' ? { a: 'A', b: 'B', then: 'then', else: 'else' }[port] : n.type === 'math' ? port.toUpperCase() : port === 'in' ? (n.type === 'target' ? 'value' : 'in') : port);

export function LogicEditor({ onClose }: { onClose: () => void }) {
  const { template, update, frame, previewData } = useDesigner();
  const cv = useCanvasView(`logic.${template?.id ?? ''}`);
  // Node widths, per browser.
  const sizesKey = `pulse.logicSizes.${template?.id ?? ''}`;
  const [sizes, setSizesState] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(sizesKey) ?? '{}');
    } catch {
      return {};
    }
  });
  const setSize = (id: string, w: number) =>
    setSizesState((cur) => {
      const next = { ...cur, [id]: w };
      try {
        localStorage.setItem(sizesKey, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const widthOf = (n: LogicNode) => sizes[n.id] ?? NODE_W;
  const [selected, setSelected] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null);
  const [preset, setPreset] = useState(false);
  const logic: Logic = template?.logic ?? { nodes: [], edges: [] };

  // Live values at the playhead.
  const values = useMemo(() => {
    if (!template) return new Map<string, LVal>();
    const hold = holdFrame(template);
    const resolved = new Map(template.layers.map((l) => [l.id, resolveLayer(l, frame, previewData, hold)]));
    return nodeValues(logic, resolved, previewData, measureLayer(template.layers, previewData, interpolateText));
  }, [template, frame, previewData]);

  if (!template) return null;
  const nodes = new Map(logic.nodes.map((n) => [n.id, n]));
  const edit = (fn: (l: Logic) => void, key?: string) =>
    update((t) => {
      t.logic ??= { nodes: [], edges: [] };
      fn(t.logic);
      if (!t.logic.nodes.length) delete t.logic;
    }, key);
  const setNode = (id: string, patch: Partial<LogicNode>, key?: string) =>
    edit((l) => {
      const n = l.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    }, key);

  const canvasPoint = cv.toWorld;

  const add = (type: LogicNode['type']) => {
    const v = cv.visible();
    const x = Math.round(v.x + 60 + ((logic.nodes.length * 30) % 300));
    const y = Math.round(v.y + 60 + ((logic.nodes.length * 40) % 360));
    const n = makeNode(type, template, x, y);
    edit((l) => void l.nodes.push(n));
    setSelected(n.id);
  };

  const dragNode = (e: React.PointerEvent, n: LogicNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('select, input, button, .port, .cv-resize')) return;
    e.preventDefault();
    setSelected(n.id);
    const start = canvasPoint(e.clientX, e.clientY);
    const base = { x: n.x, y: n.y };
    useDesigner.setState({ lastCoalesce: null });
    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev.clientX, ev.clientY);
      setNode(n.id, { x: Math.round(base.x + p.x - start.x), y: Math.round(base.y + p.y - start.y) }, `logic-move-${n.id}`);
    };
    document.body.classList.add('cv-moving');
    const up = () => {
      document.body.classList.remove('cv-moving');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startWire = (e: React.PointerEvent, from: string) => {
    e.stopPropagation();
    e.preventDefault();
    const p = canvasPoint(e.clientX, e.clientY);
    setWire({ from, ...p });
    const move = (ev: PointerEvent) => setWire({ from, ...canvasPoint(ev.clientX, ev.clientY) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWire(null);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('.port.in');
      const to = target?.dataset.node;
      const port = target?.dataset.port;
      if (to && port && to !== from) {
        edit((l) => {
          l.edges = l.edges.filter((x) => !(x.to === to && x.port === port));
          l.edges.push({ from, to, port });
        });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="logic-editor" onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <Link2 size={16} />
        <h2>Logic — {template.name}</h2>
        <span className="muted small">Wire sources into operations and targets. Values shown live at the playhead.</span>
        <div className="spacer" />
        <button className="btn small" onClick={() => setPreset(!preset)}>
          <Wand2 size={13} /> Fit a box to a text…
        </button>
        <button className="icon-btn ghost" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </header>
      <div className="logic-body">
        <aside className="logic-palette">
          {KINDS.map((k) => (
            <button key={k.type} onClick={() => add(k.type)} className={`kind-${k.type}`}>
              <k.icon size={14} />
              <span>
                <strong>{k.label}</strong>
                <em>{k.hint}</em>
              </span>
            </button>
          ))}
        </aside>
        <div
          {...cv.viewport}
          className={`logic-canvas ${cv.viewport.className}`}
          tabIndex={0}
          onPointerDown={(e) => {
            setSelected(null);
            cv.viewport.onPointerDown(e);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !(e.target as HTMLElement).closest('input, select')) {
              edit((l) => {
                l.nodes = l.nodes.filter((n) => n.id !== selected);
                l.edges = l.edges.filter((x) => x.from !== selected && x.to !== selected);
              });
              setSelected(null);
            }
          }}
        >
          <div className="logic-space" data-canvas-void style={cv.spaceStyle}>
            <svg className="logic-wires">
              {logic.edges.map((e, i) => {
                const a = nodes.get(e.from);
                const b = nodes.get(e.to);
                if (!a || !b) return null;
                return (
                  <path
                    key={i}
                    d={curve(portOut(a, widthOf(a)), portIn(b, e.port))}
                    className="wire"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      edit((l) => void (l.edges = l.edges.filter((x) => x !== l.edges[i])));
                    }}
                  >
                    <title>Click to remove</title>
                  </path>
                );
              })}
              {wire && nodes.get(wire.from) && <path d={curve(portOut(nodes.get(wire.from)!, widthOf(nodes.get(wire.from)!)), wire)} className="wire live" />}
            </svg>
            {logic.nodes.map((n) => {
              const k = KINDS.find((x) => x.type === n.type)!;
              return (
                <div key={n.id} className={`logic-node kind-${n.type} ${selected === n.id ? 'sel' : ''}`} style={{ left: n.x, top: n.y, width: widthOf(n) }} onPointerDown={(e) => (e.stopPropagation(), dragNode(e, n))}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <k.icon size={12} />
                    <span>{k.label}</span>
                    <span className="ln-value">{fmt(values.get(n.id))}</span>
                    <button
                      className="ln-del"
                      title="Delete (Del)"
                      onClick={() =>
                        edit((l) => {
                          l.nodes = l.nodes.filter((x) => x.id !== n.id);
                          l.edges = l.edges.filter((x) => x.from !== n.id && x.to !== n.id);
                        })
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                    {n.type !== 'target' && <span className="port out" title="Drag to an input" onPointerDown={(e) => startWire(e, n.id)} />}
                  </div>
                  {INPUTS[n.type].map((port) => (
                    <div key={port} className="ln-input" style={{ height: ROW }}>
                      <span className="port in" data-node={n.id} data-port={port} />
                      <span>{inputLabel(n, port)}</span>
                    </div>
                  ))}
                  <div className="ln-body">
                    <LogicNodeBody n={n} template={template} setNode={setNode} />
                  </div>
                  <ResizeCorner onPointerDown={(e) => cv.resize(e, (w) => setSize(n.id, w))} />
                </div>
              );
            })}
            {!logic.nodes.length && (
              <div className="logic-empty">
                <p>
                  No relation yet. Add nodes from the left, then drag from an output (right dot) to an input (left dot).
                  <br />
                  Example: <em>Text size</em> (name) → <em>Math</em> A + B with <em>Number</em> 60 → <em>Set property</em> plate width.
                </p>
              </div>
            )}
          </div>
          {cv.controls}
          {preset && (
            <FitPreset
              template={template}
              onClose={() => setPreset(false)}
              onCreate={(ns, es) =>
                edit((l) => {
                  const v = cv.visible();
                  const ox = Math.round(v.x + 20);
                  const oy = Math.round(v.y + 20 + (l.nodes.length ? 320 : 0));
                  l.nodes.push(...ns.map((n) => ({ ...n, x: n.x + ox, y: n.y + oy })));
                  l.edges.push(...es);
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

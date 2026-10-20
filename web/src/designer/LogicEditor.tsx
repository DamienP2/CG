import { Calculator, Crosshair, Hash, Link2, Split, Target, TextCursorInput, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { holdFrame, interpolateText, newId, resolveLayer } from '../engine/evaluate';
import { INPUTS, measureLayer, nodeValues, type LVal } from '../engine/logic';
import { COLOR_PROPS, PROPS, TEXT_LIKE, type Cmp, type Layer, type Logic, type LogicNode, type MathOp, type Prop, type Template, type TextMetric } from '../engine/types';
import { CanvasHeader } from '../ui/CanvasHeader';
import { Dropdown } from '../ui/Dropdown';
import { NumberField } from '../ui/fields';
import { freeSpot, ResizeCorner, useCanvasView } from '../ui/canvasView';
import { PROP_LABELS } from './Inspector';
import { useDesigner } from './designerStore';
import { t } from '../i18n';

/*
 * Relations editor (MXMZ-style logic): sources → operations → targets,
 * wired on a canvas. Values update live at the playhead with the preview
 * data, and the same graph runs in the Rust renderer.
 */

const NODE_W = 210;
const HEAD = 30;
const ROW = 24;

/** Node kinds, by category (the palette's sections and the nodes' colors). */
export const KINDS: { type: LogicNode['type']; label: string; cat: 'input' | 'op' | 'output'; icon: typeof Hash }[] = [
  { type: 'layerProp', label: 'Layer property', cat: 'input', icon: Crosshair },
  { type: 'field', label: 'Data field', cat: 'input', icon: TextCursorInput },
  { type: 'constant', label: 'Number', cat: 'input', icon: Hash },
  { type: 'math', label: 'Math', cat: 'op', icon: Calculator },
  { type: 'clamp', label: 'Clamp', cat: 'op', icon: Split },
  { type: 'condition', label: 'Condition', cat: 'op', icon: Split },
  { type: 'target', label: 'Set property', cat: 'output', icon: Target },
];
const CATS: { id: 'input' | 'op' | 'output'; label: string }[] = [
  { id: 'input', label: 'Inputs' },
  { id: 'op', label: 'Operations' },
  { id: 'output', label: 'Output' },
];
/** A node's kind (a text measurement is a Layer property). */
export const kindOf = (n: LogicNode) => KINDS.find((k) => k.type === (n.type === 'textSize' ? 'layerProp' : n.type))!;

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

/** Properties a layer of this type has (what a Layer property or Set property node offers). */
export function propsOf(l: Layer | undefined, numeric: boolean): Prop[] {
  if (!l) return [];
  const has = (p: Prop) => {
    if (p === 'fill') return l.type !== 'image';
    if (p === 'stroke' || p === 'strokeWidth') return l.type !== 'image' && l.type !== 'progress' && l.type !== 'qrCode';
    if (p === 'cornerRadius') return l.type === 'rect' || l.type === 'group' || l.type === 'progress';
    if (p === 'fontSize' || p === 'letterSpacing') return TEXT_LIKE.has(l.type);
    if (p.startsWith('crop')) return l.type === 'image';
    return true;
  };
  return PROPS.filter((p) => has(p) && (!numeric || !COLOR_PROPS.has(p)));
}
/** Property names in full, for the lists (the Inspector's labels are short: W, H). */
const PROP_NAMES: Partial<Record<Prop, string>> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height', anchorX: 'Anchor X', anchorY: 'Anchor Y', scaleX: 'Scale X', scaleY: 'Scale Y', rotation: 'Rotation', opacity: 'Opacity', strokeWidth: 'Stroke width', cornerRadius: 'Corner radius', fontSize: 'Text size', letterSpacing: 'Letter spacing' };
const propName = (p: Prop) => t(PROP_NAMES[p] ?? PROP_LABELS[p] ?? p);
const METRICS: { value: TextMetric; label: string }[] = [
  { value: 'width', label: 'Text width' },
  { value: 'height', label: 'Text height' },
  { value: 'lines', label: 'Lines' },
  { value: 'chars', label: 'Characters' },
];

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

/** Settings of a logic node (layer, property, operation…), shared by the Logic and Data editors. */
export function LogicNodeBody({ n, template, setNode }: { n: LogicNode; template: Template; setNode: (id: string, patch: Partial<LogicNode>, key?: string) => void }) {
  const layerOpts = template.layers.map((l) => ({ value: l.id, label: l.name, note: l.type }));
  const layerOf = (id: string) => template.layers.find((l) => l.id === id);
  const propOpts = (l: Layer | undefined, numeric: boolean) => propsOf(l, numeric).map((p) => ({ value: p as string, label: propName(p), group: t('Property') }));
  const replace = (patch: Partial<LogicNode> & { type: LogicNode['type'] }) => setNode(n.id, patch as Partial<LogicNode>);

  switch (n.type) {
    // One node reads a layer: its properties, and for a text its measured size.
    case 'layerProp':
    case 'textSize': {
      const l = layerOf(n.layer);
      const measured = l?.type === 'text';
      const value = n.type === 'textSize' ? `m:${n.metric}` : n.prop;
      const opts = [...propOpts(l, true), ...(measured ? METRICS.map((m) => ({ value: `m:${m.value}`, label: t(m.label), group: t('Measured text') })) : [])];
      return (
        <>
          <Dropdown
            value={n.layer}
            options={layerOpts}
            onChange={(id) => {
              const nl = layerOf(id);
              // A measurement needs a text: back to a property otherwise.
              if (n.type === 'textSize' && nl?.type !== 'text') replace({ type: 'layerProp', layer: id, prop: 'width' } as never);
              else setNode(n.id, { layer: id } as Partial<LogicNode>);
            }}
          />
          <Dropdown
            value={value}
            options={opts}
            onChange={(v) => (v.startsWith('m:') ? replace({ type: 'textSize', metric: v.slice(2) as TextMetric } as never) : replace({ type: 'layerProp', prop: v as Prop } as never))}
          />
        </>
      );
    }
    case 'field':
      return (
        <Dropdown
          value={n.key}
          placeholder={t('Choose a field')}
          options={[...(template.fields.some((f) => f.key === n.key) || !n.key ? [] : [{ value: n.key, label: n.key }]), ...template.fields.map((f) => ({ value: f.key, label: f.label, note: t(f.kind) }))]}
          onChange={(key) => setNode(n.id, { key })}
        />
      );
    case 'constant':
      return <NumberField value={n.value} onChange={(v) => setNode(n.id, { value: v }, `logic-v-${n.id}`)} />;
    case 'math':
      return <Dropdown value={n.op} options={MATH.map((o) => ({ ...o, label: t(o.label) }))} onChange={(op) => setNode(n.id, { op })} />;
    case 'clamp':
      return (
        <div className="ln-pair">
          <label>
            <span>{t('Min')}</span>
            <NumberField value={n.min} onChange={(v) => setNode(n.id, { min: v }, `logic-v-${n.id}`)} />
          </label>
          <label>
            <span>{t('Max')}</span>
            <NumberField value={n.max} onChange={(v) => setNode(n.id, { max: v }, `logic-v-${n.id}`)} />
          </label>
        </div>
      );
    case 'condition':
      return <Dropdown value={n.cmp} options={CMP.map((o) => ({ ...o, label: t(o.label) }))} onChange={(cmp) => setNode(n.id, { cmp })} />;
    case 'target': {
      const l = layerOf(n.layer);
      return (
        <>
          <Dropdown value={n.layer} options={layerOpts} onChange={(id) => setNode(n.id, { layer: id } as Partial<LogicNode>)} />
          <Dropdown value={n.prop} options={propOpts(l, false)} onChange={(p) => setNode(n.id, { prop: p as Prop } as Partial<LogicNode>)} />
          <Dropdown
            value={n.mode}
            options={[
              { value: 'set', label: t('Set to') },
              { value: 'add', label: t('Add to the animation') },
              { value: 'multiply', label: t('Multiply the animation') },
            ]}
            onChange={(mode) => setNode(n.id, { mode: mode as 'set' })}
          />
        </>
      );
    }
  }
}

export const inputLabel = (n: LogicNode, port: string) => t((n.type === 'condition' ? { a: 'A', b: 'B', then: 'then', else: 'else' }[port] : n.type === 'math' ? port.toUpperCase() : port === 'in' ? (n.type === 'target' ? 'value' : 'in') : port) ?? port);

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
    const at = freeSpot(document.querySelector('.logic-editor:not(.data-canvas) .logic-canvas'), { x, y });
    const n = makeNode(type, template, at.x, at.y);
    edit((l) => void l.nodes.push(n));
    setSelected(n.id);
  };

  const dragNode = (e: React.PointerEvent, n: LogicNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('select, input, button, label, .port, .cv-resize')) return;
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
      <CanvasHeader icon={<Link2 size={15} />} title={t('Logic')} subject={template.name} onClose={onClose} />
      <div className="logic-body">
        <aside className="logic-palette">
          {CATS.map((c) => (
            <div key={c.id} className="lp-group">
              <div className="dc-pal-title">{t(c.label)}</div>
              {KINDS.filter((k) => k.cat === c.id).map((k) => (
                <button key={k.type} onClick={() => add(k.type)} className={`cat-${k.cat}`}>
                  <k.icon size={14} />
                  <strong>{t(k.label)}</strong>
                </button>
              ))}
            </div>
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
                    <title>{t('Click to remove')}</title>
                  </path>
                );
              })}
              {wire && nodes.get(wire.from) && <path d={curve(portOut(nodes.get(wire.from)!, widthOf(nodes.get(wire.from)!)), wire)} className="wire live" />}
            </svg>
            {logic.nodes.map((n) => {
              const k = kindOf(n);
              return (
                <div key={n.id} className={`logic-node kind-${n.type} cat-${k.cat} ${selected === n.id ? 'sel' : ''}`} style={{ left: n.x, top: n.y, width: widthOf(n) }} onPointerDown={(e) => (e.stopPropagation(), dragNode(e, n))}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <k.icon size={12} />
                    <span>{t(k.label)}</span>
                    <span className="ln-value">{fmt(values.get(n.id))}</span>
                    <button
                      className="ln-del"
                      title={t('Delete (Del)')}
                      onClick={() =>
                        edit((l) => {
                          l.nodes = l.nodes.filter((x) => x.id !== n.id);
                          l.edges = l.edges.filter((x) => x.from !== n.id && x.to !== n.id);
                        })
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                    {n.type !== 'target' && <span className="port out" title={t('Drag to an input')} onPointerDown={(e) => startWire(e, n.id)} />}
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
                <p>{t('No relation yet.')}</p>
              </div>
            )}
          </div>
          {cv.controls}
        </div>
      </div>
    </div>
  );
}

import { Database, ListTree, Trash2, Type, Variable, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { create } from 'zustand';
import { PickDialog } from '../data/BindingEditor';
import { useBoundData, useSources } from '../data/dataStore';
import type { Field, FieldKind, Layer, Prop, Template } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { navigate } from '../router';
import { findLayer, LABELS, useDesigner } from './designerStore';
import { fieldKey, PROP_LABELS } from './Inspector';
import { ICONS } from './LayersPanel';
import { WidgetRunButtons } from './WidgetRun';

/*
 * Data canvas: data sources → variables → layers, wired with the mouse.
 * Wires are the template's own data: a field's binding (source → variable),
 * a {{key}} in a text and a property binding (variable → layer). Node
 * positions are a per-browser layout.
 */

export const useDataCanvas = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** Properties that can follow a variable. */
const BINDABLE: Prop[] = ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth', 'cornerRadius', 'fontSize', 'letterSpacing', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom'];

const W = { source: 230, field: 250, layer: 250 };
const HEAD = 34;
const ROW = 26;
const COLS = { source: 40, field: 360, layer: 720 };

interface Layout {
  pos: Record<string, { x: number; y: number }>;
  sources: string[];
  layers: string[];
  props: Record<string, Prop[]>;
}

function loadLayout(id: string): Layout {
  try {
    return { pos: {}, sources: [], layers: [], props: {}, ...JSON.parse(localStorage.getItem(`pulse.dataCanvas.${id}`) ?? '{}') };
  } catch {
    return { pos: {}, sources: [], layers: [], props: {} };
  }
}

const tokenOf = (key: string) => `{{${key}}}`;
const usesKey = (l: Layer, key: string) => l.type === 'text' && l.text.includes(tokenOf(key));
const hasTokens = (l: Layer) => l.type === 'text' && /\{\{\w+\}\}/.test(l.text);

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

type Wire = { kind: 'source'; id: string } | { kind: 'field'; key: string };

export function DataCanvas() {
  const { open, set: setOpen } = useDataCanvas();
  const template = useDesigner((s) => s.template);
  if (!open || !template) return null;
  return <Canvas key={template.id} template={template} onClose={() => setOpen(false)} />;
}

function Canvas({ template, onClose }: { template: Template; onClose: () => void }) {
  const { update, previewData } = useDesigner();
  const sources = useSources();
  const bound = useBoundData(template, previewData);
  const values = { ...previewData, ...bound };
  const canvasRef = useRef<HTMLDivElement>(null);
  const [layout, setLayoutState] = useState<Layout>(() => loadLayout(template.id));
  const [drag, setDrag] = useState<{ wire: Wire; x: number; y: number } | null>(null);
  const [picking, setPicking] = useState<Field | null>(null);
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

  // What the canvas shows.
  const sourceIds = [...new Set([...template.fields.map((f) => f.binding?.source).filter((s): s is string => !!s), ...layout.sources])];
  const layers = template.layers.filter((l) => layout.layers.includes(l.id) || Object.values(l.bindings).some(Boolean) || hasTokens(l) || isTimed(l));
  const ports = (l: Layer): string[] => {
    const props = [...new Set([...(Object.entries(l.bindings) as [Prop, string][]).filter(([, k]) => k).map(([p]) => p), ...(layout.props[l.id] ?? [])])];
    return [...(l.type === 'text' ? ['text'] : []), ...props];
  };

  // Default layout: three columns, nodes stacked by their height.
  const nodePos = new Map<string, { x: number; y: number }>();
  const stack = (col: keyof typeof COLS, items: [string, number][]) => {
    let y = 40;
    for (const [id, h] of items) {
      nodePos.set(id, layout.pos[id] ?? { x: COLS[col], y });
      y += h + 24;
    }
  };
  stack('source', sourceIds.map((s) => [`s:${s}`, HEAD + 60]));
  stack('field', template.fields.map((f) => [`f:${f.key}`, HEAD + (f.binding ? 130 : 96)]));
  stack('layer', layers.map((l) => [`l:${l.id}`, HEAD + ports(l).length * ROW + (isTimed(l) ? 90 : 56)]));

  const sourceOut = (id: string) => {
    const p = nodePos.get(`s:${id}`)!;
    return { x: p.x + W.source, y: p.y + HEAD / 2 };
  };
  const fieldIn = (key: string) => {
    const p = nodePos.get(`f:${key}`)!;
    return { x: p.x, y: p.y + HEAD / 2 };
  };
  const fieldOut = (key: string) => {
    const p = nodePos.get(`f:${key}`)!;
    return { x: p.x + W.field, y: p.y + HEAD / 2 };
  };
  const layerIn = (l: Layer, port: string) => {
    const p = nodePos.get(`l:${l.id}`)!;
    return { x: p.x, y: p.y + HEAD + ports(l).indexOf(port) * ROW + ROW / 2 };
  };

  // The template's wires.
  const wires: { d: string; remove: () => void; title: string }[] = [];
  for (const f of template.fields)
    if (f.binding?.source && nodePos.has(`s:${f.binding.source}`))
      wires.push({ d: curve(sourceOut(f.binding.source), fieldIn(f.key)), title: `${f.label} from the source`, remove: () => update((t) => void delete t.fields.find((x) => x.key === f.key)!.binding) });
  for (const l of layers)
    for (const port of ports(l)) {
      const keys = port === 'text' ? template.fields.filter((f) => usesKey(l, f.key)).map((f) => f.key) : [l.bindings[port as Prop]].filter((k): k is string => !!k && template.fields.some((f) => f.key === k));
      for (const key of keys)
        wires.push({
          d: curve(fieldOut(key), layerIn(l, port)),
          title: `${key} → ${l.name} ${port === 'text' ? 'text' : PROP_LABELS[port as Prop]}`,
          remove: () =>
            update((t) => {
              const x = findLayer(t, l.id)!;
              if (port === 'text' && x.type === 'text') x.text = x.text.split(tokenOf(key)).join('').replace(/ {2,}/g, ' ').trim();
              else delete x.bindings[port as Prop];
            }),
        });
    }

  const point = (clientX: number, clientY: number) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };

  const newField = (t: Template, label: string, kind: FieldKind, def: string): string => {
    const key = fieldKey(label, new Set(t.fields.map((f) => f.key)));
    t.fields.push({ key, label, kind, default: def });
    return key;
  };

  /** Connects a wire dropped on a port (or on empty space). */
  const connect = (w: Wire, target: HTMLElement | null, at: { x: number; y: number }) => {
    const port = target?.closest<HTMLElement>('.port.in');
    if (w.kind === 'source') {
      const key = port?.dataset.field;
      if (key) {
        update((t) => {
          const f = t.fields.find((x) => x.key === key)!;
          f.binding = { source: w.id, path: f.binding?.source === w.id ? f.binding.path : '' };
        });
        return;
      }
      // Dropped on empty space: a new variable fed by this source.
      if (!target?.closest('.dc-node')) {
        let made = '';
        update((t) => {
          made = newField(t, `Field ${t.fields.length + 1}`, 'text', '');
          t.fields.find((x) => x.key === made)!.binding = { source: w.id, path: '' };
        });
        setLayout((l) => ({ ...l, pos: { ...l.pos, [`f:${made}`]: { x: at.x, y: at.y - HEAD / 2 } } }));
      }
      return;
    }
    const layerId = port?.dataset.layer;
    const p = port?.dataset.port;
    if (!layerId || !p) return;
    update((t) => {
      const l = findLayer(t, layerId)!;
      if (p === 'text') {
        if (l.type === 'text' && !usesKey(l, w.key)) l.text = l.text.trim() ? `${l.text} ${tokenOf(w.key)}` : tokenOf(w.key);
      } else l.bindings[p as Prop] = w.key;
    });
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

  const dragNode = (e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('select, input, button, .port, textarea')) return;
    e.preventDefault();
    const start = point(e.clientX, e.clientY);
    const base = nodePos.get(id)!;
    const move = (ev: PointerEvent) => {
      const p = point(ev.clientX, ev.clientY);
      setLayout((l) => ({ ...l, pos: { ...l.pos, [id]: { x: Math.max(0, Math.round(base.x + p.x - start.x)), y: Math.max(0, Math.round(base.y + p.y - start.y)) } } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const editField = (key: string, fn: (f: Field) => void) => update((t) => fn(t.fields.find((f) => f.key === key)!));
  const wireStart = drag && (drag.wire.kind === 'source' ? (nodePos.has(`s:${drag.wire.id}`) ? sourceOut(drag.wire.id) : null) : nodePos.has(`f:${drag.wire.key}`) ? fieldOut(drag.wire.key) : null);
  const hiddenSources = sources.filter((s) => !sourceIds.includes(s.id));
  const hiddenLayers = template.layers.filter((l) => !layers.includes(l));

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
      <div className="logic-body">
        <aside className="logic-palette">
          <button
            className="kind-field"
            onClick={() => {
              let made = '';
              update((t) => void (made = newField(t, `Field ${t.fields.length + 1}`, 'text', '')));
              const el = canvasRef.current;
              setLayout((l) => ({ ...l, pos: { ...l.pos, [`f:${made}`]: { x: COLS.field, y: (el?.scrollTop ?? 0) + 40 } } }));
            }}
          >
            <Variable size={14} />
            <span>
              <strong>Variable</strong>
              <em>The operator types it, or a source feeds it</em>
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
          {hiddenLayers.length > 0 && <div className="dc-pal-title">Layers</div>}
          {hiddenLayers.map((l) => {
            const Icon = ICONS[l.type];
            return (
              <button key={l.id} className="kind-layer" onClick={() => setLayout((x) => ({ ...x, layers: [...x.layers, l.id] }))}>
                <Icon size={14} />
                <span>
                  <strong>{l.name}</strong>
                  <em>{LABELS[l.type]}</em>
                </span>
              </button>
            );
          })}
        </aside>
        <div className="logic-canvas" ref={canvasRef}>
          <div className="logic-space">
            <svg className="logic-wires">
              {wires.map((w, i) => (
                <path key={i} d={w.d} className="wire" onPointerDown={(e) => (e.stopPropagation(), w.remove())}>
                  <title>{w.title} (click to remove)</title>
                </path>
              ))}
              {drag && wireStart && <path d={curve(wireStart, drag)} className="wire live" />}
            </svg>

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
                  </div>
                </div>
              );
            })}

            {template.fields.map((f) => {
              const p = nodePos.get(`f:${f.key}`)!;
              const v = values[f.key] ?? '';
              return (
                <div key={f.key} className="logic-node dc-node kind-field" style={{ left: p.x, top: p.y, width: W.field }} onPointerDown={(e) => dragNode(e, `f:${f.key}`)}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <span className="port in" data-field={f.key} title="Drop a source here" />
                    <Variable size={12} />
                    <input className="dc-title" value={f.label} onChange={(e) => editField(f.key, (x) => void (x.label = e.target.value))} title={`Key: ${f.key}`} />
                    <button
                      className="ln-del"
                      title="Delete the variable"
                      onClick={() =>
                        update((t) => {
                          t.fields = t.fields.filter((x) => x.key !== f.key);
                          for (const l of t.layers) for (const [prop, k] of Object.entries(l.bindings)) if (k === f.key) delete l.bindings[prop as Prop];
                        })
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                    <span className="port out" title="Drag to a layer's text or property" onPointerDown={(e) => startWire(e, { kind: 'field', key: f.key })} />
                  </div>
                  <div className="ln-body">
                    <div className="row">
                      <select value={f.kind} onChange={(e) => editField(f.key, (x) => void (x.kind = e.target.value as FieldKind))}>
                        {['text', 'multiline', 'number', 'color', 'image'].map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                      <code className="dc-key">{tokenOf(f.key)}</code>
                    </div>
                    {f.binding ? (
                      <div className="row">
                        <input className="mono" placeholder="path, e.g. items[0].title" value={f.binding.path} onChange={(e) => editField(f.key, (x) => void (x.binding = { ...x.binding!, path: e.target.value }))} />
                        <button className="icon-btn ghost" title="Pick in the source's value" onClick={() => setPicking(f)}>
                          <ListTree size={13} />
                        </button>
                      </div>
                    ) : (
                      <input placeholder="Default value" title="Value until the operator types another one" value={f.default} onChange={(e) => editField(f.key, (x) => void (x.default = e.target.value))} />
                    )}
                    {f.binding && (
                      <span className="dc-value live" title="Value from the source now">
                        {v === '' ? '(no value at this path)' : v.length > 40 ? `${v.slice(0, 40)}…` : v}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {layers.map((l) => {
              const p = nodePos.get(`l:${l.id}`)!;
              const Icon = ICONS[l.type];
              const free = BINDABLE.filter((x) => !ports(l).includes(x));
              return (
                <div key={l.id} className="logic-node dc-node kind-layer" style={{ left: p.x, top: p.y, width: W.layer }} onPointerDown={(e) => dragNode(e, `l:${l.id}`)}>
                  <div className="ln-head" style={{ height: HEAD }}>
                    <Icon size={12} />
                    <span>{l.name}</span>
                    {layout.layers.includes(l.id) && (
                      <button className="ln-del" title="Remove from the canvas" onClick={() => setLayout((x) => ({ ...x, layers: x.layers.filter((y) => y !== l.id) }))}>
                        <X size={11} />
                      </button>
                    )}
                  </div>
                  {ports(l).map((port) => (
                    <div key={port} className="ln-input" style={{ height: ROW }}>
                      <span className="port in" data-layer={l.id} data-port={port} title="Drop a variable here" />
                      {port === 'text' ? (
                        <>
                          <Type size={11} /> Text
                        </>
                      ) : (
                        <span>{PROP_LABELS[port as Prop]}</span>
                      )}
                      {port !== 'text' && !l.bindings[port as Prop] && (
                        <button className="dc-port-del" title="Hide this property" onClick={() => setLayout((x) => ({ ...x, props: { ...x.props, [l.id]: (x.props[l.id] ?? []).filter((y) => y !== port) } }))}>
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="ln-body">
                    <select
                      value=""
                      onChange={(e) => {
                        const prop = e.target.value as Prop;
                        if (prop) setLayout((x) => ({ ...x, props: { ...x.props, [l.id]: [...(x.props[l.id] ?? []), prop] } }));
                      }}
                    >
                      <option value="">+ Property…</option>
                      {free.map((x) => (
                        <option key={x} value={x}>
                          {PROP_LABELS[x]}
                        </option>
                      ))}
                    </select>
                    {isTimed(l) && <WidgetRunButtons layer={l} compact />}
                  </div>
                </div>
              );
            })}

            {!template.fields.length && !sourceIds.length && (
              <div className="logic-empty" style={{ top: 'auto', bottom: 40 }}>
                <p>Add a variable or a data source from the left, then wire it: source → variable → a layer's text or property.</p>
              </div>
            )}
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

export function DataCanvasButton({ className = 'btn small' }: { className?: string }) {
  const open = useDataCanvas((s) => s.set);
  return (
    <button className={className} onClick={() => open(true)} title="Sources, variables and what they set, on a canvas">
      <Database size={13} /> Data
    </button>
  );
}

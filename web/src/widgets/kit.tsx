// The widgets of the spec, one file each (web/src/widgets/<id>.tsx), with
// their Rust twins in crates/cg-core/src/wid/<id>.rs (settings, operator
// state and actions) and crates/cg-render/src/wid/<id>.rs (drawing). This
// file is what they share: the definition of a widget and the controls of
// the inspector and of the Operator, styled like the rest of the app.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Radio, WandSparkles, type LucideIcon } from 'lucide-react';
import { useDesigner } from '../designer/designerStore';
import { interpolateText, parseHex, toHex, type Resolved } from '../engine/evaluate';
import type { Data, Layer, LayerType, PlayoutItem, Prop, Template, Value } from '../engine/types';
import type { TimeCtx } from '../engine/widgets';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { alertDialog, confirmDialog, promptDialog } from '../ui/dialogs';

export type WidgetGroup = 'Shapes & tools' | 'Time' | 'Data' | 'Sport & interaction';
export type LayerOf<T extends LayerType> = Extract<Layer, { type: T }>;

export interface Warning {
  level: 'info' | 'warn' | 'error' | 'ok';
  text: string;
  /** Also shown to the Operator (true), or only there ('only'). */
  op?: boolean | 'only';
}

export interface RenderProps<T extends LayerType = LayerType> {
  layer: LayerOf<T>;
  /** Animated properties at this frame (fill, stroke, strokeWidth, cornerRadius, fontSize…: use num()/col()). */
  r: Resolved;
  w: number;
  h: number;
  data: Data;
  time: TimeCtx;
  /** The operator's state of this widget (undefined = default). */
  state: unknown;
  /** Template frame and its On air frame (the In runs from 0 to hold). */
  frame: number;
  hold: number;
  fps: number;
  /** Drawn in the Designer (guides such as a reserved width may show). */
  designer?: boolean;
}

export interface InspectorProps<T extends LayerType = LayerType> {
  layer: LayerOf<T>;
  template: Template;
  /** Values the Designer previews with (bound fields included). */
  data: Data;
  /** Changes the layer (coalesce: one undo step while typing/dragging). */
  edit: (fn: (l: LayerOf<T>) => void, coalesceKey?: string) => void;
  /** Sets a dot path of the layer (`stroke.width`, `items.2.text`). */
  set: (path: string, v: unknown, coalesce?: boolean) => void;
  /** Try-out state of the Designer and its actions (same logic as on air). */
  state: unknown;
  act: (op: string, args?: unknown) => void;
}

export interface OperatorProps<T extends LayerType = LayerType> {
  layer: LayerOf<T>;
  /** The operator's state of this widget (undefined = default). */
  state: unknown;
  data: Data;
  /** Sends an action (Command `act`) to the graphic on air (or to the Designer's try-out). */
  act: (op: string, args?: unknown) => void;
  /** The graphic on air (undefined in the Designer). */
  item?: PlayoutItem;
  time: TimeCtx;
}

export interface OverlayProps<T extends LayerType = LayerType> {
  layer: LayerOf<T>;
  /** Layer size and screen pixels per layer pixel. */
  w: number;
  h: number;
  scale: number;
  edit: (fn: (l: LayerOf<T>) => void, coalesceKey?: string) => void;
}

export interface WidgetDef<T extends LayerType = LayerType> {
  /** Module name (quad, timer…) and the layer type it draws. */
  id: string;
  type: T;
  label: string;
  group: WidgetGroup;
  icon: LucideIcon;
  /** Entries of the + menu (default: one, the widget itself). */
  presets?: { label: string; hint?: string; patch?: Record<string, unknown> }[];
  /** Settings and properties of a new layer (x / y are centred by the caller from width / height). */
  create: () => Partial<LayerOf<T>> & { props?: Partial<Record<Prop, Value>> };
  /** Its Fill / Stroke are in its own groups: Properties > Contents leaves them out. */
  ownsLook?: boolean;
  /** Its look changes with time: the scene re-renders every frame. */
  live?: (l: LayerOf<T>) => boolean;
  /** Layer keys of its content (wired by the Data canvas with {{key}}). */
  content?: string[];
  /** Draws the layer inside its box (absolute position, w × h). */
  Render?: (p: RenderProps<T>) => ReactNode;
  /** Groups of the inspector, above Properties (replaces General). */
  Inspector?: (p: InspectorProps<T>) => ReactNode;
  /** Controls in the Operator (graphic on air) and in the Designer's try-out. */
  Operator?: (p: OperatorProps<T>) => ReactNode;
  /** Orange handles over the selected layer in the Designer. */
  Overlay?: (p: OverlayProps<T>) => ReactNode;
  warnings?: (l: LayerOf<T>, ctx: { data: Data; state: unknown; r?: Resolved }) => Warning[];
}

export const defineWidget = <T extends LayerType>(d: WidgetDef<T>) => d;

// ------------------------------------------------------------------ paths --

export function getPath(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), o);
}

export function setPath(o: unknown, path: string, v: unknown) {
  const ks = path.split('.');
  let a = o as Record<string, unknown>;
  for (let i = 0; i < ks.length - 1; i++) {
    if (a[ks[i]] == null) a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    a = a[ks[i]] as Record<string, unknown>;
  }
  if (v === undefined) delete a[ks[ks.length - 1]];
  else a[ks[ks.length - 1]] = v;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
/** `#rrggbb[aa]` → CSS colour. */
export const hex = (s: string | undefined, fallback = 'transparent') => {
  const c = s ? parseHex(s) : undefined;
  return c ? `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})` : fallback;
};

// ------------------------------------------------------------- inspector --

/** The object the path-based controls read and write (the layer, or a list item). */
interface Bind {
  obj: unknown;
  set: (path: string, v: unknown, coalesce?: boolean) => void;
  data: Data;
}
const BindContext = createContext<Bind>({ obj: {}, set: () => {}, data: {} });

/** The object the path-based controls edit, its setter and the preview data. */
export const useBound = () => useContext(BindContext);

/** Path-based controls inside read / write `obj` (usually the layer). */
export function Bound({ obj, set, data, children }: { obj: unknown; set: Bind['set']; data?: Data; children: ReactNode }) {
  const parent = useContext(BindContext);
  return <BindContext.Provider value={{ obj, set, data: data ?? parent.data }}>{children}</BindContext.Provider>;
}

function useBind<V>(path: string | undefined, value: V | undefined, onChange: ((v: V) => void) | undefined): [V, (v: V, coalesce?: boolean) => void] {
  const b = useContext(BindContext);
  if (path) {
    // `value` is the default shown while the path is not set.
    const got = getPath(b.obj, path);
    return [(got === undefined ? value : got) as V, (v, coalesce) => b.set(path, v, coalesce)];
  }
  return [value as V, (v) => onChange?.(v)];
}

/** Collapsible group of the inspector (open state kept per browser), like General / Properties. */
export function Section({ id, title, children, actions, level = 1, closed }: { id: string; title: string; children: ReactNode; actions?: ReactNode; level?: 1 | 2; closed?: boolean }) {
  const key = `pulse.insp.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? !closed : v !== '0';
    } catch {
      return !closed;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* private mode */
    }
  };
  return (
    <section className={`pp-group l${level} ${open ? 'open' : ''}`}>
      <header>
        <button className="pp-twirl" onClick={toggle} aria-expanded={open}>
          <ChevronDown size={level === 1 ? 14 : 12} />
          <span>{title}</span>
        </button>
        {actions}
      </header>
      {open && <div className="pp-body wk-body">{children}</div>}
    </section>
  );
}

/** A labelled row of the inspector. */
export function Row({ label, children, title, lead, tail }: { label?: ReactNode; children: ReactNode; title?: string; lead?: ReactNode; tail?: ReactNode }) {
  return (
    <div className={`row wk-row ${label === undefined ? 'full' : ''}`} title={title}>
      {lead ?? <span className="wk-gut" />}
      {label !== undefined && <span className="prop-label">{label}</span>}
      <div className="wk-ctl">{children}</div>
      {tail ?? <span className="wk-gut" />}
    </div>
  );
}

type Opt<V> = readonly [V, ReactNode, string?] | V;
const opts = <V,>(o: readonly Opt<V>[]) => o.map((x) => (Array.isArray(x) ? (x as readonly [V, ReactNode, string?]) : ([x as V, String(x)] as const)));

/** Segmented choice (like Lines / Scroll of the text). */
export function Seg<V extends string | number | boolean>(p: { label?: ReactNode; path?: string; value?: V; onChange?: (v: V) => void; options: readonly Opt<V>[]; title?: string }) {
  const [v, set] = useBind<V>(p.path, p.value, p.onChange);
  const o = opts(p.options);
  return (
    <Row label={p.label} title={p.title}>
      <Segmented value={String(v)} onChange={(s) => set(o.find((x) => String(x[0]) === s)![0])} options={o.map(([val, lab, tip]) => ({ value: String(val), label: lab, title: tip }))} />
    </Row>
  );
}

export function Select<V extends string | number>(p: { label?: ReactNode; path?: string; value?: V; onChange?: (v: V) => void; options: readonly Opt<V>[] }) {
  const [v, set] = useBind<V>(p.path, p.value, p.onChange);
  const o = opts(p.options);
  return (
    <Row label={p.label}>
      <select value={String(v ?? '')} onChange={(e) => set(o.find((x) => String(x[0]) === e.target.value)![0])}>
        {o.map(([val, lab]) => (
          <option key={String(val)} value={String(val)}>
            {typeof lab === 'string' ? lab : String(val)}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** On / off switch with its text. `disabled`: the reason it cannot change. */
export function Toggle(p: { label?: ReactNode; path?: string; value?: boolean; onChange?: (v: boolean) => void; text?: ReactNode; disabled?: string }) {
  const [v, set] = useBind<boolean>(p.path, p.value, p.onChange);
  return (
    <Row label={p.label}>
      <button className={`wk-tog ${v ? 'on' : ''}`} disabled={!!p.disabled} title={p.disabled} onClick={() => set(!v)}>
        <i />
        {p.text && <span>{p.text}</span>}
      </button>
    </Row>
  );
}

/** Slider with its value. */
export function Range(p: { label?: ReactNode; path?: string; value?: number; onChange?: (v: number) => void; min: number; max: number; step?: number; unit?: string; fmt?: (v: number) => string }) {
  const [v, set] = useBind<number>(p.path, p.value, p.onChange);
  const step = p.step ?? 1;
  const val = Number(v ?? 0);
  return (
    <Row label={p.label}>
      <input type="range" min={p.min} max={p.max} step={step} value={val} onChange={(e) => set(+e.target.value, true)} />
      <span className="wk-val">{p.fmt ? p.fmt(val) : `${+val.toFixed(step < 1 ? 2 : 0)}${p.unit ?? ''}`}</span>
    </Row>
  );
}

/** Number field (drag the label, wheel, arrows), like the properties. */
export function Num(p: { label?: ReactNode; path?: string; value?: number; onChange?: (v: number) => void; min?: number; max?: number; step?: number; precision?: number; unit?: string }) {
  const [v, set] = useBind<number>(p.path, p.value, p.onChange);
  return (
    <Row label={p.label}>
      <span className="pp-field">
        <NumberField value={Number(v ?? 0)} min={p.min} max={p.max} step={p.step ?? 1} precision={p.precision ?? 0} suffix={p.unit?.trim()} onChange={(x) => set(x, true)} />
      </span>
    </Row>
  );
}

/** `#rrggbb[aa]` colour. */
export function ColorPick(p: { label?: ReactNode; path?: string; value?: string; onChange?: (v: string) => void }) {
  const [v, set] = useBind<string>(p.path, p.value, p.onChange);
  const c = parseHex(v ?? '') ?? [1, 1, 1, 1];
  return (
    <Row label={p.label}>
      <span className="pp-field color">
        <ColorField value={c} onChange={(x) => set(toHex(x, x[3] < 1), true)} />
      </span>
    </Row>
  );
}

/** One-line text. */
export function Text(p: { label?: ReactNode; path?: string; value?: string; onChange?: (v: string) => void; placeholder?: string }) {
  const [v, set] = useBind<string>(p.path, p.value, p.onChange);
  return (
    <Row label={p.label}>
      <TextInput value={String(v ?? '')} placeholder={p.placeholder} onChange={(x) => set(x, true)} />
    </Row>
  );
}

/** Several lines of text. */
export function Area(p: { label?: ReactNode; path?: string; value?: string; onChange?: (v: string) => void; placeholder?: string }) {
  const [v, set] = useBind<string>(p.path, p.value, p.onChange);
  return (
    <Row label={p.label}>
      <TextInput multiline value={String(v ?? '')} placeholder={p.placeholder} onChange={(x) => set(x, true)} />
    </Row>
  );
}

/** {{key}} of the Data canvas in a content value. */
export const wiredKeys = (s: string) => [...String(s ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

/**
 * The content of a widget (its text, value, source…). Wired in the Data
 * canvas ({{key}}), it shows the data's value, greyed and read only: it is
 * changed in the Data canvas.
 */
export function Content(p: { label?: ReactNode; path?: string; value?: string; onChange?: (v: string) => void; multiline?: boolean; placeholder?: string; lorem?: boolean; expose?: boolean }) {
  const [v, set] = useBind<string>(p.path, p.value, p.onChange);
  const { data, obj } = useContext(BindContext);
  const { template, update } = useDesigner();
  const raw = String(v ?? '');
  const layer = obj as { id?: string; name?: string };
  // Exposed to the Operator: the whole content is one variable he types (no data source).
  const single = /^\{\{(\w+)\}\}$/.exec(raw.trim());
  const field = single ? template?.fields.find((f) => f.key === single[1]) : undefined;
  const exposed = !!field && !field.binding?.source;
  if (wiredKeys(raw).length && !exposed) return <DataValue label={p.label} value={interpolateText(raw, data)} multiline={p.multiline} />;
  const value = exposed ? field!.default : raw;
  const change = (x: string) => (exposed ? update((t) => void (t.fields.find((f) => f.key === field!.key)!.default = x), `field-${field!.key}`) : set(x, true));
  const canExpose = p.expose !== false && !!p.path && !!layer.id;
  const toggleExpose = () =>
    update((t) => {
      const l = t.layers.find((x) => x.id === layer.id)!;
      if (exposed) {
        // Back to a plain content: the value typed so far.
        setPath(l, p.path!, field!.default);
        const still = t.layers.some((x) => x.id !== l.id && JSON.stringify(x).includes(`{{${field!.key}}}`));
        if (!still) t.fields = t.fields.filter((f) => f.key !== field!.key);
        return;
      }
      const taken = new Set(t.fields.map((f) => f.key));
      let key =
        String(l.name || 'text')
          .normalize('NFD')
          .replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))
          .replace(/^./, (ch) => ch.toLowerCase()) || 'text';
      if (!/^[a-z]/i.test(key)) key = `t${key}`;
      for (let i = 2; taken.has(key); i++) key = key.replace(/\d*$/, String(i));
      t.fields.push({ key, label: l.name || key, kind: p.multiline ? 'multiline' : 'text', default: raw });
      setPath(l, p.path!, `{{${key}}}`);
    });
  const inline = p.label === undefined;
  return (
    <Row
      label={p.label}
      tail={
        canExpose && !inline ? (
          <button className={`pp-op ${exposed ? 'on' : ''}`} title={exposed ? 'Exposed to the Operator · click to stop' : 'Expose to the Operator'} onClick={toggleExpose}>
            <Radio size={13} />
          </button>
        ) : undefined
      }
    >
      <div className="wk-content">
        <TextInput multiline={p.multiline} value={value} placeholder={p.placeholder} onChange={change} />
        {(p.lorem || (canExpose && inline) || exposed) && (
          <div className="wk-content-tools">
            {p.lorem && (
              <button className="wk-chip" title="Fill with a fake text" onClick={() => change(nextLorem(value))}>
                <WandSparkles size={12} /> Lorem
              </button>
            )}
            {canExpose && inline ? (
              <button className={`wk-chip op ${exposed ? 'on' : ''}`} title={exposed ? `Exposed to the Operator as “${field!.label}” · click to stop` : 'Expose to the Operator'} onClick={toggleExpose}>
                <Radio size={12} /> {exposed ? 'Exposed to the Operator' : 'Expose to the Operator'}
              </button>
            ) : (
              exposed && (
                <span className="wk-exposed">
                  <Radio size={12} /> Exposed to the Operator
                </span>
              )
            )}
          </div>
        )}
      </div>
    </Row>
  );
}

const LOREMS = ['Marie Curie, physicist and chemist', 'Breaking: the city council votes the new budget tonight', 'Live from the Stade de France: the final kicks off in ten minutes', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt'];
const nextLorem = (cur: string) => LOREMS[(LOREMS.indexOf(cur) + 1) % LOREMS.length];

/** A value coming from data: greyed, read only. */
export function DataValue({ label, value, multiline }: { label?: ReactNode; value: string; multiline?: boolean }) {
  return (
    <Row label={label} title="Comes from data: change it in the Data canvas">
      <div className="wired-value">
        {multiline ? <textarea className="wk-data" rows={3} readOnly value={value} /> : <input className="wk-data" readOnly value={value} />}
        <span className="wired-from">From data</span>
      </div>
    </Row>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="hint wk-note">{children}</p>;
}

export function Msg({ level = 'info', children }: { level?: Warning['level']; children: ReactNode }) {
  return <div className={`wk-msg ${level}`}>{children}</div>;
}

export function Warnings({ list }: { list: Warning[] }) {
  if (!list.length) return null;
  return (
    <div className="wk-warnings">
      {list.map((w, i) => (
        <Msg key={i} level={w.level}>
          {w.text}
        </Msg>
      ))}
    </div>
  );
}

export interface BtnSpec {
  label: ReactNode;
  onClick: () => void;
  /** red | green | violet | amber | ghost, plus big | huge. */
  cls?: string;
  title?: string;
  disabled?: boolean;
  /** Keyboard hint shown in the button. */
  keyHint?: string;
  /** Asks before doing it. */
  confirm?: string;
}

/** Buttons of the Operator (and of the inspector). */
export function Btns({ list, label }: { list: (BtnSpec | false | null | undefined)[]; label?: ReactNode }) {
  const row = (
    <div className="wk-btns">
      {list
        .filter((b): b is BtnSpec => !!b)
        .map((b, i) => (
          <button
            key={i}
            className={`opx-btn wk-btn ${b.cls ?? ''}`}
            title={b.title}
            disabled={b.disabled}
            onClick={async () => {
              if (b.confirm) {
                if (!(await confirmDialog({ title: b.confirm, confirm: 'Yes' }))) return;
              }
              b.onClick();
            }}
          >
            {b.label}
            {b.keyHint && <kbd>{b.keyHint}</kbd>}
          </button>
        ))}
    </div>
  );
  return label === undefined ? row : <Row label={label}>{row}</Row>;
}

export interface ListField {
  key: string;
  placeholder?: string;
  /** Width in px (else flexible). */
  w?: number;
  num?: boolean;
  color?: boolean;
  options?: readonly Opt<string>[];
}

/** Editable list of objects (reorder, remove, add, on / off). */
export function ListEditor(p: { label?: ReactNode; path?: string; value?: Record<string, unknown>[]; onChange?: (v: Record<string, unknown>[]) => void; fields: ListField[]; add?: () => Record<string, unknown>; addLabel?: string; toggle?: string; min?: number; minMsg?: string }) {
  const [v, set] = useBind<Record<string, unknown>[]>(p.path, p.value, p.onChange);
  const items = v ?? [];
  const put = (next: Record<string, unknown>[], coalesce?: boolean) => set(next, coalesce);
  const box = (
    <div className="wk-list">
      {items.map((it, i) => (
        <div key={i} className={`wk-item ${p.toggle && it[p.toggle] === false ? 'off' : ''}`}>
          {p.toggle && <input type="checkbox" checked={it[p.toggle] !== false} title="On / off" onChange={(e) => put(items.map((x, j) => (j === i ? { ...x, [p.toggle!]: e.target.checked } : x)))} />}
          {p.fields.map((f) => {
            const val = it[f.key];
            const change = (nv: unknown, coalesce?: boolean) =>
              put(
                items.map((x, j) => (j === i ? { ...x, [f.key]: nv } : x)),
                coalesce,
              );
            const style = f.w ? { flex: `0 0 ${f.w}px`, width: f.w } : undefined;
            if (f.options)
              return (
                <select key={f.key} style={style} value={String(val ?? '')} onChange={(e) => change(e.target.value)}>
                  {opts(f.options).map(([o, l]) => (
                    <option key={o} value={o}>
                      {typeof l === 'string' ? l : o}
                    </option>
                  ))}
                </select>
              );
            if (f.color) return <input key={f.key} type="color" style={style} value={String(val ?? '#ffffff').slice(0, 7)} onChange={(e) => change(e.target.value, true)} />;
            return <input key={f.key} style={style} placeholder={f.placeholder ?? f.key} value={String(val ?? '')} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => change(f.num ? +e.target.value : e.target.value, true)} />;
          })}
          <button className="wk-x" title="Up" disabled={!i} onClick={() => put(items.map((x, j) => (j === i - 1 ? items[i] : j === i ? items[i - 1] : x)))}>
            ↑
          </button>
          <button
            className="wk-x"
            title="Remove"
            onClick={async () => {
              if (p.min && items.length <= p.min) {
                return alertDialog({ title: p.minMsg ?? `At least ${p.min}` });
              }
              put(items.filter((_, j) => j !== i));
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {p.add && (
        <button className="opx-btn small wk-add" onClick={() => put([...items, p.add!()])}>
          + {p.addLabel ?? 'Add'}
        </button>
      )}
    </div>
  );
  return p.label === undefined ? box : <Row label={p.label}>{box}</Row>;
}

/** Grid of strings (first row = header when `header`), with CSV paste. */
export function GridEditor(p: { path?: string; value?: string[][]; onChange?: (v: string[][]) => void; header?: boolean; csv?: boolean }) {
  const [v, set] = useBind<string[][]>(p.path, p.value, p.onChange);
  const rows = v?.length ? v : [['']];
  const put = (next: string[][], coalesce?: boolean) => set(next, coalesce);
  const cell = (i: number, j: number, s: string) =>
    put(
      rows.map((r, a) => (a === i ? r.map((c, b) => (b === j ? s : c)) : r)),
      true,
    );
  return (
    <div className="wk-grid">
      <div className="wk-grid-scroll">
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 && p.header ? 'head' : ''}>
                {r.map((c, j) => (
                  <td key={j}>
                    <input value={c} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => cell(i, j, e.target.value)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wk-btns">
        <button className="opx-btn small" onClick={() => put([...rows, rows[0].map(() => '')])}>
          + Row
        </button>
        <button className="opx-btn small" onClick={() => rows.length > (p.header ? 2 : 1) && put(rows.slice(0, -1))}>
          − Row
        </button>
        <button className="opx-btn small" onClick={() => put(rows.map((r, i) => [...r, i === 0 && p.header ? `Col ${r.length + 1}` : '']))}>
          + Column
        </button>
        <button className="opx-btn small" onClick={() => rows[0].length > 1 && put(rows.map((r) => r.slice(0, -1)))}>
          − Column
        </button>
        {p.csv && (
          <button
            className="opx-btn small"
            onClick={async () => {
              const csv = await promptDialog({ title: 'Paste CSV', message: 'Comma, semicolon or tab separated; one row per line.', value: rows.map((r) => r.join(';')).join('\n') });
              if (csv) put(parseCsv(csv));
            }}
          >
            Import CSV…
          </button>
        )}
      </div>
    </div>
  );
}

/** Rows of a CSV text (`,` `;` or tab; quotes allowed). */
export function parseCsv(text: string): string[][] {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim());
  const sep = [';', '\t', ','].find((s) => lines[0]?.includes(s)) ?? ',';
  return lines.map((l) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"' && l[i + 1] === '"') ((cur += '"'), i++);
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) (out.push(cur), (cur = ''));
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  });
}

// ------------------------------------------------------------- operator --

/** Re-renders the component every animation frame (live readouts). */
export function useFrame(active = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

/** Keyboard shortcuts of an Operator panel while it is shown (not in fields). */
export function useKeys(map: Record<string, () => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const fn = ref.current[e.key] ?? ref.current[e.code];
      if (fn) (e.preventDefault(), fn());
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
}

/** Big monospace readout (current time, score…). */
export function Readout({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="wk-readout">
      <b>{children}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

// -------------------------------------------------------------- overlay --

/** An orange handle on the stage at layer coordinates (x, y); drag gives layer coordinates. */
export function Handle({ x, y, scale, label, onDrag, onDone }: { x: number; y: number; scale: number; label?: string; onDrag: (x: number, y: number, e: PointerEvent) => void; onDone?: () => void }) {
  return (
    <div
      className="wk-handle"
      title={label}
      style={{ left: x * scale, top: y * scale }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const move = (ev: PointerEvent) => onDrag((ev.clientX - host.left) / scale, (ev.clientY - host.top) / scale, ev);
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          onDone?.();
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      }}
    />
  );
}

/** A layer-sized surface of the overlay catching clicks (adding points…), in layer coordinates. */
export function Catcher({ scale, cursor = 'crosshair', onDown }: { scale: number; cursor?: string; onDown: (x: number, y: number, e: React.PointerEvent) => void }) {
  return (
    <div
      className="wk-catch"
      style={{ cursor }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onDown((e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e);
      }}
    />
  );
}

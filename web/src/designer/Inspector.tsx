import { RotateCcw, AlignCenter, AlignLeft, AlignRight, ChevronDown, ChevronLeft, ChevronRight, Diamond, Braces, Link as LinkIcon, Link2, LayoutTemplate, Settings2, Unlink, Upload } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { applyEasing, col, holdFrame, interpolateText, num, parseHex, propValue, resolveLayer, toHex } from '../engine/evaluate';
import { applyLogic, measureLayer } from '../engine/logic';
import { useBoundData } from '../data/dataStore';
import { MAIN_FORMAT, TEXT_LIKE, type Easing, type FontStyle, type Layer, type LayerType, type Prop, type Template, type Value } from '../engine/types';
import { api, mediaUrl, uploadAsset, useApp, type MediaFile } from '../store';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { ZonesDialog } from './ZonesDialog';
import { loadFonts, nearestWeight, useFonts } from '../engine/fonts';
import { isOverridden, resetOverride } from '../engine/formats';
import { findLayer, isAnimated, LABELS, setProp, toggleKeyAt, useDesigner } from './designerStore';
import { isTimed } from '../engine/widgets';
import { WidgetRunButtons } from './WidgetRun';
import { AreaInspector, useGuidesView } from './Guides';
import { TemplatePublish } from './Collab';
import { ICONS } from './LayersPanel';

interface PropSpec {
  prop: Prop;
  label: string;
  display?: number;
  suffix?: string;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
}

const TRANSFORM: PropSpec[] = [
  { prop: 'x', label: 'X' },
  { prop: 'y', label: 'Y' },
  { prop: 'width', label: 'W', min: 0 },
  { prop: 'height', label: 'H', min: 0 },
  { prop: 'anchorX', label: 'Anchor X', display: 100, suffix: '%' },
  { prop: 'anchorY', label: 'Anchor Y', display: 100, suffix: '%' },
  { prop: 'rotation', label: 'Rotation', suffix: '°', precision: 1 },
  { prop: 'scaleX', label: 'Scale X', display: 100, suffix: '%' },
  { prop: 'scaleY', label: 'Scale Y', display: 100, suffix: '%' },
  {
    prop: 'opacity',
    label: 'Opacity',
    display: 100,
    suffix: '%',
    min: 0,
    max: 1,
  },
];
const STYLE: PropSpec[] = [
  { prop: 'strokeWidth', label: 'Stroke W', min: 0, precision: 1 },
  { prop: 'cornerRadius', label: 'Radius', min: 0 },
];
const TEXT: PropSpec[] = [
  { prop: 'fontSize', label: 'Size', min: 1 },
  { prop: 'letterSpacing', label: 'Tracking', precision: 1 },
];
const CROP: PropSpec[] = [
  {
    prop: 'cropLeft',
    label: 'Left',
    display: 100,
    suffix: '%',
    min: 0,
    max: 1,
  },
  {
    prop: 'cropRight',
    label: 'Right',
    display: 100,
    suffix: '%',
    min: 0,
    max: 1,
  },
  { prop: 'cropTop', label: 'Top', display: 100, suffix: '%', min: 0, max: 1 },
  {
    prop: 'cropBottom',
    label: 'Bottom',
    display: 100,
    suffix: '%',
    min: 0,
    max: 1,
  },
];

export const PROP_LABELS: Record<Prop, string> = Object.fromEntries([...TRANSFORM, ...STYLE, ...TEXT, ...CROP.map((c) => ({ ...c, label: `Crop ${c.label}` })), { prop: 'fill', label: 'Fill' }, { prop: 'stroke', label: 'Stroke' }].map((s) => [s.prop, s.label])) as Record<Prop, string>;

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="insp-section">
      <header>
        <span>{title}</span>
        {actions}
      </header>
      <div className="insp-body">{children}</div>
    </section>
  );
}

/** Collapsible group of the properties panel (state kept per browser). */
function Group({ id, title, level = 1, children, actions }: { id: string; title: string; level?: 1 | 2; children: React.ReactNode; actions?: React.ReactNode }) {
  const key = `pulse.insp.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== '0';
    } catch {
      return true;
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
      {open && <div className="pp-body">{children}</div>}
    </section>
  );
}

interface RowSpec {
  label: string;
  props: Prop[];
  /** Field labels (X / Y, W / H…). */
  fields?: string[];
  display?: number;
  suffix?: string;
  precision?: number;
  min?: number;
  max?: number;
  /** Scale X / Y keep their ratio when locked. */
  lock?: boolean;
}

const TRANSFORM_ROWS: RowSpec[] = [
  { label: 'Position', props: ['x', 'y'], fields: ['X', 'Y'], suffix: 'px' },
  {
    label: 'Scale',
    props: ['scaleX', 'scaleY'],
    fields: ['X', 'Y'],
    display: 100,
    suffix: '%',
    lock: true,
  },
  {
    label: 'Dimensions',
    props: ['width', 'height'],
    fields: ['W', 'H'],
    suffix: 'px',
    min: 0,
  },
  {
    label: 'Anchor',
    props: ['anchorX', 'anchorY'],
    fields: ['X', 'Y'],
    display: 100,
    suffix: '%',
  },
  { label: 'Rotation', props: ['rotation'], suffix: '°', precision: 1 },
  {
    label: 'Opacity',
    props: ['opacity'],
    display: 100,
    suffix: '%',
    min: 0,
    max: 1,
  },
];

/** ◀ ◆ ▶ of a row: previous key, key at the playhead (all its properties), next key. */
function RowKeys({ layer, props }: { layer: Layer; props: Prop[] }) {
  const { frame, update, setFrame } = useDesigner();
  const frames = [...new Set(props.flatMap((p) => (layer.tracks[p] ?? []).map((k) => k.frame)))].sort((a, b) => a - b);
  const prev = [...frames].reverse().find((f) => f < frame - 0.5);
  const next = frames.find((f) => f > frame + 0.5);
  const here = frames.some((f) => Math.abs(f - frame) < 0.5);
  return (
    <span className="pp-keys">
      <button title="Previous keyframe" disabled={prev === undefined} onClick={() => prev !== undefined && setFrame(prev)}>
        <ChevronLeft size={12} />
      </button>
      <button
        className={here ? 'on' : ''}
        title={here ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}
        onClick={() => {
          update((t) => {
            const l = findLayer(t, layer.id)!;
            for (const p of props) if (here === (l.tracks[p] ?? []).some((k) => Math.abs(k.frame - frame) < 0.5)) toggleKeyAt(l, p, frame);
          });
          if (!here)
            useDesigner.setState((st) => ({
              expanded: { ...st.expanded, [layer.id]: true },
            }));
        }}
      >
        <Diamond size={11} fill={here ? 'currentColor' : 'none'} />
      </button>
      <button title="Next keyframe" disabled={next === undefined} onClick={() => next !== undefined && setFrame(next)}>
        <ChevronRight size={12} />
      </button>
    </span>
  );
}

/** Lit when a Logic relation drives one of the row's properties. */
function LogicBadge({ layer, props }: { layer: Layer; props: Prop[] }) {
  const driven = useDesigner((s) => s.template?.logic?.nodes.some((n) => n.type === 'target' && n.layer === layer.id && props.includes(n.prop as Prop)));
  if (!driven) return null;
  return (
    <span className="logic-badge" title="Driven by a Logic relation (Logic button in the toolbar)">
      <Link2 size={11} />
    </span>
  );
}

/** { } next to a field: makes this property a variable (the operator or a data source sets it). */
function ExposeButton({ layer, prop }: { layer: Layer; prop: Prop }) {
  const { update, template } = useDesigner();
  const [open, setOpen] = useState(false);
  if (!template) return null;
  const bound = layer.bindings[prop];
  const field = template.fields.find((f) => f.key === bound);
  const isColor = prop === 'fill' || prop === 'stroke';
  const name = PROP_LABELS[prop] ?? prop;
  const expose = () => {
    update((t) => {
      const l = findLayer(t, layer.id)!;
      const key = fieldKey(`${l.name} ${name}`, new Set(t.fields.map((f) => f.key)));
      // Default: what is seen on air.
      const v = propValue(l, prop, holdFrame(t));
      const def = isColor ? toHex(col(v), col(v)[3] < 1) : String(+num(v).toFixed(3));
      t.fields.push({
        key,
        label: `${l.name} · ${name}`,
        kind: isColor ? 'color' : 'number',
        default: def,
      });
      l.bindings[prop] = key;
    });
    setOpen(false);
  };
  const unbind = () => {
    update((t) => {
      const l = findLayer(t, layer.id)!;
      delete l.bindings[prop];
      // A field made for this binding and used nowhere else goes too.
      const used = t.layers.some((x) => Object.values(x.bindings).includes(bound!)) || t.layers.some((x) => x.type === 'text' && x.text.includes(`{{${bound}}}`));
      if (!used) t.fields = t.fields.filter((f) => f.key !== bound);
    });
    setOpen(false);
  };
  const others = template.fields.filter((f) => f.key !== bound && (isColor ? f.kind === 'color' : f.kind === 'number' || f.kind === 'text'));
  return (
    <span className="bind">
      <button className={`pp-expose ${bound ? 'on' : ''}`} title={bound ? `Set by the variable “${field?.label ?? bound}”` : `Expose ${name} as a variable`} onClick={() => setOpen(!open)}>
        <Braces size={12} />
      </button>
      {open && (
        <div className="popover" onMouseLeave={() => setOpen(false)}>
          {bound ? (
            <>
              <div className="popover-note">
                {name} is set by the variable <strong>{field?.label ?? bound}</strong>.
              </div>
              <button onClick={unbind}>Stop exposing</button>
            </>
          ) : (
            <button className="primary" onClick={expose}>
              + Expose {name} as a variable
            </button>
          )}
          {others.length > 0 && <div className="popover-note">Or use an existing variable:</div>}
          {others.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                update((t) => void (findLayer(t, layer.id)!.bindings[prop] = f.key));
                setOpen(false);
              }}
            >
              {f.label} <code>{f.key}</code>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Values of the selected layer set by data (a bound variable or a relation of the Data canvas), at the playhead. */
const DrivenContext = createContext<Map<string, Value>>(new Map());

function useDrivenValues(layer: Layer): Map<string, Value> {
  const { template, frame, previewData } = useDesigner();
  const bound = useBoundData(template, previewData);
  return useMemo(() => {
    const out = new Map<string, Value>();
    if (!template) return out;
    const targets = template.logic?.nodes.filter((n): n is typeof n & { type: 'target' } => n.type === 'target' && n.layer === layer.id && !!template.logic?.edges.some((e) => e.to === n.id)) ?? [];
    const driven = new Set<Prop>([...(Object.entries(layer.bindings) as [Prop, string][]).filter(([, k]) => k).map(([p]) => p), ...targets.map((t) => t.prop)]);
    if (!driven.size) return out;
    const data = { ...previewData, ...bound };
    const hold = holdFrame(template);
    const resolved = new Map(template.layers.map((l) => [l.id, resolveLayer(l, frame, data, hold)]));
    applyLogic(template.logic, resolved, data, measureLayer(template.layers, data, interpolateText));
    const r = resolved.get(layer.id);
    if (r) for (const p of driven) out.set(p, r[p]);
    return out;
  }, [template, frame, previewData, bound, layer]);
}

/** A value set by data: shown, not edited (change it in the Data canvas or the Operator). */
function DrivenValue({ value, display = 1, suffix, precision = 0, label }: { value: Value; display?: number; suffix?: string; precision?: number; label?: string }) {
  return (
    <span className="pp-driven" title="Set by data (Data canvas): read only">
      {label && <span className="scrub">{label}</span>}
      <span className="pp-driven-v">{+(num(value) * display).toFixed(precision)}</span>
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  );
}

/** A property row: ◀ ◆ ▶, name, animate, its fields (X / Y…). */
function GroupRow({ layer, spec }: { layer: Layer; spec: RowSpec }) {
  const { frame, update, format, updateBase } = useDesigner();
  const driven = useContext(DrivenContext);
  const locked = !!spec.lock && !!layer.scaleLock;
  const overridden = format !== MAIN_FORMAT && spec.props.some((p) => isOverridden(layer, format, p));
  const setValue = (prop: Prop, nv: number) =>
    update((t) => {
      const l = findLayer(t, layer.id)!;
      if (locked && spec.props.length === 2) {
        // Keep the X / Y ratio.
        const [a, b] = spec.props;
        const other = prop === a ? b : a;
        const cur = num(propValue(l, prop, frame));
        const ov = num(propValue(l, other, frame));
        setProp(l, other, cur ? (ov * nv) / cur : nv, frame);
      }
      setProp(l, prop, nv, frame);
    }, `prop-${layer.id}-${spec.label}`);
  return (
    <div className={`pp-row ${spec.props.some((p) => isAnimated(layer, p)) ? 'animated' : ''}`}>
      <RowKeys layer={layer} props={spec.props} />
      <span className="pp-label">{spec.label}</span>
      {spec.lock ? (
        <button className={`pp-lock ${locked ? 'on' : ''}`} title={locked ? 'Proportions locked (click to unlock)' : 'Lock the proportions'} onClick={() => update((t) => void (findLayer(t, layer.id)!.scaleLock = !locked || undefined))}>
          {locked ? <LinkIcon size={12} /> : <Unlink size={12} />}
        </button>
      ) : (
        <span className="pp-lock-space" />
      )}
      <LogicBadge layer={layer} props={spec.props} />
      <div className={`pp-fields n${spec.props.length}`}>
        {spec.props.map((p, i) => (
          <span key={p} className="pp-field">
            {driven.has(p) ? (
              <DrivenValue value={driven.get(p)!} label={spec.fields?.[i]} display={spec.display} suffix={spec.suffix} precision={spec.precision ?? (spec.display ? 0 : 1)} />
            ) : (
              <NumberField label={spec.fields?.[i]} value={num(propValue(layer, p, frame))} display={spec.display} suffix={spec.suffix} precision={spec.precision} min={spec.min} max={spec.max} onChange={(nv) => setValue(p, nv)} />
            )}
            <ExposeButton layer={layer} prop={p} />
          </span>
        ))}
      </div>
      {overridden && (
        <button className="override-mark" title="Changed in this format — click to use the main layout again" onClick={() => updateBase((t) => spec.props.forEach((p) => resetOverride(findLayer(t, layer.id)!, format, p)))}>
          <RotateCcw size={10} />
        </button>
      )}
    </div>
  );
}

/** Colour row in the same layout. */
function ColorGroupRow({ layer, prop, label }: { layer: Layer; prop: 'fill' | 'stroke'; label: string }) {
  const { frame, update } = useDesigner();
  const driven = useContext(DrivenContext).get(prop);
  return (
    <div className={`pp-row ${isAnimated(layer, prop) ? 'animated' : ''}`}>
      <RowKeys layer={layer} props={[prop]} />
      <span className="pp-label">{label}</span>
      <span className="pp-lock-space" />
      <LogicBadge layer={layer} props={[prop]} />
      <div className="pp-fields n1">
        <span className="pp-field">
          {driven ? (
            <span className="pp-driven" title="Set by data (Data canvas): read only">
              <span className="dc-swatch" style={{ background: toHex(col(driven), true) }} />
              <span className="pp-driven-v">{toHex(col(driven), true)}</span>
            </span>
          ) : (
            <ColorField value={col(propValue(layer, prop, frame))} onChange={(c) => update((t) => setProp(findLayer(t, layer.id)!, prop, c as Value, frame), `prop-${layer.id}-${prop}`)} />
          )}
          <ExposeButton layer={layer} prop={prop} />
        </span>
      </div>
      <OverrideMark layer={layer} prop={prop} />
    </div>
  );
}

/** Field key from a label: "Name plate X" -> "namePlateX". */
export function fieldKey(label: string, taken: Set<string>): string {
  const words = label
    .normalize('NFD')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let key = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || 'field';
  if (/^\d/.test(key)) key = `f${key}`;
  let k = key;
  for (let n = 2; taken.has(k); n++) k = `${key}${n}`;
  return k;
}

/** Dot on a property changed in the current format; click to inherit again. */
function OverrideMark({ layer, prop }: { layer: Layer; prop: Prop }) {
  const { format, updateBase } = useDesigner();
  if (format === MAIN_FORMAT || !isOverridden(layer, format, prop)) return null;
  return (
    <button className="override-mark" title="Changed in this format — click to use the main layout again" onClick={() => updateBase((t) => resetOverride(findLayer(t, layer.id)!, format, prop))}>
      <RotateCcw size={10} />
    </button>
  );
}

export function AssetPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const projectId = useApp((s) => s.projectId);
  const [own, setOwn] = useState<MediaFile[]>([]);
  const [shared, setShared] = useState<MediaFile[]>([]);
  const toast = useApp((s) => s.toast);
  const refresh = () => {
    const images = (l: MediaFile[]) => l.filter((m) => m.kind === 'image');
    if (projectId)
      api<MediaFile[]>('GET', mediaUrl(projectId))
        .then((l) => setOwn(images(l)))
        .catch(() => {});
    api<MediaFile[]>('GET', mediaUrl(null))
      .then((l) => setShared(images(l)))
      .catch(() => {});
  };
  useEffect(refresh, [projectId]);
  const known = [...own, ...shared].some((m) => m.src === value);
  return (
    <div className="asset-picker">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— choose an image —</option>
        {!known && value && <option value={value}>{value}</option>}
        {own.length > 0 && (
          <optgroup label="Project media">
            {own.map((m) => (
              <option key={m.src} value={m.src}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
        {shared.length > 0 && (
          <optgroup label="Shared media">
            {shared.map((m) => (
              <option key={m.src} value={m.src}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <label className="btn small" title="Upload an image to the project media">
        <Upload size={13} />
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const src = await uploadAsset(f, projectId);
              refresh();
              onChange(src);
            } catch (err) {
              toast(`Upload failed: ${(err as Error).message}`, 'error');
            }
          }}
        />
      </label>
    </div>
  );
}

export type Attrs = Record<string, unknown>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="prop-label">{label}</span>
      {children}
    </div>
  );
}

function Num({ value, onChange, min, max, step, precision, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; precision?: number; suffix?: string }) {
  return <NumberField value={value} onChange={onChange} min={min} max={max} step={step ?? 1} precision={precision ?? 0} suffix={suffix} />;
}

const CLOCK_FORMATS = ['HH:mm:ss', 'HH:mm', 'h:mm A', 'mm:ss', 'mm:ss.f', 'H:mm:ss', 'dd/MM/yyyy', 'dd/MM/yy HH:mm', 'yyyy-MM-dd'];
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
  }
})();

function ZoneInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input list="insp-zones" value={value} placeholder="Server zone" onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <datalist id="insp-zones">
        {ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

function HexInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = parseHex(value) ?? [0, 0, 0, 0];
  return <ColorField value={c} onChange={(v) => onChange(toHex(v, v[3] < 1))} />;
}

/** Settings of prefab widgets. */
export function WidgetSettings({ layer, set }: { layer: Layer; set: (key: string, v: unknown, coalesce?: boolean) => void }) {
  const a = layer as unknown as Attrs;
  const text = (key: string, multiline = false, placeholder?: string) => <TextInput multiline={multiline} value={String(a[key] ?? '')} placeholder={placeholder} onChange={(v) => set(key, v, true)} />;
  const check = (key: string, label: string) => (
    <label className="check">
      <input type="checkbox" checked={!!a[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  );
  switch (layer.type) {
    case 'clock':
      return (
        <>
          <Row label="Mode">
            <select value={layer.mode} onChange={(e) => set('mode', e.target.value)}>
              <option value="time">Time of day</option>
              <option value="countdown">Countdown to…</option>
              <option value="timer">Timer (from take)</option>
              <option value="elapsed">Stopwatch (since take)</option>
            </select>
          </Row>
          <Row label="Format">
            <input list="clock-formats" value={layer.format} onChange={(e) => set('format', e.target.value, true)} onKeyDown={(e) => e.stopPropagation()} />
            <datalist id="clock-formats">
              {CLOCK_FORMATS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Row>
          {(layer.mode === 'time' || layer.mode === 'countdown') && (
            <Row label="Time zone">
              <ZoneInput value={layer.timezone} onChange={(v) => set('timezone', v, true)} />
            </Row>
          )}
          {layer.mode === 'countdown' && (
            <>
              <span className="prop-label">Target — “20:00” today or “2026-12-31T23:59:59”</span>
              {text('target', false, '20:00')}
            </>
          )}
          {layer.mode === 'timer' && (
            <>
              <span className="prop-label">Duration — “5:00” or “1:30:00”</span>
              {text('target', false, '5:00')}
            </>
          )}
          <p className="hint">Tokens: yyyy yy MM M dd d HH H hh h mm m ss s f (tenths) A (AM/PM).</p>
        </>
      );
    case 'ticker':
      return (
        <>
          <span className="prop-label">Items (one per line)</span>
          {text('text', true)}
          <Row label="Separator">
            <input value={layer.separator} onChange={(e) => set('separator', e.target.value, true)} onKeyDown={(e) => e.stopPropagation()} />
          </Row>
          <Row label="Speed">
            <Num value={layer.speed} onChange={(v) => set('speed', v, true)} min={1} suffix=" px/s" />
          </Row>
        </>
      );
    case 'roll':
      return (
        <>
          <span className="prop-label">Text (scrolls upwards)</span>
          {text('text', true)}
          <Row label="Speed">
            <Num value={layer.speed} onChange={(v) => set('speed', v, true)} min={1} suffix=" px/s" />
          </Row>
          {check('loop', 'Loop')}
        </>
      );
    case 'analogClock':
      return (
        <>
          <Row label="Time zone">
            <ZoneInput value={layer.timezone} onChange={(v) => set('timezone', v, true)} />
          </Row>
          {check('seconds', 'Second hand')}
          <Row label="Accent">
            <HexInput value={layer.accent} onChange={(v) => set('accent', v, true)} />
          </Row>
          <p className="hint">Face = fill colour, hands and ticks = stroke colour.</p>
        </>
      );
    case 'counter':
      return (
        <>
          <Row label="From">
            <TextInput value={layer.from} onChange={(v) => set('from', v, true)} />
          </Row>
          <span className="prop-label">To</span>
          {text('to')}
          <Row label="Duration">
            <Num value={layer.duration} onChange={(v) => set('duration', v, true)} min={0} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Decimals">
            <Num value={layer.decimals} onChange={(v) => set('decimals', Math.round(v), true)} min={0} max={6} />
          </Row>
          <Row label="Prefix">
            <TextInput value={layer.prefix} onChange={(v) => set('prefix', v, true)} />
          </Row>
          <Row label="Suffix">
            <TextInput value={layer.suffix} onChange={(v) => set('suffix', v, true)} />
          </Row>
          {check('grouping', 'Thousands separator')}
        </>
      );
    case 'progress':
      return (
        <>
          <span className="prop-label">Value</span>
          {text('value')}
          <Row label="Max">
            <TextInput value={layer.max} onChange={(v) => set('max', v, true)} />
          </Row>
          <Row label="Animation">
            <Num value={layer.duration} onChange={(v) => set('duration', v, true)} min={0} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Track">
            <HexInput value={layer.track} onChange={(v) => set('track', v, true)} />
          </Row>
        </>
      );
    case 'rotator':
      return (
        <>
          <span className="prop-label">Lines (shown one after another)</span>
          {text('text', true)}
          <Row label="Each">
            <Num value={layer.interval} onChange={(v) => set('interval', v, true)} min={0.5} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Fade">
            <Num value={layer.fade} onChange={(v) => set('fade', v, true)} min={0} step={0.1} precision={1} suffix=" s" />
          </Row>
        </>
      );
    case 'typewriter':
      return (
        <>
          {text('text', true)}
          <Row label="Speed">
            <Num value={layer.speed} onChange={(v) => set('speed', v, true)} min={1} suffix=" char/s" />
          </Row>
          {check('cursor', 'Blinking cursor')}
        </>
      );
    case 'slideshow':
      return (
        <>
          <span className="prop-label">Images (one asset per line)</span>
          {text('images', true, '/assets/photo1.jpg')}
          <AssetPicker value="" onChange={(v) => v && set('images', `${layer.images.trim() ? layer.images.trim() + '\n' : ''}${v}`)} />
          <Row label="Each">
            <Num value={layer.interval} onChange={(v) => set('interval', v, true)} min={0.5} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Fade">
            <Num value={layer.fade} onChange={(v) => set('fade', v, true)} min={0} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Fit">
            <Segmented
              value={layer.fit}
              onChange={(v) => set('fit', v)}
              options={[
                { value: 'contain', label: 'Contain' },
                { value: 'cover', label: 'Cover' },
                { value: 'stretch', label: 'Stretch' },
              ]}
            />
          </Row>
        </>
      );
    case 'qrCode':
      return (
        <>
          <span className="prop-label">Content (URL, text…)</span>
          {text('data')}
          <Row label="Background">
            <HexInput value={layer.background} onChange={(v) => set('background', v, true)} />
          </Row>
        </>
      );
    case 'barChart':
      return (
        <>
          <span className="prop-label">Rows — “Label: value”, one per line</span>
          {text('text', true)}
          {check('percent', 'Show as % of total')}
          <Row label="Animation">
            <Num value={layer.duration} onChange={(v) => set('duration', v, true)} min={0} step={0.1} precision={1} suffix=" s" />
          </Row>
          <Row label="Track">
            <HexInput value={layer.track} onChange={(v) => set('track', v, true)} />
          </Row>
          <Row label="Labels">
            <HexInput value={layer.textColor} onChange={(v) => set('textColor', v, true)} />
          </Row>
        </>
      );
    default:
      return null;
  }
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** Font picker: the fonts the server really has (bundled, uploaded, system). */
function FontControls({ layer, set }: { layer: Layer & FontStyle; set: (key: string, v: unknown) => void }) {
  const families = useFonts((s) => s.families);
  const toast = useApp((s) => s.toast);
  // The list is loaded at start, which fails before logging in.
  useEffect(() => {
    if (!families.length) void loadFonts();
  }, [families.length]);
  const current = families.find((f) => f.family.toLowerCase() === layer.fontFamily.toLowerCase());
  const weights = current?.weights ?? [400, 700];
  const groups: [string, typeof families][] = [
    ['Uploaded', families.filter((f) => f.source === 'uploaded')],
    ['Built in', families.filter((f) => f.source === 'bundled')],
    ['Server', families.filter((f) => f.source === 'system')],
  ];
  const upload = async (file: File) => {
    const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    try {
      const res = await fetch(`/api/fonts/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: file,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(await res.text());
      await loadFonts();
      toast(`Font ${file.name} added`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <div className="row">
        <span className="prop-label">Font</span>
        <select
          value={current?.family ?? layer.fontFamily}
          onChange={(e) => {
            const fam = families.find((f) => f.family === e.target.value);
            set('fontFamily', e.target.value);
            // Keep a weight that exists in the new family.
            if (fam && !fam.weights.includes(layer.fontWeight)) set('fontWeight', nearestWeight(fam, layer.fontWeight));
          }}
          style={{ fontFamily: `"${current?.family ?? layer.fontFamily}"` }}
        >
          {!current && <option value={layer.fontFamily}>{layer.fontFamily} (missing on the server)</option>}
          {groups
            .filter(([, list]) => list.length)
            .map(([label, list]) => (
              <optgroup key={label} label={label}>
                {list.map((f) => (
                  <option key={f.family} value={f.family} style={{ fontFamily: `"${f.family}"` }}>
                    {f.family}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <select value={layer.fontWeight} onChange={(e) => set('fontWeight', +e.target.value)}>
          {[...new Set([...weights, layer.fontWeight])]
            .sort((a, b) => a - b)
            .map((w) => (
              <option key={w} value={w}>
                {WEIGHT_NAMES[w] ?? w}
                {weights.includes(w) ? '' : ' (n/a)'}
              </option>
            ))}
        </select>
        <label className="icon-btn ghost" title="Add a font (.ttf, .otf, .woff)">
          <Upload size={13} />
          <input type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      <div className="row">
        <Segmented
          value={layer.align}
          onChange={(v) => set('align', v)}
          options={[
            { value: 'left', label: <AlignLeft size={13} /> },
            { value: 'center', label: <AlignCenter size={13} /> },
            { value: 'right', label: <AlignRight size={13} /> },
          ]}
        />
        <Segmented
          value={layer.verticalAlign}
          onChange={(v) => set('verticalAlign', v)}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Mid' },
            { value: 'bottom', label: 'Bot' },
          ]}
        />
        {layer.type !== 'text' && (
          <button className={`btn small ${layer.uppercase ? 'on' : ''}`} onClick={() => set('uppercase', !layer.uppercase)} title="Upper case">
            AA
          </button>
        )}
      </div>
      {layer.type === 'text' && (
        <div className="row">
          <Segmented
            value={layer.uppercase ? 'upper' : (layer.transform ?? 'none')}
            onChange={(v) => {
              set('uppercase', false);
              set('transform', v === 'none' ? undefined : v);
            }}
            options={[
              { value: 'none', label: <span title="As typed">—</span> },
              { value: 'upper', label: <span title="UPPER CASE">AA</span> },
              { value: 'lower', label: <span title="lower case">aa</span> },
              { value: 'capitalize', label: <span title="Each Word">Aa</span> },
            ]}
          />
          <Segmented
            value={layer.decoration ?? 'none'}
            onChange={(v) => set('decoration', v === 'none' ? undefined : v)}
            options={[
              { value: 'none', label: <span title="No decoration">—</span> },
              {
                value: 'underline',
                label: (
                  <span title="Underline" style={{ textDecoration: 'underline' }}>
                    U
                  </span>
                ),
              },
              {
                value: 'lineThrough',
                label: (
                  <span title="Strike through" style={{ textDecoration: 'line-through' }}>
                    S
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
    </>
  );
}

const FILL_LABEL: Partial<Record<LayerType, string>> = {
  progress: 'Bar',
  barChart: 'Bars',
  analogClock: 'Face',
  qrCode: 'Modules',
};

/** In another format than main: what is specific to it, and a reset. */
function FormatNote({ layer }: { layer: Layer }) {
  const { format, updateBase } = useDesigner();
  const project = useApp((s) => s.project);
  if (format === MAIN_FORMAT || !project) return null;
  const name = project.formats.find((f) => f.id === format)?.name ?? format;
  const o = layer.overrides?.[format];
  const n = Object.keys(o?.props ?? {}).length + Object.keys(o?.tracks ?? {}).length + (o?.visible !== undefined ? 1 : 0);
  return (
    <div className="format-note">
      <span>
        Editing the <strong>{name}</strong> layout: changes apply to {name} only. Texts, data and new layers are shared.
      </span>
      {n > 0 && (
        <button className="btn small" onClick={() => updateBase((t) => resetOverride(findLayer(t, layer.id)!, format))}>
          <RotateCcw size={12} /> Reset {n} change{n > 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

/** What a layer shows: its text, picture, widget settings (and ▶ ❚❚ ⟲ to try a widget). */
function LayerGeneral({ layer }: { layer: Layer }) {
  const { update, template } = useDesigner();
  if (!template) return null;
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  const set = (key: string, v: unknown, coalesce?: boolean) => edit((l) => void ((l as unknown as Attrs)[key] = v), coalesce ? `${key}-${layer.id}` : undefined);
  return (
    <div className="pp-general">
      {layer.type === 'text' && (
        <>
          <TextInput multiline value={layer.text} onChange={(v) => set('text', v, true)} />
          <div className="row">
            <span className="prop-label">Lines</span>
            <Segmented
              value={layer.wrap ? 'paragraph' : 'single'}
              onChange={(v) => edit((l) => void (l.type === 'text' && (l.wrap = v === 'paragraph' || undefined)))}
              options={[
                {
                  value: 'single',
                  label: <span title="Line breaks only where you type them">As typed</span>,
                },
                {
                  value: 'paragraph',
                  label: <span title="Lines wrap at the width of the box">Paragraph</span>,
                },
              ]}
            />
          </div>
          <div className="row">
            <span className="prop-label">Scroll</span>
            <Segmented
              value={layer.scroll ?? 'none'}
              onChange={(v) => edit((l) => void (l.type === 'text' && (l.scroll = v === 'none' ? undefined : v)))}
              options={[
                {
                  value: 'none',
                  label: <span title="The text stays in place">Fixed</span>,
                },
                {
                  value: 'horizontal',
                  label: <span title="The lines one after the other, right to left (ticker)">Horizontal</span>,
                },
                {
                  value: 'vertical',
                  label: <span title="Bottom to top (credit roll)">Vertical</span>,
                },
              ]}
            />
          </div>
          {layer.scroll && layer.scroll !== 'none' && (
            <>
              <div className="row">
                <span className="prop-label">Speed</span>
                <NumberField value={layer.speed ?? 120} min={1} max={2000} suffix="px/s" onChange={(v) => edit((l) => void (l.type === 'text' && (l.speed = v)), `speed-${layer.id}`)} />
              </div>
              {layer.scroll === 'horizontal' ? (
                <div className="row">
                  <span className="prop-label">Separator</span>
                  <TextInput value={layer.separator ?? '   •   '} onChange={(v) => set('separator', v, true)} />
                </div>
              ) : (
                <label className="check">
                  <input type="checkbox" checked={!!layer.looping} onChange={(e) => edit((l) => void (l.type === 'text' && (l.looping = e.target.checked || undefined)))} />
                  Loop (comes round again)
                </label>
              )}
            </>
          )}
        </>
      )}
      {TEXT_LIKE.has(layer.type) && (
        <div className="pp-typo">
          <FontControls layer={layer as Layer & FontStyle} set={set} />
          <GroupRow layer={layer} spec={{ label: 'Size', props: ['fontSize'], min: 1, suffix: 'px' }} />
          <GroupRow
            layer={layer}
            spec={{
              label: 'Spacing',
              props: ['letterSpacing'],
              precision: 1,
              suffix: 'px',
            }}
          />
          {layer.type === 'text' && (
            <div className="row">
              <span className="prop-label">Line height</span>
              <NumberField value={layer.lineHeight ?? 1.2} min={0.5} max={4} step={0.05} precision={2} suffix="×" onChange={(v) => edit((l) => void (l.type === 'text' && (l.lineHeight = Math.abs(v - 1.2) < 1e-6 ? undefined : v)), `lh-${layer.id}`)} />
            </div>
          )}
        </div>
      )}
      {layer.type === 'image' && <AssetPicker value={layer.src} onChange={(v) => edit((l) => void (l.type === 'image' && (l.src = v)))} />}
      <WidgetSettings layer={layer} set={set} />
      {isTimed(layer) && (
        <div className="dp-run">
          <span className="prop-label">Try it</span>
          <WidgetRunButtons layer={layer} />
        </div>
      )}
      {isTimed(layer) && (
        <label className="check" title="The operator starts it with ▶ in the controls of the graphic on air (or API action widget)">
          <input type="checkbox" checked={!!layer.manualStart} onChange={(e) => edit((l) => void (l.manualStart = e.target.checked || undefined))} />
          Start manually (the operator presses ▶)
        </label>
      )}
      {layer.type === 'group' && <p className="hint">A group holds layers; its properties apply to all of them.</p>}
      {layer.type !== 'text' && layer.type !== 'image' && layer.type !== 'group' && !isTimed(layer) && <p className="hint">{LABELS[layer.type]}</p>}
    </div>
  );
}

function LayerInspector({ layer }: { layer: Layer }) {
  const { update } = useDesigner();
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  const textLike = TEXT_LIKE.has(layer.type);
  const radius = layer.type === 'rect' || layer.type === 'group' || layer.type === 'progress';
  const Icon = ICONS[layer.type];
  const hasLook = layer.type !== 'image' && layer.type !== 'slideshow';
  const driven = useDrivenValues(layer);
  return (
    <DrivenContext.Provider value={driven}>
      <FormatNote layer={layer} />
      <div className="pp-head">
        <span className="pp-type">
          <Icon size={14} />
        </span>
        <TextInput value={layer.name} commitOnBlur onChange={(v) => edit((l) => void (l.name = v))} />
      </div>
      <Group id="general" title="General">
        <LayerGeneral layer={layer} />
      </Group>
      <Group id="properties" title="Properties">
        <Group id="transform" title="Transform" level={2}>
          {TRANSFORM_ROWS.map((r) => (
            <GroupRow key={r.label} layer={layer} spec={r} />
          ))}
        </Group>
        <Group id="contents" title="Contents" level={2}>
          {hasLook && <ColorGroupRow layer={layer} prop="fill" label={FILL_LABEL[layer.type] ?? (textLike ? 'Color' : 'Fill')} />}
          {hasLook && layer.type !== 'progress' && layer.type !== 'qrCode' && <ColorGroupRow layer={layer} prop="stroke" label={layer.type === 'analogClock' ? 'Hands' : 'Stroke'} />}
          {hasLook &&
            STYLE.filter((st) => (st.prop === 'cornerRadius' ? radius : !['analogClock', 'progress', 'qrCode'].includes(layer.type))).map((st) => (
              <GroupRow
                key={st.prop}
                layer={layer}
                spec={{
                  label: st.label === 'Stroke W' ? 'Stroke width' : st.label,
                  props: [st.prop],
                  min: st.min,
                  precision: st.precision,
                  suffix: 'px',
                }}
              />
            ))}
          {layer.type === 'image' && (
            <div className="row">
              <span className="prop-label">Fit</span>
              <Segmented
                value={layer.fit}
                onChange={(v) => edit((l) => void (l.type === 'image' && (l.fit = v)))}
                options={[
                  { value: 'contain', label: 'Contain' },
                  { value: 'cover', label: 'Cover' },
                  { value: 'stretch', label: 'Stretch' },
                ]}
              />
            </div>
          )}
          {layer.type === 'group' && (
            <label className="check">
              <input type="checkbox" checked={!!layer.clip} onChange={(e) => edit((l) => void (l.type === 'group' && (l.clip = e.target.checked)))} />
              Clip children to group bounds
            </label>
          )}
        </Group>
        <Group id="reveal" title="Reveal mask" level={2}>
          {[
            { label: 'Left', props: ['cropLeft'] as Prop[] },
            { label: 'Right', props: ['cropRight'] as Prop[] },
            { label: 'Top', props: ['cropTop'] as Prop[] },
            { label: 'Bottom', props: ['cropBottom'] as Prop[] },
          ].map((r) => (
            <GroupRow key={r.label} layer={layer} spec={{ ...r, display: 100, suffix: '%', min: 0, max: 1 }} />
          ))}
        </Group>
      </Group>
    </DrivenContext.Provider>
  );
}

const EASINGS: { value: Easing['type']; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'easeIn', label: 'Ease in' },
  { value: 'easeOut', label: 'Ease out' },
  { value: 'easeInOut', label: 'Easy ease' },
  { value: 'back', label: 'Back (overshoot)' },
  { value: 'elastic', label: 'Elastic' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'bezier', label: 'Custom bezier' },
  { value: 'hold', label: 'Hold' },
];

export function EasingCurve({ easing, size = 120 }: { easing: Easing; size?: number }) {
  const pad = 14;
  const s = size - pad * 2;
  const pts = Array.from({ length: 61 }, (_, i) => {
    const t = i / 60;
    const y = easing.type === 'hold' ? (t < 1 ? 0 : 1) : applyEasing(easing, t);
    return `${pad + t * s},${pad + (1 - y) * s * 0.75 + s * 0.125}`;
  }).join(' ');
  return (
    <svg className="easing-curve" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <rect x={pad} y={pad} width={s} height={s} rx={4} />
      <polyline points={pts} />
    </svg>
  );
}

function KeyframeInspector() {
  const { template, selectedKeys, update } = useDesigner();
  if (!template || !selectedKeys.length) return null;
  const first = selectedKeys[0];
  const k = findLayer(template, first.layerId)?.tracks[first.prop]?.find((x) => x.frame === first.frame);
  if (!k) return null;
  const setEasing = (e: Easing) =>
    update((t) => {
      for (const ref of selectedKeys) {
        const kk = findLayer(t, ref.layerId)?.tracks[ref.prop]?.find((x) => x.frame === ref.frame);
        if (kk) kk.easing = e;
      }
    });
  const bez = k.easing.type === 'bezier' ? k.easing : { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
  return (
    <Section title={`Keyframe${selectedKeys.length > 1 ? `s (${selectedKeys.length})` : ''} · frame ${k.frame}`}>
      <div className="row">
        <span className="prop-label">Easing</span>
        <select
          value={k.easing.type}
          onChange={(e) => {
            const type = e.target.value as Easing['type'];
            setEasing(type === 'bezier' ? { type, ...bez } : ({ type } as Easing));
          }}
        >
          {EASINGS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div className="easing-box">
        <EasingCurve easing={k.easing} />
        {k.easing.type === 'bezier' && (
          <div className="bez-grid">
            {(['x1', 'y1', 'x2', 'y2'] as const).map((c) => (
              <NumberField
                key={c}
                label={c}
                value={bez[c]}
                step={0.01}
                precision={2}
                display={1}
                onChange={(v) =>
                  setEasing({
                    type: 'bezier',
                    ...bez,
                    [c]: c.startsWith('x') ? Math.min(1, Math.max(0, v)) : v,
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
      <p className="hint">The curve applies to the segment leaving this keyframe.</p>
    </Section>
  );
}

/** "5" or "5s" seconds, "2:10" seconds and frames, "1:02:10" minutes too → frames. */
function parseDuration(text: string, rate: number): number | null {
  const t = text.trim().replace(/s$/i, '');
  if (/^\d+([.,]\d+)?$/.test(t)) return Math.round(parseFloat(t.replace(',', '.')) * rate);
  const parts = t.split(':').map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((x) => Number.isNaN(x) || x < 0)) return null;
  const [m, sec, fr] = parts.length === 3 ? parts : [0, ...parts];
  return Math.round((m * 60 + sec) * rate) + fr;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Frames as mm:ss:ff. */
const timecode = (frames: number, rate: number) => {
  const r = Math.round(rate);
  const sec = Math.floor(frames / r);
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}:${pad2(frames % r)}`;
};

/** A template's length: a timecode to type in, steps of one frame or one second, and usual lengths. */
function DurationField({ frames, rate, onChange }: { frames: number; rate: number; onChange: (frames: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const r = Math.round(rate);
  const commit = () => {
    if (text !== null) {
      const v = parseDuration(text, rate);
      if (v !== null) onChange(Math.max(1, v));
    }
    setText(null);
  };
  const step = (d: number) => onChange(Math.max(1, frames + d));
  return (
    <div className="dur-field">
      <div className="dur-main">
        <button className="dur-step" title="− 1 second (Shift: − 1 frame)" onClick={(e) => step(e.shiftKey ? -1 : -r)}>
          <ChevronLeft size={14} />
        </button>
        <input
          className="dur-tc"
          value={text ?? timecode(frames, rate)}
          title="Minutes:seconds:frames — or type 5, 5s, 2:10"
          onFocus={(e) => (setText(timecode(frames, rate)), e.currentTarget.select())}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') (setText(null), e.currentTarget.blur());
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : r));
              setText(null);
            }
            e.stopPropagation();
          }}
        />
        <button className="dur-step" title="+ 1 second (Shift: + 1 frame)" onClick={(e) => step(e.shiftKey ? 1 : r)}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="dur-units">
        <span>min</span>
        <span>sec</span>
        <span>frames</span>
      </div>
      <div className="dur-presets">
        {[3, 5, 8, 10, 15, 30].map((sec) => (
          <button key={sec} className={frames === sec * r ? 'on' : ''} onClick={() => onChange(sec * r)}>
            {sec}s
          </button>
        ))}
      </div>
    </div>
  );
}

function TemplateInspector({ template }: { template: Template }) {
  const { update } = useDesigner();
  const fps = useApp((s) => s.project?.frameRate);
  const project = useApp((s) => s.project);
  const zones = project?.zones ?? [];
  const [zonesOpen, setZonesOpen] = useState(false);
  const rate = fps ? fps.num / fps.den : 50;
  const sorted = [...zones].sort((a, b) => b.layer - a.layer);
  return (
    <>
      <div className="pp-head">
        <span className="pp-type">
          <LayoutTemplate size={14} />
        </span>
        <TextInput value={template.name} commitOnBlur onChange={(v) => update((t) => void (t.name = v))} />
      </div>
      {project && (
        <div className="tpl-publish-row pjp-publish">
          <TemplatePublish project={project} id={template.id} readOnly={false} />
        </div>
      )}
      <Group id="tpl-general" title="General">
        <div className="pp-general tpl-general">
          <Row label="Duration">
            <DurationField frames={template.duration} rate={rate} onChange={(v) => update((t) => void (t.duration = v), 'duration')} />
          </Row>
          <Row label="Zone">
            <div className="zone-pick">
              {sorted.map((z) => (
                <button key={z.id} className={template.zone === z.id ? 'on' : ''} style={{ ['--z' as string]: z.color }} onClick={() => update((t) => void (t.zone = z.id))}>
                  <span className="zone-dot" />
                  {z.name}
                </button>
              ))}
              {!zones.some((z) => z.id === template.zone) && <span className="muted small">No zone</span>}
              <button className="zone-edit" title="Edit the zones" onClick={() => setZonesOpen(true)}>
                <Settings2 size={13} />
              </button>
            </div>
          </Row>
        </div>
      </Group>
      {zonesOpen && <ZonesDialog onClose={() => setZonesOpen(false)} />}
    </>
  );
}

export function Inspector() {
  const { template, selected } = useDesigner();
  const editSafe = useGuidesView((s) => s.editSafe);
  const project = useApp((s) => s.project);
  if (editSafe && project)
    return (
      <div className="inspector">
        <AreaInspector project={project} />
      </div>
    );
  if (!template)
    return (
      <div className="inspector">
        <Section title="All templates">
          <p className="hint">The stage shows every template at its on-air point, each in its zone. Click a graphic, or a template on the left, to open it; Esc in a template comes back here.</p>
        </Section>
      </div>
    );
  const layer = selected.length === 1 ? findLayer(template, selected[0]) : undefined;
  return (
    <div className="inspector">
      <KeyframeInspector />
      {layer ? (
        <LayerInspector layer={layer} />
      ) : selected.length > 1 ? (
        <Section title="Selection">
          <p className="hint">{selected.length} layers selected. Drag on the stage to move them together.</p>
        </Section>
      ) : (
        <TemplateInspector template={template} />
      )}
    </div>
  );
}

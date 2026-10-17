import { RotateCcw, AlignCenter, AlignLeft, AlignRight, ChevronDown, ChevronLeft, ChevronRight, Diamond, Link as LinkIcon, Link2, Spline, Unlink, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyEasing, col, num, parseHex, propValue, toHex } from '../engine/evaluate';
import { MAIN_FORMAT, TEXT_LIKE, type Easing, type FontStyle, type Layer, type LayerType, type Prop, type Template, type Value } from '../engine/types';
import { api, mediaUrl, uploadAsset, useApp, type MediaFile } from '../store';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { ZonesDialog } from './ZonesDialog';
import { loadFonts, nearestWeight, useFonts } from '../engine/fonts';
import { isOverridden, resetOverride } from '../engine/formats';
import { findLayer, isAnimated, setProp, toggleKeyAt, toggleStopwatch, useDesigner } from './designerStore';
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
  { prop: 'opacity', label: 'Opacity', display: 100, suffix: '%', min: 0, max: 1 },
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
  { prop: 'cropLeft', label: 'Left', display: 100, suffix: '%', min: 0, max: 1 },
  { prop: 'cropRight', label: 'Right', display: 100, suffix: '%', min: 0, max: 1 },
  { prop: 'cropTop', label: 'Top', display: 100, suffix: '%', min: 0, max: 1 },
  { prop: 'cropBottom', label: 'Bottom', display: 100, suffix: '%', min: 0, max: 1 },
];

export const PROP_LABELS: Record<Prop, string> = Object.fromEntries(
  [...TRANSFORM, ...STYLE, ...TEXT, ...CROP.map((c) => ({ ...c, label: `Crop ${c.label}` })), { prop: 'fill', label: 'Fill' }, { prop: 'stroke', label: 'Stroke' }].map((s) => [
    s.prop,
    s.label,
  ]),
) as Record<Prop, string>;


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
  { label: 'Scale', props: ['scaleX', 'scaleY'], fields: ['X', 'Y'], display: 100, suffix: '%', lock: true },
  { label: 'Dimensions', props: ['width', 'height'], fields: ['W', 'H'], suffix: 'px', min: 0 },
  { label: 'Anchor', props: ['anchorX', 'anchorY'], fields: ['X', 'Y'], display: 100, suffix: '%' },
  { label: 'Rotation', props: ['rotation'], suffix: '°', precision: 1 },
  { label: 'Opacity', props: ['opacity'], display: 100, suffix: '%', min: 0, max: 1 },
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
        onClick={() =>
          update((t) => {
            const l = findLayer(t, layer.id)!;
            for (const p of props) if (here === (l.tracks[p] ?? []).some((k) => Math.abs(k.frame - frame) < 0.5)) toggleKeyAt(l, p, frame);
          })
        }
      >
        <Diamond size={11} fill={here ? 'currentColor' : 'none'} />
      </button>
      <button title="Next keyframe" disabled={next === undefined} onClick={() => next !== undefined && setFrame(next)}>
        <ChevronRight size={12} />
      </button>
    </span>
  );
}

/** Animate toggle of a row (all its properties), lit while animated. */
function AnimateToggle({ layer, props }: { layer: Layer; props: Prop[] }) {
  const { frame, update } = useDesigner();
  const animated = props.some((p) => isAnimated(layer, p));
  const driven = useDesigner((s) => s.template?.logic?.nodes.some((n) => n.type === 'target' && n.layer === layer.id && props.includes(n.prop as Prop)));
  return (
    <>
      {driven && (
        <span className="logic-badge" title="Driven by a Logic relation (Logic button in the toolbar)">
          <Link2 size={11} />
        </span>
      )}
      <button
        className={`pp-anim ${animated ? 'on' : ''}`}
        title={animated ? 'Stop animating' : 'Animate (keyframes at the playhead)'}
        onClick={() => {
          update((t) => {
            const l = findLayer(t, layer.id)!;
            for (const p of props) if (isAnimated(l, p) === animated) toggleStopwatch(l, p, frame);
          });
          if (!animated) useDesigner.setState((st) => ({ expanded: { ...st.expanded, [layer.id]: true } }));
        }}
      >
        <Spline size={14} />
      </button>
    </>
  );
}

/** A property row: ◀ ◆ ▶, name, animate, its fields (X / Y…). */
function GroupRow({ layer, spec }: { layer: Layer; spec: RowSpec }) {
  const { frame, update, format, updateBase } = useDesigner();
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
      <AnimateToggle layer={layer} props={spec.props} />
      <div className={`pp-fields n${spec.props.length}`}>
        {spec.props.map((p, i) => (
          <NumberField
            key={p}
            label={spec.fields?.[i]}
            value={num(propValue(layer, p, frame))}
            display={spec.display}
            suffix={spec.suffix}
            precision={spec.precision}
            min={spec.min}
            max={spec.max}
            onChange={(nv) => setValue(p, nv)}
          />
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
  return (
    <div className={`pp-row ${isAnimated(layer, prop) ? 'animated' : ''}`}>
      <RowKeys layer={layer} props={[prop]} />
      <span className="pp-label">{label}</span>
      <span className="pp-lock-space" />
      <AnimateToggle layer={layer} props={[prop]} />
      <div className="pp-fields n1">
        <ColorField value={col(propValue(layer, prop, frame))} onChange={(c) => update((t) => setProp(findLayer(t, layer.id)!, prop, c as Value, frame), `prop-${layer.id}-${prop}`)} />
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

/** Inserts `{{field}}` placeholders into a text attribute. */
export function FieldChips({ template, onInsert }: { template: Template; onInsert: (token: string) => void }) {
  if (!template.fields.length) return null;
  return (
    <div className="chips">
      {template.fields.map((f) => (
        <button key={f.key} className="chip" onClick={() => onInsert(`{{${f.key}}}`)}>
          + {f.label}
        </button>
      ))}
    </div>
  );
}

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
export function WidgetSettings({ layer, template, set }: { layer: Layer; template: Template; set: (key: string, v: unknown, coalesce?: boolean) => void }) {
  const a = layer as unknown as Attrs;
  const text = (key: string, multiline = false, placeholder?: string) => (
    <>
      <TextInput multiline={multiline} value={String(a[key] ?? '')} placeholder={placeholder} onChange={(v) => set(key, v, true)} />
      <FieldChips template={template} onInsert={(tok) => set(key, `${a[key] ?? ''}${tok}`)} />
    </>
  );
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

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

/** Font picker: the fonts the server really has (bundled, uploaded, system). */
function FontControls({ layer, set }: { layer: Layer & FontStyle; set: (key: string, v: unknown) => void }) {
  const families = useFonts((s) => s.families);
  const toast = useApp((s) => s.toast);
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
      const res = await fetch(`/api/fonts/${encodeURIComponent(name)}`, { method: 'PUT', body: file, credentials: 'same-origin' });
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
          {[...new Set([...weights, layer.fontWeight])].sort((a, b) => a - b).map((w) => (
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
        <button className={`btn small ${layer.uppercase ? 'on' : ''}`} onClick={() => set('uppercase', !layer.uppercase)}>
          AA
        </button>
      </div>
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

/** Right panel: the properties of the selected layer. Its content, widget
 *  settings and data live in the left panel (DataPanel). */
function LayerInspector({ layer }: { layer: Layer }) {
  const { update } = useDesigner();
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  const set = (key: string, v: unknown, coalesce?: boolean) => edit((l) => void ((l as unknown as Attrs)[key] = v), coalesce ? `${key}-${layer.id}` : undefined);
  const textLike = TEXT_LIKE.has(layer.type);
  const radius = layer.type === 'rect' || layer.type === 'group' || layer.type === 'progress';
  const Icon = ICONS[layer.type];
  const hasLook = layer.type !== 'image' && layer.type !== 'slideshow';
  return (
    <>
      <FormatNote layer={layer} />
      <div className="pp-head">
        <span className="pp-type">
          <Icon size={14} />
        </span>
        <TextInput value={layer.name} commitOnBlur onChange={(v) => edit((l) => void (l.name = v))} />
      </div>
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
              <GroupRow key={st.prop} layer={layer} spec={{ label: st.label === 'Stroke W' ? 'Stroke width' : st.label, props: [st.prop], min: st.min, precision: st.precision, suffix: 'px' }} />
            ))}
          {textLike && (
            <>
              <GroupRow layer={layer} spec={{ label: 'Font size', props: ['fontSize'], min: 1, suffix: 'px' }} />
              <GroupRow layer={layer} spec={{ label: 'Tracking', props: ['letterSpacing'], precision: 1 }} />
              <FontControls layer={layer as Layer & FontStyle} set={set} />
            </>
          )}
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
    </>
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
                onChange={(v) => setEasing({ type: 'bezier', ...bez, [c]: c.startsWith('x') ? Math.min(1, Math.max(0, v)) : v })}
              />
            ))}
          </div>
        )}
      </div>
      <p className="hint">The curve applies to the segment leaving this keyframe.</p>
    </Section>
  );
}

function TemplateInspector({ template }: { template: Template }) {
  const { update } = useDesigner();
  const fps = useApp((s) => s.project?.frameRate);
  const zones = useApp((s) => s.project?.zones ?? []);
  const [zonesOpen, setZonesOpen] = useState(false);
  const rate = fps ? fps.num / fps.den : 50;
  return (
    <>
      <Section title="Template">
        <div className="row">
          <span className="prop-label">Name</span>
          <TextInput value={template.name} commitOnBlur onChange={(v) => update((t) => void (t.name = v))} />
        </div>
        <div className="row">
          <NumberField label="Duration" value={template.duration} min={1} suffix="fr" onChange={(v) => update((t) => void (t.duration = Math.round(v)), 'duration')} />
          <span className="muted">{(template.duration / rate).toFixed(2)} s</span>
        </div>
        <div className="row">
          <span className="prop-label">Zone</span>
          <select value={template.zone} onChange={(e) => update((t) => void (t.zone = e.target.value))} title="Where this template plays by default">
            {!zones.some((z) => z.id === template.zone) && <option value={template.zone}>—</option>}
            {[...zones]
              .sort((a, b) => b.layer - a.layer)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
          </select>
          <button className="btn small" onClick={() => setZonesOpen(true)}>
            Zones…
          </button>
        </div>
        <p className="hint">One template at a time per zone; zones are on air together.</p>
      </Section>
      {zonesOpen && <ZonesDialog onClose={() => setZonesOpen(false)} />}
      <p className="hint pad">Variables and data are in the panel on the left, under the templates.</p>
    </>
  );
}

export function Inspector() {
  const { template, selected } = useDesigner();
  if (!template) return null;
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

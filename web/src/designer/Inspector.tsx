import { AlignCenter, AlignLeft, AlignRight, ChevronLeft, ChevronRight, Diamond, Link2, Plus, Timer, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyEasing, col, num, propValue, sortKeys } from '../engine/evaluate';
import type { Easing, Field, FieldKind, Layer, MarkerKind, Prop, Template, Value } from '../engine/types';
import { uploadAsset, useApp } from '../store';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { findLayer, isAnimated, setProp, toggleKeyAt, toggleStopwatch, useDesigner } from './designerStore';

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

const FONTS = ['Inter', 'Inter Display', 'DejaVu Sans', 'DejaVu Serif', 'FreeSans', 'Roboto', 'Montserrat', 'Oswald', 'Bebas Neue'];

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
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

/** Stopwatch + keyframe navigation, the AE way. */
function KeyControls({ layer, prop }: { layer: Layer; prop: Prop }) {
  const { frame, update, setFrame } = useDesigner();
  const animated = isAnimated(layer, prop);
  const keys = animated ? sortKeys(layer.tracks[prop]!) : [];
  const onKey = keys.some((k) => k.frame === Math.round(frame));
  const prev = [...keys].reverse().find((k) => k.frame < Math.round(frame));
  const next = keys.find((k) => k.frame > Math.round(frame));
  return (
    <div className="key-controls">
      <button
        className={`icon-btn ghost ${animated ? 'on accent' : ''}`}
        title={animated ? 'Disable animation' : 'Animate this property'}
        onClick={() => {
          update((t) => toggleStopwatch(findLayer(t, layer.id)!, prop, frame));
          // Reveal the new track in the timeline, like AE does.
          if (!animated) useDesigner.setState((s) => ({ expanded: { ...s.expanded, [layer.id]: true } }));
        }}
      >
        <Timer size={13} />
      </button>
      {animated && (
        <>
          <button className="icon-btn ghost" disabled={!prev} onClick={() => prev && setFrame(prev.frame)} title="Previous keyframe">
            <ChevronLeft size={12} />
          </button>
          <button
            className={`icon-btn ghost key-diamond ${onKey ? 'on' : ''}`}
            title={onKey ? 'Remove keyframe' : 'Add keyframe'}
            onClick={() => update((t) => toggleKeyAt(findLayer(t, layer.id)!, prop, frame))}
          >
            <Diamond size={11} />
          </button>
          <button className="icon-btn ghost" disabled={!next} onClick={() => next && setFrame(next.frame)} title="Next keyframe">
            <ChevronRight size={12} />
          </button>
        </>
      )}
    </div>
  );
}

function BindButton({ layer, prop, template }: { layer: Layer; prop: Prop; template: Template }) {
  const { update } = useDesigner();
  const bound = layer.bindings[prop];
  const [open, setOpen] = useState(false);
  if (!template.fields.length) return null;
  return (
    <div className="bind">
      <button className={`icon-btn ghost ${bound ? 'on accent' : ''}`} title={bound ? `Bound to {{${bound}}}` : 'Bind to a data field'} onClick={() => setOpen(!open)}>
        <Link2 size={12} />
      </button>
      {open && (
        <div className="popover" onMouseLeave={() => setOpen(false)}>
          <button
            onClick={() => {
              update((t) => void delete findLayer(t, layer.id)!.bindings[prop]);
              setOpen(false);
            }}
          >
            — None —
          </button>
          {template.fields.map((f) => (
            <button
              key={f.key}
              className={bound === f.key ? 'on' : ''}
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
    </div>
  );
}

function PropRow({ layer, spec, template }: { layer: Layer; spec: PropSpec; template: Template }) {
  const { frame, update } = useDesigner();
  const v = num(propValue(layer, spec.prop, frame));
  return (
    <div className={`prop-row ${isAnimated(layer, spec.prop) ? 'animated' : ''}`}>
      <KeyControls layer={layer} prop={spec.prop} />
      <NumberField
        label={spec.label}
        value={v}
        display={spec.display}
        suffix={spec.suffix}
        step={spec.step ?? (spec.display === 100 ? 1 : 1)}
        precision={spec.precision}
        min={spec.min}
        max={spec.max}
        onChange={(nv) => update((t) => setProp(findLayer(t, layer.id)!, spec.prop, nv, frame), `prop-${layer.id}-${spec.prop}`)}
      />
      <BindButton layer={layer} prop={spec.prop} template={template} />
    </div>
  );
}

function ColorRow({ layer, prop, label, template }: { layer: Layer; prop: 'fill' | 'stroke'; label: string; template: Template }) {
  const { frame, update } = useDesigner();
  return (
    <div className={`prop-row ${isAnimated(layer, prop) ? 'animated' : ''}`}>
      <KeyControls layer={layer} prop={prop} />
      <span className="prop-label">{label}</span>
      <ColorField value={col(propValue(layer, prop, frame))} onChange={(c) => update((t) => setProp(findLayer(t, layer.id)!, prop, c as Value, frame), `prop-${layer.id}-${prop}`)} />
      <BindButton layer={layer} prop={prop} template={template} />
    </div>
  );
}

function AssetPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [assets, setAssets] = useState<string[]>([]);
  const toast = useApp((s) => s.toast);
  const refresh = () =>
    fetch('/api/assets')
      .then((r) => r.json())
      .then(setAssets)
      .catch(() => {});
  useEffect(() => void refresh(), []);
  return (
    <div className="asset-picker">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— choose an asset —</option>
        {!assets.includes(value) && value && <option value={value}>{value}</option>}
        {assets.map((a) => (
          <option key={a} value={a}>
            {a.replace('/assets/', '')}
          </option>
        ))}
      </select>
      <label className="btn small" title="Upload an image">
        <Upload size={13} />
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const src = await uploadAsset(f);
              await refresh();
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

function LayerInspector({ layer, template }: { layer: Layer; template: Template }) {
  const { update } = useDesigner();
  const edit = (fn: (l: Layer) => void, key?: string) => update((t) => fn(findLayer(t, layer.id)!), key);
  return (
    <>
      <Section title={layer.type.toUpperCase()}>
        <div className="row">
          <span className="prop-label">Name</span>
          <TextInput value={layer.name} commitOnBlur onChange={(v) => edit((l) => void (l.name = v))} />
        </div>
        {layer.type === 'group' && (
          <label className="check">
            <input type="checkbox" checked={!!layer.clip} onChange={(e) => edit((l) => void (l.type === 'group' && (l.clip = e.target.checked)))} />
            Clip children to group bounds
          </label>
        )}
        {layer.type === 'text' && (
          <>
            <TextInput multiline value={layer.text} onChange={(v) => edit((l) => void (l.type === 'text' && (l.text = v)), `text-${layer.id}`)} />
            {template.fields.length > 0 && (
              <div className="chips">
                {template.fields.map((f) => (
                  <button key={f.key} className="chip" onClick={() => edit((l) => void (l.type === 'text' && (l.text += `{{${f.key}}}`)))}>
                    + {f.label}
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <span className="prop-label">Font</span>
              <select value={layer.fontFamily} onChange={(e) => edit((l) => void (l.type === 'text' && (l.fontFamily = e.target.value)))}>
                {[...new Set([layer.fontFamily, ...FONTS])].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
              <select value={layer.fontWeight} onChange={(e) => edit((l) => void (l.type === 'text' && (l.fontWeight = +e.target.value)))}>
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <Segmented
                value={layer.align}
                onChange={(v) => edit((l) => void (l.type === 'text' && (l.align = v)))}
                options={[
                  { value: 'left', label: <AlignLeft size={13} /> },
                  { value: 'center', label: <AlignCenter size={13} /> },
                  { value: 'right', label: <AlignRight size={13} /> },
                ]}
              />
              <Segmented
                value={layer.verticalAlign}
                onChange={(v) => edit((l) => void (l.type === 'text' && (l.verticalAlign = v)))}
                options={[
                  { value: 'top', label: 'Top' },
                  { value: 'middle', label: 'Mid' },
                  { value: 'bottom', label: 'Bot' },
                ]}
              />
              <button className={`btn small ${layer.uppercase ? 'on' : ''}`} onClick={() => edit((l) => void (l.type === 'text' && (l.uppercase = !l.uppercase)))}>
                AA
              </button>
            </div>
          </>
        )}
        {layer.type === 'image' && (
          <>
            <AssetPicker value={layer.src} onChange={(v) => edit((l) => void (l.type === 'image' && (l.src = v)))} />
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
          </>
        )}
      </Section>
      <Section title="Transform">
        {TRANSFORM.map((s) => (
          <PropRow key={s.prop} layer={layer} spec={s} template={template} />
        ))}
      </Section>
      {layer.type !== 'image' && (
        <Section title="Appearance">
          <ColorRow layer={layer} prop="fill" label={layer.type === 'text' ? 'Color' : 'Fill'} template={template} />
          <ColorRow layer={layer} prop="stroke" label="Stroke" template={template} />
          {STYLE.filter((s) => s.prop !== 'cornerRadius' || layer.type === 'rect' || layer.type === 'group').map((s) => (
            <PropRow key={s.prop} layer={layer} spec={s} template={template} />
          ))}
        </Section>
      )}
      {layer.type === 'text' && (
        <Section title="Typography">
          {TEXT.map((s) => (
            <PropRow key={s.prop} layer={layer} spec={s} template={template} />
          ))}
        </Section>
      )}
      <Section title="Reveal mask">
        {CROP.map((s) => (
          <PropRow key={s.prop} layer={layer} spec={s} template={template} />
        ))}
      </Section>
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
  const { update, previewData, set, frame } = useDesigner();
  const fps = useApp((s) => s.project?.frameRate);
  const rate = fps ? fps.num / fps.den : 50;
  const editField = (i: number, fn: (f: Field) => void) => update((t) => fn(t.fields[i]));
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
      </Section>
      <Section
        title="Data fields"
        actions={
          <button
            className="icon-btn ghost"
            title="Add field"
            onClick={() =>
              update((t) => {
                let n = t.fields.length + 1;
                while (t.fields.some((f) => f.key === `field${n}`)) n++;
                t.fields.push({ key: `field${n}`, label: `Field ${n}`, kind: 'text', default: '' });
              })
            }
          >
            <Plus size={14} />
          </button>
        }
      >
        {template.fields.length === 0 && <p className="hint">Fields are the inputs the operator fills in. Use them in text with {'{{key}}'} or bind them to properties.</p>}
        {template.fields.map((f, i) => (
          <div key={i} className="field-card">
            <div className="row">
              <TextInput value={f.label} commitOnBlur placeholder="Label" onChange={(v) => editField(i, (x) => void (x.label = v))} />
              <TextInput value={f.key} commitOnBlur placeholder="key" onChange={(v) => editField(i, (x) => void (x.key = v.replace(/[^A-Za-z0-9_]/g, '')))} />
            </div>
            <div className="row">
              <select value={f.kind} onChange={(e) => editField(i, (x) => void (x.kind = e.target.value as FieldKind))}>
                {['text', 'multiline', 'number', 'color', 'image'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <TextInput value={f.default} commitOnBlur placeholder="Default value" onChange={(v) => editField(i, (x) => void (x.default = v))} />
              <button className="icon-btn ghost" onClick={() => update((t) => void t.fields.splice(i, 1))}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="row">
              <span className="prop-label">Preview</span>
              <TextInput value={previewData[f.key] ?? ''} onChange={(v) => set({ previewData: { ...previewData, [f.key]: v } })} />
            </div>
          </div>
        ))}
      </Section>
      <Section
        title="Markers"
        actions={
          <button
            className="icon-btn ghost"
            title="Add pause marker at playhead"
            onClick={() => update((t) => void t.markers.push({ id: crypto.randomUUID().slice(0, 8), frame: Math.round(frame), name: 'Pause', kind: 'pause' }))}
          >
            <Plus size={14} />
          </button>
        }
      >
        <p className="hint">Pause: playout holds here, “Continue” resumes. Out: “Take out” jumps here and plays to the end.</p>
        {[...template.markers]
          .sort((a, b) => a.frame - b.frame)
          .map((m) => (
            <div key={m.id} className="row">
              <span className={`marker-dot ${m.kind}`} />
              <TextInput value={m.name} commitOnBlur onChange={(v) => update((t) => void (t.markers.find((x) => x.id === m.id)!.name = v))} />
              <NumberField value={m.frame} min={0} max={template.duration} onChange={(v) => update((t) => void (t.markers.find((x) => x.id === m.id)!.frame = Math.round(v)), `marker-${m.id}`)} />
              <select value={m.kind} onChange={(e) => update((t) => void (t.markers.find((x) => x.id === m.id)!.kind = e.target.value as MarkerKind))}>
                <option value="pause">pause</option>
                <option value="out">out</option>
                <option value="label">label</option>
              </select>
              <button className="icon-btn ghost" onClick={() => update((t) => void (t.markers = t.markers.filter((x) => x.id !== m.id)))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
      </Section>
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
        <LayerInspector layer={layer} template={template} />
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

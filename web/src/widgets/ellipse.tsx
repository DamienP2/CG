// Ellipse: circle lock, portion (sector / arc / chord) between a start and an end angle, ring / donut.
// Drawn as a path in layer pixels (never a scaled circle), so a flat ellipse keeps an even stroke.
// Same picture as crates/cg-render/src/wid/ellipse.rs; geometry mirrors crates/cg-core/src/wid/ellipse.rs.
import { useEffect } from 'react';
import { Circle } from 'lucide-react';
import { col, cssColor, num } from '../engine/evaluate';
import { ColorGroupRow, GroupRow } from '../designer/Inspector';
import { Bound, Btns, clamp, defineWidget, Handle, Note, Range, Section, Seg, Toggle, useBound, type Warning, withDefaults } from './kit';
import { FillStrokeSections, ShapeSvg, STROKE, type FillStyle, type StrokeStyle } from './shape';

export interface Config {
  circle?: boolean;
  /** Degrees, 0 = 12 o'clock, clockwise. */
  start?: number;
  /** Past 360 wraps round; 360° of sweep = full ellipse. */
  end?: number;
  portion?: 'sector' | 'arc' | 'chord';
  /** Sector: inner radius, % (ring / donut). */
  inner?: number;
  fillStyle?: FillStyle;
  /** Older ellipses (none set) have a centred stroke. */
  strokeStyle?: StrokeStyle;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface State {}

const D = { circle: false, start: 0, end: 360, portion: 'sector' as const, inner: 0 };
const cfg = (c: Config) => withDefaults(D, c);
const strokeOf = (c: Config): StrokeStyle => ({ position: 'center', ...c.strokeStyle });
const DEG = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Sweep in degrees: 0 = nothing, 360 = full ellipse. */
export function sweep(c: Config) {
  const k = cfg(c);
  let d = k.end - k.start;
  if (d < 0) d += 360;
  return clamp(d, 0, 360);
}

const pt = (cx: number, cy: number, rx: number, ry: number, a: number): [number, number] => [cx + Math.sin(a * DEG) * rx, cy - Math.cos(a * DEG) * ry];

/** Cubic Béziers of an elliptical arc (mirrors arc_to). */
function arcTo(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
  const step = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan((step * DEG) / 4);
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = (a0 + step * i) * DEG;
    const b = (a0 + step * (i + 1)) * DEG;
    const p0 = [cx + Math.sin(a) * rx, cy - Math.cos(a) * ry];
    const p1 = [cx + Math.sin(b) * rx, cy - Math.cos(b) * ry];
    const d0 = [Math.cos(a) * rx, Math.sin(a) * ry];
    const d1 = [Math.cos(b) * rx, Math.sin(b) * ry];
    s += `C${r3(p0[0] + d0[0] * k)} ${r3(p0[1] + d0[1] * k)} ${r3(p1[0] - d1[0] * k)} ${r3(p1[1] - d1[1] * k)} ${r3(p1[0])} ${r3(p1[1])}`;
  }
  return s;
}

/** The outline and whether it is closed; null = nothing to draw (mirrors outline). */
export function outline(c: Config, w: number, h: number): { d: string; closed: boolean } | null {
  const k = cfg(c);
  const [cx, cy, rx, ry] = [w / 2, h / 2, w / 2, h / 2];
  const sw = sweep(c);
  if (sw <= 0.01 || rx <= 0 || ry <= 0) return null;
  const q = clamp(k.inner, 0, 100) / 100;
  const ring = k.portion === 'sector' && q > 0;
  if (ring && q >= 1) return null;
  const M = (p: [number, number]) => `M${r3(p[0])} ${r3(p[1])}`;
  const a = pt(cx, cy, rx, ry, k.start);
  if (sw >= 360) {
    let d = M(a) + arcTo(cx, cy, rx, ry, k.start, k.start + 360) + 'Z';
    if (ring) d += M(pt(cx, cy, rx * q, ry * q, k.start)) + arcTo(cx, cy, rx * q, ry * q, k.start, k.start - 360) + 'Z';
    return { d, closed: true };
  }
  const end = k.start + sw;
  const arc = arcTo(cx, cy, rx, ry, k.start, end);
  if (k.portion === 'arc') return { d: M(a) + arc, closed: false };
  if (k.portion === 'chord') return { d: M(a) + arc + 'Z', closed: true };
  if (ring) {
    const ib = pt(cx, cy, rx * q, ry * q, end);
    return { d: M(a) + arc + `L${r3(ib[0])} ${r3(ib[1])}` + arcTo(cx, cy, rx * q, ry * q, end, k.start) + 'Z', closed: true };
  }
  return { d: `M${cx} ${cy}L${r3(a[0])} ${r3(a[1])}` + arc + 'Z', closed: true };
}

/** Stroke group of an arc: colour, width, style and ends (the stroke is centred). */
function ArcStroke({ layer }: { layer: Parameters<typeof FillStrokeSections>[0]['layer'] }) {
  return (
    <Section id="ellipse-arc-stroke" title="Stroke">
      <ColorGroupRow layer={layer} prop="stroke" label="Color" />
      <GroupRow layer={layer} spec={{ label: 'Width', props: ['strokeWidth'], min: 0, suffix: 'px' }} />
      <Seg
        label="Style"
        path="strokeStyle.dash"
        value={STROKE.dash}
        options={[
          ['solid', 'Solid'],
          ['dashed', 'Dashes'],
          ['dotted', 'Dots'],
        ]}
      />
      <Seg
        label="Ends"
        path="strokeStyle.cap"
        value={STROKE.cap}
        options={[
          ['butt', 'Flat'],
          ['round', 'Round'],
          ['square', 'Square'],
        ]}
      />
      <Note>An arc stroke is centred on the outline.</Note>
    </Section>
  );
}

/** Fill / Stroke groups showing the centred stroke of older ellipses. */
function Look({ layer }: { layer: Parameters<typeof FillStrokeSections>[0]['layer'] & Config }) {
  const b = useBound();
  return (
    <Bound obj={{ ...layer, strokeStyle: strokeOf(layer) }} set={b.set}>
      <FillStrokeSections layer={layer} id="ellipse" />
    </Bound>
  );
}

export default defineWidget({
  id: 'ellipse',
  type: 'ellipse',
  label: 'Ellipse',
  group: 'Shapes & tools',
  icon: Circle,
  presets: [{ label: 'Circle' }, { label: 'Ellipse', patch: { circle: false, end: 360, inner: 0 } }, { label: 'Pie', patch: { end: 300, inner: 0 } }, { label: 'Ring', patch: { end: 360, inner: 55 } }, { label: 'Arc', patch: { portion: 'arc', start: 270, end: 450 } }],
  create: () => ({
    circle: true,
    start: 0,
    end: 300,
    inner: 55,
    fillStyle: { kind: 'linear', color2: '#ff3b5c', angle: 135 },
    strokeStyle: { position: 'inside', cap: 'round', join: 'round' },
    props: { width: 600, height: 600, fill: [0.486, 0.361, 1, 1], stroke: [0.98, 0.8, 0.08, 1], strokeWidth: 0 },
  }),
  ownsLook: true,
  Render: ({ layer, r, w, h, data }) => {
    const p = outline(layer, w, h);
    if (!p) return null;
    const st = { ...strokeOf(layer) };
    if (!p.closed) {
      const sw = Math.max(1, num(r.strokeWidth));
      const dash = st.dash === 'dashed' ? `${sw * 3} ${sw * 2}` : st.dash === 'dotted' ? `0.001 ${sw * 2}` : undefined;
      return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <path d={p.d} fill="none" stroke={cssColor(col(r.stroke))} strokeWidth={sw} strokeLinecap={st.dash === 'dotted' ? 'round' : (st.cap ?? 'butt')} strokeLinejoin={st.join ?? 'miter'} strokeDasharray={dash} />
        </svg>
      );
    }
    return <ShapeSvg d={p.d} w={w} h={h} r={r} fill={layer.fillStyle} stroke={st} rule="evenodd" data={data} />;
  },
  Inspector: ({ layer, edit }) => {
    const k = cfg(layer);
    const sw = sweep(layer);
    return (
      <>
        <Section id="ellipse-shape" title="Shape">
          <Toggle
            expose="circle"
            exposeValue={k.circle}
            label="Circle"
            value={k.circle}
            text="Lock the proportions"
            onChange={(v) =>
              edit((l) => {
                l.circle = v;
                if (v) l.props.height = l.props.width;
              })
            }
          />
          <Range label="Start angle" path="start" value={k.start} min={0} max={360} unit="°" />
          <Range label="End angle" path="end" value={k.end} min={0} max={720} fmt={(v) => `${v}°${v > 360 ? ` (${v - 360}°)` : ''}`} />
          <Note>
            Sweep <b style={{ color: 'var(--text)' }}>{Math.round(sw)}°</b> · 0° is 12 o'clock, clockwise · an end past 360° wraps round · 360° of sweep = full ellipse.
          </Note>
          <Btns
            label="Quick"
            list={[
              { label: 'Full', cls: 'ghost', onClick: () => edit((l) => void ((l.start = 0), (l.end = 360))) },
              { label: 'Half', cls: 'ghost', onClick: () => edit((l) => void ((l.start = 270), (l.end = 450))) },
              { label: 'Quarter', cls: 'ghost', onClick: () => edit((l) => void ((l.start = 0), (l.end = 90))) },
            ]}
          />
          <Seg
            expose="portion"
            exposeValue={k.portion}
            label="Portion"
            value={k.portion}
            onChange={(v) =>
              edit((l) => {
                l.portion = v;
                if (v === 'arc' && !num(l.props.strokeWidth ?? 0)) {
                  l.props.strokeWidth = 28;
                  l.props.stroke = [0.98, 0.8, 0.08, 1];
                }
              })
            }
            options={[
              ['sector', 'Sector', 'Pie slice: closed through the centre'],
              ['arc', 'Arc', 'The outline only'],
              ['chord', 'Chord', 'Closed by a straight line'],
            ]}
          />
          {k.portion === 'sector' ? (
            <>
              <Range label="Inner radius" path="inner" value={k.inner} min={0} max={100} unit=" %" />
              <Note>Above 0 %: a ring (full sweep) or a donut slice.</Note>
            </>
          ) : (
            <Note>{k.portion === 'arc' ? 'Arc: only the stroke is drawn (fill ignored). Its width, style and ends are in Stroke.' : 'Chord: the arc closed by a straight line. Inner radius does not apply.'}</Note>
          )}
          <Note>Orange dots: start, end and inner radius with the mouse.</Note>
        </Section>
        {k.portion === 'arc' ? <ArcStroke layer={layer} /> : <Look layer={layer} />}
      </>
    );
  },
  Overlay: ({ layer, w, h, scale, edit }) => {
    const k = cfg(layer);
    // Circle: the box stays square (also after a resize on the stage).
    useEffect(() => {
      if (k.circle && Math.abs(w - h) > 0.5) edit((l) => void (l.props.height = l.props.width), `circle-${layer.id}`);
    }, [k.circle, w, h, edit, layer.id]);
    const sw = sweep(layer);
    const q = clamp(k.inner, 0, 100) / 100;
    const ang = (x: number, y: number) => Math.round((Math.atan2((x - w / 2) / (w / 2), -(y - h / 2) / (h / 2)) / DEG + 360) % 360);
    const a = pt(w / 2, h / 2, w / 2, h / 2, k.start);
    const b = pt(w / 2, h / 2, w / 2, h / 2, k.start + sw);
    const m = pt(w / 2, h / 2, (w / 2) * q, (h / 2) * q, k.start + sw / 2);
    const apart = sw >= 360 || sw <= 0.01 ? 22 / scale : 0;
    return (
      <>
        <Handle x={a[0]} y={a[1]} scale={scale} label={`Start ${Math.round(k.start)}°`} onDrag={(x, y) => edit((l) => void (l.start = ang(x, y)), `estart-${layer.id}`)} />
        <Handle
          x={b[0] + apart}
          y={b[1]}
          scale={scale}
          label={`End ${Math.round(k.end)}° · sweep ${Math.round(sw)}°`}
          onDrag={(x, y) =>
            edit((l) => {
              let e = ang(x, y);
              const s = cfg(l).start;
              if (e <= s) e += 360; // the end always sweeps clockwise from the start
              l.end = e;
            }, `eend-${layer.id}`)
          }
        />
        {k.portion === 'sector' && (
          <Handle
            x={m[0]}
            y={m[1]}
            scale={scale}
            label={`Inner radius ${Math.round(k.inner)} %`}
            onDrag={(x, y) => {
              const dx = (x - w / 2) / (w / 2);
              const dy = (y - h / 2) / (h / 2);
              edit((l) => void (l.inner = Math.round(clamp(Math.hypot(dx, dy) * 100, 0, 100))), `einner-${layer.id}`);
            }}
          />
        )}
      </>
    );
  },
  warnings: (layer, { r }) => {
    const k = cfg(layer);
    const out: Warning[] = [];
    const sw = sweep(layer);
    const w = num(r?.width ?? layer.props.width ?? 0);
    const h = num(r?.height ?? layer.props.height ?? 0);
    const width = num(r?.strokeWidth ?? layer.props.strokeWidth ?? 0);
    if (sw <= 0.01) out.push({ level: 'info', text: 'Start and end are equal (0° of sweep): nothing is drawn.' });
    if (k.portion === 'sector' && k.inner >= 100 && sw > 0.01) out.push({ level: 'warn', text: 'Inner radius at 100 %: the ring has no thickness, the shape is invisible.' });
    if (k.portion !== 'arc' && layer.fillStyle?.kind === 'none' && !width) out.push({ level: 'warn', text: 'No fill and no stroke: the shape is invisible.' });
    const flat = Math.min(w, h) / Math.max(w, h, 1);
    if (flat < 0.12 && (width || k.portion === 'arc')) out.push({ level: 'ok', text: 'Very flat ellipse: the outline is computed in stage pixels, the stroke keeps the same thickness all round.' });
    return out;
  },
});

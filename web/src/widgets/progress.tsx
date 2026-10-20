// Progress bar: linear (horizontal / vertical), ring, segmented — settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/progress.rs; values and actions in crates/cg-core/src/wid/progress.rs.
import { useContext, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SceneLayers } from '../engine/sceneLayers';
import { TimeContext } from '../engine/Scene';
import * as T from './timer-fmt';
import { display as counterDisplay, partsOf } from './counter';
import { useDesigner } from '../designer/designerStore';
import { Dropdown } from '../ui/Dropdown';
import { SlidersHorizontal } from 'lucide-react';
import { col, cssColor, interpolateText, num, type Resolved } from '../engine/evaluate';
import { textWidth } from '../engine/widgets';
import type { Data, Layer } from '../engine/types';
import { ColorGroupRow, GroupRow } from '../designer/Inspector';
import { useApp } from '../store';
import { Btns, ColorPick, Content, defineWidget, hex, ListEditor, Msg, Num, Row, Section, Seg, Text, Toggle, useFrame, useKeys, type LayerOf, type Warning, withDefaults } from './kit';
import { t } from '../i18n';

export interface Config {
  shape?: 'linear' | 'ring' | 'segments';
  orient?: 'h' | 'v';
  input?: 'value' | 'percent' | 'follow';
  /** Layer id of the widget followed (input follow). */
  follow?: string;
  min?: string;
  step?: number;
  unit?: string;
  decimals?: number;
  dir?: 'start' | 'end' | 'center';
  angle?: number;
  circleDir?: 'cw' | 'ccw' | 'center';
  segments?: number;
  segGap?: number;
  segPartial?: 'partial' | 'round';
  gradient?: boolean;
  color2?: string;
  thickness?: number;
  rounded?: boolean;
  steps?: { on?: boolean; below?: number; color?: string }[];
  label?: 'none' | 'pct' | 'value';
  labelPos?: 'inside' | 'end' | 'beside';
  labelSize?: number;
  labelColor?: string;
  easing?: 'linear' | 'out' | 'inout' | 'back';
}

/** The value set by the operator and the transition towards it (mirrors `State` in Rust). */
export interface State {
  value?: number | null;
  from?: number;
  at?: number;
}

type L = LayerOf<'progress'>;
const D = {
  shape: 'linear' as NonNullable<Config['shape']>,
  orient: 'h' as 'h' | 'v',
  input: 'value' as 'value' | 'percent' | 'follow',
  follow: '',
  min: '',
  step: 5,
  unit: '',
  decimals: 0,
  dir: 'start' as NonNullable<Config['dir']>,
  angle: 0,
  circleDir: 'cw' as NonNullable<Config['circleDir']>,
  segments: 10,
  segGap: 10,
  segPartial: 'partial' as 'partial' | 'round',
  gradient: false,
  color2: '#22c55e',
  rounded: false,
  steps: [] as NonNullable<Config['steps']>,
  label: 'none' as NonNullable<Config['label']>,
  labelPos: 'inside' as NonNullable<Config['labelPos']>,
  labelSize: 30,
  labelColor: '#ffffff',
  easing: 'out' as NonNullable<Config['easing']>,
};
const cfg = (l: Config) => withDefaults(D, l) as typeof D & { thickness?: number };
const LH = 1.2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** "1 250,5", "64 %" → number (mirrors parse_num). */
export function parseNum(s: string): number | null {
  const t = String(s ?? '')
    .trim()
    .replace(/%+$/, '')
    .replace(/[\s ]/g, '')
    .replace(',', '.');
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
const numOf = (raw: string, data: Data) => parseNum(interpolateText(raw ?? '', data)) ?? 0;

const EASE = {
  linear: (k: number) => k,
  out: (k: number) => 1 - Math.pow(1 - k, 3),
  inout: (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  back: (k: number) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2),
};

/** The value of the widget followed now and its natural end (mirror of progress::followed). */
export function followed(layers: Layer[], c: { input: string; follow: string }, widgetState: ((id: string) => unknown) | undefined, data: Data, now: number, ageSecs: number, tz: string): [number, number | null] | null {
  if (c.input !== 'follow') return null;
  const l = layers.find((x) => x.id === c.follow);
  if (!l) return null;
  const st = widgetState?.(l.id);
  if (l.type === 'clock') {
    const e = T.eff(l as never, data);
    const v = T.value(e, T.run(e, st as never, now, ageSecs * 1000, tz), now, tz);
    if (!v) return null;
    const secs = v.v / 1000;
    if (e.mode === 'countdown') return [v.over ? 0 : Math.max(0, secs), e.cdTime ? null : e.duration / 1000];
    if (e.mode === 'stopwatch') return [secs, e.c.swLimitOn ? e.c.swLimit / 1000 : null];
    return null;
  }
  if (l.type === 'counter') return [counterDisplay(partsOf(l as never), (st ?? {}) as never, data, now, ageSecs, null)[0], null];
  return null;
}

export function effOf(l: L, data: Data, follow?: [number, number | null] | null) {
  const c = cfg(l);
  const [lo, hi] =
    c.input === 'percent' ? [0, 100] : c.input === 'follow' ? [numOf(c.min, data), follow?.[1] != null && !(l.max ?? '').trim() ? follow[1] : numOf(l.max, data)] : [numOf(c.min, data), numOf(l.max, data)];
  const base = c.input === 'follow' ? (follow?.[0] ?? 0) : numOf(l.value, data);
  const capped = (v: number) => (hi > lo ? clamp(v, lo, hi) : hi < lo ? clamp(v, hi, lo) : v);
  const ease = (k: number) => (EASE[c.easing] ?? EASE.out)(clamp(k, 0, 1));
  const shown = (st: State | undefined, now: number, age: number) => {
    const d = Math.max(0, l.duration ?? 0);
    if (st?.value != null) {
      const k = d <= 0 ? 1 : (now - (st.at ?? 0)) / (d * 1000);
      const [a, b] = [capped(st.from ?? 0), capped(st.value)];
      return a + (b - a) * ease(k);
    }
    const k = d <= 0 ? 1 : age / d;
    return lo + (capped(base) - lo) * ease(k);
  };
  const frac = (v: number): [number, boolean, number] => {
    const span = hi - lo;
    if (span === 0 || !Number.isFinite(span) || !Number.isFinite(v)) return [0, true, 0];
    const f = (v - lo) / span;
    return [clamp(f, 0, 1), false, f];
  };
  const stepColor = (f: number) => {
    let best: { below?: number; color?: string } | null = null;
    for (const s of c.steps) if (s.on !== false && f * 100 < +(s.below ?? NaN) && (!best || +s.below! < +best.below!)) best = s;
    return best?.color || null;
  };
  const target = (st: State | undefined) => st?.value ?? base;
  return { c, lo, hi, base, shown, frac, stepColor, target };
}

/** "5 000.5" (mirrors fmt_num). */
export function fmtNum(v: number, dec: number): string {
  const s = Math.abs(v).toFixed(dec);
  const [int, fr] = s.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const neg = v < 0 && /[1-9]/.test(s);
  return `${neg ? '-' : ''}${g}${fr !== undefined ? '.' + fr : ''}`;
}

function labelText(e: ReturnType<typeof effOf>, v: number, f: number) {
  const c = e.c;
  if (c.label === 'none') return '';
  if (e.frac(v)[1]) return '—';
  const dec = Math.min(3, c.decimals);
  if (c.label === 'pct') return `${fmtNum(f * 100, dec)} %`;
  return `${fmtNum(v, dec)} / ${fmtNum(e.hi, 0)}${c.unit ? ' ' + c.unit : ''}`;
}

// --------------------------------------------------------------- drawing --

let seq = 0;
function View({ layer, r, w, h, data, nowMs, ageSecs, state }: { layer: L; r: Resolved; w: number; h: number; data: Data; nowMs: number; ageSecs: number; state: unknown }) {
  const [id] = useState(() => `pg${++seq}`);
  const layers = useContext(SceneLayers);
  const time = useContext(TimeContext);
  const e = effOf(layer, data, followed(layers, cfg(layer), time.widgetState, data, nowMs, ageSecs, time.defaultTz ?? ''));
  const c = e.c;
  const v = e.shown(state as State | undefined, nowMs, ageSecs);
  const [f] = e.frac(v);
  const fs = Math.max(1, c.labelSize);
  const text = labelText(e, v, f);
  const tw = text ? textWidth(text, 'Inter', 800, fs, 0) : 0;
  const lc = hex(c.labelColor, '#fff');
  const sw = Math.max(0, num(r.strokeWidth));
  const sc = cssColor(col(r.stroke));
  const track = hex(layer.track);
  const fill = cssColor(col(r.fill));
  const thr = e.stepColor(f);
  const labels: ReactNode[] = [];
  const lab = (s: string, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end', key: string) => {
    const W = 20000;
    const left = anchor === 'start' ? x : anchor === 'middle' ? x - W / 2 : x - W;
    labels.push(
      <div
        key={key}
        style={{
          position: 'absolute',
          left,
          top: y - (size * LH) / 2,
          width: W,
          height: size * LH,
          lineHeight: LH,
          fontSize: size,
          font: `800 ${size}px Inter, system-ui, sans-serif`,
          color: lc,
          whiteSpace: 'pre',
          textAlign: anchor === 'start' ? 'left' : anchor === 'middle' ? 'center' : 'right',
          pointerEvents: 'none',
        }}
      >
        {s}
      </div>,
    );
  };
  const svg: ReactNode[] = [];
  const defs: ReactNode[] = [];
  const paint = (x1: number, y1: number, x2: number, y2: number) => {
    if (thr) return hex(thr);
    if (!c.gradient) return fill;
    defs.push(
      <linearGradient key="g" id={`${id}g`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
        <stop offset="0" stopColor={fill} />
        <stop offset="1" stopColor={hex(c.color2)} />
      </linearGradient>,
    );
    return `url(#${id}g)`;
  };
  const bubble = (x: number, y: number, ptr: boolean) => {
    const bw = tw + fs * 0.9;
    const bh = fs * 1.5;
    const bx = clamp(x - bw / 2, 0, Math.max(0, w - bw));
    svg.push(<rect key="bb" x={bx} y={y - bh} width={bw} height={bh} rx={bh / 2} fill="#0d0a1f" stroke={lc} strokeOpacity={0.25} strokeWidth={1} />);
    if (ptr) svg.push(<path key="bp" d={`M ${x - 9} ${y} L ${x + 9} ${y} L ${x} ${y + 10} Z`} fill="#0d0a1f" />);
    lab(text, bx + bw / 2, y - bh / 2, fs, 'middle', 'bl');
  };

  if (c.shape === 'ring') {
    const besideW = text && c.labelPos === 'beside' ? tw + 30 : 0;
    const cx = (w - besideW) / 2;
    const cy = h / 2;
    const m = Math.min(w - besideW, h);
    const T = Math.max(1, Math.min(c.thickness ?? m * 0.12, m / 2 - 4));
    const R = Math.max(4, m / 2 - T / 2 - sw - (c.labelPos === 'end' && text ? fs * 0.9 : 2));
    const p = paint(cx - R, cy - R, cx + R, cy + R);
    svg.push(<circle key="t" cx={cx} cy={cy} r={R} fill="none" stroke={track} strokeWidth={T} />);
    const span = f * 360;
    const s0 = c.circleDir === 'ccw' ? c.angle - span : c.circleDir === 'center' ? c.angle - span / 2 : c.angle;
    const P = (a: number) => [cx + R * Math.sin((a * Math.PI) / 180), cy - R * Math.cos((a * Math.PI) / 180)];
    if (f >= 0.9995) svg.push(<circle key="b" cx={cx} cy={cy} r={R} fill="none" stroke={p} strokeWidth={T} />);
    else if (f > 0) {
      const sp = Math.max(span, 0.05);
      const [x0, y0] = P(s0);
      const [x1, y1] = P(s0 + sp);
      svg.push(<path key="b" d={`M ${x0} ${y0} A ${R} ${R} 0 ${sp > 180 ? 1 : 0} 1 ${x1} ${y1}`} fill="none" stroke={p} strokeWidth={T} strokeLinecap={c.rounded ? 'round' : 'butt'} />);
    }
    if (sw > 0)
      for (const [k, rr] of [
        ['o', R + T / 2],
        ['i', Math.max(0, R - T / 2)],
      ] as const)
        svg.push(<circle key={k} cx={cx} cy={cy} r={rr} fill="none" stroke={sc} strokeWidth={sw} />);
    if (text) {
      if (c.labelPos === 'inside') lab(text, cx, cy, Math.max(1, Math.min(fs * 1.8, (R - T / 2) * 0.62)), 'middle', 'l');
      else if (c.labelPos === 'beside') lab(text, w - besideW + 20, cy, fs, 'start', 'l');
      else {
        const end = (((c.circleDir === 'ccw' ? c.angle - span : c.circleDir === 'center' ? c.angle + span / 2 : c.angle + span) * Math.PI) / 180) as number;
        const rr = R + T / 2 + fs * 0.9;
        bubble(cx + rr * Math.sin(end), cy - rr * Math.cos(end) + fs * 0.75, false);
      }
    }
  } else {
    const horiz = c.orient === 'h';
    const L0 = horiz ? w : h;
    const C = horiz ? h : w;
    const besideL = text && c.labelPos === 'beside' ? (horiz ? tw + 24 : fs * 1.6) : 0;
    const Ln = Math.max(10, L0 - besideL - sw);
    const T = c.thickness != null ? Math.max(2, Math.min(c.thickness, C - 4)) : C;
    const c0 = C / 2 - T / 2;
    const so = sw / 2;
    const rect = (key: string, p: number, q: number, rx: number, fillP: string, extra: Record<string, unknown> = {}) => {
      const [x, y, rw, rh] = horiz ? [so + p, c0, Math.max(0, q - p), T] : [c0, h - so - q, T, Math.max(0, q - p)];
      const rr = Math.max(0, Math.min(rx, rw / 2, rh / 2));
      return <rect key={key} x={x} y={y} width={rw} height={rh} rx={rr} fill={fillP} {...extra} />;
    };
    const p0 = horiz ? paint(so, 0, so + Ln, 0) : paint(0, h - so, 0, h - so - Ln);
    let p = c.dir === 'end' ? Ln - f * Ln : c.dir === 'center' ? Ln / 2 - (f * Ln) / 2 : 0;
    let q = c.dir === 'end' ? Ln : c.dir === 'center' ? Ln / 2 + (f * Ln) / 2 : f * Ln;
    const radius = c.rounded ? T / 2 : num(r.cornerRadius);
    const strokeAttr = sw > 0 ? { stroke: sc, strokeWidth: sw } : {};
    if (c.shape === 'segments') {
      let N = Math.max(1, Math.round(c.segments));
      const g = Math.max(0, c.segGap);
      while (N > 1 && (Ln - g * (N - 1)) / N < 3) N--;
      const sl = (Ln - g * (N - 1)) / N;
      const rx = c.rounded ? Math.min(T, sl) * 0.3 : 0;
      let u = f * N;
      if (c.segPartial === 'round') u = c.dir === 'center' && N % 2 === 0 ? 2 * Math.round(u / 2) : Math.round(u);
      const mid = (N - 1) / 2;
      const clip: ReactNode[] = [];
      const fills: ReactNode[] = [];
      for (let i = 0; i < N; i++) {
        const a = i * (sl + g);
        clip.push(rect(`c${i}`, a, a + sl, rx, '#fff'));
        svg.push(rect(`t${i}`, a, a + sl, rx, track, strokeAttr));
        let fi: number;
        let from: 'start' | 'end' | 'mid';
        if (c.dir === 'end') ((fi = clamp(u - (N - 1 - i), 0, 1)), (from = 'end'));
        else if (c.dir === 'center') {
          const rr = Math.abs(i - mid);
          fi = N % 2 ? (rr === 0 ? clamp(u, 0, 1) : clamp((u - 1) / 2 - (rr - 1), 0, 1)) : clamp(u / 2 - Math.floor(rr), 0, 1);
          from = i < mid ? 'end' : i > mid ? 'start' : 'mid';
        } else ((fi = clamp(u - i, 0, 1)), (from = 'start'));
        if (fi <= 0) continue;
        const len = sl * fi;
        const [fp, fq] = from === 'start' ? [a, a + len] : from === 'end' ? [a + sl - len, a + sl] : [a + (sl - len) / 2, a + (sl + len) / 2];
        fills.push(rect(`f${i}`, fp, fq, 0, p0));
      }
      defs.push(
        <clipPath key="c" id={`${id}c`}>
          {clip}
        </clipPath>,
      );
      svg.push(
        <g key="fills" clipPath={`url(#${id}c)`}>
          {fills}
        </g>,
      );
    } else {
      if (c.rounded && f > 0 && q - p < T) {
        if (c.dir === 'end') ((p = Ln - T), (q = Ln));
        else if (c.dir === 'center') ((p = Ln / 2 - T / 2), (q = Ln / 2 + T / 2));
        else q = T;
      }
      svg.push(rect('t', 0, Ln, radius, track, strokeAttr));
      if (f > 0) svg.push(rect('b', p, q, radius, p0));
    }
    if (text) {
      const pos = (a: number) => (horiz ? so + a : h - so - a);
      const len = q - p;
      if (c.labelPos === 'beside') {
        if (horiz) lab(text, Ln + so + 24, C / 2, fs, 'start', 'l');
        else lab(text, C / 2, h - so - Ln - fs * 0.9, fs, 'middle', 'l');
      } else if (c.labelPos === 'end') {
        const en = c.dir === 'end' ? p : q;
        if (horiz) bubble(pos(en), c0 - 12, true);
        else lab(text, c0 + T + 14, pos(en), fs, 'start', 'l');
      } else if (horiz) {
        const fits = c.shape !== 'segments' && len > tw + fs;
        if (c.shape === 'segments') {
          const bw = tw + fs * 1.1;
          const bh = Math.min(T + 8, fs * 1.6);
          svg.push(<rect key="pill" x={so + Ln / 2 - bw / 2} y={C / 2 - bh / 2} width={bw} height={bh} rx={bh / 2} fill="#0d0a1f" fillOpacity={0.92} />);
          lab(text, so + Ln / 2, C / 2, fs, 'middle', 'l');
        } else if (c.dir === 'center') lab(text, so + Ln / 2, C / 2, fs, 'middle', 'l');
        else if (fits) {
          if (c.dir === 'end') lab(text, pos(p) + fs * 0.6, C / 2, fs, 'start', 'l');
          else lab(text, pos(q) - fs * 0.6, C / 2, fs, 'end', 'l');
        } else if (c.dir === 'end') lab(text, pos(p) - fs * 0.5, C / 2, fs, 'end', 'l');
        else lab(text, pos(q) + fs * 0.5, C / 2, fs, 'start', 'l');
      } else {
        let ty = c.dir === 'center' || c.shape === 'segments' ? h - so - Ln / 2 : c.dir === 'end' ? pos(q) + fs * 0.9 : pos(q) - fs * 0.9;
        ty = Math.min(h - fs * 0.7, Math.max(fs * 0.7, ty));
        lab(text, C / 2, ty, Math.max(1, Math.min(fs, T * 0.42)), 'middle', 'l');
      }
    }
  }
  return (
    <>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>{defs}</defs>
        {svg}
      </svg>
      {labels}
    </>
  );
}

// ------------------------------------------------------------- inspector --

function fitBox(l: L, shape: string, orient: string) {
  const [w, h] = shape === 'ring' ? [460, 460] : orient === 'v' ? [220, 640] : [1200, 140];
  const p = l.props as Record<string, unknown>;
  const cx = num(p.x as number) + num(p.width as number) / 2;
  const cy = num(p.y as number) + num(p.height as number) / 2;
  Object.assign(p, { width: w, height: h, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2) });
}

function Inspector({ layer, data, edit }: { layer: L; data: Data; edit: (fn: (l: L) => void, key?: string) => void }) {
  const e = effOf(layer, data);
  const c = e.c;
  const stroke = num(layer.props.strokeWidth ?? 0) > 0;
  return (
    <>
      <Section id="progress-value" title={t('Value')}>
        <Seg
          label={t('Input')}
          path="input"
          value="value"
          options={[
            ['value', t('Min / max')],
            ['percent', '%'],
            ['follow', t('Follow'), t('The value of a timer or a counter of the graphic')],
          ]}
        />
        {c.input === 'follow' ? (
          <FollowPick value={c.follow} onChange={(v) => edit((l) => void ((l as never as { follow: string }).follow = v))} />
        ) : (
          <Content label={t('Value')} path="value" value="" placeholder="64" />
        )}
        {c.input === 'follow' && (
          <>
            <Content label={t('Min')} path="min" value="" placeholder="0" />
            <Content label={t('Max')} path="max" value="" placeholder={t('Its duration / limit')} />
          </>
        )}
        {c.input === 'value' && (
          <>
            <Content label={t('Min')} path="min" value="" placeholder="0" />
            <Content label={t('Max')} path="max" value="100" placeholder="100" />
          </>
        )}
        <Num label={t('Step + / −')} path="step" value={5} min={0} step={1} precision={2} />
      </Section>
      <Section id="progress-shape" title={t('Shape')}>
        <Seg
          expose="shape"
          exposeValue={c.shape}
          label={t('Shape')}
          value={c.shape}
          options={[
            ['linear', t('Linear')],
            ['ring', t('Ring')],
            ['segments', t('Segmented')],
          ]}
          onChange={(v) =>
            edit((l) => {
              (l as L & Config).shape = v;
              fitBox(l, v, cfg(l).orient);
            })
          }
        />
        {c.shape !== 'ring' && (
          <Seg
            expose="orient"
            exposeValue={c.orient}
            label={t('Orientation')}
            value={c.orient}
            options={[
              ['h', t('Horizontal')],
              ['v', t('Vertical')],
            ]}
            onChange={(v) =>
              edit((l) => {
                (l as L & Config).orient = v;
                fitBox(l, cfg(l).shape, v);
              })
            }
          />
        )}
        {c.shape === 'segments' && (
          <>
            <Num label={t('Segments')} path="segments" value={10} min={2} max={40} />
            <Num label={t('Gap')} path="segGap" value={10} min={0} max={40} unit="px" />
            <Seg
              label={t('Partial')}
              path="segPartial"
              value="partial"
              options={[
                ['partial', t('Partial')],
                ['round', t('Whole')],
              ]}
            />
          </>
        )}
        {c.shape === 'ring' ? (
          <>
            <Num label={t('Start angle')} path="angle" value={0} min={0} max={359} unit="°" />
            <Seg
              label={t('Turn')}
              path="circleDir"
              value="cw"
              options={[
                ['cw', t('Clockwise')],
                ['ccw', t('Anticlockwise')],
                ['center', t('Both ways')],
              ]}
            />
          </>
        ) : (
          <Seg
            label={t('Fill')}
            path="dir"
            value="start"
            options={
              c.orient === 'h'
                ? [
                    ['start', t('Left → right')],
                    ['end', t('Right → left')],
                    ['center', t('Centre')],
                  ]
                : [
                    ['start', t('Bottom → top')],
                    ['end', t('Top → bottom')],
                    ['center', t('Centre')],
                  ]
            }
          />
        )}
      </Section>
      <Section id="progress-style" title={t('Style')}>
        <ColorPick label={t('Track')} path="track" value="#ffffff33" />
        <ColorGroupRow layer={layer} prop="fill" label={c.gradient ? t('From') : t('Bar')} />
        <Toggle label={t('Gradient')} path="gradient" value={false} />
        {c.gradient && <ColorPick label={t('To')} path="color2" value="#22c55e" />}
        <Toggle
          expose="thickness"
          exposeValue={c.thickness ?? 56}
          label={t('Thickness')}
          value={c.thickness != null}
          onChange={(v) =>
            edit((l) => {
              if (v) (l as L & Config).thickness = 56;
              else delete (l as L & Config).thickness;
            })
          }
        />
        {c.thickness != null && <Num label={t('Width')} path="thickness" value={56} min={2} max={2000} unit="px" />}
        <Toggle label={t('Rounded')} path="rounded" value={false} />
        {!c.rounded && <GroupRow layer={layer} spec={{ label: t('Corners'), props: ['cornerRadius'], min: 0, suffix: 'px' }} />}
        <Toggle
          expose="props.strokeWidth"
          exposeValue={num(layer.props.strokeWidth ?? 0)}
          label={t('Stroke')}
          value={stroke}
          onChange={(v) =>
            edit((l) => {
              l.props.strokeWidth = v ? 2 : 0;
              const sc = col(l.props.stroke ?? [0, 0, 0, 0]);
              if (v && sc[3] === 0) l.props.stroke = [1, 1, 1, 1];
            })
          }
        />
        {stroke && (
          <>
            <ColorGroupRow layer={layer} prop="stroke" label={t('Color')} />
            <GroupRow layer={layer} spec={{ label: t('Width'), props: ['strokeWidth'], min: 0, suffix: 'px' }} />
          </>
        )}
        <Toggle
          expose="steps"
          exposeValue={c.steps}
          label={t('Steps')}
          value={c.steps.length > 0}
          onChange={(v) =>
            edit((l) => {
              if (v) (l as L & Config).steps = [{ on: true, below: 20, color: '#ff3b5c' }];
              else delete (l as L & Config).steps;
            })
          }
        />
        {c.steps.length > 0 && (
          <ListEditor
            path="steps"
            value={[]}
            toggle="on"
            fields={[
              { key: 'below', num: true, w: 60, placeholder: '%' },
              { key: 'color', color: true, w: 40 },
            ]}
            add={() => ({ on: true, below: 20, color: '#ff3b5c' })}
            addLabel={t('Step')}
          />
        )}
      </Section>
      <Section id="progress-label" title={t('Label')}>
        <Toggle
          expose="label"
          exposeValue={c.label}
          exposeOptions={[
            ['none', t('None')],
            ['pct', '%'],
            ['value', t('Value')],
          ]}
          label={t('Label')}
          value={c.label !== 'none'}
          onChange={(v) => edit((l) => void ((l as L & Config).label = v ? 'pct' : 'none'))}
        />
        {c.label !== 'none' && (
          <>
            <Seg
              expose={false}
              label={t('Show')}
              path="label"
              value="none"
              options={[
                ['pct', '%'],
                ['value', t('Value / max')],
              ]}
            />
            <Seg
              label={t('Where')}
              path="labelPos"
              value="inside"
              options={[
                ['inside', t('Inside')],
                ['end', t('End')],
                ['beside', t('Beside')],
              ]}
            />
            <Num label={t('Size')} path="labelSize" value={30} min={1} max={400} unit="px" />
            <ColorPick label={t('Color')} path="labelColor" value="#ffffff" />
            <Num label={t('Decimals')} path="decimals" value={0} min={0} max={3} />
            {c.label === 'value' && <Text label={t('Unit')} path="unit" value="" placeholder="€, pts…" />}
          </>
        )}
      </Section>
      <Section id="progress-anim" title={t('Transition')}>
        <Num label={t('Duration')} path="duration" value={0} min={0} max={60} step={0.05} precision={2} unit="s" />
        <Seg
          label={t('Curve')}
          path="easing"
          value="out"
          options={[
            ['linear', t('Linear')],
            ['out', t('Ease out')],
            ['inout', t('Ease in-out')],
            ['back', t('Overshoot')],
          ]}
        />
      </Section>
    </>
  );
}

// -------------------------------------------------------------- operator --

function Operator({ layer, state, data, act, item, time }: { layer: L; state: unknown; data: Data; act: (op: string, args?: unknown) => void; item?: unknown; time: { nowMs: number; ageSecs: number } }) {
  useFrame();
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  const got = useRef({ age: time.ageSecs, at: Date.now() });
  if (got.current.age !== time.ageSecs) got.current = { age: time.ageSecs, at: Date.now() };
  const e = effOf(layer, data);
  const c = e.c;
  const st = state as State | undefined;
  const serverOffset = useApp((s) => s.serverOffset) ?? 0;
  const now = Date.now() + (item ? serverOffset : 0);
  const v = e.shown(st, now, got.current.age + (Date.now() - got.current.at) / 1000);
  const [f, bad] = e.frac(v);
  const col = e.stepColor(f) ?? 'var(--accent)';
  const stepTxt = fmtNum(c.step, 2).replace(/\.?0+$/, '');
  const set = () => {
    const x = parseNum(input);
    if (!input.trim()) return setErr(t('Empty value'));
    if (x == null) return setErr(t('“{value}” is not a number', { value: input.trim() }));
    act('set', { value: x });
    setErr('');
    setInput('');
  };
  useKeys({
    ArrowUp: () => act('inc'),
    ArrowRight: () => act('inc'),
    ArrowDown: () => act('dec'),
    ArrowLeft: () => act('dec'),
    r: () => act('reset'),
    v: () => setTimeout(() => inp.current?.focus(), 30),
  });
  const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--line-2, var(--line))' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ font: '800 40px/1 var(--mono, monospace)', whiteSpace: 'nowrap' }}>{bad ? '—' : `${fmtNum(f * 100, c.decimals)} %`}</span>
          <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono, monospace)' }}>
            {fmtNum(v, c.decimals)} / {fmtNum(e.hi, 0)}
            {c.unit ? ` ${c.unit}` : ''}
          </span>
          {st?.value != null && <span style={{ marginLeft: 'auto', font: '800 10.5px Inter, system-ui, sans-serif', color: '#38bdf8' }}>{t('SET BY HAND')}</span>}
        </div>
        <div style={{ height: 10, borderRadius: 5, background: 'var(--panel-3, #2a2346)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(f * 100).toFixed(2)}%`, background: col.startsWith('#') ? hex(col) : col }} />
        </div>
      </div>
      <Row label={t('Set value')}>
        <div style={{ display: 'flex', gap: 6, width: '100%' }}>
          <input
            ref={inp}
            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono, monospace)' }}
            value={input}
            placeholder={c.input === 'percent' ? '0 – 100' : `${fmtNum(e.lo, 0)} – ${fmtNum(e.hi, 0)}`}
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === 'Enter') set();
            }}
          />
          <button className="opx-btn violet" onClick={set}>
            {t('Set')} <kbd>V</kbd>
          </button>
        </div>
      </Row>
      {err && <Msg level="error">⛔ {t('{error} — nothing changed on air.', { error: err })}</Msg>}
      <Btns
        list={[
          { label: `− ${stepTxt}`, cls: 'big', keyHint: '↓', onClick: () => act('dec') },
          { label: `+ ${stepTxt}`, cls: 'green big', keyHint: '↑', onClick: () => act('inc') },
          { label: t('↺ Reset'), cls: 'big', keyHint: 'R', confirm: item ? t('{name} is on air: back to the min?', { name: layer.name }) : undefined, onClick: () => act('reset') },
        ]}
      />
    </div>
  );
}

function warnings(l: L, data: Data, state: unknown): Warning[] {
  const out: Warning[] = [];
  const e = effOf(l, data);
  const c = e.c;
  const v = e.target(state as State | undefined);
  const [f, bad, raw] = e.frac(v);
  if (bad) out.push({ level: 'error', op: true, text: t('Min = max ({value}): the bar stays empty — no division by zero. Set a max above the min.', { value: fmtNum(e.lo, 2) }) });
  else if (e.hi < e.lo) out.push({ level: 'warn', text: t('Min is above max: the bar fills backwards.') });
  if (!bad && raw > 1 + 1e-9) out.push({ level: 'info', op: true, text: t('Value {value} is above the max {max}: capped at 100 %.', { value: fmtNum(v, c.decimals), max: fmtNum(e.hi, 0) }) });
  if (!bad && raw < -1e-9) out.push({ level: 'info', op: true, text: t('Value {value} is below the min {min}: capped at 0 %.', { value: fmtNum(v, c.decimals), min: fmtNum(e.lo, 0) }) });
  if (parseNum(interpolateText(l.value ?? '', data)) == null) out.push({ level: 'warn', text: t('The value “{value}” is not a number: 0 is used.', { value: interpolateText(l.value ?? '', data) }) });
  const w = num(l.props.width ?? 0);
  const h = num(l.props.height ?? 0);
  if (c.shape === 'linear' && c.rounded && f > 0) {
    const Lg = c.orient === 'h' ? w : h;
    const C = c.orient === 'h' ? h : w;
    if (f * Lg < Math.min(c.thickness ?? C, C - 4)) out.push({ level: 'info', text: t('Very small value: drawn as a round dot (the bar thickness), never a deformed shape.') });
  }
  if (c.shape === 'segments') {
    const Lg = c.orient === 'h' ? w : h;
    if ((Lg - c.segGap * (c.segments - 1)) / c.segments < 3) out.push({ level: 'warn', text: t('Too many segments for this length: fewer are drawn.') });
  }
  return out;
}

export default defineWidget({
  id: 'progress',
  type: 'progress',
  label: 'Progress bar',
  group: 'Data',
  icon: SlidersHorizontal,
  create: () => ({
    value: '64',
    max: '100',
    duration: 0.6,
    track: '#2a2346',
    props: { width: 1200, height: 140, fill: [0.486, 0.361, 1, 1] },
  }),
  ownsLook: true,
  live: () => true,
  content: ['value', 'max', 'min'],
  Render: ({ layer, r, w, h, data, time, state }) => <View layer={layer} r={r} w={w} h={h} data={data} nowMs={time.nowMs} ageSecs={time.ageSecs} state={state} />,
  Inspector: ({ layer, data, edit }) => <Inspector layer={layer} data={data} edit={edit} />,
  Operator: ({ layer, state, data, act, item, time }) => <Operator layer={layer} state={state} data={data} act={act} item={item} time={time} />,
  warnings: (l, { data, state }) => warnings(l, data, state),
});

/** The timer or counter of the graphic a progress follows. */
function FollowPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const layers = useDesigner((s) => s.template?.layers ?? []);
  const opts = layers
    .filter((l) => l.type === 'counter' || (l.type === 'clock' && ['countdown', 'stopwatch'].includes(T.eff(l as never, {}).mode)))
    .map((l) => ({ value: l.id, label: `${l.name} · ${t(l.type === 'counter' ? 'counter' : T.eff(l as never, {}).mode)}` }));
  return (
    <Row label={t('Follows')}>
      <Dropdown value={value} options={[{ value: '', label: opts.length ? t('Choose…') : t('No timer or counter in this graphic') }, ...opts]} onChange={onChange} />
    </Row>
  );
}

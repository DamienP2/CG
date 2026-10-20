// Image: fits (incl. original size and tile), focal point, crop, rounded / circle mask, stroke,
// colorize, fallback picture when the source is missing.
// Same picture as crates/cg-render/src/wid/image.rs; geometry and actions mirror crates/cg-core/src/wid/image.rs.
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { api, useApp } from '../store';
import { Image } from 'lucide-react';
import { col, cssColor, interpolateText, num } from '../engine/evaluate';
import type { Data } from '../engine/types';
import { AssetPicker, ColorGroupRow, GroupRow } from '../designer/Inspector';
import { Btns, clamp, ColorPick, DataValue, defineWidget, ExposeToggle, Handle, hex, Note, Num, Row, Section, Seg, Toggle, useBound, useExposable, type Warning, withDefaults } from './kit';
import { t, tn } from '../i18n';

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}
export interface Config {
  /** Original / Tile on top of the layer's `fit` (contain / cover / stretch). */
  fitMode?: 'original' | 'tile';
  tileScale?: number;
  /** Kept in view when Cover crops (fractions of the picture). */
  focal?: { x: number; y: number };
  crop?: Crop;
  mask?: 'none' | 'rounded' | 'circle';
  radius?: number;
  colorize?: 'none' | 'replace' | 'tint';
  tint?: string;
  /** Shown when the source cannot be found (empty = the built-in slate). */
  fallback?: string;
  /** Animated sequence: pictures played instead of `src`. */
  frames?: string[];
  fps?: number;
  playMode?: 'loop' | 'once' | 'count';
  loops?: number;
  start?: 'in' | 'manual';
}

/** Operator state of a sequence started by hand (wall-clock ms). */
export interface State {
  playing?: boolean;
  atMs?: number;
  pausedEl?: number;
}

type Fit = 'contain' | 'cover' | 'stretch' | 'original' | 'tile';
type Rect = [number, number, number, number];
type ImgLayer = Config & { id: string; src: string; fit: 'contain' | 'cover' | 'stretch'; props: Record<string, unknown> };

const D = { tileScale: 100, focal: { x: 0.5, y: 0.5 }, crop: { l: 0, t: 0, r: 0, b: 0 }, mask: 'none' as const, radius: 28, colorize: 'none' as const, tint: '#ff3b5c', fallback: '', frames: [] as string[], fps: 12, playMode: 'loop' as const, loops: 3, start: 'in' as const };
const cfg = (c: Config) => withDefaults(D, c);
const fitOf = (l: ImgLayer): Fit => l.fitMode ?? l.fit ?? 'contain';

/** The frame in the box and its radius (mirrors frame_rect). */
function frameRect(c: Config, w: number, h: number): [Rect, number] {
  const k = cfg(c);
  if (k.mask === 'circle') {
    const d = Math.min(w, h);
    return [[(w - d) / 2, (h - d) / 2, d, d], d / 2];
  }
  if (k.mask === 'rounded') return [[0, 0, w, h], Math.min(Math.max(0, k.radius), w / 2, h / 2)];
  return [[0, 0, w, h], 0];
}

/** Crop capped so 5 % of the picture is always left (mirrors crop). */
function cropOf(c: Config): Crop {
  const k = cfg(c).crop;
  const l = clamp(k.l, 0, 0.95);
  const t = clamp(k.t, 0, 0.95);
  return { l, t, r: clamp(k.r, 0, Math.max(0, 0.95 - l)), b: clamp(k.b, 0, Math.max(0, 0.95 - t)) };
}

/** Visible window and whole picture in the frame (mirrors place). */
function place(c: Config, [iw, ih]: [number, number], [fw, fh]: [number, number], fit: Fit, cr: Crop): [Rect, Rect] {
  const focal = cfg(c).focal;
  const cw = Math.max(1e-3, iw * (1 - cr.l - cr.r));
  const ch = Math.max(1e-3, ih * (1 - cr.t - cr.b));
  let sx: number, sy: number, ox: number, oy: number;
  if (fit === 'stretch') [sx, sy, ox, oy] = [fw / cw, fh / ch, 0, 0];
  else {
    const k = fit === 'contain' ? Math.min(fw / cw, fh / ch) : fit === 'cover' ? Math.max(fw / cw, fh / ch) : 1;
    let [x, y] = [(fw - cw * k) / 2, (fh - ch * k) / 2];
    if (fit === 'cover') {
      x = clamp(fw / 2 - (focal.x - cr.l) * iw * k, fw - cw * k, 0);
      y = clamp(fh / 2 - (focal.y - cr.t) * ih * k, fh - ch * k, 0);
    }
    [sx, sy, ox, oy] = [k, k, x, y];
  }
  return [
    [ox, oy, cw * sx, ch * sy],
    [ox - cr.l * iw * sx, oy - cr.t * ih * sy, iw * sx, ih * sy],
  ];
}

/** Where a sequence is (mirrors seq). */
export function seqInfo(c: Config, st: State | undefined, nowMs: number, ageSecs: number) {
  const k = cfg(c);
  const n = Math.max(1, k.frames.length);
  const el = Math.max(0, k.start === 'in' ? ageSecs : st?.playing ? (nowMs - (st.atMs ?? 0)) / 1000 : (st?.pausedEl ?? 0));
  const loops = k.playMode === 'loop' ? Infinity : k.playMode === 'once' ? 1 : Math.max(1, k.loops);
  let f = Math.floor(el * clamp(k.fps, 0.1, 120));
  let ended = false;
  if (f >= n * loops) ((f = n * loops - 1), (ended = true));
  return { idx: f % n, lap: Math.floor(f / n) + 1, loops, ended, el, n };
}

// --------------------------------------------------------------- pictures --
// Natural sizes and failures, per source (module level: warnings read them too).
const sizes = new Map<string, [number, number]>();
const failed = new Set<string>();
const loading = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  subs.forEach((f) => f());
};
const useStore = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  );

function load(src: string) {
  if (!src || sizes.has(src) || failed.has(src) || loading.has(src)) return;
  loading.add(src);
  const img = new window.Image();
  img.onload = () => {
    loading.delete(src);
    sizes.set(src, [img.naturalWidth || 1, img.naturalHeight || 1]);
    bump();
  };
  img.onerror = () => {
    loading.delete(src);
    failed.add(src);
    bump();
  };
  img.src = src;
}

/** 'ok' with its size, 'missing', or 'loading'. */
function status(src: string): { s: 'ok'; size: [number, number] } | { s: 'missing' } | { s: 'loading' } {
  src = src.trim();
  if (!src || failed.has(src)) return { s: 'missing' };
  const z = sizes.get(src);
  if (z) return { s: 'ok', size: z };
  load(src);
  return { s: 'loading' };
}

/** The source in effect: frame of the sequence or the picture. */
function wantedSrc(l: ImgLayer, data: Data, idx = 0) {
  const k = cfg(l);
  return interpolateText(k.frames.length ? k.frames[Math.min(idx, k.frames.length - 1)] : l.src, data).trim();
}

// Designer-only UI: crop editing and the key / fill preview, per layer (not saved).
const ui = { crop: new Set<string>(), view: new Map<string, 'program' | 'fill' | 'key'>() };
const setUi = (fn: () => void) => (fn(), bump());

// --------------------------------------------------------------- drawing --

const px = (r: Rect): CSSProperties => ({ position: 'absolute', left: r[0], top: r[1], width: r[2], height: r[3] });

/** One picture at rectangle P, colorized, in the preview view. */
function Pic({ src, P, colorize, tint, view }: { src: string; P: Rect; colorize: string; tint: string; view: string }) {
  const q = `url("${src.replace(/"/g, '%22')}")`;
  const filters: string[] = [];
  if (colorize === 'tint') filters.push('grayscale(1)');
  if (view === 'key') filters.push('brightness(0) invert(1)');
  const filter = filters.join(' ') || undefined;
  const masked = (bg: string): CSSProperties => ({ ...px(P), background: bg, WebkitMaskImage: q, maskImage: q, WebkitMaskSize: '100% 100%', maskSize: '100% 100%', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat' });
  if (colorize === 'replace') return <div style={masked(view === 'key' ? '#fff' : hex(tint))} />;
  return (
    <>
      <img src={src} alt="" draggable={false} onError={() => (failed.add(src), bump())} style={{ ...px(P), maxWidth: 'none', display: 'block', filter }} />
      {colorize === 'tint' && view !== 'key' && <div style={{ ...masked(hex(tint)), mixBlendMode: 'multiply' }} />}
    </>
  );
}

/** The pulse line of the slate, in ring radii (mirrors SLATE_PULSE). */
const SLATE_PULSE: [number, number][] = [
  [-0.73, 0.08],
  [-0.36, 0.08],
  [-0.19, -0.4],
  [0.02, 0.52],
  [0.23, -0.6],
  [0.42, 0.08],
  [0.75, 0.08],
];

/** The built-in slate: neutral, branded, never an error on air (same as the Rust one). */
function Slate({ F }: { F: Rect }) {
  const [x, y, w, h] = F;
  const s = Math.min(w, h);
  const [cx, cy, rr] = [x + w / 2, y + h / 2, s * 0.2];
  const id = `slate${Math.round(x)}_${Math.round(w)}`;
  return (
    <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width="100%" height="100%">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x} y1={y} x2={x + w} y2={y + h}>
          <stop offset="0" stopColor="#1b1442" />
          <stop offset="1" stopColor="#3b0d2a" />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={w} height={h} fill={`url(#${id})`} />
      <circle cx={cx} cy={cy} r={rr} fill="none" stroke="#fff" strokeWidth={s * 0.045} />
      <path d={SLATE_PULSE.map(([u, v], i) => `${i ? 'L' : 'M'}${cx + u * rr} ${cy + v * rr}`).join('')} fill="none" stroke="#ff3b5c" strokeWidth={s * 0.038} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** What is shown: the picture, the fallback (missing), or the slate. */
function resolve(l: ImgLayer, data: Data, idx: number) {
  const k = cfg(l);
  const src = wantedSrc(l, data, idx);
  const st = status(src);
  if (st.s !== 'missing') return { src, st, missing: false };
  const fb = interpolateText(k.fallback, data).trim();
  return { src: fb, st: status(fb), missing: true };
}

function ImageView({ layer, r, w, h, data, time, state, designer }: { layer: ImgLayer; r: Record<string, unknown>; w: number; h: number; data: Data; time: { nowMs: number; ageSecs: number }; state: unknown; designer?: boolean }) {
  useStore();
  const k = cfg(layer);
  // Every frame of a sequence decoded once, up front: cycling never stutters.
  useEffect(() => k.frames.forEach((f) => load(interpolateText(f, data).trim())), [k.frames, data]);
  const sq = seqInfo(layer, state as State, time.nowMs, time.ageSecs);
  const { src, st, missing } = resolve(layer, data, sq.idx);
  const view = designer ? (ui.view.get(layer.id) ?? 'program') : 'program';
  const [F, radius] = frameRect(layer, w, h);
  const sw = num(r.strokeWidth as never);
  const bg: CSSProperties = view === 'program' ? {} : { background: '#000' };
  const fit: Fit = missing ? 'cover' : fitOf(layer);
  const colorize = missing ? 'none' : k.colorize;
  let inner: ReactNode = null;
  if (st.s === 'missing') inner = <Slate F={[0, 0, F[2], F[3]]} />;
  else if (st.s === 'ok') {
    const [iw, ih] = st.size;
    if (designer && ui.crop.has(layer.id) && fit !== 'tile' && !missing) {
      // Crop editing: the whole picture (contain), outside the crop dimmed.
      const [R] = place(layer, [iw, ih], [w, h], 'contain', { l: 0, t: 0, r: 0, b: 0 });
      const c = cropOf(layer);
      const [cx, cy, cw, ch] = [R[0] + c.l * R[2], R[1] + c.t * R[3], R[2] * (1 - c.l - c.r), R[3] * (1 - c.t - c.b)];
      return (
        <div style={{ position: 'absolute', inset: 0, ...bg }}>
          <Pic src={src} P={R} colorize="none" tint="" view={view} />
          <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
            <path fillRule="evenodd" fill="#000" opacity={0.6} d={`M${R[0]} ${R[1]}h${R[2]}v${R[3]}h${-R[2]}Z M${cx} ${cy}h${cw}v${ch}h${-cw}Z`} />
            <rect x={cx} y={cy} width={cw} height={ch} fill="none" stroke="#f59e0b" strokeWidth={4} strokeDasharray="14 10" />
          </svg>
        </div>
      );
    }
    if (fit === 'tile') {
      const t = clamp(k.tileScale, 1, 1000) / 100;
      const q = `url("${src.replace(/"/g, '%22')}")`;
      const size = `${iw * t}px ${ih * t}px`;
      inner =
        colorize === 'replace' ? (
          <div style={{ position: 'absolute', inset: 0, background: view === 'key' ? '#fff' : hex(k.tint), WebkitMaskImage: q, maskImage: q, WebkitMaskSize: size, maskSize: size, WebkitMaskRepeat: 'repeat', maskRepeat: 'repeat' }} />
        ) : (
          <>
            <div style={{ position: 'absolute', inset: 0, backgroundImage: q, backgroundSize: size, backgroundRepeat: 'repeat', filter: view === 'key' ? 'brightness(0) invert(1)' : colorize === 'tint' ? 'grayscale(1)' : undefined }} />
            {colorize === 'tint' && view !== 'key' && <div style={{ position: 'absolute', inset: 0, background: hex(k.tint), mixBlendMode: 'multiply', WebkitMaskImage: q, maskImage: q, WebkitMaskSize: size, maskSize: size }} />}
          </>
        );
    } else {
      const [win, pic] = place(layer, [iw, ih], [F[2], F[3]], fit, missing ? { l: 0, t: 0, r: 0, b: 0 } : cropOf(layer));
      inner = (
        <div style={{ ...px(win), overflow: 'hidden', isolation: 'isolate' }}>
          <Pic src={src} P={[pic[0] - win[0], pic[1] - win[1], pic[2], pic[3]]} colorize={colorize} tint={k.tint} view={view} />
        </div>
      );
    }
  }
  return (
    <div style={{ position: 'absolute', inset: 0, ...bg }}>
      <div style={{ ...px(F), borderRadius: radius, overflow: 'hidden', isolation: 'isolate' }}>{inner}</div>
      {sw > 0 && <div style={{ ...px(F), borderRadius: radius, boxShadow: `inset 0 0 0 ${sw}px ${view === 'key' ? '#fff' : cssColor(col(r.stroke as never))}`, pointerEvents: 'none' }} />}
    </div>
  );
}

// ------------------------------------------------------------- inspector --

/** Source thumbnail with the focal point and the crop; a click sets the focal point. */
function Thumb({ src, size, layer, edit }: { src: string; size: [number, number]; layer: ImgLayer; edit: (fn: (l: ImgLayer) => void, key?: string) => void }) {
  const k = cfg(layer);
  const c = cropOf(layer);
  return (
    <div
      style={{ position: 'relative', width: `min(100%, ${Math.round((170 * size[0]) / size[1])}px)`, aspectRatio: `${size[0]} / ${size[1]}`, background: `url("${src}") 0 0 / 100% 100%`, borderRadius: 6, margin: '4px auto', cursor: 'crosshair' }}
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        edit((l) => void (l.focal = { x: +clamp((e.clientX - b.left) / b.width, 0, 1).toFixed(3), y: +clamp((e.clientY - b.top) / b.height, 0, 1).toFixed(3) }));
      }}
    >
      <div style={{ position: 'absolute', left: `${c.l * 100}%`, top: `${c.t * 100}%`, right: `${c.r * 100}%`, bottom: `${c.b * 100}%`, outline: '2px dashed #f59e0b' }} />
      <div style={{ position: 'absolute', left: `${k.focal.x * 100}%`, top: `${k.focal.y * 100}%`, width: 16, height: 16, margin: -8, borderRadius: '50%', border: '3px solid #fff', background: '#f59e0b', boxShadow: '0 1px 4px #000' }} />
    </div>
  );
}

/** The picture: chosen in the library, or exposed to the Operator (who then picks it); from data it is read only. */
function PictureRow() {
  const x = useExposable('src', '', undefined, 'image');
  const b = useBound();
  if (x.wired) return <DataValue label={t('Picture')} value={interpolateText(x.raw, x.data)} />;
  return (
    <Row label={t('Picture')} tail={x.canExpose ? <ExposeToggle on={x.exposed} onClick={x.toggleExpose} /> : undefined}>
      <AssetPicker
        value={x.shown}
        clearable={false}
        onChange={(v) => {
          x.change(v);
          // A new picture: the old crop means nothing for it.
          if (!x.exposed) b.set('crop', undefined);
        }}
      />
    </Row>
  );
}

export default defineWidget({
  id: 'image',
  type: 'image',
  label: 'Image',
  group: 'Shapes & tools',
  icon: Image,
  create: () => ({ src: '', fit: 'contain', props: { width: 800, height: 560, stroke: [1, 1, 1, 1], strokeWidth: 0 } }),
  ownsLook: true,
  content: ['src'],
  live: (l) => (l.frames?.length ?? 0) > 0,
  Render: ({ layer, r, w, h, data, time, state, designer }) => <ImageView layer={layer as unknown as ImgLayer} r={r as never} w={w} h={h} data={data} time={time} state={state} designer={designer} />,
  Inspector: ({ layer, data, edit }) => {
    useStore();
    const l = layer as unknown as ImgLayer;
    const ed = edit as unknown as (fn: (l: ImgLayer) => void, key?: string) => void;
    const k = cfg(l);
    const fit = fitOf(l);
    const { src, st, missing } = resolve(l, data, 0);
    const cropping = ui.crop.has(layer.id);
    const view = ui.view.get(layer.id) ?? 'program';
    const stroke = num(l.props.strokeWidth as never) > 0;
    return (
      <>
        <Section id="image-source" title={t('Picture')}>
          <PictureRow />
          <Row expose="fallback" exposeValue={k.fallback} label={t('Fallback')}>
            <AssetPicker value={k.fallback} title={t('Choose the fallback picture')} placeholder={t('None')} onChange={(v) => ed((x) => void (x.fallback = v || undefined))} />
          </Row>
        </Section>
        <Sequence k={k} ed={ed} />
        <Section id="image-fit" title={t('Fit & crop')}>
          <Seg
            expose="fit"
            exposeValue={l.fit}
            exposeOptions={[
              ['contain', t('Contain')],
              ['cover', t('Cover')],
              ['stretch', t('Stretch')],
            ]}
            label={t('Fit')}
            value={fit}
            onChange={(v) =>
              ed((x) => {
                if (v === 'original' || v === 'tile') x.fitMode = v;
                else ((x.fitMode = undefined), (x.fit = v));
              })
            }
            options={[
              ['contain', t('Contain')],
              ['cover', t('Cover')],
              ['stretch', t('Stretch')],
              ['original', t('Original')],
              ['tile', t('Tile')],
            ]}
          />
          {fit === 'tile' && <Num label={t('Tile size')} path="tileScale" value={k.tileScale} min={5} max={400} unit="%" />}
          {fit === 'cover' && !missing && st.s === 'ok' && (
            <Row expose={['focal.x', 'focal.y']} exposeValue={{ 'focal.x': k.focal.x, 'focal.y': k.focal.y }} label={t('Focal point')}>
              <Thumb src={src} size={st.size} layer={l} edit={ed} />
            </Row>
          )}
          {fit !== 'tile' && (
            <>
              <Toggle label={t('Crop')} value={cropping} onChange={(v) => setUi(() => (v ? ui.crop.add(layer.id) : ui.crop.delete(layer.id)))} />
              {cropping && (
                <>
                  {(['l', 'r', 't', 'b'] as const).map((s) => (
                    <Num
                      expose={`crop.${s}`}
                      exposeValue={cropOf(l)[s]}
                      key={s}
                      label={t({ l: 'Left', t: 'Top', r: 'Right', b: 'Bottom' }[s])}
                      value={Math.round(cropOf(l)[s] * 100)}
                      min={0}
                      max={95}
                      unit="%"
                      onChange={(v) => ed((x) => void (x.crop = { ...cropOf(x), [s]: v / 100 }), `crop-${layer.id}`)}
                    />
                  ))}
                  <Btns list={[{ label: t('Reset crop'), cls: 'ghost', onClick: () => ed((x) => void delete x.crop) }]} />
                </>
              )}
            </>
          )}
        </Section>
        <Section id="image-shape" title={t('Shape')}>
          <Seg
            label={t('Mask')}
            path="mask"
            value={k.mask}
            options={[
              ['none', t('Square')],
              ['rounded', t('Rounded')],
              ['circle', t('Circle')],
            ]}
          />
          {k.mask === 'rounded' && <Num label={t('Radius')} path="radius" value={k.radius} min={0} max={2000} unit="px" />}
          <Toggle
            expose="props.strokeWidth"
            exposeValue={num(l.props.strokeWidth as never)}
            label={t('Stroke')}
            value={stroke}
            onChange={(v) =>
              ed((x) => {
                x.props.strokeWidth = v ? 4 : 0;
                if (v && col((x.props.stroke as never) ?? [0, 0, 0, 0])[3] === 0) x.props.stroke = [1, 1, 1, 1];
              })
            }
          />
          {stroke && (
            <>
              <ColorGroupRow layer={layer} prop="stroke" label={t('Color')} />
              <GroupRow layer={layer} spec={{ label: t('Width'), props: ['strokeWidth'], min: 0, suffix: 'px' }} />
            </>
          )}
        </Section>
        <Section id="image-colorize" title={t('Colorize')}>
          <Seg
            label={t('Mode')}
            path="colorize"
            value={k.colorize}
            options={[
              ['none', t('Off')],
              ['replace', t('Replace'), t('Every opaque pixel takes the colour (one-colour logos)')],
              ['tint', t('Tint'), t('Greys take the colour')],
            ]}
          />
          {k.colorize !== 'none' && <ColorPick label={t('Colour')} path="tint" value={D.tint} />}
        </Section>
        <Section id="image-preview" title={t('Output preview')} closed>
          <Seg
            label={t('View')}
            value={view}
            onChange={(v) => setUi(() => ui.view.set(layer.id, v))}
            options={[
              ['program', t('Program')],
              ['fill', t('Fill')],
              ['key', t('Key')],
            ]}
          />
        </Section>
      </>
    );
  },

  // A sequence started by hand: the operator plays it.
  Operator: ({ layer, state, act }) => {
    const k = cfg(layer as unknown as ImgLayer);
    if (!k.frames.length) return null;
    const st = (state ?? {}) as State;
    return (
      <>
        <Btns
          list={[
            { label: st.playing ? t('Pause') : t('Play'), cls: st.playing ? '' : 'violet', onClick: () => act(st.playing ? 'pause' : 'play') },
            { label: t('Restart'), cls: 'ghost', onClick: () => act('restart') },
          ]}
        />
        <Note>
          {tn(k.frames.length, '{n} frame at {fps} fps', '{n} frames at {fps} fps', { fps: k.fps })} · {k.playMode === 'loop' ? t('loops') : k.playMode === 'once' ? t('plays once') : tn(k.loops, 'plays {n} time', 'plays {n} times')}
          {k.start === 'in' ? ` · ${t('starts at the In')}` : ''}
        </Note>
      </>
    );
  },

  Overlay: ({ layer, w, h, scale, edit }) => {
    useStore();
    const l = layer as unknown as ImgLayer;
    const ed = edit as unknown as (fn: (l: ImgLayer) => void, key?: string) => void;
    const fit = fitOf(l);
    const { st, missing } = resolve(l, {}, 0);
    if (st.s !== 'ok' || missing) return null;
    const c = cropOf(l);
    if (ui.crop.has(layer.id) && fit !== 'tile') {
      const [R] = place(l, st.size, [w, h], 'contain', { l: 0, t: 0, r: 0, b: 0 });
      const fx = (x: number) => (x - R[0]) / R[2];
      const fy = (y: number) => (y - R[1]) / R[3];
      const r3 = (v: number) => +v.toFixed(3);
      return (
        <>
          <Handle x={R[0] + c.l * R[2]} y={R[1] + c.t * R[3]} scale={scale} label={t('Crop: top left')} onDrag={(x, y) => ed((q) => void (q.crop = { ...cropOf(q), l: r3(clamp(fx(x), 0, 0.95 - c.r)), t: r3(clamp(fy(y), 0, 0.95 - c.b)) }), `crop-${layer.id}`)} />
          <Handle x={R[0] + (1 - c.r) * R[2]} y={R[1] + (1 - c.b) * R[3]} scale={scale} label={t('Crop: bottom right')} onDrag={(x, y) => ed((q) => void (q.crop = { ...cropOf(q), r: r3(clamp(1 - fx(x), 0, 0.95 - c.l)), b: r3(clamp(1 - fy(y), 0, 0.95 - c.t)) }), `crop-${layer.id}`)} />
        </>
      );
    }
    if (fit === 'cover') {
      const k = cfg(l);
      const [F] = frameRect(l, w, h);
      const ux = (k.focal.x - c.l) / (1 - c.l - c.r);
      const uy = (k.focal.y - c.t) / (1 - c.t - c.b);
      return (
        <Handle
          x={F[0] + clamp(ux, 0, 1) * F[2]}
          y={F[1] + clamp(uy, 0, 1) * F[3]}
          scale={scale}
          label={t('Focal point: kept in view when Cover crops')}
          onDrag={(x, y) =>
            ed((q) => {
              const cc = cropOf(q);
              const [G] = frameRect(q, w, h);
              q.focal = { x: +(cc.l + clamp((x - G[0]) / G[2], 0, 1) * (1 - cc.l - cc.r)).toFixed(3), y: +(cc.t + clamp((y - G[1]) / G[3], 0, 1) * (1 - cc.t - cc.b)).toFixed(3) };
            }, `focal-${layer.id}`)
          }
        />
      );
    }
    return null;
  },
  warnings: (layer, { data, state }) => {
    const l = layer as unknown as ImgLayer;
    const k = cfg(l);
    const out: Warning[] = [];
    const wanted = wantedSrc(l, data, 0);
    const r = resolve(l, data, 0);
    if (r.missing) {
      const slate = r.st.s === 'missing';
      const also = !!k.fallback && slate;
      const v = { file: wanted, fallback: slate ? k.fallback : r.src };
      const text = wanted
        ? slate
          ? also
            ? t('File not found: {file}. On air: the channel slate instead (the fallback {fallback} cannot be found either).', v)
            : t('File not found: {file}. On air: the channel slate instead.', v)
          : t('File not found: {file}. On air: the fallback {fallback} instead.', v)
        : slate
          ? also
            ? t('No picture chosen: the channel slate is shown (the fallback {fallback} cannot be found either).', v)
            : t('No picture chosen: the channel slate is shown.', v)
          : t('No picture chosen: the fallback {fallback} is shown.', v);
      out.push({ level: 'error', text, op: true });
    }
    const missingFrames = k.frames.filter((f) => status(interpolateText(f, data)).s === 'missing').length;
    if (k.frames.length && missingFrames) out.push({ level: 'warn', text: tn(missingFrames, '{n} frame of the sequence cannot be found: the fallback shows in their place.', '{n} frames of the sequence cannot be found: the fallback shows in their place.'), op: true });
    if (k.colorize !== 'none' && r.missing) out.push({ level: 'info', text: t('Colorize does not apply to the fallback picture.') });
    if (k.frames.length && !r.missing && k.start === 'manual') {
      const s = seqInfo(l, state as State, Date.now(), 0);
      if (!(state as State | undefined)?.playing || s.ended) out.push({ level: 'info', text: s.ended ? t('Sequence finished on frame {n}/{total}.', { n: s.idx + 1, total: s.n }) : t('Sequence paused on frame {n}/{total}.', { n: s.idx + 1, total: s.n }), op: 'only' });
    }
    return out;
  },
});

/** Animated sequence: frames played instead of the picture (an animated GIF / APNG is split into frames). */
function Sequence({ k, ed }: { k: ReturnType<typeof cfg>; ed: (fn: (l: ImgLayer) => void, key?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pid = useApp((s) => s.project?.id);
  const toast = useApp((s) => s.toast);
  const importFile = async (f: File) => {
    if (!pid) return;
    setBusy(true);
    try {
      const r = await api<{ frames: string[]; fps: number }>('POST', `/api/projects/${encodeURIComponent(pid)}/sequence/${encodeURIComponent(f.name)}`, f);
      ed((x) => {
        x.frames = r.frames;
        x.fps = Math.round(r.fps * 100) / 100;
      });
      toast(tn(r.frames.length, '{n} frame at {fps} fps', '{n} frames at {fps} fps', { fps: Math.round(r.fps * 10) / 10 }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const n = k.frames.length;
  return (
    <Section id="image-anim" title={n ? tn(n, 'Animation · {n} frame', 'Animation · {n} frames') : t('Animation')} closed={!n}>
      <Row label={t('Import')}>
        <label className={`btn small ${busy ? 'disabled' : ''}`} title={t("An animated GIF or PNG (APNG): split into frames in the project's media")}>
          {busy ? t('Splitting…') : t('Animated GIF / PNG…')}
          <input type="file" accept="image/gif,image/png,image/apng" hidden disabled={busy} onChange={(e) => (e.target.files?.[0] && void importFile(e.target.files[0]), (e.target.value = ''))} />
        </label>
      </Row>
      {n > 0 && (
        <div className="seq-frames">
          {k.frames.map((f, i) => (
            <span key={i} className="seq-frame" title={f}>
              <img src={f} alt="" loading="lazy" />
              <i>{i + 1}</i>
              <button title={t('Remove this frame')} onClick={() => ed((x) => void (x.frames = cfg(x).frames.filter((_, j) => j !== i)))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Row label={t('Add a frame')}>
        <AssetPicker value="" placeholder={t('Choose a picture…')} title={t('Add a frame at the end')} onChange={(v) => v && ed((x) => void (x.frames = [...cfg(x).frames, v]))} />
      </Row>
      {n > 0 && (
        <>
          <Num label={t('Speed')} path="fps" value={k.fps} min={0.1} max={120} step={1} unit="fps" />
          <Seg
            label={t('Play')}
            path="playMode"
            value={k.playMode}
            options={[
              ['loop', t('Loop')],
              ['once', t('Once')],
              ['count', t('Times')],
            ]}
          />
          {k.playMode === 'count' && <Num label={t('Times')} path="loops" value={k.loops} min={1} max={999} />}
          <Seg
            label={t('Start')}
            path="start"
            value={k.start}
            options={[
              ['in', t('At the In')],
              ['manual', t('By the operator')],
            ]}
          />
          <Btns list={[{ label: t('Remove the animation'), cls: 'ghost', onClick: () => ed((x) => void (x.frames = [])) }]} />
        </>
      )}
    </Section>
  );
}

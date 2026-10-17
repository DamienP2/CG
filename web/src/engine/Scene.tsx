// HTML5 renderer: same conventions as crates/cg-render (box at x/y in parent
// space, rotate/scale around the anchor, crop as a reveal mask).
import { createContext, memo, useContext, useEffect, useReducer, type CSSProperties } from 'react';
import { col, cssColor, holdFrame, interpolateText, num, parseHex, resolveLayer, type Resolved } from './evaluate';
import type { Data, FontStyle, Layer, LayerType, Template, TextAlign, VerticalAlign } from './types';
import * as W from './widgets';
import { applyLogic, measureLayer } from './logic';
import { useFonts } from './fonts';

/** Time seen by widgets; provided per playout layer (or by the designer). */
export const TimeContext = createContext<W.TimeCtx>({ nowMs: Date.now(), ageSecs: 0, defaultTz: '' });

/** Layers whose look depends on the clock: their scene re-renders every frame. */
export const LIVE_TYPES: ReadonlySet<LayerType> = new Set([
  'clock',
  'ticker',
  'roll',
  'analogClock',
  'counter',
  'progress',
  'rotator',
  'typewriter',
  'slideshow',
  'barChart',
]);

export const hasLiveWidgets = (t: Template) => t.layers.some((l) => l.visible && LIVE_TYPES.has(l.type));

interface SceneProps {
  template: Template;
  frame: number;
  data: Data;
  /** Render hidden layers' ids for hit-testing in the designer. */
  interactive?: boolean;
}

export const LINE_HEIGHT = 1.2;

/** Layers changed by the template's logic graph (resolved values). */
const LogicContext = createContext<Map<string, Resolved>>(new Map());

function layerStyle(layer: Layer, frame: number, data: Data, hold: number, logic?: Resolved): { style: CSSProperties; text?: string; src?: string } {
  const r = logic ?? resolveLayer(layer, frame, data, hold);
  const w = num(r.width);
  const h = num(r.height);
  const style: CSSProperties = {
    position: 'absolute',
    left: num(r.x),
    top: num(r.y),
    width: w,
    height: h,
    opacity: num(r.opacity),
    transformOrigin: `${num(r.anchorX) * 100}% ${num(r.anchorY) * 100}%`,
    transform: `rotate(${num(r.rotation)}deg) scale(${num(r.scaleX)}, ${num(r.scaleY)})`,
    boxSizing: 'border-box',
  };
  const cl = num(r.cropLeft);
  const cr = num(r.cropRight);
  const ct = num(r.cropTop);
  const cb = num(r.cropBottom);
  if (cl > 0 || cr > 0 || ct > 0 || cb > 0) {
    const p = (v: number) => `${Math.min(1, Math.max(0, v)) * 100}%`;
    style.clipPath = `inset(${p(ct)} ${p(cr)} ${p(cb)} ${p(cl)})`;
  }
  const fill = cssColor(col(r.fill));
  const strokeW = num(r.strokeWidth);
  const stroke = cssColor(col(r.stroke));
  const strokeCss = (s: CSSProperties) => {
    if (strokeW > 0) {
      s.outline = `${strokeW}px solid ${stroke}`;
      s.outlineOffset = -strokeW / 2;
    }
  };
  switch (layer.type) {
    case 'group':
      if (layer.props.fill !== undefined || layer.tracks.fill) style.background = fill;
      if (layer.clip) style.overflow = 'hidden';
      style.borderRadius = num(r.cornerRadius);
      return { style };
    case 'rect':
      style.background = fill;
      style.borderRadius = num(r.cornerRadius);
      strokeCss(style);
      return { style };
    case 'ellipse':
      style.background = fill;
      style.borderRadius = '50%';
      strokeCss(style);
      return { style };
    case 'text': {
      let text = interpolateText(layer.text, data);
      if (layer.uppercase) text = text.toUpperCase();
      Object.assign(style, {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: layer.verticalAlign === 'top' ? 'flex-start' : layer.verticalAlign === 'bottom' ? 'flex-end' : 'center',
        textAlign: layer.align,
        color: fill,
        fontFamily: `"${layer.fontFamily}", Inter, system-ui, sans-serif`,
        fontWeight: layer.fontWeight,
        fontSize: num(r.fontSize),
        letterSpacing: num(r.letterSpacing),
        lineHeight: LINE_HEIGHT,
        whiteSpace: layer.wrap ? 'pre-wrap' : 'pre',
        overflow: 'visible',
        fontKerning: 'normal',
      } satisfies CSSProperties);
      if (strokeW > 0) (style as Record<string, unknown>).WebkitTextStroke = `${strokeW}px ${stroke}`;
      return { style, text };
    }
    case 'image':
      return { style, src: interpolateText(layer.src, data) };
    default:
      // Widgets draw their own content (see WidgetContent).
      return { style };
  }
}

const hexColor = (s: string, fallback = 'transparent') => {
  const c = parseHex(s);
  return c ? cssColor(c) : fallback;
};

const justify = (v: VerticalAlign) => (v === 'top' ? 'flex-start' : v === 'bottom' ? 'flex-end' : 'center');

/** A block of text in a box, laid out like the Rust text engine. */
function TextBox({
  text,
  font,
  r,
  align,
  valign,
  box,
  color,
  stroke = true,
  opacity = 1,
}: {
  text: string;
  font: FontStyle;
  r: Resolved;
  align: TextAlign;
  valign: VerticalAlign;
  box: [number, number, number, number];
  color?: string;
  stroke?: boolean;
  opacity?: number;
}) {
  if (!text) return null;
  const strokeW = num(r.strokeWidth);
  const style: CSSProperties = {
    position: 'absolute',
    left: box[0],
    top: box[1],
    width: box[2],
    height: box[3],
    opacity,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: justify(valign),
    textAlign: align,
    color: color ?? cssColor(col(r.fill)),
    fontFamily: `"${font.fontFamily}", Inter, system-ui, sans-serif`,
    fontWeight: font.fontWeight,
    fontSize: num(r.fontSize),
    letterSpacing: num(r.letterSpacing),
    lineHeight: LINE_HEIGHT,
    whiteSpace: 'pre',
    fontKerning: 'normal',
  };
  if (stroke && strokeW > 0) (style as Record<string, unknown>).WebkitTextStroke = `${strokeW}px ${cssColor(col(r.stroke))}`;
  return (
    <div style={style}>
      {text.split('\n').map((line, i) => (
        <div key={i} style={{ width: '100%' }}>
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

function QrCode({ content, w, h, fill, background }: { content: string; w: number; h: number; fill: string; background: string }) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => W.onQrLoaded(rerender), []);
  const side = Math.min(w, h);
  const qr = content ? W.qrModules(content) : null;
  const rects: React.ReactNode[] = [];
  if (qr) {
    for (let i = 0; i < qr.modules.length; i++) {
      if (qr.modules[i] === '1') rects.push(<rect key={i} x={(i % qr.size) + 4} y={Math.floor(i / qr.size) + 4} width={1.02} height={1.02} />);
    }
  }
  const n = (qr?.size ?? 21) + 8;
  return (
    <svg style={{ position: 'absolute', left: (w - side) / 2, top: (h - side) / 2, width: side, height: side }} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill={background} />
      <g fill={fill}>{rects}</g>
    </svg>
  );
}

/** Content of a widget layer; reads the time context so only it re-renders. */
function WidgetContent({ layer, frame, data, hold }: { layer: Layer; frame: number; data: Data; hold: number }) {
  const base = useContext(TimeContext);
  const time = base.layerAge ? { ...base, ageSecs: base.layerAge(layer) } : base;
  const r = useContext(LogicContext).get(layer.id) ?? resolveLayer(layer, frame, data, hold);
  const w = num(r.width);
  const h = num(r.height);
  const age = time.ageSecs;
  const up = (s: string, font: FontStyle) => (font.uppercase ? s.toUpperCase() : s);
  const clip: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden' };
  switch (layer.type) {
    case 'clock':
      return <TextBox text={up(W.clockText(layer.mode, layer.format, layer.timezone, layer.target, data, time), layer)} font={layer} r={r} align={layer.align} valign={layer.verticalAlign} box={[0, 0, w, h]} />;
    case 'counter':
      return <TextBox text={up(W.counterText(layer, data, age), layer)} font={layer} r={r} align={layer.align} valign={layer.verticalAlign} box={[0, 0, w, h]} />;
    case 'typewriter':
      return <TextBox text={up(W.typewriterText(layer.text, layer.speed, layer.cursor, data, age), layer)} font={layer} r={r} align={layer.align} valign={layer.verticalAlign} box={[0, 0, w, h]} />;
    case 'rotator': {
      const items = W.lines(layer.text, data);
      if (!items.length) return null;
      const [idx, alpha] = W.rotatorState(items.length, layer.interval, layer.fade, age);
      return <TextBox text={up(items[idx], layer)} font={layer} r={r} align={layer.align} valign={layer.verticalAlign} box={[0, 0, w, h]} opacity={alpha} />;
    }
    case 'ticker': {
      const items = W.lines(layer.text, data);
      if (!items.length) return null;
      const strip = up(items.join(layer.separator) + layer.separator, layer);
      const ls = num(r.letterSpacing);
      const cycle = W.textWidth(strip, layer.fontFamily, layer.fontWeight, num(r.fontSize), ls) + ls;
      return (
        <div style={clip}>
          {W.scrollPositions(w, cycle, layer.speed * age, true).map((x, i) => (
            <TextBox key={i} text={strip} font={layer} r={r} align="left" valign={layer.verticalAlign} box={[x, 0, cycle, h]} />
          ))}
        </div>
      );
    }
    case 'roll': {
      const body = up(interpolateText(layer.text, data), layer);
      const block = body.split('\n').length * num(r.fontSize) * LINE_HEIGHT;
      const cycle = layer.loop ? block + h : block;
      return (
        <div style={clip}>
          {W.scrollPositions(h, cycle, layer.speed * age, layer.loop).map((y, i) => (
            <TextBox key={i} text={body} font={layer} r={r} align={layer.align} valign="top" box={[0, y, w, block]} />
          ))}
        </div>
      );
    }
    case 'analogClock': {
      const [ha, ma, sa] = W.clockHands(layer.timezone, time);
      const d = Math.min(w, h);
      const [cx, cy, rad] = [w / 2, h / 2, d / 2];
      const ink = cssColor(col(r.stroke));
      const accent = hexColor(layer.accent, 'white');
      const seg = (deg: number, r0: number, r1: number) => {
        const a = (deg * Math.PI) / 180;
        return { x1: cx + Math.sin(a) * r0, y1: cy - Math.cos(a) * r0, x2: cx + Math.sin(a) * r1, y2: cy - Math.cos(a) * r1 };
      };
      return (
        <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width={w} height={h} strokeLinecap="round">
          <circle cx={cx} cy={cy} r={rad} fill={cssColor(col(r.fill))} />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} {...seg(i * 30, rad * (i % 3 === 0 ? 0.78 : 0.84), rad * 0.92)} stroke={ink} strokeWidth={Math.max(1.5, d * 0.02)} />
          ))}
          <line {...seg(ha, -rad * 0.08, rad * 0.5)} stroke={ink} strokeWidth={d * 0.06} />
          <line {...seg(ma, -rad * 0.08, rad * 0.74)} stroke={ink} strokeWidth={d * 0.04} />
          {layer.seconds && <line {...seg(sa, -rad * 0.15, rad * 0.86)} stroke={accent} strokeWidth={Math.max(1, d * 0.012)} />}
          <circle cx={cx} cy={cy} r={d * 0.035} fill={layer.seconds ? accent : ink} />
        </svg>
      );
    }
    case 'progress': {
      const ratio = W.progressRatio(layer.value, layer.max, layer.duration, data, age);
      const radius = num(r.cornerRadius);
      return (
        <>
          <div style={{ position: 'absolute', inset: 0, background: hexColor(layer.track), borderRadius: radius }} />
          <div style={{ position: 'absolute', left: 0, top: 0, height: h, width: w * ratio, background: cssColor(col(r.fill)), borderRadius: Math.min(radius, (w * ratio) / 2) }} />
        </>
      );
    }
    case 'slideshow': {
      const list = W.lines(layer.images, data);
      if (!list.length) return null;
      const [cur, next, mix] = W.slideshowState(list.length, layer.interval, layer.fade, age);
      const img = (src: string, opacity: number) => (
        <img key={src + opacity} src={src} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: layer.fit === 'stretch' ? 'fill' : layer.fit, opacity }} />
      );
      return (
        <>
          {img(list[cur], 1 - mix)}
          {mix > 0 && img(list[next], mix)}
        </>
      );
    }
    case 'qrCode':
      return <QrCode content={interpolateText(layer.data, data)} w={w} h={h} fill={cssColor(col(r.fill))} background={hexColor(layer.background, 'white')} />;
    case 'barChart': {
      const rows = W.chartRows(layer.text, data);
      if (!rows.length) return null;
      const total = rows.reduce((a, [, v]) => a + Math.max(0, v), 0);
      const max = rows.reduce((a, [, v]) => Math.max(a, v), 0);
      const g = W.grow(layer.duration, age);
      const rowH = h / rows.length;
      const [labelW, valueW] = [w * 0.28, w * 0.16];
      const barX = labelW + w * 0.02;
      const barW = Math.max(0, w - labelW - valueW - w * 0.04);
      const color = hexColor(layer.textColor, 'white');
      return (
        <>
          {rows.map(([label, v], i) => {
            const y = i * rowH;
            const bh = rowH * 0.56;
            const by = y + (rowH - bh) / 2;
            const frac = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
            const shown = layer.percent
              ? `${W.formatNumber((total > 0 ? (v / total) * 100 : 0) * g, 0, false)}%`
              : W.formatNumber(v * g, Number.isInteger(v) ? 0 : 1, true);
            return (
              <div key={i}>
                <div style={{ position: 'absolute', left: barX, top: by, width: barW, height: bh, background: hexColor(layer.track), borderRadius: bh / 4 }} />
                <div style={{ position: 'absolute', left: barX, top: by, width: barW * frac * g, height: bh, background: cssColor(col(r.fill)), borderRadius: bh / 4 }} />
                <TextBox text={up(label, layer)} font={layer} r={r} align="left" valign="middle" box={[0, y, labelW, rowH]} color={color} stroke={false} />
                <TextBox text={shown} font={layer} r={r} align="right" valign="middle" box={[w - valueW, y, valueW, rowH]} color={color} stroke={false} />
              </div>
            );
          })}
        </>
      );
    }
    default:
      return null;
  }
}

const LayerNode = memo(function LayerNode({
  layer,
  childrenOf,
  frame,
  data,
  hold,
  interactive,
}: {
  layer: Layer;
  childrenOf: Map<string | null, Layer[]>;
  frame: number;
  data: Data;
  hold: number;
  interactive?: boolean;
}) {
  const logic = useContext(LogicContext).get(layer.id);
  const { style, text, src } = layerStyle(layer, frame, data, hold, logic);
  const kids = childrenOf.get(layer.id) ?? [];
  return (
    <div style={style} data-layer-id={interactive ? layer.id : undefined}>
      {text !== undefined &&
        text.split('\n').map((line, i) => (
          <div key={i} style={{ width: '100%' }}>
            {line || ' '}
          </div>
        ))}
      {src && layer.type === 'image' && (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: layer.fit === 'stretch' ? 'fill' : layer.fit, display: 'block' }}
        />
      )}
      {LIVE_TYPES.has(layer.type) || layer.type === 'qrCode' ? <WidgetContent layer={layer} frame={frame} data={data} hold={hold} /> : null}
      {kids.map((k) => (
        <LayerNode key={k.id} layer={k} childrenOf={childrenOf} frame={frame} data={data} hold={hold} interactive={interactive} />
      ))}
    </div>
  );
});

export function childrenMap(layers: Layer[], includeHidden = false): Map<string | null, Layer[]> {
  const ids = new Set(layers.map((l) => l.id));
  const m = new Map<string | null, Layer[]>();
  for (const l of layers) {
    if (!includeHidden && !l.visible) continue;
    const parent = l.parent && ids.has(l.parent) ? l.parent : null;
    const arr = m.get(parent) ?? [];
    arr.push(l);
    m.set(parent, arr);
  }
  return m;
}

/** Renders a template at native resolution (the caller scales it). */
export const Scene = memo(function Scene({ template, frame, data, interactive }: SceneProps) {
  const childrenOf = childrenMap(template.layers);
  const hold = holdFrame(template);
  // Text measured by the logic changes when fonts finish loading.
  useFonts((s) => s.ready);
  // Relations: resolve every layer, run the graph, keep the changed ones.
  const logic = new Map<string, Resolved>();
  if (template.logic?.nodes.length) {
    const values = new Map(template.layers.map((l) => [l.id, resolveLayer(l, frame, data, hold)]));
    applyLogic(template.logic, values, data, measureLayer(template.layers, data, interpolateText));
    for (const n of template.logic.nodes) if (n.type === 'target' && values.has(n.layer)) logic.set(n.layer, values.get(n.layer)!);
  }
  return (
    <LogicContext.Provider value={logic}>
      {(childrenOf.get(null) ?? []).map((l) => (
        <LayerNode key={l.id} layer={l} childrenOf={childrenOf} frame={frame} data={data} hold={hold} interactive={interactive} />
      ))}
    </LogicContext.Provider>
  );
});

/** Fixed-size canvas scaled to fit its container. */
export function Viewport({
  width,
  height,
  scale,
  children,
  className,
  style,
}: {
  width: number;
  height: number;
  scale: number;
  children: React.ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={{ width: width * scale, height: height * scale, position: 'relative', overflow: 'hidden', ...style }}>
      <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}>{children}</div>
    </div>
  );
}

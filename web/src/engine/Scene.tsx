// HTML5 renderer: same conventions as crates/cg-render (box at x/y in parent
// space, rotate/scale around the anchor, crop as a reveal mask).
import { memo, type CSSProperties } from 'react';
import { col, cssColor, interpolateText, num, resolveLayer } from './evaluate';
import type { Data, Layer, Template } from './types';

interface SceneProps {
  template: Template;
  frame: number;
  data: Data;
  /** Render hidden layers' ids for hit-testing in the designer. */
  interactive?: boolean;
}

export const LINE_HEIGHT = 1.2;

function layerStyle(layer: Layer, frame: number, data: Data): { style: CSSProperties; text?: string; src?: string } {
  const r = resolveLayer(layer, frame, data);
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
        whiteSpace: 'pre',
        overflow: 'visible',
        fontKerning: 'normal',
      } satisfies CSSProperties);
      if (strokeW > 0) (style as Record<string, unknown>).WebkitTextStroke = `${strokeW}px ${stroke}`;
      return { style, text };
    }
    case 'image':
      return { style, src: interpolateText(layer.src, data) };
  }
}

const LayerNode = memo(function LayerNode({
  layer,
  childrenOf,
  frame,
  data,
  interactive,
}: {
  layer: Layer;
  childrenOf: Map<string | null, Layer[]>;
  frame: number;
  data: Data;
  interactive?: boolean;
}) {
  const { style, text, src } = layerStyle(layer, frame, data);
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
      {kids.map((k) => (
        <LayerNode key={k.id} layer={k} childrenOf={childrenOf} frame={frame} data={data} interactive={interactive} />
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
export function Scene({ template, frame, data, interactive }: SceneProps) {
  const childrenOf = childrenMap(template.layers);
  return (
    <>
      {(childrenOf.get(null) ?? []).map((l) => (
        <LayerNode key={l.id} layer={l} childrenOf={childrenOf} frame={frame} data={data} interactive={interactive} />
      ))}
    </>
  );
}

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

import type { Layer } from '../engine/types';
import { num, propValue } from '../engine/evaluate';
import { findLayer, setProp, useDesigner } from './designerStore';

/*
 * « Fit the frame to its content »: the layer's box shrinks (or grows) to
 * what it draws on the stage — the glyphs of a text, the picture of an image
 * (its letterbox removed), the drawing of an SVG — measured on the Designer's
 * stage, so it works for every widget.
 */

type Box = { l: number; t: number; r: number; b: number };

const add = (u: Box | null, r: { left: number; top: number; right: number; bottom: number }): Box | null => {
  if (r.right - r.left < 0.5 && r.bottom - r.top < 0.5) return u;
  return u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
};

/** The picture of an `<img>`, inside its box (object-fit: contain leaves bands). */
function imageRect(img: HTMLImageElement) {
  const r = img.getBoundingClientRect();
  const fit = getComputedStyle(img).objectFit;
  if (fit !== 'contain' || !img.naturalWidth || !img.naturalHeight) return r;
  const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * k;
  const h = img.naturalHeight * k;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  return { left, top, right: left + w, bottom: top + h };
}

/** What a layer's element draws, in screen pixels. */
function drawn(el: HTMLElement): Box | null {
  let u: Box | null = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const range = document.createRange();
  for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) u = add(u, r);
    } else if (n instanceof HTMLImageElement) u = add(u, imageRect(n));
    else if (n instanceof HTMLVideoElement || n instanceof HTMLCanvasElement) u = add(u, n.getBoundingClientRect());
    else if (n instanceof SVGSVGElement) {
      // Its drawing, not its viewport.
      for (const g of n.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line, text, image, use')) u = add(u, g.getBoundingClientRect());
    }
  }
  return u;
}

/** Fits the boxes of `ids` (folders excepted) to what they draw. */
export function fitToContent(ids: string[]) {
  const st = useDesigner.getState();
  const tpl = st.template;
  if (!tpl) return;
  const frame = st.frame;
  const boxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const id of ids) {
    const layer = findLayer(tpl, id);
    if (!layer || layer.type === 'group') continue;
    const el = [...document.querySelectorAll<HTMLElement>(`.stage-wrap [data-layer-id="${CSS.escape(id)}"]`)].find((e) => !e.closest('.stage-ghosts'));
    if (!el || !el.offsetWidth || !el.offsetHeight) continue;
    const u = drawn(el);
    if (!u) continue;
    const v = (p: Parameters<typeof propValue>[1]) => num(propValue(layer, p, frame));
    const [x, y, w, h] = [v('x'), v('y'), v('width'), v('height')];
    const deg = v('rotation');
    const a = (deg * Math.PI) / 180;
    const box = el.getBoundingClientRect();
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    // Screen pixels per layer pixel (stage zoom × the layer's scale).
    const s = deg ? box.width / (el.offsetWidth * Math.abs(cos) + el.offsetHeight * Math.abs(sin)) : 0;
    const sx = deg ? s : box.width / el.offsetWidth;
    const sy = deg ? s : box.height / el.offsetHeight;
    // A screen point → the layer's own pixels (from its top left corner).
    const local = (px: number, py: number): [number, number] => {
      if (!deg) return [(px - box.left) / sx, (py - box.top) / sy];
      const [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2];
      const [dx, dy] = [(px - cx) / s, (py - cy) / s];
      return [el.offsetWidth / 2 + dx * cos + dy * sin, el.offsetHeight / 2 - dx * sin + dy * cos];
    };
    const pts = [local(u.l, u.t), local(u.r, u.t), local(u.l, u.b), local(u.r, u.b)];
    const lx = Math.min(...pts.map((p) => p[0]));
    const ly = Math.min(...pts.map((p) => p[1]));
    const rx = Math.max(...pts.map((p) => p[0]));
    const ry = Math.max(...pts.map((p) => p[1]));
    // The element may draw at another size than the layer's (CSS px = layer px here).
    const kx = w / el.offsetWidth;
    const ky = h / el.offsetHeight;
    const [ox, oy] = [lx * kx, ly * ky];
    const [nw, nh] = [Math.max(1, (rx - lx) * kx), Math.max(1, (ry - ly) * ky)];
    // Turned and scaled about its anchor: the new corner keeps what it draws in place.
    const [ax, ay] = [v('anchorX'), v('anchorY')];
    const [scx, scy] = [v('scaleX'), v('scaleY')];
    const [vx, vy] = [(ox + ax * (nw - w)) * scx, (oy + ay * (nh - h)) * scy];
    boxes.push({ id, x: x - ax * (nw - w) + vx * cos - vy * sin, y: y - ay * (nh - h) + vx * sin + vy * cos, w: nw, h: nh });
  }
  if (!boxes.length) return;
  st.update((t) => {
    for (const b of boxes) {
      const l: Layer | undefined = findLayer(t, b.id);
      if (!l) continue;
      const r = (n: number) => Math.round(n * 10) / 10;
      setProp(l, 'x', r(b.x), frame);
      setProp(l, 'y', r(b.y), frame);
      setProp(l, 'width', r(b.w), frame);
      setProp(l, 'height', r(b.h), frame);
    }
  });
}

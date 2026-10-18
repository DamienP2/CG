import type { TextOverflow } from './types';

/*
 * A text made to fit its box, with the same rules as the Rust renderer
 * (crates/cg-render/src/text.rs, fit_text): narrower first (one line of
 * text), then smaller down to the minimum, then cut at the box; or "…",
 * or cut, or drawn outside.
 */

export interface Fitted {
  /** The lines to draw (wrapped, or shortened with "…"). */
  text: string;
  size: number;
  /** Horizontal scale (1 = as designed). */
  squeeze: number;
  /** Cut at the box. */
  clip: boolean;
  /** Size and width kept, 1 = as designed. */
  ratio: number;
  /** Not all of it shows (cut, "…", or outside its box). */
  overflows: boolean;
}

export interface FitOptions {
  fontFamily: string;
  fontWeight: number;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  boxW: number;
  boxH: number;
  wrap: boolean;
  overflow: TextOverflow;
  squeeze: number;
  minSize: number;
}

let ctx: CanvasRenderingContext2D | null = null;

export function textWidth(text: string, o: Pick<FitOptions, 'fontFamily' | 'fontWeight' | 'letterSpacing'>, size: number): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${o.fontWeight} ${size}px "${o.fontFamily}", Inter, system-ui, sans-serif`;
  return Math.max(0, ...text.split('\n').map((line) => ctx!.measureText(line).width + Math.max(0, [...line].length - 1) * o.letterSpacing));
}

/** Breaks lines at spaces so that none is wider than `maxW` (like the Rust wrap_text). */
export function wrapText(text: string, o: Pick<FitOptions, 'fontFamily' | 'fontWeight' | 'letterSpacing'>, size: number, maxW: number): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let cur = '';
    for (const word of line.split(' ')) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (cur && textWidth(candidate, o, size) > maxW) {
        out.push(cur);
        cur = word;
      } else cur = candidate;
    }
    out.push(cur);
  }
  return out.join('\n');
}

const blockHeight = (lines: number, size: number, lh: number) => (lines ? (lines - 1) * size * lh + size : 0);

export function fitText(content: string, o: FitOptions): Fitted {
  const bw = Math.max(1, o.boxW);
  const bh = Math.max(1, o.boxH);
  const eps = 0.5;
  const layout = (size: number, width: number) => {
    const t = o.wrap ? wrapText(content, o, size, width) : content;
    return { t, w: textWidth(t, o, size), h: blockHeight(t.split('\n').length, size, o.lineHeight) };
  };
  const size0 = o.size;
  const first = layout(size0, bw);
  const fits = first.w <= bw + eps && first.h <= bh + eps;
  if (fits) return { text: first.t, size: size0, squeeze: 1, clip: false, ratio: 1, overflows: false };
  if (o.overflow === 'visible') return { text: first.t, size: size0, squeeze: 1, clip: false, ratio: 1, overflows: true };
  if (o.overflow === 'clip') return { text: first.t, size: size0, squeeze: 1, clip: true, ratio: 1, overflows: true };
  if (o.overflow === 'ellipsis') {
    const maxLines = Math.max(0, Math.floor((bh - size0) / (size0 * o.lineHeight))) + 1;
    const all = first.t.split('\n');
    const cut = all.length > maxLines;
    const lines = all.slice(0, maxLines).map((line, i, arr) => {
      const last = i === arr.length - 1;
      if (textWidth(line, o, size0) <= bw + eps && !(last && cut)) return line;
      const chars = [...line];
      for (;;) {
        const t = chars.join('').trimEnd() + '…';
        if (!chars.length || textWidth(t, o, size0) <= bw + eps) return t;
        chars.pop();
      }
    });
    return { text: lines.join('\n'), size: size0, squeeze: 1, clip: true, ratio: 1, overflows: true };
  }
  // Fit: narrower first (a paragraph wraps instead), then smaller.
  const sx = o.wrap || first.w <= bw ? 1 : Math.max(bw / first.w, Math.min(1, Math.max(0.1, o.squeeze)));
  const test = (size: number) => {
    const l = layout(size, bw / sx);
    return { ok: l.w * sx <= bw + eps && l.h <= bh + eps, t: l.t };
  };
  const at0 = test(size0);
  if (at0.ok) return { text: at0.t, size: size0, squeeze: sx, clip: false, ratio: sx, overflows: false };
  const loSize = size0 * Math.min(1, Math.max(0.1, o.minSize));
  const atLo = test(loSize);
  if (!atLo.ok) return { text: atLo.t, size: loSize, squeeze: sx, clip: true, ratio: (loSize / size0) * sx, overflows: true };
  let lo = loSize;
  let hi = size0;
  let best = atLo.t;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const r = test(mid);
    if (r.ok) {
      lo = mid;
      best = r.t;
    } else hi = mid;
  }
  return { text: best, size: lo, squeeze: sx, clip: false, ratio: (lo / size0) * sx, overflows: false };
}

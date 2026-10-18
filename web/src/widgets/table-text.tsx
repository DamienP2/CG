// One line of text fitted to its cell for the table, ticker and credits widgets: shrink → squeeze → ellipsis,
// the chain of crates/cg-render/src/wid/table.rs `fitted_path` (engine/textFit.ts fitText = cg_render text::fit_text).
import type { CSSProperties } from 'react';
import { fitText, textWidth } from '../engine/textFit';

export const FONT = 'Inter';
export const FONT_CSS = `"Inter", system-ui, sans-serif`;
export type Overflow = 'shrink' | 'squeeze' | 'ellipsis';
export interface FitCfg {
  overflow: Overflow;
  /** px. */
  minSize: number;
  /** %. */
  minSqueeze: number;
}

/** Width of one line (Inter at a weight), px. */
export const tw = (text: string, size: number, weight: number, ls = 0) => textWidth(text, { fontFamily: FONT, fontWeight: weight, letterSpacing: ls }, size);

export interface Fitted1 {
  text: string;
  size: number;
  sx: number;
  changed: boolean;
}

/** The fitted text of a cell `w` px wide (mirrors fitted_path). */
export function fit1(text: string, size: number, weight: number, ls: number, w: number, fit?: FitCfg): Fitted1 {
  if (!fit) return { text, size, sx: 1, changed: false };
  const base = { fontFamily: FONT, fontWeight: weight, letterSpacing: ls, lineHeight: 1.2, boxW: Math.max(1, w), boxH: size, wrap: false };
  const r = fit.overflow === 'ellipsis' ? fitText(text, { ...base, size, overflow: 'ellipsis', squeeze: 1, minSize: 1 }) : fitText(text, { ...base, size, overflow: 'fit', squeeze: fit.minSqueeze / 100, minSize: fit.overflow === 'shrink' ? Math.min(1, fit.minSize / size) : 1 });
  let t = r.text;
  if (r.clip && fit.overflow !== 'ellipsis') t = fitText(t, { ...base, boxW: Math.max(1, w / r.squeeze), size: r.size, overflow: 'ellipsis', squeeze: 1, minSize: 1 }).text;
  return { text: t, size: r.size, sx: r.squeeze, changed: r.size !== size || r.squeeze !== 1 || t !== text };
}

/** A fitted line in the box (x, y, w, h), vertically centred. */
export function FitLine({ text, size, weight, ls = 0, align, box: [x, y, w, h], color, fit, style }: { text: string; size: number; weight: number; ls?: number; align: 'left' | 'center' | 'right'; box: [number, number, number, number]; color: string; fit?: FitCfg; style?: CSSProperties }) {
  const f = fit1(text, size, weight, ls, w, fit);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', ...style }}>
      <span
        style={{
          display: 'block',
          width: w / f.sx,
          flex: 'none',
          transform: f.sx < 1 ? `scaleX(${f.sx})` : undefined,
          transformOrigin: '0 50%',
          fontFamily: FONT_CSS,
          fontWeight: weight,
          fontSize: f.size,
          letterSpacing: ls,
          lineHeight: 1.2,
          whiteSpace: 'pre',
          overflow: 'hidden',
          textAlign: align,
          color,
        }}
      >
        {f.text}
      </span>
    </div>
  );
}

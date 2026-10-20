// Table: data grid (manual grid with CSV paste, or a linked source: a {{key}} whose value is CSV / JSON rows),
// mapped columns, header row / column, merges, widths fixed / auto / %, styles per level, borders, conditional
// formatting, sort, pagination (pages or continuous scroll) and a cascade of the rows.
// Same picture as crates/cg-render/src/wid/table.rs; model and actions mirror crates/cg-core/src/wid/table.rs.
import { Pencil, Rows3, Table } from 'lucide-react';
import { interpolateText, num as vnum, parseHex, toHex } from '../engine/evaluate';
import type { Data, Template } from '../engine/types';
import { useTableEditor } from './table-editor-store';
import { ColorField } from '../ui/fields';
import { Btns, clamp, defineWidget, easeOut, Handle, hex, Note, parseCsv, Range, Readout, Row, Select, Toggle, useBound, useFrame, useKeys, type Warning } from './kit';
import { FitLine, tw, type FitCfg, type Overflow } from './table-text';

export interface Col {
  src?: string;
  label?: string;
  type?: 'text' | 'image' | 'number';
  align?: 'left' | 'center' | 'right';
  w?: number;
  pct?: number;
  fmt?: string;
  on?: boolean;
  /** A colour column of the data drawn as a small swatch before the text ('' = none). */
  mark?: string;
}
interface Pair {
  bg?: string;
  color?: string;
}
interface Line {
  on?: boolean;
  width?: number;
  color?: string;
}
export interface Config {
  grid?: string[][];
  link?: string;
  cols?: Col[];
  title?: { on?: boolean; text?: string };
  headerRow?: boolean;
  headerColOn?: boolean;
  headerCol?: string;
  showRank?: boolean;
  merges?: { on?: boolean; row?: number; col?: number; span?: number; text?: string }[];
  widthMode?: 'auto' | 'fixed' | 'percent';
  rowH?: number;
  pad?: number;
  gap?: number;
  headSize?: number;
  overflow?: Overflow;
  minSize?: number;
  minSqueeze?: number;
  st?: { header?: Pair; hcol?: Pair; odd?: Pair; even?: Pair; hl?: Pair; top3?: Pair; tableBg?: string };
  cell?: { on?: boolean; row?: number; col?: number; bg?: string; color?: string };
  borders?: { outer?: Line; innerH?: Line; innerV?: Line };
  cf?: { neg?: boolean; negColor?: string; top3?: boolean; top3Color?: string };
  sortCol?: string;
  sortDir?: 'desc' | 'asc';
  perPage?: number;
  repeatHeader?: boolean;
  pageMode?: 'pages' | 'scroll';
  scrollSpeed?: number;
  indicator?: boolean;
  cascade?: { on?: boolean; style?: 'slide' | 'fade' | 'flip'; offset?: number; dur?: number };
  emptyMode?: 'message' | 'hide';
  emptyText?: string;
}

/** Mirrors `State` of the Rust module. */
export interface State {
  page?: number;
  pageAt?: number;
  auto?: boolean;
  interval?: number;
  autoAt?: number;
  pausedAt?: number;
  hl?: string;
}

// ------------------------------------------------------------ defaults --
const P = (bg: string, color: string) => ({ bg, color });
export const DST = { header: P('#7c5cff', '#ffffff'), hcol: P('#232a4d', '#ffffff'), odd: P('#141a33', '#ffffff'), even: P('#1c2344', '#ffffff'), hl: P('#ff3b5c', '#ffffff'), top3: P('#2c2717', '#fff4cc'), tableBg: '#060812d9' };
const DCOL: Required<Col> = { src: '', label: '', type: 'text', align: 'left', w: 100, pct: 10, fmt: '0', on: true, mark: '' };
export function cfg(c: Config) {
  const st = c.st ?? {};
  const b = c.borders ?? {};
  return {
    grid: c.grid ?? [],
    link: c.link ?? '',
    cols: (c.cols ?? []).map((x) => ({ ...DCOL, ...x })),
    title: { on: false, text: 'Standings', ...c.title },
    headerRow: c.headerRow ?? true,
    headerColOn: c.headerColOn ?? false,
    headerCol: c.headerCol ?? '',
    showRank: c.showRank ?? false,
    merges: (c.merges ?? []).map((g) => ({ on: true, row: 1, col: 1, span: 2, text: '', ...g })),
    widthMode: c.widthMode ?? 'auto',
    rowH: c.rowH ?? 66,
    pad: c.pad ?? 18,
    gap: c.gap ?? 4,
    headSize: c.headSize ?? 20,
    overflow: c.overflow ?? 'shrink',
    minSize: c.minSize ?? 20,
    minSqueeze: c.minSqueeze ?? 70,
    st: { header: { ...DST.header, ...st.header }, hcol: { ...DST.hcol, ...st.hcol }, odd: { ...DST.odd, ...st.odd }, even: { ...DST.even, ...st.even }, hl: { ...DST.hl, ...st.hl }, top3: { ...DST.top3, ...st.top3 }, tableBg: st.tableBg ?? DST.tableBg },
    cell: { on: false, row: 1, col: 1, bg: '#facc15', color: '#111111', ...c.cell },
    borders: { outer: { on: false, width: 4, color: '#ffffff', ...b.outer }, innerH: { on: true, width: 1, color: '#ffffff14', ...b.innerH }, innerV: { on: false, width: 1, color: '#ffffff1f', ...b.innerV } },
    cf: { neg: true, negColor: '#ff6b81', top3: false, top3Color: '#facc15', ...c.cf },
    sortCol: c.sortCol ?? '',
    sortDir: c.sortDir ?? 'desc',
    perPage: Math.max(1, c.perPage ?? 7),
    repeatHeader: c.repeatHeader ?? true,
    pageMode: c.pageMode ?? 'pages',
    scrollSpeed: c.scrollSpeed ?? 50,
    indicator: c.indicator ?? true,
    cascade: { on: true, style: 'slide' as const, offset: 70, dur: 450, ...c.cascade },
    emptyMode: c.emptyMode ?? 'message',
    emptyText: c.emptyText ?? 'No data yet',
  };
}
type K = ReturnType<typeof cfg>;

// ---------------------------------------------------------------- data --
const jsonCell = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
/** Rows of a linked value: JSON array (of arrays, or of objects: keys = header) or CSV. */
export function parseRows(text: string): string[][] {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v = JSON.parse(t);
      const arr: unknown[] = Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : Array.isArray(v?.data) ? v.data : [];
      if (arr.every((r) => Array.isArray(r))) return (arr as unknown[][]).map((r) => r.map(jsonCell));
      const head: string[] = [];
      arr.forEach((r) => r && typeof r === 'object' && Object.keys(r).forEach((k) => !head.includes(k) && head.push(k)));
      return [head, ...arr.filter((r) => r && typeof r === 'object').map((r) => head.map((k) => jsonCell((r as Record<string, unknown>)[k])))];
    } catch {
      /* CSV */
    }
  }
  return parseCsv(text);
}
export const gridOf = (k: K, data: Data) => (k.link.trim() ? parseRows(interpolateText(k.link, data)) : k.grid.map((r) => r.map((s) => interpolateText(String(s ?? ''), data))));
export function num(s: string): number | undefined {
  const t = String(s ?? '')
    .replace(/[\s  ]/g, '')
    .replace('−', '-')
    .replace(',', '.')
    .replace(/%+$/, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
export function fmtNum(s: string, f: string): string {
  const n = num(s);
  if (n === undefined) return s;
  const minus = n < 0 ? '−' : '';
  if (f === '0.0') return minus + Math.abs(n).toFixed(1);
  if (f === '+0') {
    const r = Math.round(n);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r);
  }
  if (f === '0 %') return `${minus}${Math.abs(Math.round(n))} %`;
  const r = Math.abs(Math.round(n));
  return minus + (r >= 1000 ? String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(r));
}
export interface MCol {
  col: Required<Col>;
  i?: number;
}
export interface MRow {
  r: string[];
  k: number;
  key: string;
  rank: number;
}
const RANK: Required<Col> = { src: '', label: '#', type: 'number', align: 'center', w: 80, pct: 7, fmt: '0', on: true, mark: '' };
export function model(k: K, data: Data) {
  const g = gridOf(k, data);
  const head = (g[0] ?? []).map((h) => String(h ?? '').trim());
  const body = g.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  const auto = !k.cols.length;
  const mapped = auto ? head.filter(Boolean).map((h) => ({ ...DCOL, src: h, label: h })) : k.cols;
  const cols: MCol[] = [];
  const missing: string[] = [];
  mapped
    .filter((c) => c.on)
    .forEach((c) => {
      const i = head.indexOf(c.src);
      if (i < 0) missing.push(c.src);
      else cols.push({ col: c, i });
    });
  if (k.showRank) cols.unshift({ col: RANK });
  const unmapped = auto ? [] : head.filter((h) => h && !k.cols.some((c) => c.src === h || (c.on && c.mark === h)));
  const keyCol = cols.find((m) => m.i !== undefined && k.headerColOn && m.col.src === k.headerCol) ?? cols.find((m) => m.col.type === 'text' && m.i !== undefined);
  const rows: MRow[] = body.map((r, i) => ({ r, k: i, key: keyCol ? String(r[keyCol.i!] ?? '') : String(i + 1), rank: 0 }));
  const sc = cols.find((m) => m.i !== undefined && k.sortCol && m.col.src === k.sortCol);
  if (sc) {
    const dir = k.sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = a.r[sc.i!] ?? '';
      const y = b.r[sc.i!] ?? '';
      const nx = num(x);
      const ny = num(y);
      const d = nx !== undefined && ny !== undefined ? nx - ny : x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0;
      return d * dir || a.k - b.k;
    });
  }
  rows.forEach((r, i) => (r.rank = i + 1));
  return { head, cols, rows, unmapped, missing };
}
type M = ReturnType<typeof model>;
export const pageCount = (k: K, m: M) => Math.max(1, Math.ceil(m.rows.length / k.perPage));
export const cellText = (c: MCol, row: MRow) => (c.i === undefined ? String(row.rank) : c.col.type === 'number' ? fmtNum(row.r[c.i] ?? '', c.col.fmt) : String(row.r[c.i] ?? ''));
function mergeOf(k: K, m: M, row: MRow): [number, number, string] | undefined {
  const g = k.merges.find((x) => x.on && +x.row === row.rank);
  if (!g) return;
  const j = Math.max(1, +g.col) - 1;
  if (j >= m.cols.length) return;
  return [j, Math.min(Math.max(1, +g.span), m.cols.length - j), g.text];
}
export const headerH = (k: K) => Math.round(k.rowH * 0.85);
export const TITLE_H = 64;

/** Page shown at `now` and when it appeared (0 = since on air), mirrors current_page. */
export function currentPage(st: State, pages: number, now: number): [number, number] {
  pages = Math.max(1, pages);
  const page = st.page ?? 0;
  if (st.auto && (st.interval ?? 0) > 0 && (st.autoAt ?? 0) > 0 && pages > 1) {
    const t = st.pausedAt ? st.pausedAt : now;
    const step = Math.trunc(st.interval! * 1000);
    const n = Math.floor(Math.max(0, t - st.autoAt!) / Math.max(1, step));
    return [(page + n) % pages, n > 0 ? st.autoAt! + n * step : (st.pageAt ?? 0)];
  }
  return [Math.min(page, pages - 1), st.pageAt ?? 0];
}
function nextIn(st: State, now: number): number | undefined {
  if (!st.auto || !(st.interval! > 0) || !st.autoAt) return;
  const t = st.pausedAt ? st.pausedAt : now;
  const step = st.interval! * 1000;
  return (step - (Math.max(0, t - st.autoAt) % step)) / 1000;
}

/** Column widths (mirrors widths() of the renderer). */
export function widths(k: K, m: M, W: number, size: number): number[] {
  const n = m.cols.length;
  const avail = W - k.gap * Math.max(0, n - 1);
  if (k.widthMode === 'fixed') return m.cols.map((c) => c.col.w);
  if (k.widthMode === 'percent') {
    const rk = m.cols.some((c) => c.i === undefined) ? 80 : 0;
    return m.cols.map((c) => (c.i === undefined ? 80 : (c.col.pct / 100) * (avail - rk)));
  }
  const nat = m.cols.map((c) => {
    if (c.col.type === 'image') return k.rowH * 0.75 + 2 * k.pad;
    let w = tw(c.col.label.toUpperCase(), k.headSize, 800);
    for (const r of m.rows) w = Math.max(w, tw(cellText(c, r), size, c.col.type === 'number' ? 800 : 700));
    return Math.min(w, 600) + 2 * k.pad + 8;
  });
  const isText = m.cols.map((c) => c.col.type === 'text' && c.i !== undefined);
  const fixed = nat.reduce((a, w, i) => a + (isText[i] ? 0 : w), 0);
  const textNat = nat.reduce((a, w, i) => a + (isText[i] ? w : 0), 0);
  const rest = avail - fixed;
  if (textNat <= 0 || rest < textNat * 0.25) {
    const sum = Math.max(
      1,
      nat.reduce((a, b) => a + b, 0),
    );
    return nat.map((w) => (w * avail) / sum);
  }
  return nat.map((w, i) => (isText[i] ? (w * rest) / textNat : w));
}

/** A picture cell: an asset path, else a grey chip with the code. */
export function Picture({ v, cx, cy, h }: { v: string; cx: number; cy: number; h: number }) {
  const s = v.trim();
  if (!s) return null;
  if (s.startsWith('/') || s.includes('.')) return <img src={s} alt="" draggable={false} style={{ position: 'absolute', left: cx, top: cy - h / 2, height: h, transform: 'translateX(-50%)', display: 'block' }} />;
  const w = h * 1.5;
  return <div style={{ position: 'absolute', left: cx - w / 2, top: cy - h / 2, width: w, height: h, borderRadius: h * 0.1, background: '#334155', color: '#cbd5e1', display: 'grid', placeItems: 'center', font: `700 ${h * 0.35}px Inter, sans-serif` }}>{s.slice(0, 3).toUpperCase()}</div>;
}

// ------------------------------------------------------------- render --
export function TableRender({ layer, r, w, data, time, state }: { layer: Config; r: Record<string, unknown>; w: number; data: Data; time: { nowMs: number; ageSecs: number }; state: unknown }) {
  const k = cfg(layer);
  const st = (state ?? {}) as State;
  const m = model(k, data);
  const size = Math.max(1, vnum(r.fontSize as number));
  if (!m.rows.length && k.emptyMode === 'hide') return null;
  const pages = pageCount(k, m);
  const [page, at] = currentPage(st, pages, time.nowMs);
  const since = at > 0 ? (time.nowMs - at) / 1000 : time.ageSecs;
  const scroll = k.pageMode === 'scroll';
  const ws = widths(k, m, w, size);
  const xs: number[] = [];
  ws.reduce((x, ww, i) => ((xs[i] = x), x + ww + k.gap), 0);
  const { rowH: rh, gap, pad } = k;
  const hh = headerH(k);
  const showHead = k.headerRow && (scroll || k.repeatHeader || page === 0);
  const fit: FitCfg = { overflow: k.overflow, minSize: k.minSize, minSqueeze: k.minSqueeze };
  const per = k.perPage;
  const list = scroll ? m.rows : m.rows.slice(page * per, page * per + per);
  const shownN = scroll ? per : list.length;
  const clipH = !m.rows.length ? rh * 2 : Math.max(0, Math.min(per, shownN) * (rh + gap) - gap);
  let y = 0;
  if (k.title.on) y += TITLE_H + gap;
  if (showHead) y += hh + gap;
  const y0 = y;
  const totalH = y0 + clipH;
  const bH = k.borders.innerH;
  const bV = k.borders.innerV;
  const lines = (top: boolean, left: boolean, x: number, yy: number, cw: number, ch: number, key: string) => (
    <>
      {top && bH.on && <div key={`${key}h`} style={{ position: 'absolute', left: x, top: yy, width: cw, height: Math.min(bH.width, ch), background: hex(bH.color) }} />}
      {left && bV.on && <div key={`${key}v`} style={{ position: 'absolute', left: x, top: yy, width: Math.min(bV.width, cw), height: ch, background: hex(bV.color) }} />}
    </>
  );
  const out: React.ReactNode[] = [];
  out.push(<div key="bg" style={{ position: 'absolute', left: 0, top: 0, width: w, height: totalH, background: hex(k.st.tableBg) }} />);
  let yy = 0;
  if (k.title.on) {
    out.push(<div key="title" style={{ position: 'absolute', left: 0, top: 0, width: w, height: TITLE_H, background: 'linear-gradient(90deg,#ff3b5c,#7c5cff)' }} />);
    out.push(<FitLine key="tt" text={k.title.text.toUpperCase()} size={30} weight={900} ls={1.2} align="left" box={[24, 0, w - 48, TITLE_H]} color="#ffffff" fit={{ overflow: 'shrink', minSize: 18, minSqueeze: 70 }} />);
    yy += TITLE_H + gap;
  }
  if (showHead) {
    const top = yy;
    m.cols.forEach((c, j) => {
      out.push(<div key={`h${j}`} style={{ position: 'absolute', left: xs[j], top, width: ws[j], height: hh, background: hex(k.st.header.bg) }} />);
      out.push(<span key={`hl${j}`}>{lines(false, j > 0, xs[j], top, ws[j], hh, `h${j}`)}</span>);
      out.push(<FitLine key={`ht${j}`} text={c.col.label.toUpperCase()} size={k.headSize} weight={800} ls={k.headSize * 0.05} align={c.col.align} box={[xs[j] + pad, top, ws[j] - 2 * pad, hh]} color={hex(k.st.header.color)} fit={fit} />);
    });
    yy += hh + gap;
  }
  if (!m.rows.length) {
    out.push(
      <div key="empty" style={{ position: 'absolute', left: 0, top: y0, width: w, height: rh * 2, background: hex(k.st.odd.bg), opacity: 0.85 }}>
        <FitLine text={k.emptyText} size={size} weight={700} align="center" box={[pad, 0, w - 2 * pad, rh * 2]} color={hex(k.st.odd.color)} fit={fit} />
      </div>,
    );
  } else {
    const step = rh + gap;
    const looped = scroll && m.rows.length > per;
    const off = looped ? (((k.scrollSpeed * time.ageSecs) % (m.rows.length * step)) + m.rows.length * step) % (m.rows.length * step) : 0;
    const shown = looped ? [...list, ...list] : list;
    const rowsOut: React.ReactNode[] = [];
    shown.forEach((row, i) => {
      const ry = i * step - off;
      if (ry > clipH || ry + rh < 0) return;
      let transform: string | undefined;
      let opacity = 1;
      if (!scroll && k.cascade.on) {
        const kk = easeOut(clamp((since * 1000 - i * k.cascade.offset) / Math.max(1, k.cascade.dur), 0, 1));
        if (k.cascade.style === 'slide') ((transform = `translateX(${(1 - kk) * -80}px)`), (opacity = kk));
        else if (k.cascade.style === 'fade') opacity = kk;
        else ((transform = `scaleY(${Math.max(0.001, Math.cos(((1 - kk) * 90 * Math.PI) / 180))})`), (opacity = kk > 0 ? 1 : 0));
        if (opacity <= 0.001) return;
      }
      const hl = !!row.key && row.key === st.hl;
      const top3 = !hl && k.cf.top3 && row.rank <= 3;
      const base = hl ? k.st.hl : top3 ? k.st.top3 : row.rank % 2 ? k.st.odd : k.st.even;
      const merge = mergeOf(k, m, row);
      let skipTo = 0;
      const cells: React.ReactNode[] = [];
      m.cols.forEach((c, j) => {
        if (j < skipTo) return;
        let cw = ws[j];
        let txt = cellText(c, row);
        let align = c.col.align;
        let type = c.col.type;
        if (merge && merge[0] === j) {
          for (let q = 1; q < merge[1]; q++) cw += ws[j + q] + gap;
          skipTo = j + merge[1];
          if (merge[2]) ((txt = merge[2]), (type = 'text'));
          align = 'center';
        }
        let bg = base.bg;
        let color = base.color;
        if (!hl && k.headerColOn && c.i !== undefined && c.col.src === k.headerCol) ((bg = k.st.hcol.bg), (color = k.st.hcol.color));
        if (type === 'number' && c.i !== undefined && k.cf.neg && !hl && (num(row.r[c.i] ?? '') ?? 0) < 0) color = k.cf.negColor;
        if (c.i === undefined && top3) color = k.cf.top3Color;
        if (k.cell.on && +k.cell.row === row.rank && +k.cell.col === j + 1) ((bg = k.cell.bg), (color = k.cell.color));
        const x = xs[j];
        cells.push(<div key={`b${j}`} style={{ position: 'absolute', left: x, top: 0, width: cw, height: rh, background: hex(bg) }} />);
        cells.push(<span key={`l${j}`}>{lines(i > 0 || showHead || k.title.on, j > 0, x, 0, cw, rh, `c${j}`)}</span>);
        if (j === 0 && top3) cells.push(<div key="t3" style={{ position: 'absolute', left: x, top: 0, width: 8, height: rh, background: hex(k.cf.top3Color) }} />);
        if (j === 0 && hl) cells.push(<div key="hl" style={{ position: 'absolute', left: x, top: 0, width: 8, height: rh, background: '#fff' }} />);
        // A colour swatch before the text (a colour column of the data).
        let tx0 = x + pad;
        const mi = type === 'text' && c.col.mark ? m.head.indexOf(c.col.mark) : -1;
        const mv = mi >= 0 ? String(row.r[mi] ?? '').trim() : '';
        if (mv) {
          const s = Math.round(rh * 0.3);
          cells.push(<div key={`m${j}`} style={{ position: 'absolute', left: tx0, top: (rh - s) / 2, width: s, height: s, borderRadius: s * 0.2, background: hex(mv) }} />);
          tx0 += s * 1.6;
        }
        if (type === 'image') cells.push(<Picture key={`p${j}`} v={txt} cx={x + cw / 2} cy={rh / 2} h={Math.round(rh * 0.5)} />);
        else cells.push(<FitLine key={`t${j}`} text={txt} size={size} weight={type === 'number' ? 800 : 700} align={align} box={[tx0, 0, cw - pad - (tx0 - x), rh]} color={hex(color)} fit={fit} style={type === 'number' ? { fontVariantNumeric: 'tabular-nums' } : undefined} />);
      });
      rowsOut.push(
        <div key={`r${i}`} style={{ position: 'absolute', left: 0, top: ry, width: w, height: rh, transform, transformOrigin: 'left top', opacity }}>
          {cells}
        </div>,
      );
    });
    out.push(
      <div key="rows" style={{ position: 'absolute', left: 0, top: y0, width: w, height: clipH, overflow: 'hidden' }}>
        {rowsOut}
      </div>,
    );
  }
  if (k.borders.outer.on) out.push(<div key="outer" style={{ position: 'absolute', left: 0, top: 0, width: w, height: totalH, boxShadow: `inset 0 0 0 ${k.borders.outer.width}px ${hex(k.borders.outer.color)}` }} />);
  if (k.indicator && pages > 1 && !scroll && m.rows.length)
    out.push(
      <div key="ind" style={{ position: 'absolute', right: 0, top: totalH + 14, display: 'flex', alignItems: 'center', gap: 8, font: `800 24px ${'Inter, sans-serif'}`, lineHeight: 1.2, color: '#fff', background: 'rgba(11,13,24,.8)', padding: '8px 16px', borderRadius: 24, whiteSpace: 'nowrap' }}>
        {Array.from({ length: pages }, (_, i) => (
          <i key={i} style={{ width: i === page ? 30 : 12, height: 12, borderRadius: 6, background: i === page ? '#ff3b5c' : 'rgba(255,255,255,.35)', display: 'inline-block' }} />
        ))}
        <span style={{ marginLeft: 6 }}>
          {page + 1} / {pages}
        </span>
      </div>,
    );
  return <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>{out}</div>;
}

// ------------------------------------------------------------ inspector --
/** Background · text colours of a level. */
export function PairRow({ label, path }: { label: string; path: string }) {
  const b = useBound();
  const v = (path.split('.').reduce<unknown>((a, x) => (a as Record<string, unknown> | undefined)?.[x], b.obj) ?? {}) as Pair;
  const d = path.split('.').reduce<unknown>((a, x) => (a as Record<string, unknown> | undefined)?.[x], { st: DST, cell: { bg: '#facc15', color: '#111111' } }) as Pair;
  const pick = (k: 'bg' | 'color') => <ColorField value={parseHex(v[k] ?? d?.[k] ?? '#ffffff') ?? [1, 1, 1, 1]} onChange={(c) => b.set(`${path}.${k}`, toHex(c, c[3] < 1), true)} />;
  return (
    <Row expose={[`${path}.bg`, `${path}.color`]} exposeValue={{ [`${path}.bg`]: v.bg ?? d?.bg, [`${path}.color`]: v.color ?? d?.color }} label={label}>
      <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{pick('bg')}</div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{pick('color')}</div>
      </div>
    </Row>
  );
}
export const FMTS: [string, string][] = [
  ['0', '1 234'],
  ['0.0', '12.3'],
  ['+0', '+5 / −3'],
  ['0 %', '45 %'],
];

type TL = Config & { props: Record<string, unknown>; id: string };
const sizeOf = (l: TL) => vnum((l.props.fontSize as number) ?? 30);

function warningsOf(layer: TL, data: Data, state: unknown, W: number, H: number): Warning[] {
  const k = cfg(layer);
  const m = model(k, data);
  const out: Warning[] = [];
  m.unmapped.forEach((h) => out.push({ level: 'warn', text: `New column '${h}' in the data — not mapped (ignored until mapped in Columns).`, op: true }));
  if (m.missing.length) out.push({ level: 'error', text: `Mapped column(s) not in the data: ${m.missing.join(', ')} — not shown.` });
  if (!m.rows.length) out.push({ level: 'info', text: k.emptyMode === 'hide' ? 'No data: the table is hidden.' : 'No data: the fallback message is on air.', op: true });
  const pages = pageCount(k, m);
  const [page] = currentPage((state ?? {}) as State, pages, Date.now());
  if (pages > 1 && k.pageMode === 'pages') out.push({ level: 'info', text: `${m.rows.length} rows for ${k.perPage} per page: automatic pagination, page ${page + 1}/${pages}.` });
  const size = sizeOf(layer);
  const ws = widths(k, m, W, size);
  if (k.widthMode === 'fixed') {
    const sum = ws.reduce((a, b) => a + b, 0) + k.gap * Math.max(0, m.cols.length - 1);
    if (sum > W + 0.5) out.push({ level: 'warn', text: `Fixed widths total ${Math.round(sum)} px for a ${Math.round(W)} px box: the right columns are cut.` });
  }
  if (k.widthMode === 'percent') {
    const sum = m.cols.filter((c) => c.i !== undefined).reduce((a, c) => a + (+c.col.pct || 0), 0);
    if (Math.abs(sum - 100) > 0.5) out.push({ level: 'warn', text: `Column widths total ${sum} % (should be 100 %).` });
  }
  const need = (k.title.on ? TITLE_H + k.gap : 0) + (k.headerRow ? headerH(k) + k.gap : 0) + Math.min(k.perPage, Math.max(1, m.rows.length)) * (k.rowH + k.gap) + (k.indicator && pages > 1 && k.pageMode === 'pages' ? 70 : 0);
  if (need > H + 1) out.push({ level: 'warn', text: `The table (${Math.round(need)} px) is taller than the box (${Math.round(H)} px): fewer rows per page or a smaller row height.` });
  let cut = 0;
  m.rows.forEach((r) => m.cols.forEach((c, j) => c.col.type === 'text' && c.i !== undefined && tw(cellText(c, r), size, 700) > ws[j] - 2 * k.pad && cut++));
  if (cut) out.push({ level: 'info', text: `${cut} cell(s) too long: ${k.overflow === 'shrink' ? 'shrunk (then squeezed / ellipsis at the minimum)' : k.overflow === 'squeeze' ? 'squeezed (then ellipsis at the minimum)' : 'cut with an ellipsis'}.` });
  return out;
}

export default defineWidget({
  id: 'table',
  type: 'table',
  label: 'Table',
  group: 'Data',
  icon: Table,
  create: () => ({
    grid: [
      ['Name', 'Value'],
      ['Alpha', '1'],
      ['Beta', '2'],
      ['Gamma', '3'],
    ],
    st: { header: { bg: '#00000000', color: '#ffffffb3' }, even: { ...DST.odd } },
    borders: { innerH: { on: false, width: 1, color: '#ffffff14' } },
    cf: { neg: false },
    cascade: { on: false },
    props: { width: 1200, height: 400, fontSize: 30 },
  }),
  ownsLook: true,
  content: ['link', 'grid'],
  live: (l) => {
    const k = cfg(l);
    return k.cascade.on || k.pageMode === 'scroll';
  },
  Render: ({ layer, r, w, data, time, state }) => <TableRender layer={layer} r={r as never} w={w} data={data} time={time} state={state} />,
  Inspector: ({ layer, data, template }) => <TableCard layer={layer as unknown as TL} data={data} template={template} />,
  Operator: ({ layer, state, data, act, time }) => {
    const now = useFrame() + (time.nowMs - Date.now());
    const k = cfg(layer);
    const st = (state ?? {}) as State;
    const m = model(k, data);
    const pages = pageCount(k, m);
    const [page] = currentPage(st, pages, now);
    const scroll = k.pageMode === 'scroll';
    useKeys({ ArrowLeft: () => !scroll && act('prev'), ArrowRight: () => !scroll && act('next') });
    const a = page * k.perPage + 1;
    const b = Math.min(m.rows.length, (page + 1) * k.perPage);
    const left = nextIn(st, now);
    return (
      <>
        {!m.rows.length ? (
          <Readout sub={k.emptyMode === 'hide' ? 'table hidden' : 'fallback message on air'}>NO DATA</Readout>
        ) : scroll ? (
          <Readout sub={`${m.rows.length} rows · ${k.scrollSpeed} px/s continuous`}>SCROLL</Readout>
        ) : (
          <Readout sub={`rows ${a}–${b} of ${m.rows.length}`}>{`PAGE ${page + 1}/${pages}`}</Readout>
        )}
        <Btns
          list={[
            { label: '◀ Previous', cls: 'big', keyHint: '←', disabled: scroll || pages < 2, onClick: () => act('prev') },
            { label: 'Next ▶', cls: 'big violet', keyHint: '→', disabled: scroll || pages < 2, onClick: () => act('next') },
          ]}
        />
        {!scroll && pages > 1 && <Btns label="Go to page" list={Array.from({ length: pages }, (_, i) => ({ label: String(i + 1), cls: i === page ? 'violet' : 'ghost', title: `Go to page ${i + 1}`, onClick: () => act('go', { page: i + 1 }) }))} />}
        <Toggle label="Auto pages" value={!!st.auto} text="Turn pages automatically" disabled={scroll ? 'Not in continuous scroll' : pages < 2 ? 'One page only' : undefined} onChange={(v) => act(v ? 'auto' : 'stop', v ? { seconds: st.interval || 6 } : undefined)} />
        {st.auto && !scroll && (
          <>
            <Range label="Interval" value={st.interval ?? 6} min={2} max={30} unit=" s" onChange={(v) => act('auto', { seconds: v })} />
            <Btns list={[st.pausedAt ? { label: '▶ Resume', cls: 'green', onClick: () => act('resume') } : { label: '❚❚ Pause', cls: 'amber', onClick: () => act('pause') }]} />
            {left !== undefined && (
              <Note>
                {st.pausedAt ? '❚❚ Paused' : '▶ Next page in'} {Math.max(0, left).toFixed(1)} s
              </Note>
            )}
          </>
        )}
        <Select label="Highlight row" value={st.hl ?? ''} options={[['', '— none —'], ...m.rows.map((r) => [r.key, `${r.rank}. ${r.key}`] as [string, string])]} onChange={(v) => act('highlight', { row: v })} />
        {st.hl && <Btns list={[{ label: 'Clear highlight', cls: 'ghost', onClick: () => act('highlight', { row: '' }) }]} />}
        <Note>{k.link.trim() ? 'Source: linked data — an update keeps the page if it still exists.' : 'Source: manual grid.'}</Note>
      </>
    );
  },
  Overlay: ({ layer, scale, edit }) => {
    const k = cfg(layer);
    const top = (k.title.on ? TITLE_H + k.gap : 0) + (k.headerRow ? headerH(k) + k.gap : 0);
    return <Handle x={-14 / scale} y={top + k.rowH} scale={scale} label={`Row height ${k.rowH} px`} onDrag={(_, y) => edit((l) => void (l.rowH = clamp(Math.round(y - top), 30, 160)), `rowh-${layer.id}`)} />;
  },
  warnings: (layer, { data, state, r }) => warningsOf(layer as unknown as TL, data, state, vnum(r?.width ?? (layer.props.width as number) ?? 0), vnum(r?.height ?? (layer.props.height as number) ?? 0)),
});

export function ColorPickRow({ label, path, value }: { label: string; path: string; value: string }) {
  const b = useBound();
  const v = (path.split('.').reduce<unknown>((a, x) => (a as Record<string, unknown> | undefined)?.[x], b.obj) as string | undefined) ?? value;
  return (
    <Row expose={path} exposeValue={v} label={label}>
      <ColorField value={parseHex(v) ?? [1, 1, 1, 1]} onChange={(c) => b.set(path, toHex(c, c[3] < 1), true)} />
    </Row>
  );
}

/** The right panel: what the table shows, and the button to its editor (every setting is there). */
function TableCard({ layer, data, template }: { layer: TL; data: Data; template: Template }) {
  const open = useTableEditor((s) => s.open);
  const k = cfg(layer);
  const m = model(k, data);
  const dsKey = /\{\{(\w+)__table\}\}/.exec(k.link)?.[1];
  const ds = dsKey ? template.datasets?.find((d) => d.key === dsKey) : undefined;
  const ncols = m.cols.filter((c) => c.i !== undefined).length;
  return (
    <div className="te-card">
      <div className="te-sum">
        <span className={`te-chip ${ds || k.link.trim() ? 'data' : ''}`}>
          <Rows3 size={11} /> {ds ? `${ds.name} · All rows` : k.link.trim() ? 'Linked data' : 'Rows by hand'}
        </span>
        <span className="te-chip">
          {ncols} column{ncols === 1 ? '' : 's'}
        </span>
        <span className="te-chip">{k.pageMode === 'scroll' ? 'Scrolling' : `${k.perPage} rows per page`}</span>
      </div>
      <button className="btn primary te-edit" onClick={() => open(layer.id)}>
        <Pencil size={14} /> Edit the table
      </button>
    </div>
  );
}

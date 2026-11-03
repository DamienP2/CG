// Credits: roll (vertical), crawl (horizontal) or pages (cards). Structured entries (sections, role | name lines,
// logos, spaces) with an import from text, 1 / 2 / 3 columns, styles per level, speed from a total duration or
// px/s (optimised: whole px per frame), start off / on screen, end exit / stop on the last element, fades.
// Same picture as crates/cg-render/src/wid/credits.rs; layout and progress mirror crates/cg-core/src/wid/credits.rs.
import { memo, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Flag, GripVertical, Minus, Pause, Play, Plus, RotateCcw, ScrollText, SkipForward, Trash2, X } from 'lucide-react';
import { interpolateText, num, parseHex, toHex } from '../engine/evaluate';
import { onQrLoaded, parseDuration, qrModules } from '../engine/widgets';
import type { Data, PlayoutItem } from '../engine/types';
import { useApp } from '../store';
import { ColorField, NumberField, Segmented } from '../ui/fields';
import { Dropdown } from '../ui/Dropdown';
import { AssetPicker } from '../designer/AssetPicker';
import { confirmDialog } from '../ui/dialogs';
import { loadFonts, useFonts } from '../engine/fonts';
import { clamp, findCol, headerRows, ColorPick, Content, defineWidget, ExposeSetting, hex, Num, Row, Section, Seg, Text, Toggle, useBound, useCentreMode, useKeys, type Warning } from './kit';
import { Centre, ExposedFilter, startMode, WaitsContinue, WaitsTrigger, type Line2Item } from './centre';
import { familyCss, FitLine, FONT, OpField, tw, useLiveTime } from './table-text';
import { layerTime } from './ticker';
import { t, tc, tl } from '../i18n';

type Kind = 'section' | 'line' | 'logo' | 'space' | 'qr';
/** How a space shows (its `a`): nothing, a rule, a dotted rule, a dot. */
type SpaceStyle = '' | 'line' | 'dots' | 'dot';
const spaceStyle = (a: string): SpaceStyle => (a === 'line' || a === 'dots' || a === 'dot' ? a : '');
export interface Entry {
  kind?: Kind;
  a?: string;
  b?: string;
}
interface Style {
  size?: number;
  color?: string;
  weight?: number;
  upper?: boolean;
}
export interface Config {
  mode?: 'roll' | 'crawl' | 'pages';
  entries?: Entry[];
  link?: string;
  importText?: string;
  layout?: 'one' | 'two' | 'three';
  /** Lines as role + name (default), or one text each (false: the name only, in one column). */
  roles?: boolean;
  align?: 'left' | 'center' | 'right';
  /** One font for the whole credits (the channel's), Inter by default. */
  font?: string;
  gutter?: number;
  sectionGap?: number;
  lineGap?: number;
  spaceH?: number;
  logoH?: number;
  st?: { section?: Style; role?: Style; name?: Style };
  speedMode?: 'duration' | 'pxs' | 'card';
  duration?: number;
  pxs?: number;
  optimised?: boolean;
  /** Frames per second of the optimised speed (the project's). */
  fps?: number;
  maxPxs?: number;
  cardDur?: number;
  start?: 'off' | 'on';
  end?: 'exit' | 'stop';
  /** The graphic goes out by itself once the credits have gone all the way (else the operator's OUT). */
  autoOut?: boolean;
  shortMode?: 'center' | 'exit';
  fade?: boolean;
  fadeSize?: number;
  panel?: boolean;
  panelColor?: string;
}
/** Mirrors `State` of the Rust module. */
export interface State {
  started?: boolean;
  running?: boolean;
  base?: number;
  anchor?: number;
  rate?: number | null;
}

const S = (size: number, color: string, weight: number, upper: boolean) => ({ size, color, weight, upper });
export function cfg(c: Config) {
  const st = c.st ?? {};
  return {
    mode: c.mode ?? 'roll',
    entries: (c.entries ?? []).map((e) => ({ kind: e.kind ?? 'line', a: e.a ?? '', b: e.b ?? '' })),
    link: c.link ?? '',
    importText: c.importText ?? '',
    // Without roles: one column (credits.rs Config::lay).
    layout: c.roles === false ? 'one' : (c.layout ?? 'two'),
    roles: c.roles !== false,
    align: c.align ?? 'center',
    font: c.font?.trim() || FONT,
    gutter: c.gutter ?? 40,
    sectionGap: c.sectionGap ?? 70,
    lineGap: c.lineGap ?? 10,
    spaceH: c.spaceH ?? 40,
    logoH: c.logoH ?? 130,
    st: { section: { ...S(30, '#a594ff', 900, true), ...st.section }, role: { ...S(26, '#a3a9bd', 600, true), ...st.role }, name: { ...S(38, '#ffffff', 800, false), ...st.name } },
    speedMode: c.speedMode ?? 'duration',
    duration: c.duration ?? 40,
    pxs: c.pxs ?? 120,
    optimised: c.optimised ?? false,
    fps: c.fps && c.fps >= 1 ? c.fps : 25,
    maxPxs: c.maxPxs ?? 260,
    cardDur: c.cardDur ?? 4,
    start: c.start ?? 'on',
    end: c.end ?? 'stop',
    autoOut: c.autoOut ?? false,
    shortMode: c.shortMode ?? 'center',
    fade: c.fade ?? true,
    fadeSize: c.fadeSize ?? 140,
    panel: c.panel ?? true,
    panelColor: c.panelColor ?? '#060812c7',
  };
}
type K = ReturnType<typeof cfg>;
type St = K['st']['name'];
type E = { kind: Kind; a: string; b: string };

// ------------------------------------------------------------- content --
/** Mirrors parse(). */
export function parse(text: string): E[] {
  const out: E[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l) {
      if (out.length && out[out.length - 1].kind !== 'space') out.push({ kind: 'space', a: '', b: '' });
      continue;
    }
    if (l.startsWith('#')) {
      out.push({ kind: 'section', a: l.replace(/^#+\s*/, ''), b: '' });
      continue;
    }
    if (l.toLowerCase().startsWith('[logo') && l.endsWith(']')) {
      const v = l.slice(5, -1).trim();
      out.push({ kind: 'logo', a: v || 'PULSE TV', b: '' });
      continue;
    }
    if (l.toLowerCase().startsWith('[qr') && l.endsWith(']')) {
      const v = l.slice(3, -1);
      const bar = v.indexOf('|');
      out.push({ kind: 'qr', a: (bar < 0 ? v : v.slice(0, bar)).trim(), b: bar < 0 ? '' : v.slice(bar + 1).trim() });
      continue;
    }
    const parts = line.split(/[|;\t]/);
    if (parts.length > 1)
      out.push({
        kind: 'line',
        a: parts[0].trim(),
        b: parts
          .slice(1)
          .map((s) => s.trim())
          .join(' ')
          .trim(),
      });
    else out.push({ kind: 'line', a: '', b: l });
  }
  return out;
}
export const toText = (es: E[]) => es.map((e) => (e.kind === 'section' ? `# ${e.a}` : e.kind === 'logo' ? `[logo ${e.a}]` : e.kind === 'qr' ? (e.b ? `[qr ${e.a} | ${e.b}]` : `[qr ${e.a}]`) : e.kind === 'space' ? '' : e.a ? `${e.a} | ${e.b}` : e.b)).join('\n');
/** Entries from a table (a data set): its section / logo / role / name columns, else the first two columns as role and name. */
function tableEntries(head: string[], rows: string[][]): E[] {
  const section = findCol(head, ['section']);
  const logo = findCol(head, ['logo']);
  let role = findCol(head, ['role', 'job', 'function']);
  let name = findCol(head, ['name', 'person']);
  if (section < 0 && logo < 0 && role < 0 && name < 0) [role, name] = head.length >= 2 ? [0, 1] : [-1, 0];
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: E[] = [];
  for (const r of rows) {
    if (cell(r, section)) out.push({ kind: 'section', a: cell(r, section), b: '' });
    if (cell(r, logo)) out.push({ kind: 'logo', a: cell(r, logo), b: '' });
    if (cell(r, role) || cell(r, name)) out.push({ kind: 'line', a: cell(r, role), b: cell(r, name) });
  }
  return out;
}
export function entriesOf(k: K, data: Data): E[] {
  const es = rawEntries(k, data);
  // Without roles: one text a line (a role alone, from a table of one column, is that text) — as credits.rs.
  return k.roles ? es : es.map((e) => (e.kind === 'line' ? { ...e, a: '', b: e.b.trim() ? e.b : e.a } : e));
}

function rawEntries(k: K, data: Data): E[] {
  if (k.link.trim()) {
    const v = interpolateText(k.link, data);
    if (v.trim().startsWith('[')) {
      try {
        const a = JSON.parse(v.trim());
        const t = Array.isArray(a) ? headerRows(a) : null;
        if (t) return tableEntries(t.head, t.rows);
        if (Array.isArray(a)) {
          const out: E[] = [];
          for (const r of a) {
            if (typeof r === 'string') out.push(...parse(r));
            else if (r && typeof r === 'object') {
              const s = (x: string) => (typeof r[x] === 'string' ? r[x] : '');
              if (s('section')) out.push({ kind: 'section', a: s('section'), b: '' });
              if (s('logo')) out.push({ kind: 'logo', a: s('logo'), b: '' });
              if (s('name')) out.push({ kind: 'line', a: s('role'), b: s('name') });
            }
          }
          return out;
        }
      } catch {
        /* text */
      }
    }
    return parse(v);
  }
  return k.entries.map((e) => ({ kind: e.kind, a: interpolateText(e.a, data), b: interpolateText(e.b, data) }));
}

// -------------------------------------------------------------- layout --
type Body = { t: 'section'; s: string } | { t: 'logo'; s: string } | { t: 'space'; style: SpaceStyle } | { t: 'qr'; link: string; caption: string } | { t: 'lines'; row: [string, string][] };
interface Block {
  body: Body;
  gap: number;
  y: number;
  h: number;
  roleH: number;
}
const R = Math.round;
/** Height of a QR code's caption row (gap included), 0 without one (mirrors qr_caption_h). */
const qrCaptionH = (k: K, caption: string) => (caption.trim() ? R(k.st.role.size * 0.5) + R(k.st.role.size * 1.3) : 0);
/** Between a QR code and its caption, in the crawl (QR_CAPTION_GAP). */
const QR_CAPTION_GAP = 14;
export function blocks(k: K, es: E[]): [Block[], number] {
  const { section: s, role: rs, name: ns } = k.st;
  const out: Block[] = [];
  let i = 0;
  while (i < es.length) {
    const e = es[i];
    const first = !out.length;
    if (e.kind === 'section') (out.push({ body: { t: 'section', s: e.a }, gap: first ? 0 : k.sectionGap, y: 0, h: R(s.size * 1.3) + R(k.lineGap * 1.5), roleH: 0 }), i++);
    else if (e.kind === 'logo') (out.push({ body: { t: 'logo', s: e.a }, gap: first ? 0 : k.sectionGap, y: 0, h: k.logoH, roleH: 0 }), i++);
    else if (e.kind === 'qr') (out.push({ body: { t: 'qr', link: e.a, caption: e.b }, gap: first ? 0 : k.sectionGap, y: 0, h: k.logoH + qrCaptionH(k, e.b), roleH: 0 }), i++);
    else if (e.kind === 'space') (out.push({ body: { t: 'space', style: spaceStyle(e.a) }, gap: 0, y: 0, h: k.spaceH, roleH: 0 }), i++);
    else if (k.layout === 'three') {
      const row: [string, string][] = [];
      while (i < es.length && es[i].kind === 'line' && row.length < 3) (row.push([es[i].a, es[i].b]), i++);
      const roleH = row.some((x) => x[0]) ? R(rs.size * 1.3) : 0;
      out.push({ body: { t: 'lines', row }, gap: 0, y: 0, h: roleH + R(ns.size * 1.25) + k.lineGap, roleH });
    } else if (k.layout === 'one') {
      const roleH = e.a ? R(rs.size * 1.3) : 0;
      out.push({ body: { t: 'lines', row: [[e.a, e.b]] }, gap: 0, y: 0, h: roleH + R(ns.size * 1.25) + k.lineGap, roleH });
      i++;
    } else {
      const lh = R(Math.max(rs.size, ns.size) * 1.32);
      out.push({ body: { t: 'lines', row: [[e.a, e.b]] }, gap: 0, y: 0, h: lh + k.lineGap, roleH: lh });
      i++;
    }
  }
  while (out.length && out[out.length - 1].body.t === 'space') out.pop();
  let y = 0;
  out.forEach((b) => ((y += b.gap), (b.y = y), (y += b.h)));
  return [out, y];
}
interface Card {
  blocks: Block[];
  h: number;
}
export function cards(bl: Block[], boxH: number): Card[] {
  const max = boxH - 80;
  const cs: Card[] = [];
  for (const b of bl) {
    const cur = cs[cs.length - 1];
    if (b.body.t === 'space' && (!cur || !cur.blocks.length)) continue;
    if (!cur || b.body.t === 'section' || b.body.t === 'logo' || b.body.t === 'qr' || cur.h + b.h > max) cs.push({ blocks: [], h: 0 });
    const c = cs[cs.length - 1];
    const yy = c.blocks.length ? c.h + b.gap : 0;
    c.blocks.push({ ...b, y: yy });
    c.h = yy + b.h;
  }
  cs.forEach((c) => {
    while (c.blocks.length && c.blocks[c.blocks.length - 1].body.t === 'space') c.h -= c.blocks.pop()!.h;
  });
  return cs.filter((c) => c.blocks.length);
}
const styled = (s: St, t: string) => (s.upper ? t.toUpperCase() : t);
const lsOf = (s: St) => (s.upper ? s.size * 0.06 : 0);
const mw = (t: string, s: St, family: string) => tw(styled(s, t), s.size, s.weight, lsOf(s), family);
const isAsset = (s: string) => s.startsWith('/') || s.includes('.');
const IMG = new Map<string, number>();
/** Width / height of a picture (loaded once; 3 until known). */
function ratioOf(src: string): number {
  if (!isAsset(src)) return 3;
  const v = IMG.get(src);
  if (v !== undefined) return v || 3;
  IMG.set(src, 0);
  const im = new Image();
  im.onload = () => IMG.set(src, im.naturalWidth / Math.max(1, im.naturalHeight));
  im.src = src;
  return 3;
}
const crawlLogoH = (k: K, h: number) => Math.min(k.logoH, h * 0.7);
interface CItem {
  body: Body;
  x: number;
  w: number;
  roleW: number;
}
export function crawlItems(k: K, es: E[], h: number): [CItem[], number] {
  const out: CItem[] = [];
  let x = 0;
  const lh = crawlLogoH(k, h);
  for (const e of es) {
    let gap = out.length ? k.gutter * 2 : 0;
    let it: Omit<CItem, 'x'>;
    if (e.kind === 'section') {
      if (out.length) gap = k.sectionGap * 2;
      it = { body: { t: 'section', s: e.a }, w: mw(e.a, k.st.section, k.font), roleW: 0 };
    } else if (e.kind === 'logo') {
      if (out.length) gap = k.sectionGap * 2;
      it = { body: { t: 'logo', s: e.a }, w: lh * ratioOf(e.a), roleW: 0 };
    } else if (e.kind === 'qr') {
      if (out.length) gap = k.sectionGap * 2;
      it = { body: { t: 'qr', link: e.a, caption: e.b }, w: lh + (e.b.trim() ? QR_CAPTION_GAP + mw(e.b, k.st.role, k.font) : 0), roleW: 0 };
    } else if (e.kind === 'space') {
      const style = spaceStyle(e.a);
      // Marked: drawn halfway between its neighbours.
      if (style) {
        x += gap;
        out.push({ body: { t: 'space', style }, x, w: k.spaceH, roleW: 0 });
      }
      x += k.spaceH;
      continue;
    } else {
      const rw = e.a ? mw(e.a, k.st.role, k.font) + 16 : 0;
      it = { body: { t: 'lines', row: [[e.a, e.b]] }, w: rw + mw(e.b, k.st.name, k.font), roleW: rw };
    }
    x += gap;
    out.push({ ...it, x });
    x += it.w;
  }
  return [out, x];
}
export function travel(k: K, len: number, lastMid: number | undefined, boxl: number) {
  let a = k.start === 'off' ? boxl : k.fade ? k.fadeSize * 0.6 : 0;
  const short = len < boxl;
  const b = short && k.shortMode === 'center' ? (boxl - len) / 2 : k.end === 'stop' && lastMid !== undefined ? boxl / 2 - lastMid : -len;
  a = Math.max(a, b);
  return { a, b, x: a - b, len, short };
}
/** Everything the motion needs (mirrors the renderer). */
function geo(k: K, es: E[], w: number, h: number) {
  if (k.mode === 'pages') {
    const [bl] = blocks(k, es);
    const cs = cards(bl, h);
    return { mode: k.mode, cards: cs, x: cs.length, a: 0, len: 0, short: false, bl, items: [] as CItem[] };
  }
  if (k.mode === 'roll') {
    const [bl, len] = blocks(k, es);
    const t = travel(k, len, bl.length ? bl[bl.length - 1].y + bl[bl.length - 1].h / 2 : undefined, h);
    return { mode: k.mode, cards: [] as Card[], ...t, bl, items: [] as CItem[] };
  }
  const [items, len] = crawlItems(k, es, h);
  const l = items[items.length - 1];
  const t = travel(k, len, l ? l.x + l.w / 2 : undefined, w);
  return { mode: k.mode, cards: [] as Card[], ...t, bl: [] as Block[], items };
}
export function nominal(k: K, x: number) {
  x = Math.max(1e-6, x);
  if (k.speedMode === 'duration') return 1 / Math.max(0.5, k.duration);
  if (k.mode === 'pages') return 1 / (Math.max(0.3, k.cardDur) * x);
  return Math.max(1, k.pxs) / x;
}
/** The speed as a whole number of px per frame (no shimmer of the text) when that keeps the duration within 3 %, else null (mirrors snapped()). */
function snapped(k: K, v: number): number | null {
  if (!k.optimised || k.mode === 'pages' || v <= 0) return null;
  const w = Math.max(1, Math.round(v / k.fps)) * k.fps;
  return Math.abs(w - v) <= v * 0.03 ? w : null;
}
export function progress(k: K, st: State, x: number, now: number, age: number) {
  const rate = st.rate ?? nominal(k, x);
  const [base, dt] = !st.started ? [0, Math.max(0, age)] : st.running ? [st.base ?? 0, Math.max(0, now - (st.anchor ?? 0)) / 1000] : [st.base ?? 0, 0];
  const v = x > 0 ? snapped(k, rate * x) : null;
  // Whole frames (a hair of tolerance: 29 frames summed in floats may come out as 28.999…).
  const adv = v != null ? ((v / k.fps) * Math.floor(dt * k.fps + 1e-3)) / x : rate * dt;
  return clamp(base + adv, 0, 1);
}
/** progress() for drawing a frame: the same speed, continuous in time, so the roll moves on each of
 * the screen's frames (a 60 Hz or 120 Hz display) instead of standing still on some (credits.rs progress_smooth). */
export function progressSmooth(k: K, st: State, x: number, now: number, age: number) {
  const rate = st.rate ?? nominal(k, x);
  const [base, dt0] = !st.started ? [0, Math.max(0, age)] : st.running ? [st.base ?? 0, Math.max(0, now - (st.anchor ?? 0)) / 1000] : [st.base ?? 0, 0];
  const v = x > 0 ? snapped(k, rate * x) : null;
  const speed = v != null ? v / x : rate;
  // Whole frames of the project: on its own rate, exactly the stepped position.
  const frames = dt0 * k.fps;
  const dt = Math.abs(frames - Math.round(frames)) < 1e-3 ? Math.round(frames) / k.fps : dt0;
  return clamp(base + speed * dt, 0, 1);
}
function realRate(k: K, st: State, x: number) {
  const rate = st.rate ?? nominal(k, x);
  const v = x > 0 ? snapped(k, rate * x) : null;
  return v != null ? v / x : rate;
}
export const remaining = (k: K, st: State, x: number, now: number, age: number) => (1 - progress(k, st, x, now, age)) / Math.max(1e-9, realRate(k, st, x));

// -------------------------------------------------------------- render --
function Logo({ src, x, y, h }: { src: string; x: number; y: number; h: number }) {
  if (isAsset(src) && (IMG.get(src) ?? 0) > 0) return <img src={src} alt="" draggable={false} style={{ position: 'absolute', left: x, top: y, height: h, display: 'block' }} />;
  const n = src.toUpperCase().slice(0, 18);
  return (
    <svg style={{ position: 'absolute', left: x, top: y }} width={h * 3} height={h} viewBox="0 0 420 140">
      <defs>
        <linearGradient id="cg-cr-g" x1="0" x2="1">
          <stop offset="0" stopColor="#ff3b5c" />
          <stop offset="1" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="412" height="132" rx="30" fill="url(#cg-cr-g)" />
      <circle cx="70" cy="70" r="38" fill="#fff" />
      <circle cx="70" cy="70" r="16" fill="#ff3b5c" />
      <text x="255" y="70" dominantBaseline="central" fontFamily="Inter, sans-serif" fontWeight={900} fontSize={n.length > 9 ? 30 : 46} fill="#fff" textAnchor="middle">
        {n}
      </text>
    </svg>
  );
}
/** A QR code of `link` (modules from the server, as the Rust renderer): white, 2-module quiet zone. */
function QrBox({ link, x, y, side }: { link: string; x: number; y: number; side: number }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onQrLoaded(rerender), []);
  const qr = link.trim() ? qrModules(link.trim()) : null;
  const n = (qr?.size ?? 21) + 4;
  const rects: React.ReactNode[] = [];
  if (qr) for (let i = 0; i < qr.modules.length; i++) if (qr.modules[i] === '1') rects.push(<rect key={i} x={(i % qr.size) + 2} y={Math.floor(i / qr.size) + 2} width={1.02} height={1.02} />);
  return (
    <svg style={{ position: 'absolute', left: x, top: y }} width={side} height={side} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} rx={n * 0.04} fill="#fff" />
      <g fill="#000">{rects}</g>
    </svg>
  );
}
/** A space's mark, `len` long centred on (cx, cy), across when `vertical` (mirrors draw_space). */
function SpaceMark({ style, cx, cy, len, vertical, color }: { style: SpaceStyle; cx: number; cy: number; len: number; vertical?: boolean; color: string }) {
  if (!style) return null;
  const pad = 4;
  const [bw, bh] = vertical ? [pad * 2, len + pad * 2] : [len + pad * 2, pad * 2];
  const box = { position: 'absolute' as const, left: cx - bw / 2, top: cy - bh / 2 };
  let shapes: React.ReactNode;
  if (style === 'line') shapes = vertical ? <rect x={pad - 1} y={pad} width={2} height={len} /> : <rect x={pad} y={pad - 1} width={len} height={2} />;
  else if (style === 'dot') shapes = <circle cx={bw / 2} cy={bh / 2} r={3.5} />;
  else {
    const step = 9;
    const n = Math.max(1, Math.floor(len / step));
    const start = -((n - 1) * step) / 2;
    shapes = Array.from({ length: n }, (_, i) => <circle key={i} cx={bw / 2 + (vertical ? 0 : start + i * step)} cy={bh / 2 + (vertical ? start + i * step : 0)} r={1.6} />);
  }
  return (
    <svg style={box} width={bw} height={bh} fill={color}>
      {shapes}
    </svg>
  );
}
/** Length of a space's rule in the roll / pages (space_len). */
const spaceLen = (w: number) => Math.min(w * 0.3, 320);
function TextBox({ s, t, align, box, cut, family }: { s: St; t: string; align: 'left' | 'center' | 'right'; box: [number, number, number, number]; cut?: boolean; family: string }) {
  if (!t.trim()) return null;
  return <FitLine text={styled(s, t)} size={s.size} weight={s.weight} ls={lsOf(s)} align={align} box={box} color={hex(s.color, '#fff')} family={family} fit={cut ? { overflow: 'ellipsis', minSize: s.size, minSqueeze: 100 } : undefined} />;
}
// Memoised: a block rolling by keeps its props (it is slid by its parent), it is not drawn again on each frame.
const BlockView = memo(function BlockView({ k, b, y0, w }: { k: K; b: Block; y0: number; w: number }) {
  const { section: ss, role: rs, name: ns } = k.st;
  const al = k.align;
  const place = (bw: number) => (al === 'left' ? 0 : al === 'center' ? (w - bw) / 2 : w - bw);
  if (b.body.t === 'space') {
    const len = spaceLen(w);
    return <SpaceMark style={b.body.style} cx={place(len) + len / 2} cy={y0 + b.h / 2} len={len} color={hex(rs.color, '#fff')} />;
  }
  if (b.body.t === 'qr') {
    const ch = qrCaptionH(k, b.body.caption);
    const rh = R(rs.size * 1.3);
    return (
      <>
        <QrBox link={b.body.link} x={place(k.logoH)} y={y0} side={k.logoH} />
        {ch > 0 && <TextBox family={k.font} s={rs} t={b.body.caption} align={al} box={[0, y0 + k.logoH + ch - rh, w, rh]} cut />}
      </>
    );
  }
  if (b.body.t === 'section') return <TextBox family={k.font} s={ss} t={b.body.s} align={al} box={[0, y0, w, R(ss.size * 1.3)]} />;
  if (b.body.t === 'logo') {
    const lw = k.logoH * ratioOf(b.body.s);
    return <Logo src={b.body.s} x={al === 'left' ? 0 : al === 'center' ? (w - lw) / 2 : w - lw} y={y0} h={k.logoH} />;
  }
  const row = b.body.row;
  if (k.layout === 'two') {
    const [role, name] = row[0];
    const split = al === 'left' ? 0.4 : al === 'right' ? 0.6 : 0.5;
    const lw = w * split - k.gutter / 2;
    return (
      <>
        <TextBox family={k.font} s={rs} t={role} align={al === 'left' ? 'left' : 'right'} box={[0, y0, lw, b.roleH]} cut />
        <TextBox family={k.font} s={ns} t={name} align={al === 'right' ? 'right' : 'left'} box={[lw + k.gutter, y0, w - lw - k.gutter, b.roleH]} cut />
      </>
    );
  }
  const three = k.layout === 'three';
  const cw = three ? (w - 2 * k.gutter) / 3 : w;
  const nh = R(ns.size * 1.25);
  return (
    <>
      {row.map(([role, name], j) => (
        <span key={j}>
          {b.roleH > 0 && <TextBox family={k.font} s={rs} t={role} align={al} box={[j * (cw + k.gutter), y0, cw, b.roleH]} cut={three} />}
          <TextBox family={k.font} s={ns} t={name} align={al} box={[j * (cw + k.gutter), y0 + b.roleH, cw, nh]} cut={three} />
        </span>
      ))}
    </>
  );
});

function CreditsRender({ layer, w, h, data, time, state }: { layer: Config; w: number; h: number; data: Data; time: { nowMs: number; ageSecs: number }; state: unknown }) {
  // Redrawn on each frame: the layout is kept (laid out again when a font loads).
  const fonts = useFonts((s) => s.ready);
  const k = useMemo(() => cfg(layer), [layer]);
  const st = (state ?? {}) as State;
  const g = useMemo(() => geo(k, entriesOf(k, data), w, h), [k, data, w, h, fonts]); // eslint-disable-line react-hooks/exhaustive-deps
  const vert = k.mode !== 'crawl';
  const f = k.fadeSize;
  const mask = k.fade ? `linear-gradient(${vert ? '180deg' : '90deg'},transparent 0,#000 ${f}px,#000 calc(100% - ${f}px),transparent 100%)` : undefined;
  const band = Math.min(h, R(Math.max(k.st.name.size, k.st.section.size, Math.min(k.logoH, h * 0.7)) * 1.6));
  const out: React.ReactNode[] = [];
  // Cards keep the project's steps; a roll or a crawl moves on each frame shown.
  const p = k.mode === 'pages' ? progress(k, st, g.x, time.nowMs, time.ageSecs) : progressSmooth(k, st, g.x, time.nowMs, time.ageSecs);
  if (k.mode === 'roll') {
    const off = g.a - p * g.x;
    const rows: React.ReactNode[] = [];
    g.bl.forEach((b, i) => {
      const y = off + b.y;
      if (y > h || y + b.h < 0) return;
      rows.push(
        <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: 0, transform: `translateY(${b.y}px)` }}>
          <BlockView k={k} b={b} y0={0} w={w} />
        </div>,
      );
    });
    // The whole roll slides as one layer of the graphics card: on each frame only its offset changes.
    out.push(
      <div key="roll" style={{ position: 'absolute', inset: 0, transform: `translate3d(0, ${off}px, 0)`, willChange: 'transform' }}>
        {rows}
      </div>,
    );
  } else if (k.mode === 'crawl') {
    const off = g.a - p * g.x;
    const lh = crawlLogoH(k, h);
    g.items.forEach((it, i) => {
      const x = off + it.x;
      if (x > w || x + it.w < 0) return;
      if (it.body.t === 'section') out.push(<TextBox family={k.font} key={i} s={k.st.section} t={it.body.s} align="left" box={[x, 0, it.w + 4, h]} />);
      else if (it.body.t === 'logo') out.push(<Logo key={i} src={it.body.s} x={x} y={(h - lh) / 2} h={lh} />);
      else if (it.body.t === 'qr')
        out.push(
          <span key={i}>
            <QrBox link={it.body.link} x={x} y={(h - lh) / 2} side={lh} />
            {it.body.caption.trim() && <TextBox family={k.font} s={k.st.role} t={it.body.caption} align="left" box={[x + lh + QR_CAPTION_GAP, 0, it.w - lh - QR_CAPTION_GAP + 4, h]} />}
          </span>,
        );
      else if (it.body.t === 'space') out.push(<SpaceMark key={i} style={it.body.style} cx={x + it.w / 2} cy={h / 2} len={lh * 0.5} vertical color={hex(k.st.role.color, '#fff')} />);
      else if (it.body.t === 'lines') {
        const [role, name] = it.body.row[0];
        out.push(
          <span key={i}>
            {role && <TextBox family={k.font} s={k.st.role} t={role} align="left" box={[x, 0, it.roleW, h]} />}
            <TextBox family={k.font} s={k.st.name} t={name} align="left" box={[x + it.roleW, 0, it.w - it.roleW + 4, h]} />
          </span>,
        );
      }
    });
  } else {
    const n = g.cards.length;
    const pc = p * n;
    const rate = (st.rate ?? nominal(k, n)) * n;
    const fk = Math.min(0.45, 0.6 * Math.max(0.05, rate));
    g.cards.forEach((c, i) => {
      const inn = i === 0 ? (k.start === 'on' ? 1 : clamp(pc / fk, 0, 1)) : clamp((pc - i + fk / 2) / fk, 0, 1);
      const o2 = i < n - 1 ? clamp((i + 1 + fk / 2 - pc) / fk, 0, 1) : k.end === 'exit' ? clamp((n - pc) / fk, 0, 1) : 1;
      const o = Math.min(inn, o2);
      if (o <= 0.001) return;
      const top = (h - c.h) / 2;
      out.push(
        <div key={i} style={{ position: 'absolute', inset: 0, opacity: o, transform: `translateY(${(1 - inn) * 30}px)` }}>
          {c.blocks.map((b, j) => (
            <BlockView key={j} k={k} b={b} y0={top + b.y} w={w} />
          ))}
        </div>,
      );
    });
  }
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: familyCss(k.font) }}>
      {k.panel && <div style={{ position: 'absolute', left: 0, width: w, ...(vert ? { top: 0, height: h } : { top: R((h - band) / 2), height: band }), background: hex(k.panelColor), borderRadius: 6 }} />}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', WebkitMaskImage: mask, maskImage: mask }}>{out}</div>
    </div>
  );
}

// ------------------------------------------------------------ inspector --
/** A time of day, hh:mm:ss, in the server's zone (the end time is read there). */
const fmtClock = (ms: number, tz?: string) => {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz || undefined });
  } catch {
    return new Date(ms).toLocaleTimeString('en-GB');
  }
};
const mss = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const TEXT0 = `# Directed by
Presenter | Claire Martin
Director | Paul Fontaine

# Production
Production | Strata Studio
Thanks | City of Lyon`;

type CL = Config & { id: string; name?: string; props: Record<string, unknown>; manualStart?: boolean; startOn?: 'continue' | 'trigger'; startTrigger?: string };
const sizeOf = (l: CL, r?: Record<string, unknown>) => [num((r?.width as number) ?? (l.props.width as number) ?? 1100), num((r?.height as number) ?? (l.props.height as number) ?? 1000)];

function warningsOf(l: CL, data: Data, state: unknown, w: number, h: number): Warning[] {
  const k = cfg(l);
  const st = (state ?? {}) as State;
  const es = entriesOf(k, data);
  const g = geo(k, es, w, h);
  const out: Warning[] = [];
  const live = !!st.started;
  if (k.mode !== 'pages') {
    const v0 = (live && st.rate ? st.rate : nominal(k, g.x)) * g.x;
    const v = snapped(k, v0) ?? v0;
    if (v > k.maxPxs) out.push({ level: 'error', text: t('Speed {speed} px/s is above the readable threshold ({max} px/s): at least {secs} s needed.', { speed: v.toFixed(0), max: k.maxPxs, secs: Math.ceil(g.x / k.maxPxs) }), op: true });
  } else {
    const per = 1 / Math.max(1e-6, (live && st.rate ? st.rate : nominal(k, g.x)) * Math.max(1, g.x));
    if (per < 1.5) out.push({ level: 'error', text: t('{secs} s per card is too short to read (min 1.5 s).', { secs: per.toFixed(1) }), op: true });
  }
  if (g.short) out.push({ level: 'info', text: k.shortMode === 'center' ? t('Content shorter than the screen: it stops centred — no empty scroll.') : t('Content shorter than the screen: it passes and exits — no empty scroll.') });
  if (!es.length) out.push({ level: 'warn', text: t('No content.'), op: true });
  return out;
}

/** The font of the whole credits (families of Assets, each shown in itself). */
function FamilyRow({ value }: { value: string }) {
  const b = useBound();
  const families = useFonts((s) => s.families);
  // The list is loaded at start, which fails before logging in.
  useEffect(() => {
    if (!families.length) void loadFonts();
  }, [families.length]);
  const known = families.some((f) => f.family.toLowerCase() === value.toLowerCase());
  const opts = [...(known ? [] : [{ value, label: t('{family} (missing)', { family: value }) }]), ...families.map((f) => ({ value: f.family, label: f.family, style: { fontFamily: `"${f.family}", Inter, sans-serif` } }))];
  return (
    <Row label={t('Font')} expose="font" exposeValue={value}>
      <div className="font-pick">
        <Dropdown value={families.find((f) => f.family.toLowerCase() === value.toLowerCase())?.family ?? value} options={opts} onChange={(v) => b.set('font', v)} />
      </div>
    </Row>
  );
}

type OpP = { layer: unknown; state: unknown; data: Data; act: (op: string, args?: unknown) => void; item?: unknown; time: { nowMs: number; ageSecs: number; defaultTz?: string; fps?: number; held?: boolean } };

/** The entries as a table (type · role / title · name): the Designer's content and the Operator's when exposed. */
export function EntriesTable({ value, onChange, roles = true }: { value: Entry[]; onChange: (v: Entry[]) => void; /** false: one text a line (no role column). */ roles?: boolean }) {
  const kinds: { value: Kind; label: string }[] = [
    { value: 'section', label: t('Section') },
    { value: 'line', label: t('Line') },
    { value: 'logo', label: t('Logo') },
    { value: 'qr', label: t('QR code') },
    { value: 'space', label: t('Space') },
  ];
  const spaces: { value: SpaceStyle; label: string }[] = [
    { value: '', label: tc('space', 'Empty') },
    { value: 'line', label: tc('space', 'Rule') },
    { value: 'dots', label: tc('space', 'Dotted') },
    { value: 'dot', label: tc('space', 'Dot') },
  ];
  // A space keeps its style in `a`: its values start again when the type changes to or from it.
  const setKind = (i: number, e: Entry, kind: Kind) => put(i, (e.kind ?? 'line') === 'space' || kind === 'space' ? { kind, a: '', b: '' } : { kind });
  const put = (i: number, patch: Partial<Entry>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  // Rows moved by their grip: the one dragged, and where it would go (before row `at`).
  const [from, setFrom] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const stop = () => (setFrom(null), setAt(null));
  const drop = () => {
    if (from != null && at != null && at !== from && at !== from + 1) {
      const rows = value.slice();
      const [e] = rows.splice(from, 1);
      rows.splice(at > from ? at - 1 : at, 0, e);
      onChange(rows);
    }
    stop();
  };
  return (
    <div className="cr-table">
      <table>
        <thead>
          <tr>
            <th />
            <th>{t('Type')}</th>
            {roles ? (
              <>
                <th>{t('Role / title / logo / link')}</th>
                <th>{t('Name / caption')}</th>
              </>
            ) : (
              <th colSpan={2}>{t('Text')}</th>
            )}
            <th />
          </tr>
        </thead>
        <tbody>
          {value.map((e, i) => {
            const kind = e.kind ?? 'line';
            return (
              <tr
                key={i}
                className={`${from === i ? 'cr-dragging' : ''} ${from != null && at === i ? 'cr-drop-before' : ''} ${from != null && at === i + 1 && i === value.length - 1 ? 'cr-drop-after' : ''}`}
                onDragOver={(ev) => {
                  if (from == null) return;
                  // Ours only: the rundown's and playlists' drops stay theirs.
                  ev.preventDefault();
                  ev.stopPropagation();
                  ev.dataTransfer.dropEffect = 'move';
                  const r = ev.currentTarget.getBoundingClientRect();
                  setAt(ev.clientY > r.top + r.height / 2 ? i + 1 : i);
                }}
                onDrop={(ev) => {
                  if (from == null) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  drop();
                }}
              >
                <td
                  className="cr-grip"
                  draggable
                  title={t('Drag to reorder')}
                  onDragStart={(ev) => {
                    ev.stopPropagation();
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('application/x-strata-credit', String(i));
                    const row = ev.currentTarget.parentElement;
                    if (row) ev.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
                    setFrom(i);
                  }}
                  onDragEnd={stop}
                >
                  <GripVertical size={13} />
                </td>
                <td className="cr-kind">
                  <Dropdown value={kind} options={kinds} onChange={(v) => setKind(i, e, v as Kind)} />
                </td>
                {kind === 'logo' ? (
                  <td colSpan={2}>
                    <AssetPicker value={e.a ?? ''} title={t('Logo')} clearable={false} onChange={(v) => put(i, { a: v })} />
                  </td>
                ) : kind === 'space' ? (
                  <td colSpan={2}>
                    <Segmented value={spaceStyle(e.a ?? '')} options={spaces} onChange={(v) => put(i, { a: v })} />
                  </td>
                ) : !roles && kind === 'line' ? (
                  <td colSpan={2}>
                    <input value={e.b || e.a || ''} onKeyDown={(ev) => ev.stopPropagation()} onChange={(ev) => put(i, { a: '', b: ev.target.value })} />
                  </td>
                ) : !roles && kind === 'section' ? (
                  <td colSpan={2}>
                    <input value={e.a ?? ''} onKeyDown={(ev) => ev.stopPropagation()} onChange={(ev) => put(i, { a: ev.target.value })} />
                  </td>
                ) : (
                  <>
                    <td>
                      <input value={e.a ?? ''} placeholder={kind === 'qr' ? 'https://…' : ''} onKeyDown={(ev) => ev.stopPropagation()} onChange={(ev) => put(i, { a: ev.target.value })} />
                    </td>
                    <td>{(kind === 'line' || kind === 'qr') && <input value={e.b ?? ''} onKeyDown={(ev) => ev.stopPropagation()} onChange={(ev) => put(i, { b: ev.target.value })} />}</td>
                  </>
                )}
                <td className="cr-x">
                  <button title={t('Remove')} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="link-btn cr-add" onClick={() => onChange([...value, { kind: 'line', a: '', b: '' }])}>
        <Plus size={13} /> {t('Entry')}
      </button>
    </div>
  );
}

/** The credits a value feeds (its content exposed) show roles: false when they show one text a line. */
export function rolesFor(fieldKey: string): boolean {
  for (const tpl of useApp.getState().project?.templates ?? [])
    for (const l of tpl.layers) if (l.type === 'credits' && (l as { settingBindings?: Record<string, string> }).settingBindings?.entries === fieldKey) return (l as Config).roles !== false;
  return true;
}

/** Credits set to go out by themselves (Config.autoOut), on air: seconds left and the whole roll; null when they do not. */
export function creditsLeft(layer: unknown, state: unknown, data: Data, nowMs: number, ageSecs: number): { left: number; total: number } | null {
  const l = layer as CL;
  const k = cfg(l);
  if (!k.autoOut) return null;
  const st = (state ?? {}) as State;
  // Waiting for its manual start: not counting yet.
  if (l.manualStart && !st.started) return null;
  const [w, h] = sizeOf(l);
  const g = geo(k, entriesOf(k, data), w, h);
  const left = Math.max(0, remaining(k, st, g.x, nowMs, st.started ? 0 : Math.max(0, ageSecs)));
  return { left, total: 1 / Math.max(1e-9, realRate(k, st, g.x)) };
}

/** Where the credits are now, for the Operator's controls. */
function useRun({ layer, state, data, time }: OpP) {
  const { now, age } = useLiveTime(time);
  const l = layer as CL;
  const k = cfg(l);
  const st = (state ?? {}) as State;
  const [w, h] = sizeOf(l);
  const g = geo(k, entriesOf(k, data), w, h);
  const ageNow = st.started ? 0 : Math.max(0, age);
  const f = progress(k, st, g.x, now, ageNow);
  const rem = remaining(k, st, g.x, now, ageNow);
  // Manual launch: it waits for the operator's top.
  const status: 'running' | 'paused' | 'done' | 'idle' = f >= 1 - 1e-9 ? 'done' : !st.started ? (l.manualStart ? 'idle' : 'running') : st.running ? 'running' : f > 0 ? 'paused' : 'idle';
  return { l, k, st, g, f, rem, status, now, travel: { travel: g.x } };
}

/** Pictograms of the Motion choices (a frame, its lines, where they go). */
const Box = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 44 30" width={44} height={30} aria-hidden>
    {children}
  </svg>
);
const frame = <rect x="8" y="2" width="28" height="26" rx="2" fill="none" stroke="currentColor" strokeOpacity=".5" />;
const up = <path d="M40 20V8m-3 3 3-3 3 3" stroke="var(--accent)" strokeWidth="1.6" fill="none" />;
const ICON = {
  roll: (
    <Box>
      {frame}
      <path d="M14 9h16M14 15h16M14 21h16" stroke="currentColor" strokeWidth="2" />
      {up}
    </Box>
  ),
  crawl: (
    <Box>
      <rect x="2" y="8" width="40" height="14" rx="2" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <path d="M6 15h12M22 15h10" stroke="currentColor" strokeWidth="2" />
      <path d="M34 26H10m3-3-3 3 3 3" stroke="var(--accent)" strokeWidth="1.6" fill="none" />
    </Box>
  ),
  pages: (
    <Box>
      <rect x="4" y="6" width="22" height="18" rx="2" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <rect x="18" y="3" width="22" height="18" rx="2" fill="var(--panel-2)" stroke="currentColor" />
      <path d="M23 10h12M23 14h9" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  in: (
    <Box>
      <rect x="6" y="7" width="32" height="16" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <text x="22" y="19" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">
        IN
      </text>
    </Box>
  ),
  continue: (
    <Box>
      <path d="M12 8l8 7-8 7M22 8l8 7-8 7" stroke="currentColor" strokeWidth="2" fill="none" />
    </Box>
  ),
  trigger: (
    <Box>
      <path d="M24 4 14 17h8l-2 9 10-13h-8z" fill="currentColor" />
    </Box>
  ),
  off: (
    <Box>
      <rect x="8" y="2" width="28" height="18" rx="2" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <path d="M14 24h16M14 28h16" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  on: (
    <Box>
      {frame}
      <path d="M14 9h16M14 15h16" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  exit: (
    <Box>
      <rect x="8" y="8" width="28" height="20" rx="2" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <path d="M14 2h16M14 5h16" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  stop: (
    <Box>
      {frame}
      <path d="M14 15h16" stroke="currentColor" strokeWidth="2" />
      <path d="M39 12v6" stroke="var(--accent)" strokeWidth="2" />
    </Box>
  ),
  still: (
    <Box>
      {frame}
      <path d="M14 12h16M14 18h16" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  rolls: (
    <Box>
      {frame}
      <path d="M14 8h16M14 14h16" stroke="currentColor" strokeWidth="2" />
      {up}
    </Box>
  ),
  auto: (
    <Box>
      <circle cx="22" cy="15" r="10" fill="none" stroke="currentColor" strokeOpacity=".5" />
      <path d="M22 15V8M22 15l5 3" stroke="currentColor" strokeWidth="2" />
    </Box>
  ),
  out: (
    <Box>
      <rect x="8" y="8" width="28" height="14" rx="3" fill="var(--live)" />
      <text x="22" y="18.5" textAnchor="middle" fontSize="8" fontWeight="800" fill="#fff">
        OUT
      </text>
    </Box>
  ),
};

/** A choice shown as pictures, its label above (with its expose button). */
function Pics<V extends string>({ label, value, options, onChange, n = 2, expose, exposeValue }: { label: string; value: V; options: [V, string, ReactNode][]; onChange: (v: V) => void; n?: number; expose?: string[]; exposeValue?: unknown }) {
  const mode = useCentreMode();
  const filter = useContext(ExposedFilter);
  // In the Operator: only when exposed.
  if (filter && expose && !filter(expose)) return null;
  return (
    <div className="cr-pics">
      <div className="cr-pics-h">
        <span>{label}</span>
        {expose && mode === 'designer' && !filter && <ExposeSetting paths={expose} label={label} value={exposeValue} />}
      </div>
      <div className="cr-pics-g" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {options.map(([v, text, icon]) => (
          <button key={v} type="button" className={`cr-pic ${v === value ? 'on' : ''}`} onClick={() => onChange(v)}>
            {icon}
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** How the credits start on air (exposable): at the In, on Continue (F2), on a trigger. */
function StartChoice({ layer }: { layer: { manualStart?: boolean; startOn?: 'continue' | 'trigger'; startTrigger?: string } }) {
  const b = useBound();
  const m = startMode(layer);
  return (
    <>
      <Pics
        label={tc('cc', 'Start')}
        value={m}
        n={3}
        expose={['manualStart', 'startOn']}
        exposeValue={{ manualStart: !!layer.manualStart, startOn: layer.startOn ?? '' }}
        onChange={(v) => {
          b.set('manualStart', v !== 'in' ? true : undefined);
          b.set('startOn', v === 'trigger' ? 'trigger' : undefined);
        }}
        options={[
          ['in', tc('cc', 'At the In'), ICON.in],
          ['continue', tc('cc', 'Continue F2'), ICON.continue],
          ['trigger', tc('cc', 'Trigger'), ICON.trigger],
        ]}
      />
      {m === 'trigger' && <Text label={tc('cc', 'Trigger name')} path="startTrigger" value="" />}
    </>
  );
}

/** The whole roll's duration, m:ss on a slider (exposable). */
function DurationRow({ value, onChange }: { value: number; onChange: (s: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const done = () => {
    if (drag !== null && drag !== value) onChange(drag);
    setDrag(null);
  };
  return (
    <Row label={t('Duration')} expose="duration" exposeValue={value}>
      <span className="cr-slide">
        <input type="range" min={5} max={600} step={1} value={clamp(Math.round(shown), 5, 600)} onChange={(e) => setDrag(+e.target.value)} onPointerUp={done} onKeyUp={done} onBlur={done} onKeyDown={(e) => e.stopPropagation()} />
        <OpField
          width={58}
          title={t('Duration')}
          value={mss(Math.round(shown))}
          placeholder="m:ss"
          onSubmit={(v) => {
            const s = parseDuration(v);
            if (s != null && s > 0) onChange(Math.round(s));
          }}
        />
      </span>
    </Row>
  );
}

/** Where the credits are, from the start to the end: dragging moves them there (Designer). */
function PositionRow({ f, total, onSeek }: { f: number; total: number; onSeek: (f: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const last = useRef(0);
  const shown = drag ?? f;
  const seek = (v: number, force = false) => {
    setDrag(v);
    // At most one move every 80 ms while dragging, the last one always.
    const now = performance.now();
    if (force || now - last.current > 80) {
      last.current = now;
      onSeek(v);
    }
  };
  return (
    <Row label={tc('credits', 'Position')}>
      <span className="cr-slide">
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(shown * 1000)}
          onChange={(e) => seek(+e.target.value / 1000)}
          onPointerUp={(e) => (seek(+(e.target as HTMLInputElement).value / 1000, true), setDrag(null))}
          onKeyUp={(e) => (seek(+(e.target as HTMLInputElement).value / 1000, true), setDrag(null))}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="cr-slide-v">{mss(Math.round(shown * total))}</span>
      </span>
    </Row>
  );
}

/** Whole pixels a frame at the project's rate (credits.rs `snapped`): the roll does not shimmer. */
const smooth = (set: (path: string, v: unknown) => void) => {
  const fr = useApp.getState().project?.frameRate;
  set('optimised', true);
  if (fr) set('fps', fr.num / fr.den);
};

/**
 * The control centre of the credits (web/src/widgets/centre.tsx). Line 1: the time left, when it
 * ends (or its state), its start on air. Line 2: play / pause, reset (the Designer); the Operator
 * also has next card (pages), finish and ∓10 s. Line 3: the duration of the whole roll (exposable),
 * where it is (Designer), its start (Operator, when exposed) and the end time (Operator).
 */
function CreditsBar(p: OpP) {
  const { act } = p;
  const item = p.item as PlayoutItem | undefined;
  const mode = useCentreMode();
  const b = useBound();
  const designer = mode === 'designer';
  const l0 = p.layer as CL;
  const time = layerTime(l0, item, p.time, !!(p.state as State | undefined)?.started);
  const { l, k, st, g, f, rem, status, now, travel } = useRun({ ...p, time });
  const tz = time.defaultTz || undefined;
  const running = status === 'running';
  const play = () => act(status === 'paused' || (status === 'idle' && f > 0) ? 'resume' : 'start', travel);
  // Space stays the Operator's CONTINUE.
  useKeys({
    s: () => act('start', travel),
    p: () => (running ? act('pause', travel) : play()),
    ArrowRight: () => k.mode === 'pages' && act('next', travel),
  });
  const sub = running ? t('ends at {time}', { time: fmtClock(now + rem * 1000, tz) }) : status === 'paused' ? tc('cc', 'paused') : status === 'done' ? tc('cc', 'finished') : tc('cc', 'ready');
  // Waiting for its start on air: Continue (F2) or its trigger (the server starts it, see credits.rs).
  const waiting = !!item && !!l.manualStart && !st.started;
  const status1 = waiting ? l.startOn === 'trigger' ? <WaitsTrigger name={l.startTrigger ?? ''} /> : <WaitsContinue /> : undefined;
  const resetMsg = item ? t('{name} is on air: back to the start of the credits?', { name: l.name ?? '' }) : undefined;
  const playPause: Line2Item = running ? { icon: Pause, label: tc('cc', 'Pause'), key: 'P', main: true, onClick: () => act('pause', travel) } : { icon: Play, label: tc('cc', 'Play'), key: 'P', main: true, onClick: play };
  const reset: Line2Item = { icon: RotateCcw, label: tc('cc', 'Reset'), confirm: resetMsg, onClick: () => act('reset') };
  const actions: Line2Item[] = designer
    ? [playPause, reset]
    : [
        playPause,
        k.mode === 'pages' && { icon: SkipForward, label: tc('credits', 'Next card'), key: '→', onClick: () => act('next', travel) },
        { icon: Flag, label: t('Finish'), disabled: status === 'done', onClick: () => act('finish', travel) },
        reset,
        { icon: Minus, text: '−10 s', label: t('Remaining −10 s'), onClick: () => act('adjust', { seconds: -10, ...travel }) },
        { icon: Plus, text: '+10 s', label: t('Remaining +10 s'), onClick: () => act('adjust', { seconds: 10, ...travel }) },
      ];
  // The time of the whole roll: the template's (Designer, or the take's when exposed).
  const total = 1 / Math.max(1e-9, nominal(k, g.x));
  const setDuration = (s: number) => {
    b.set('duration', Math.max(1, Math.round(s)));
    if (designer) {
      if (k.speedMode !== 'duration') b.set('speedMode', 'duration');
      if (!k.optimised) smooth(b.set);
    }
  };
  // Under the Operator's preview (its controls only): as in the Designer, play / pause, reset, the duration (when exposed) and where it is.
  const preview = mode === 'air' && !item;
  if (preview)
    return (
      <Centre name={l.name} actions={[playPause, reset]} l3Air>
        <DurationRow value={Math.round(total)} onChange={setDuration} />
        <PositionRow f={f} total={total} onSeek={(x) => act('seek', { fraction: x, ...travel })} />
      </Centre>
    );
  return (
    <Centre name={l.name} readout={{ v: mss(rem), sub }} status={status1} actions={actions}>
      <DurationRow value={Math.round(total)} onChange={setDuration} />
      {designer && <PositionRow f={f} total={total} onSeek={(x) => act('seek', { fraction: x, ...travel })} />}
      {!designer && <StartChoice layer={l} />}
      {!designer && (
        <Row label={t('End at')}>
          <OpField width={84} title={t('End at')} value={status === 'done' ? '' : fmtClock(now + rem * 1000, tz)} placeholder="hh:mm:ss" onSubmit={(v) => act('endAt', { time: v, ...(tz ? { tz } : {}), ...travel })} />
        </Row>
      )}
    </Centre>
  );
}

/** Colour · size · weight · CAPS of a level. */
function StyleRows({ label, path, s }: { label: string; path: string; s: St }) {
  const b = useBound();
  return (
    <>
      <Row expose={[`${path}.color`, `${path}.size`]} exposeValue={{ [`${path}.color`]: s.color, [`${path}.size`]: s.size }} label={label}>
        <span className="pp-field color" style={{ flex: 1, minWidth: 0 }}>
          <ColorField value={parseHex(s.color) ?? [1, 1, 1, 1]} onChange={(c) => b.set(`${path}.color`, toHex(c, c[3] < 1), true)} />
        </span>
        <span className="pp-field" style={{ flex: 'none' }}>
          <NumberField value={s.size} min={1} max={400} suffix="px" onChange={(x) => b.set(`${path}.size`, x, true)} />
        </span>
      </Row>
      <Row expose={[`${path}.weight`, `${path}.upper`]} exposeValue={{ [`${path}.weight`]: s.weight, [`${path}.upper`]: s.upper }} label="">
        <Segmented
          value={String(s.weight)}
          onChange={(x) => b.set(`${path}.weight`, +x)}
          options={[
            { value: '500', label: t('Med') },
            { value: '700', label: t('Bold') },
            { value: '900', label: t('Black') },
          ]}
        />
        <Segmented value={s.upper ? 'u' : ''} onChange={() => b.set(`${path}.upper`, !s.upper)} options={[{ value: 'u', label: 'AA', title: t('Upper case') }]} />
      </Row>
    </>
  );
}

export default defineWidget({
  id: 'credits',
  type: 'credits',
  label: 'Credits',
  group: 'Data',
  icon: ScrollText,
  create: () => {
    // The sample credits in the project's language.
    const text = tl(useApp.getState().project?.language, TEXT0);
    // Whole pixels a frame at the project's rate (credits.rs `snapped`).
    const fr = useApp.getState().project?.frameRate;
    return { entries: parse(text), importText: text, fade: false, panel: false, optimised: true, ...(fr ? { fps: fr.num / fr.den } : {}), props: { width: 1100, height: 1000 } };
  },
  ownsLook: true,
  content: ['entries', 'link'],
  // Exposed, they are settings of its control centre (duration, start), not values.
  controlSettings: ['duration', 'manualStart', 'startOn'],
  live: () => true,
  ageOnly: true,
  Render: ({ layer, w, h, data, time, state }) => <CreditsRender layer={layer} w={w} h={h} data={data} time={time} state={state} />,
  Inspector: ({ layer, edit }) => {
    const l = layer as unknown as CL;
    const k = cfg(l);
    const set = (fn: (x: Config) => void) => edit((x) => fn(x as never));
    return (
      <>
        <Section id="credits-content" title={t('Content')}>
          {/* Role + name a line, or one text. */}
          <Toggle label={t('Roles')} path="roles" value={k.roles} />
          {k.link.trim() ? (
            // Fed by the Data canvas: its source, not the table.
            <Content label={t('Source')} path="link" placeholder="{{key}}" />
          ) : (
            <>
              <div className="cr-tools">
                <ExposeSetting paths={['entries']} label={t('Content')} value={k.entries} text={t('Expose to the Operator')} />
                <button
                  className="btn small"
                  disabled={!k.entries.length}
                  onClick={async () => {
                    if (await confirmDialog({ title: t('Clear the whole credits?'), confirm: t('Clear all'), danger: true })) set((x) => void (x.entries = []));
                  }}
                >
                  <Trash2 size={13} /> {t('Clear all')}
                </button>
              </div>
              <EntriesTable value={k.entries} roles={k.roles} onChange={(v) => set((x) => void (x.entries = v))} />
            </>
          )}
        </Section>
        <Section id="credits-layout" title={t('Layout')}>
          {k.mode !== 'crawl' && (
            <>
              {k.roles && (
              <Seg
                label={t('Columns')}
                path="layout"
                value={k.layout}
                options={[
                  ['one', '1'],
                  ['two', '2'],
                  ['three', '3'],
                ]}
              />
              )}
              <Seg
                label={t('Align')}
                path="align"
                value={k.align}
                options={[
                  ['left', t('Left')],
                  ['center', t('Centre')],
                  ['right', t('Right')],
                ]}
              />
            </>
          )}
          <Num label={t('Gutter')} path="gutter" value={k.gutter} min={0} max={1000} unit="px" />
          <Num label={t('Section gap')} path="sectionGap" value={k.sectionGap} min={0} max={1000} unit="px" />
          <Num label={t('Line gap')} path="lineGap" value={k.lineGap} min={0} max={1000} unit="px" />
          <Num label={t('Space')} path="spaceH" value={k.spaceH} min={0} max={1000} unit="px" />
          <Num label={t('Logo height')} path="logoH" value={k.logoH} min={10} max={1000} unit="px" />
        </Section>
        <Section id="credits-styles" title={t('Styles')}>
          <FamilyRow value={k.font} />
          <StyleRows label={t('Section')} path="st.section" s={k.st.section} />
          <StyleRows label={t('Role')} path="st.role" s={k.st.role} />
          <StyleRows label={t('Name')} path="st.name" s={k.st.name} />
          <Toggle label={t('Panel')} path="panel" value={k.panel} />
          {k.panel && <ColorPick label={t('Color')} path="panelColor" value={k.panelColor} />}
          <Toggle label={t('Fade')} path="fade" value={k.fade} />
          {k.fade && <Num label={t('Size')} path="fadeSize" value={k.fadeSize} min={1} max={1000} unit="px" />}
        </Section>
        <Section id="credits-motion" title={t('Motion')}>
          <Pics
            label={t('Mode')}
            value={k.mode}
            n={3}
            onChange={(v) => set((c) => void (c.mode = v))}
            options={[
              ['roll', t('Vertical'), ICON.roll],
              ['crawl', t('Horizontal'), ICON.crawl],
              ['pages', t('Pages'), ICON.pages],
            ]}
          />
          <StartChoice layer={l} />
          {k.mode !== 'pages' && (
            <Pics
              label={tc('credits', 'At the start')}
              value={k.start}
              onChange={(v) => set((c) => void (c.start = v))}
              options={[
                ['off', tc('credits', 'Off frame, comes in'), ICON.off],
                ['on', tc('credits', 'Already shown'), ICON.on],
              ]}
            />
          )}
          <Pics
            label={tc('credits', 'At the end')}
            value={k.end}
            onChange={(v) => set((c) => void (c.end = v))}
            options={[
              ['exit', k.mode === 'pages' ? tc('credits', 'Last card fades out') : tc('credits', 'Goes out of frame'), ICON.exit],
              ['stop', k.mode === 'pages' ? tc('credits', 'Last card stays') : tc('credits', 'Last line centred'), ICON.stop],
            ]}
          />
          {k.mode !== 'pages' && (
            <Pics
              label={tc('credits', 'If it fits in the frame')}
              value={k.shortMode}
              onChange={(v) => set((c) => void (c.shortMode = v))}
              options={[
                ['center', tc('credits', 'Centred, still'), ICON.still],
                ['exit', tc('credits', 'Rolls anyway'), ICON.rolls],
              ]}
            />
          )}
          <Pics
            label={tc('credits', 'Graphic goes out')}
            value={k.autoOut ? 'auto' : 'manual'}
            onChange={(v) => set((c) => void (c.autoOut = v === 'auto'))}
            options={[
              ['auto', tc('credits', 'Auto, at the end'), ICON.auto],
              ['manual', tc('credits', 'Manual'), ICON.out],
            ]}
          />
        </Section>
      </>
    );
  },
  // The Operator's preview holds it until its Play: not started yet.
  plays: () => 'start',
  Operator: (p) => <CreditsBar {...p} />,
  // A manual start on Continue waits for it (credits.rs starts it on F2), unless the operator started it himself.
  waits: (l, state) => !!l.manualStart && l.startOn !== 'trigger' && !(state as State | undefined)?.started,
  warnings: (layer, { data, state, r }) => {
    const l = layer as unknown as CL;
    const [w, h] = sizeOf(l, r as never);
    return warningsOf(l, data, state, w, h);
  },
});

// Ticker: crawl (horizontal, continuous), roll (vertical, line by line) or flip (one item at a time), separators
// text / symbol / picture, categories, title block, edge fade, end of list. The queue lives in the operator's
// state (seeded from the layer's items); its edits apply at the next pass, without a jump.
// Same picture as crates/cg-render/src/wid/ticker.rs; tape logic mirrors crates/cg-core/src/wid/ticker.rs.
import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { cssColor, col, interpolateText, num } from '../engine/evaluate';
import type { Data, FontStyle } from '../engine/types';
import { FontControls, GroupRow, ColorGroupRow, AssetPicker } from '../designer/Inspector';
import { Btns, clamp, ColorPick, hex as cssBg, Content, defineWidget, ease, ListEditor, Note, Num, Range, Readout, Row, Section, Seg, Select, Text, Toggle, useFrame, useKeys, type Warning } from './kit';
import { FitLine, FONT_CSS, tw } from './table-text';

export interface Item {
  cat?: string;
  text?: string;
  on?: boolean;
}
export interface Cat {
  name?: string;
  bg?: string;
  color?: string;
  text?: string;
}
export interface Config {
  mode?: 'crawl' | 'roll' | 'flip';
  dir?: 'left' | 'right';
  rollDir?: 'up' | 'down';
  itemDur?: number;
  transDur?: number;
  trans?: 'slide' | 'push' | 'fade' | 'flip';
  items?: Item[];
  sepType?: 'text' | 'symbol' | 'image' | 'none';
  sepSymbol?: string;
  sepImage?: string;
  sepColor?: string;
  cats?: Cat[];
  title?: { on?: boolean; text?: string; bg?: string; color?: string; w?: number };
  barBg?: string;
  spacing?: number;
  fade?: boolean;
  fadeW?: number;
  end?: 'loop' | 'passes' | 'stop';
  passes?: number;
  emptyMode?: 'message' | 'hide';
  emptyText?: string;
  startFull?: boolean;
}
interface Run {
  at: number;
  items: Item[];
  prio?: Item | null;
  kind?: 'pass' | 'item' | 'cut';
}
/** Mirrors `State` of the Rust module. */
export interface State {
  started?: boolean;
  running?: boolean;
  base?: number;
  anchor?: number;
  speed?: number | null;
  queue?: Item[] | null;
  runs?: Run[];
}

type TL = Config & FontStyle & { text: string; separator: string; speed: number; props: Record<string, unknown>; manualStart?: boolean };
const PAD = 30;

export function cfg(c: Config) {
  return {
    mode: c.mode ?? 'crawl',
    dir: c.dir ?? 'left',
    rollDir: c.rollDir ?? 'up',
    itemDur: c.itemDur ?? 5,
    transDur: c.transDur ?? 0.6,
    trans: c.trans ?? 'slide',
    items: c.items ?? [],
    sepType: c.sepType ?? 'text',
    sepSymbol: c.sepSymbol ?? '●',
    sepImage: c.sepImage ?? '',
    sepColor: c.sepColor ?? '',
    cats: (c.cats ?? []).map((x) => ({ name: 'NEW', bg: '#7c5cff', color: '#ffffff', text: '', ...x })),
    title: { on: false, text: 'INFO', bg: '#ff3b5c', color: '#ffffff', w: 190, ...c.title },
    barBg: c.barBg ?? '',
    spacing: c.spacing ?? 0,
    fade: c.fade ?? false,
    fadeW: c.fadeW ?? 90,
    end: c.end ?? 'loop',
    passes: c.passes ?? 2,
    emptyMode: c.emptyMode ?? 'message',
    emptyText: c.emptyText ?? '',
    startFull: c.startFull ?? false,
  };
}
type K = ReturnType<typeof cfg>;

// ----------------------------------------------------- tape (mirror) --
const it0 = (i: Item) => ({ cat: i.cat ?? '', text: i.text ?? '', on: i.on !== false });
export function layerItems(l: TL): Item[] {
  if (l.items?.length) return l.items.map(it0);
  return String(l.text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ cat: '', text, on: true }));
}
export function expand(items: Item[], data: Data): Item[] {
  const out: Item[] = [];
  for (const raw of items) {
    const it = it0(raw);
    if (!it.on) continue;
    const t = interpolateText(it.text, data);
    if (t.trim().startsWith('[')) {
      try {
        const a = JSON.parse(t.trim());
        if (Array.isArray(a)) {
          for (const v of a) {
            const text = typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.text ?? v.title ?? '') : JSON.stringify(v);
            const cat = v && typeof v === 'object' && typeof (v.cat ?? v.category) === 'string' ? (v.cat ?? v.category) : it.cat;
            if (text.trim()) out.push({ cat, text: text.trim(), on: true });
          }
          continue;
        }
      } catch {
        /* lines */
      }
    }
    t.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((text) => out.push({ cat: it.cat, text, on: true }));
  }
  return out;
}
const speedOf = (l: TL, st: State) => clamp(st.speed ?? l.speed ?? 120, 1, 5000);
export const periodOf = (l: TL, k: K, st: State, h: number) => (k.mode === 'flip' ? Math.max(0.5, k.itemDur) : Math.max(0, k.itemDur) + h / Math.max(5, speedOf(l, st)));
export function clockOf(l: TL, k: K, st: State, now: number, age: number) {
  const rate = k.mode === 'crawl' ? speedOf(l, st) : 1;
  if (!st.started) return rate * Math.max(0, age);
  return (st.base ?? 0) + (st.running ? (rate * Math.max(0, now - (st.anchor ?? 0))) / 1000 : 0);
}
export const queueOf = (l: TL, st: State) => (st.queue ?? layerItems(l)).map(it0);
const runsOf = (l: TL, st: State): Run[] => (st.runs?.length ? st.runs : [{ at: 0, items: queueOf(l, st), prio: null, kind: 'pass' }]);
const limitOf = (k: K) => (k.end === 'loop' ? undefined : k.end === 'stop' ? 1 : Math.max(1, k.passes));

interface Placed {
  start: number;
  lead: [Item, number][];
  items: [Item, number][];
  leadW: number;
  cycle: number;
  passesBefore: number;
  leadPass: boolean;
  end: number;
}
const sum = (a: [Item, number][]) => a.reduce((s, x) => s + x[1], 0);
/** Mirrors resolve(). */
export function resolve(runs: Run[], data: Data, wf: (i: Item) => number, z: number, first: number, limit?: number): Placed[] {
  const out: Placed[] = [];
  const place = (items: Item[]) => expand(items, data).map((i) => [i, Math.max(1e-3, wf(i))] as [Item, number]);
  for (const run of runs) {
    const kind = run.kind ?? 'pass';
    const items = place(run.items ?? []);
    const cycle = sum(items);
    let start: number;
    let lead: [Item, number][];
    let passesBefore: number;
    let leadPass: boolean;
    const r = out[out.length - 1];
    if (!r) {
      start = first;
      lead = run.prio ? place([run.prio]) : [];
      passesBefore = 0;
      leadPass = false;
    } else {
      const t = run.at + z;
      const lp = r.leadPass ? 1 : 0;
      let b: number;
      let rest: [Item, number][] = [];
      let done = 0;
      if (t <= r.start) {
        b = r.start;
        if (kind === 'item') rest = r.lead.slice();
      } else if (t <= r.start + r.leadW || r.cycle <= 0) {
        if (kind === 'pass' || (r.cycle <= 0 && t > r.start + r.leadW)) {
          b = r.cycle <= 0 ? Math.max(t, r.start + r.leadW) : r.start + r.leadW;
          done = lp;
        } else {
          let x = r.start;
          let idx = r.lead.length;
          for (let i = 0; i < r.lead.length; i++) {
            if (x >= t - 1e-9) {
              idx = i;
              break;
            }
            x += r.lead[i][1];
          }
          b = x;
          if (kind === 'item') rest = r.lead.slice(idx);
          done = idx === r.lead.length ? lp : 0;
        }
      } else {
        const u = t - r.start - r.leadW;
        const n = Math.floor(u / r.cycle);
        const base = r.start + r.leadW + n * r.cycle;
        if (kind === 'pass') {
          const n2 = base >= t - 1e-9 ? n : n + 1;
          b = r.start + r.leadW + n2 * r.cycle;
          done = lp + n2;
        } else {
          let x = base;
          let idx = r.items.length;
          for (let i = 0; i < r.items.length; i++) {
            if (x >= t - 1e-9) {
              idx = i;
              break;
            }
            x += r.items[i][1];
          }
          b = x;
          if (idx === r.items.length) done = lp + n + 1;
          else {
            if (kind === 'item') rest = r.items.slice(idx);
            done = lp + n;
          }
        }
      }
      lead = run.prio ? place([run.prio]) : [];
      leadPass = rest.length > 0;
      lead.push(...rest);
      if (b > r.end) {
        start = Infinity;
        passesBefore = r.passesBefore + lp;
      } else {
        start = b;
        passesBefore = r.passesBefore + done;
      }
    }
    if (r) r.end = Math.min(r.end, start);
    if (!Number.isFinite(start)) break;
    const leadW = sum(lead);
    let end = Infinity;
    if (limit !== undefined) {
      const dn = passesBefore + (leadPass ? 1 : 0);
      end = dn >= limit || cycle <= 0 ? start + leadW : start + leadW + (limit - dn) * cycle;
    } else if (cycle <= 0) end = start + leadW;
    out.push({ start, lead, items, leadW, cycle, passesBefore, leadPass, end });
  }
  return out;
}
export function segs(placed: Placed[], lo: number, hi: number): { item: Item; x: number; w: number }[] {
  const out: { item: Item; x: number; w: number }[] = [];
  for (const p of placed) {
    if (p.start >= hi || p.end <= lo) continue;
    const stop = Math.min(p.end, hi);
    let x = p.start;
    for (const [item, w] of p.lead) {
      if (x >= stop) break;
      if (x + w > lo) out.push({ item, x, w });
      x += w;
    }
    if (p.cycle <= 0 || x >= stop) continue;
    x += Math.max(0, Math.floor((lo - x) / p.cycle)) * p.cycle;
    let guard = 0;
    outer: while (x < stop && guard < 10000) {
      for (const [item, w] of p.items) {
        if (x >= stop) break outer;
        if (x + w > lo) out.push({ item, x, w });
        x += w;
        guard++;
      }
    }
  }
  return out;
}
const tapeEnd = (p: Placed[]) => {
  const e = p[p.length - 1]?.end;
  return e !== undefined && Number.isFinite(e) ? e : undefined;
};
function passAt(p: Placed[], x: number) {
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    if (x >= q.start) {
      const after = x - q.start - q.leadW;
      const n = q.cycle > 0 && after > 0 ? Math.floor(after / q.cycle) : 0;
      return q.passesBefore + (q.leadPass && after > 0 ? 1 : 0) + n + 1;
    }
  }
  return 1;
}

// ------------------------------------------------------------- measure --
interface Look {
  /** CSS align-items of the text (old tickers keep their vertical alignment). */
  ai: string;
  family: string;
  weight: number;
  size: number;
  ls: number;
  upper: boolean;
  color: string;
}
const chip = (size: number) => ({ cs: Math.round(size * 0.6), cp: Math.round(size * 0.36), cg: Math.round(size * 0.45) });
const upc = (s: string, u: boolean) => (u ? s.toUpperCase() : s);
function measure(k: K, l: TL, lk: Look) {
  const catOf = (it: Item) => (it.cat ? k.cats.find((c) => c.name === it.cat) : undefined);
  const chipW = (it: Item) => {
    const c = catOf(it);
    if (!c) return 0;
    const { cs, cp, cg } = chip(lk.size);
    return tw(c.name.toUpperCase(), cs, 900) + 2 * cp + cg;
  };
  const textW = (s: string) => tw(upc(s, lk.upper), lk.size, lk.weight, lk.ls);
  const itemW = (it: Item) => textW(it.text ?? '') + chipW(it);
  const sepW = k.sepType === 'none' ? 0 : k.sepType === 'image' ? Math.round(lk.size * 1.05) * 2.4 : k.sepType === 'symbol' ? tw(k.sepSymbol, Math.round(lk.size * 0.7), 900) : textW(l.separator ?? '');
  return { catOf, chipW, itemW, sepW };
}

function ItemView({ it, x, h, k, lk, ms }: { it: Item; x: number; h: number; k: K; lk: Look; ms: ReturnType<typeof measure> }) {
  const c = ms.catOf(it);
  const { cs, cp, cg } = chip(lk.size);
  const cw = ms.chipW(it);
  const ch = Math.round(cs * 1.7);
  const color = c?.text ? c.text : lk.color;
  return (
    <>
      {c && (
        <div style={{ position: 'absolute', left: x, top: (h - ch) / 2, width: cw - cg, height: ch, borderRadius: 6, background: c.bg, color: c.color, font: `900 ${cs}px ${FONT_CSS}`, lineHeight: `${ch}px`, paddingLeft: cp, boxSizing: 'border-box', whiteSpace: 'pre' }}>{c.name.toUpperCase()}</div>
      )}
      <div style={{ position: 'absolute', left: x + cw, top: 0, height: h, display: 'flex', alignItems: lk.ai, whiteSpace: 'pre', fontFamily: `"${lk.family}", ${FONT_CSS}`, fontWeight: lk.weight, fontSize: lk.size, letterSpacing: lk.ls, lineHeight: 1.2, color }}>{upc(it.text ?? '', lk.upper)}</div>
      {void k}
    </>
  );
}
function SepView({ x, w, h, k, l, lk }: { x: number; w: number; h: number; k: K; l: TL; lk: Look }) {
  const color = k.sepColor || lk.color;
  const box = { position: 'absolute' as const, left: x, top: 0, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'pre' as const };
  if (k.sepType === 'none') return null;
  if (k.sepType === 'image') {
    const ih = Math.round(lk.size * 1.05);
    return <div style={box}>{k.sepImage ? <img src={k.sepImage} alt="" style={{ height: ih, display: 'block' }} /> : <div style={{ width: ih * 2.4, height: ih, borderRadius: ih * 0.24, background: '#ff3b5c' }} />}</div>;
  }
  if (k.sepType === 'symbol') return <div style={{ ...box, font: `900 ${Math.round(lk.size * 0.7)}px ${FONT_CSS}`, lineHeight: 1.2, color }}>{k.sepSymbol}</div>;
  return <div style={{ ...box, alignItems: lk.ai, fontFamily: `"${lk.family}", ${FONT_CSS}`, fontWeight: lk.weight, fontSize: lk.size, letterSpacing: lk.ls, lineHeight: 1.2, color }}>{upc(l.separator ?? '', lk.upper)}</div>;
}

function lookOf(l: TL, r: Record<string, unknown>): Look {
  return {
    ai: l.items?.length ? 'center' : l.verticalAlign === 'top' ? 'flex-start' : l.verticalAlign === 'bottom' ? 'flex-end' : 'center',
    family: l.fontFamily || 'Inter',
    weight: l.fontWeight || 800,
    size: Math.max(1, num(r.fontSize as number)),
    ls: num(r.letterSpacing as number),
    upper: !!l.uppercase,
    color: cssColor(col(r.fill as never)),
  };
}

/** Everything the picture and the Operator need at `now`. */
function scene(l: TL, k: K, st: State, data: Data, lk: Look, w: number, h: number, now: number, age: number) {
  const ms = measure(k, l, lk);
  const zx = k.title.on ? Math.max(0, Math.min(k.title.w, w - 40)) : 0;
  const zw = Math.max(40, w - zx);
  const e = clockOf(l, k, st, now, age);
  const q = expand(queueOf(l, st), data);
  const crawl = k.mode === 'crawl';
  const gap = k.spacing + ms.sepW;
  const placed = crawl ? resolve(runsOf(l, st), data, (i) => ms.itemW(i) + gap, zw, k.startFull ? 0 : zw, limitOf(k)) : resolve(runsOf(l, st), data, () => 1, 0, 0, limitOf(k));
  const P = periodOf(l, k, st, h);
  const pos = crawl ? e : Math.floor(e / P);
  const end = tapeEnd(placed);
  const ended = end !== undefined && (crawl ? pos >= end : pos >= end);
  return { ms, zx, zw, e, q, crawl, gap, placed, P, pos, ended, pass: passAt(placed, pos) };
}

// ------------------------------------------------------------- render --
function TickerRender({ l, r, w, h, data, time, state }: { l: TL; r: Record<string, unknown>; w: number; h: number; data: Data; time: { nowMs: number; ageSecs: number }; state: unknown }) {
  const k = cfg(l);
  const st = (state ?? {}) as State;
  const lk = lookOf(l, r);
  const sc = scene(l, k, st, data, lk, w, h, time.nowMs, time.ageSecs);
  const { ms, zx, zw, e, crawl, gap, placed, P } = sc;
  const empty = !sc.q.length;
  if (empty && k.emptyMode === 'hide') return null;
  const fw = crawl ? Math.min(k.fadeW, zw / 3) : Math.min(k.fadeW, h * 0.2);
  const mask = k.fade ? `linear-gradient(${crawl ? '90deg' : '180deg'},transparent 0,#000 ${fw}px,#000 calc(100% - ${fw}px),transparent 100%)` : undefined;
  const content: React.ReactNode[] = [];
  if (empty) {
    if (k.emptyText)
      content.push(
        <div key="empty" style={{ position: 'absolute', left: PAD, top: 0, height: h, display: 'flex', alignItems: 'center', whiteSpace: 'pre', fontFamily: `"${lk.family}", ${FONT_CSS}`, fontWeight: lk.weight, fontSize: lk.size, letterSpacing: lk.ls, color: lk.color, opacity: 0.6 }}>
          {k.emptyText}
        </div>,
      );
  } else if (crawl) {
    const right = k.dir === 'right';
    segs(placed, e, e + zw).forEach((g, i) => {
      const iw = ms.itemW(g.item);
      const rel = g.x - e;
      const x0 = right ? zw - rel - g.w : rel;
      content.push(
        <div key={i}>
          {right ? (
            <>
              <SepView x={x0} w={gap} h={h} k={k} l={l} lk={lk} />
              <ItemView it={g.item} x={x0 + gap} h={h} k={k} lk={lk} ms={ms} />
            </>
          ) : (
            <>
              <ItemView it={g.item} x={x0} h={h} k={k} lk={lk} ms={ms} />
              <SepView x={x0 + iw} w={gap} h={h} k={k} l={l} lk={lk} />
            </>
          )}
        </div>,
      );
    });
  } else {
    const kk = Math.floor(e / P);
    const wk = e - kk * P;
    const at = (s: number) => segs(placed, s, s + 1).find((g) => g.x <= s + 1e-9)?.item;
    const cur = at(kk);
    const prev = kk >= 1 ? at(kk - 1) : undefined;
    const next = at(kk + 1);
    const started = !!st.started || time.ageSecs > 0;
    const scrollOf = (it: Item, wt: number) => {
      const over = ms.itemW(it) + 2 * PAD - zw;
      if (over <= 0) return 0;
      const t0 = (k.mode === 'flip' ? k.transDur : 0) + 0.7;
      const t1 = (k.mode === 'flip' ? P : k.itemDur) - 0.7;
      return -over * clamp((wt - t0) / Math.max(0.1, t1 - t0), 0, 1);
    };
    const put = (key: string, it: Item, dx: number, dy: number, op: number, sy: number, wt: number) => {
      if (op <= 0.001) return;
      content.push(
        <div key={key} style={{ position: 'absolute', left: 0, top: 0, width: zw, height: h, transform: `translate(${dx}px,${dy}px) scaleY(${Math.max(0.001, sy)})`, transformOrigin: '50% 50%', opacity: op }}>
          <ItemView it={it} x={PAD + scrollOf(it, wt)} h={h} k={k} lk={lk} ms={ms} />
        </div>,
      );
    };
    if (k.mode === 'flip') {
      const inTrans = wk < k.transDur && !!prev && !!cur && started;
      const p = inTrans ? ease(wk / Math.max(0.01, k.transDur)) : 1;
      if (!inTrans) {
        if (cur) put('a', cur, 0, 0, 1, 1, wk);
      } else if (k.trans === 'fade') (put('b', prev!, 0, 0, 1 - p, 1, P), put('a', cur!, 0, 0, p, 1, wk));
      else if (k.trans === 'push') (put('b', prev!, -p * zw, 0, 1, 1, P), put('a', cur!, (1 - p) * zw, 0, 1, 1, wk));
      else if (k.trans === 'flip') {
        const c = Math.abs(Math.cos(p * Math.PI));
        if (p < 0.5) put('b', prev!, 0, 0, 1, c, P);
        else put('a', cur!, 0, 0, 1, c, wk);
      } else (put('b', prev!, 0, -p * h, 1, 1, P), put('a', cur!, 0, (1 - p) * h, 1, 1, wk));
    } else {
      const hold = k.itemDur;
      const m = wk > hold && started ? ease((wk - hold) / Math.max(0.01, P - hold)) : 0;
      const u = k.rollDir === 'down' ? -1 : 1;
      if (cur) put('a', cur, 0, -u * m * h, 1, 1, wk);
      if (next && m > 0) put('b', next, 0, u * (1 - m) * h, 1, 1, 0);
    }
  }
  const ts = Math.round(lk.size * 0.95);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: k.barBg ? cssBg(k.barBg) : undefined }}>
      <div style={{ position: 'absolute', left: zx, top: 0, width: zw, height: h, overflow: 'hidden', WebkitMaskImage: mask, maskImage: mask }}>{content}</div>
      {k.title.on && zx > 0 && (
        <>
          <div style={{ position: 'absolute', left: 0, top: 0, width: zx, height: h, background: cssBg(k.title.bg), clipPath: `polygon(0 0,100% 0,calc(100% - ${Math.min(22, zx)}px) 100%,0 100%)` }} />
          <FitLine text={k.title.text} size={ts} weight={900} ls={ts * 0.06} align="center" box={[0, 0, Math.max(1, zx - 16), h]} color={cssBg(k.title.color)} fit={{ overflow: 'shrink', minSize: ts * 0.5, minSqueeze: 70 }} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ operator --
function QueueRow({ it, i, n, cats, act }: { it: Item; i: number; n: number; cats: string[]; act: (op: string, args?: unknown) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== it.text) act('edit', { index: i, text: draft });
    setDraft(null);
  };
  return (
    <div className={`wk-item ${it.on === false ? 'off' : ''}`}>
      <input type="checkbox" checked={it.on !== false} title="On / off" onChange={(e) => act('toggle', { index: i, on: e.target.checked })} />
      <select style={{ flex: '0 0 92px', width: 92 }} value={it.cat ?? ''} onChange={(e) => act('edit', { index: i, cat: e.target.value })}>
        <option value="">—</option>
        {cats.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input value={draft ?? it.text ?? ''} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && commit())} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      <button className="wk-x" title="Up" disabled={!i} onClick={() => act('move', { from: i, to: i - 1 })}>
        ↑
      </button>
      <button className="wk-x" title="Remove" onClick={() => act('delete', { index: i })}>
        ✕
      </button>
      {void n}
    </div>
  );
}

function TickerOperator({ l, state, data, act, time }: { l: TL; state: unknown; data: Data; act: (op: string, args?: unknown) => void; time: { nowMs: number; ageSecs: number } }) {
  const frame = useFrame();
  const now = frame + (time.nowMs - Date.now());
  const k = cfg(l);
  const st = (state ?? {}) as State;
  const [prio, setPrio] = useState({ text: '', cat: k.cats.find((c) => c.name === 'URGENT')?.name ?? '', keep: false });
  const [add, setAdd] = useState('');
  const w = num(l.props.width as number) || 1920;
  const h = num(l.props.height as number) || 80;
  const lk = lookOf(l, { fontSize: l.props.fontSize ?? 34, letterSpacing: l.props.letterSpacing ?? 0, fill: l.props.fill ?? [1, 1, 1, 1] });
  const age = st.started ? 0 : time.ageSecs + (now - time.nowMs) / 1000;
  const sc = scene(l, k, st, data, lk, w, h, now, age);
  const status = sc.ended ? 'ENDED' : !st.started ? 'AUTO' : st.running ? 'RUNNING' : 'PAUSED';
  const color = { RUNNING: 'var(--pvw, #22c55e)', AUTO: 'var(--pvw, #22c55e)', PAUSED: 'var(--warn, #f59e0b)', ENDED: 'var(--text-3, #888)' }[status];
  const v = speedOf(l, st);
  const lim = limitOf(k);
  const q = queueOf(l, st);
  const cats = k.cats.map((c) => c.name);
  useKeys({ Space: () => act(sc.ended ? 'start' : st.started && !st.running ? 'resume' : 'pause'), ArrowRight: () => k.mode !== 'crawl' && act('next'), '+': () => act('speed', { delta: 20 }), '-': () => act('speed', { delta: -20 }) });
  let onAir: Item | undefined;
  if (!sc.crawl) onAir = segs(sc.placed, sc.pos, sc.pos + 1).find((g) => g.x <= sc.pos + 1e-9)?.item;
  const paused = !!st.started && !st.running;
  return (
    <>
      <Readout sub={`${k.mode.toUpperCase()} · ${Math.round(v)} px/s (${(v / 25).toFixed(1)} px/frame) · pass ${Math.max(1, sc.pass)}/${lim ?? '∞'} · ${sc.q.length} active item(s)`}>
        <i style={{ color, fontStyle: 'normal' }}>{status}</i>
      </Readout>
      {onAir && (
        <Note>
          On air: <b>{(onAir.text ?? '').slice(0, 70)}</b>
        </Note>
      )}
      <Btns
        list={[
          { label: '▶ Start', cls: 'big green', title: 'Start from the top of the queue', onClick: () => act('start') },
          paused ? { label: '▶ Resume', cls: 'big violet', keyHint: 'Space', onClick: () => act('resume') } : { label: '❚❚ Pause', cls: 'big amber', keyHint: 'Space', disabled: sc.ended, onClick: () => act('pause') },
          { label: 'Next item ⏭', cls: 'big', keyHint: '→', disabled: k.mode === 'crawl', title: 'Flip / roll: go to the next item', onClick: () => act('next') },
        ]}
      />
      <Btns
        label="Speed live"
        list={[
          { label: '− Slower', keyHint: '-', onClick: () => act('speed', { delta: -20 }) },
          { label: '+ Faster', keyHint: '+', onClick: () => act('speed', { delta: 20 }) },
        ]}
      />
      <Text label="Priority" value={prio.text} placeholder="Priority item" onChange={(t) => setPrio({ ...prio, text: t })} />
      <Select label="Category" value={prio.cat} options={[['', '—'], ...cats.map((c) => [c, c] as [string, string])]} onChange={(c) => setPrio({ ...prio, cat: c })} />
      <Toggle value={prio.keep} text="Also keep it in the queue" onChange={(b) => setPrio({ ...prio, keep: b })} />
      <Btns
        list={[
          { label: '⚡ Insert now', cls: 'red', disabled: !prio.text.trim(), onClick: () => act('insert', { ...prio, when: 'now' }) },
          { label: 'After current', cls: 'violet', disabled: !prio.text.trim(), onClick: () => act('insert', { ...prio, when: 'after' }) },
        ]}
      />
      {k.mode === 'crawl' && <Note>Crawl: the priority item takes the next free slot, right after the item entering the zone (nothing on screen jumps).</Note>}
      <Note>QUEUE · on/off · category · text · ↑ reorder · ✕ delete</Note>
      <div className="wk-list">
        {q.map((it, i) => (
          <QueueRow key={`${i}-${it.text}`} it={it} i={i} n={q.length} cats={cats} act={act} />
        ))}
        <div className="wk-item">
          <input placeholder="New item" value={add} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && add.trim() && (act('add', { text: add }), setAdd('')))} onChange={(e) => setAdd(e.target.value)} />
          <button className="opx-btn small" disabled={!add.trim()} onClick={() => (act('add', { text: add }), setAdd(''))}>
            + Add item
          </button>
        </div>
      </div>
      <Note>Edits, order and on/off apply at the next pass — no jump, no gap.</Note>
      <Btns list={[{ label: 'Clear the queue', cls: 'ghost', confirm: 'Remove every item of the queue? What is on air finishes.', onClick: () => act('clear') }]} />
    </>
  );
}

// ----------------------------------------------------------- inspector --
const Q0: Item[] = [
  { cat: 'URGENT', text: 'Storm warning upgraded to red for the north-west coast from 6 pm', on: true },
  { cat: '', text: 'Parliament adopts the 2027 budget after a 14-hour session', on: true },
  { cat: 'SPORT', text: 'Ligue 1: Lyon beat Nantes 3–1 and move up to third', on: true },
  { cat: 'ECONOMY', text: 'CAC 40 closes up 0.8 % at 8,214 points', on: true },
  { cat: 'WEATHER', text: 'Tomorrow: sunny spells in the south, up to 21 °C', on: true },
  { cat: '', text: 'Rail strike: two trains out of three expected on Monday', on: true },
  { cat: 'SPORT', text: 'Tennis: semi-final tonight at 8 pm on our channel', on: false },
];

function warningsOf(l: TL, data: Data, state: unknown, W: number, H: number): Warning[] {
  const k = cfg(l);
  const st = (state ?? {}) as State;
  const out: Warning[] = [];
  const q = expand(queueOf(l, st), data);
  if (!q.length) out.push({ level: 'warn', text: `Queue empty: ${k.emptyMode === 'hide' ? 'the ticker is hidden' : 'the fallback message is shown'}.`, op: true });
  const v = speedOf(l, st);
  if (k.mode === 'crawl' && v > 400) out.push({ level: 'warn', text: `${Math.round(v)} px/s is hard to read (above 400 px/s).`, op: true });
  const lk = lookOf(l, { fontSize: l.props.fontSize ?? 34, letterSpacing: l.props.letterSpacing ?? 0, fill: [1, 1, 1, 1] });
  const sc = scene(l, k, st, data, lk, W, H, Date.now(), 0);
  if (st.started && sc.ended) out.push({ level: 'info', text: 'End of the list reached — Start to play it again.', op: true });
  if (k.mode !== 'crawl') {
    const long = q.filter((it) => sc.ms.itemW(it) + 2 * PAD > sc.zw);
    if (long.length) out.push({ level: 'info', text: `${long.length} item(s) longer than the zone: they scroll within their slot.` });
  }
  return out;
}

export default defineWidget({
  id: 'ticker',
  type: 'ticker',
  label: 'Ticker',
  group: 'Data',
  icon: ArrowLeftRight,
  presets: [{ label: 'Ticker' }, { label: 'Flip ticker', patch: { mode: 'flip' } }, { label: 'Roll ticker', patch: { mode: 'roll' } }],
  create: () => ({
    text: '',
    separator: '—',
    speed: 140,
    fontFamily: 'Inter',
    fontWeight: 800,
    align: 'left',
    verticalAlign: 'middle',
    uppercase: false,
    items: Q0.map((x) => ({ ...x })),
    sepType: 'symbol',
    sepSymbol: '●',
    sepColor: '#ff3b5c',
    cats: [
      { name: 'URGENT', bg: '#ff3b5c', color: '#ffffff', text: '#ffb3c0' },
      { name: 'SPORT', bg: '#22c55e', color: '#04140a', text: '' },
      { name: 'ECONOMY', bg: '#38bdf8', color: '#04121c', text: '' },
      { name: 'WEATHER', bg: '#f59e0b', color: '#241500', text: '' },
    ],
    title: { on: true, text: 'INFO', bg: '#ff3b5c', color: '#ffffff', w: 190 },
    barBg: '#0f1222',
    spacing: 70,
    fade: true,
    fadeW: 90,
    emptyText: 'More news in a moment',
    startFull: true,
    props: { width: 1920, height: 80, fontSize: 34, fill: [1, 1, 1, 1] },
  }),
  ownsLook: true,
  content: ['items', 'text'],
  live: () => true,
  Render: ({ layer, r, w, h, data, time, state }) => <TickerRender l={layer as unknown as TL} r={r as never} w={w} h={h} data={data} time={time} state={state} />,
  Inspector: ({ layer, set }) => {
    const l = layer as unknown as TL;
    const k = cfg(l);
    const cats: [string, string][] = [['', '—'], ...k.cats.map((c) => [c.name, c.name] as [string, string])];
    const sp = l.speed ?? 140;
    const h = num(l.props.height as number) || 80;
    return (
      <>
        <Section id="ticker-mode" title="Mode & motion">
          <Seg
            label="Mode"
            path="mode"
            value={k.mode}
            options={[
              ['crawl', 'Crawl ⇠', 'Horizontal, continuous'],
              ['roll', 'Roll ⇡', 'Vertical, line by line'],
              ['flip', 'Flip ⧉', 'One item at a time'],
            ]}
          />
          {k.mode === 'crawl' && (
            <Seg
              label="Direction"
              path="dir"
              value={k.dir}
              options={[
                ['left', '← Right to left'],
                ['right', '→ Left to right'],
              ]}
            />
          )}
          {k.mode === 'roll' && (
            <Seg
              label="Direction"
              path="rollDir"
              value={k.rollDir}
              options={[
                ['up', '↑ Up'],
                ['down', '↓ Down'],
              ]}
            />
          )}
          <Range label={k.mode === 'flip' ? 'Scroll speed' : 'Speed'} path="speed" value={sp} min={10} max={800} step={5} unit=" px/s" />
          {k.mode !== 'crawl' && <Range label={k.mode === 'flip' ? 'Per item' : 'Hold per line'} path="itemDur" value={k.itemDur} min={1} max={20} step={0.5} fmt={(v) => `${v.toFixed(1)} s`} />}
          {k.mode === 'flip' && (
            <>
              <Seg
                label="Transition"
                path="trans"
                value={k.trans}
                options={[
                  ['slide', 'Slide up'],
                  ['push', 'Push'],
                  ['fade', 'Fade'],
                  ['flip', 'Flip 3D'],
                ]}
              />
              <Range label="Transition" path="transDur" value={k.transDur} min={0.1} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)} s`} />
              <Note>An item longer than the zone scrolls within its slot (after a short hold).</Note>
            </>
          )}
          {k.mode === 'crawl' && <Toggle label="At the In" path="startFull" value={k.startFull} text="Zone already full (else enters from the edge)" />}
          <Note>
            {k.mode === 'crawl'
              ? `Constant speed whatever the item length: ${sp} px/s = ${(sp / 25).toFixed(2)} px/frame at 25 fps. Position computed from the clock, never by increments.`
              : k.mode === 'roll'
                ? `Line change: ${(h / sp).toFixed(2)} s at ${sp} px/s, then ${k.itemDur} s hold.`
                : `${k.itemDur} s per item, ${k.transDur} s transition.`}
          </Note>
        </Section>
        <Section id="ticker-items" title="Items">
          {k.items.length ? (
            <>
              <Note>Items of the list (the Operator edits its own queue, seeded from these). A text may hold a {'{{key}}'}: a value of several lines or a JSON array gives several items.</Note>
              <ListEditor
                path="items"
                toggle="on"
                fields={[
                  { key: 'cat', options: cats, w: 92 },
                  { key: 'text', placeholder: 'Text' },
                ]}
                add={() => ({ cat: '', text: 'New item', on: true })}
                addLabel="Item"
              />
            </>
          ) : (
            <>
              <Content label="Lines" path="text" multiline placeholder="One item per line" />
              <Btns list={[{ label: 'Convert to items (categories, on / off)', cls: 'violet', onClick: () => set('items', layerItems(l)) }]} />
            </>
          )}
        </Section>
        <Section id="ticker-look" title="Look">
          <ColorPick label="Bar" path="barBg" value={k.barBg || '#00000000'} />
          <FontControls layer={layer as never} set={set} />
          <GroupRow layer={layer as never} spec={{ label: 'Size', props: ['fontSize'], min: 1, suffix: 'px' }} />
          <ColorGroupRow layer={layer as never} prop="fill" label="Text" />
          <Seg
            label="Separator"
            path="sepType"
            value={k.sepType}
            options={[
              ['text', 'Text'],
              ['symbol', 'Symbol'],
              ['image', 'Logo'],
              ['none', 'None'],
            ]}
          />
          {k.sepType === 'text' && <Text label="Text" path="separator" value={l.separator} />}
          {k.sepType === 'symbol' && <Seg label="Symbol" path="sepSymbol" value={k.sepSymbol} options={['●', '◆', '▶', '■', '★', '|', '/']} />}
          {(k.sepType === 'text' || k.sepType === 'symbol') && <ColorPick label="Sep. colour" path="sepColor" value={k.sepColor || '#ffffff'} />}
          {k.sepType === 'image' && (
            <Row expose="sepImage" exposeValue={k.sepImage} label="Logo">
              <AssetPicker value={k.sepImage} onChange={(v) => set('sepImage', v)} />
            </Row>
          )}
        </Section>
        <Section id="ticker-cats" title="Categories" closed>
          <Note>Each category has its own chip (background · text) and an optional item text colour.</Note>
          <ListEditor
            path="cats"
            fields={[
              { key: 'name', placeholder: 'Name' },
              { key: 'bg', color: true, w: 40 },
              { key: 'color', color: true, w: 40 },
              { key: 'text', color: true, w: 40 },
            ]}
            add={() => ({ name: 'NEW', bg: '#7c5cff', color: '#ffffff', text: '' })}
            addLabel="Category"
          />
        </Section>
        <Section id="ticker-title" title="Title block">
          <Toggle label="Title" path="title.on" value={k.title.on} text="Fixed block on the left" />
          {k.title.on && (
            <>
              <Content label="Text" path="title.text" value={k.title.text} />
              <ColorPick label="Background" path="title.bg" value={k.title.bg} />
              <ColorPick label="Text colour" path="title.color" value={k.title.color} />
              <Range label="Width" path="title.w" value={k.title.w} min={80} max={500} unit=" px" />
            </>
          )}
        </Section>
        <Section id="ticker-space" title="Spacing & edges" closed>
          <Range label="Spacing" path="spacing" value={k.spacing} min={0} max={300} unit=" px" />
          <Toggle label="Edge fade" path="fade" value={k.fade} text={k.mode === 'crawl' ? 'Fade left and right' : 'Fade top and bottom'} />
          {k.fade && <Range label="Fade width" path="fadeW" value={k.fadeW} min={10} max={300} unit=" px" />}
        </Section>
        <Section id="ticker-end" title="End of list" closed>
          <Seg
            label="At the end"
            path="end"
            value={k.end}
            options={[
              ['loop', 'Loop ∞'],
              ['passes', 'N passes'],
              ['stop', 'Stop'],
            ]}
          />
          {k.end === 'passes' && <Num label="Passes" path="passes" value={k.passes} min={1} max={99} />}
          <Note>A pass = the whole queue once. After the last pass the zone empties (the bar stays until OUT).</Note>
        </Section>
        <Section id="ticker-empty" title="Empty queue" closed>
          <Seg
            label="Nothing to show"
            path="emptyMode"
            value={k.emptyMode}
            options={[
              ['message', 'Fallback message'],
              ['hide', 'Hide the ticker'],
            ]}
          />
          {k.emptyMode === 'message' && <Text label="Message" path="emptyText" value={k.emptyText} />}
        </Section>
      </>
    );
  },
  Operator: ({ layer, state, data, act, time }) => <TickerOperator l={layer as unknown as TL} state={state} data={data} act={act} time={time} />,
  warnings: (layer, { data, state, r }) => {
    const l = layer as unknown as TL;
    return warningsOf(l, data, state, num((r?.width as number) ?? (l.props.width as number) ?? 1920), num((r?.height as number) ?? (l.props.height as number) ?? 80));
  },
});

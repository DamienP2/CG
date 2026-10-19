// Typewriter: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/typewriter.rs; timeline and actions in crates/cg-core/src/wid/typewriter.rs.
//
// Frozen layout: the complete text is laid out (and auto-shrunk) before typing;
// what is not typed yet is not drawn, so no word ever jumps line. Everything
// is a pure function of the elapsed time (time on air, or the operator's
// timestamps): the state never counts.
import { useEffect, useRef, type CSSProperties } from 'react';
import { Keyboard } from 'lucide-react';
import { col, cssColor, interpolateText, num } from '../engine/evaluate';
import type { Data, FontStyle, Layer } from '../engine/types';
import { graphemes } from '../engine/textFit';
import { ColorGroupRow, FontControls, GroupRow } from '../designer/Inspector';
import { Btns, clamp, ColorPick, Content, defineWidget, hex, ListEditor, Note, Range, Section, Seg, Toggle, useFrame, useKeys, type LayerOf, type Warning, withDefaults } from './kit';
import { fontCss, measure } from './text';

export interface Config {
  /** Texts typed after the first one (`text`). */
  more?: { text: string }[];
  unit?: 'char' | 'word' | 'line';
  speedMode?: 'rate' | 'duration';
  duration?: number;
  jitter?: number;
  punctPause?: number;
  appear?: 'instant' | 'fade' | 'slide';
  appearMs?: number;
  cursorCh?: string;
  /** Empty = the text colour. */
  cursorColor?: string;
  cursorBlink?: boolean;
  cursorHide?: boolean;
  erase?: 'backspace' | 'block';
  eraseRate?: number;
  hold?: number;
  chainLoop?: boolean;
  frozen?: boolean;
  onEdit?: 'restart' | 'continue';
  autoShrink?: boolean;
  minSize?: number;
  lineHeight?: number;
  plate?: boolean;
  plateColor?: string;
  shadow?: boolean;
}

/** Mirrors `State` in crates/cg-core/src/wid/typewriter.rs. */
export interface State {
  mode?: 'auto' | 'run' | 'paused' | 'idle';
  idx?: number;
  base?: number;
  since?: number | null;
  allAt?: number | null;
}

const D: Required<Config> = {
  more: [],
  unit: 'char',
  speedMode: 'rate',
  duration: 4,
  jitter: 0,
  punctPause: 0,
  appear: 'instant',
  appearMs: 220,
  cursorCh: '|',
  cursorColor: '',
  cursorBlink: true,
  cursorHide: false,
  erase: 'backspace',
  eraseRate: 90,
  hold: 1.6,
  chainLoop: false,
  frozen: true,
  onEdit: 'restart',
  autoShrink: false,
  minSize: 30,
  lineHeight: 1.2,
  plate: false,
  plateColor: '#160f33',
  shadow: false,
};
type K = Required<Config>;
const cfg = (c: Config): K => withDefaults(D, c);
type TwLayer = LayerOf<'typewriter'>;

// ------------------------------------------------------------- timeline --

/** Deterministic noise 0..1 (same integer hash as rnd() in Rust). */
export function rnd(i: number, j: number): number {
  let h = ((Math.imul(i, 374761393) >>> 0) + (Math.imul(j, 668265263) >>> 0)) >>> 0;
  h = (h ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
const isPunct = (s: string) => /[.,;:!?…—]$/.test(s.trimEnd());
const wordChar = (g: string) => /^[\p{L}\p{N}]/u.test(g);

export interface Timeline {
  g: string[];
  units: [number, number][];
  t: number[];
  unitOf: number[];
  appear: number;
  typeEnd: number;
  eraseDur: number;
}

/** When each unit of one text appears (mirrors timeline()). */
export function timeline(c: K, rate: number, text: string, idx: number, lines?: number[]): Timeline {
  const g = graphemes(text);
  const n = g.length;
  const units: [number, number][] = [];
  if (c.unit === 'char') for (let i = 0; i < n; i++) units.push([i, i + 1]);
  else if (c.unit === 'word') {
    let start = 0;
    let seen = false;
    for (let i = 0; i < n; i++) {
      const w = wordChar(g[i]);
      if (w && seen && (i === 0 || !wordChar(g[i - 1]))) (units.push([start, i]), (start = i));
      seen ||= w;
    }
    if (n > start) units.push([start, n]);
  } else {
    const lineOf = (i: number) => (lines ? (lines[i] ?? 0) : g.slice(0, i).filter((x) => x.includes('\n')).length);
    let start = 0;
    for (let i = 1; i <= n; i++) if (i === n || lineOf(i) !== lineOf(start)) (units.push([start, i]), (start = i));
  }
  const k = units.length;
  const per = c.speedMode === 'rate' ? 1 / Math.max(0.1, rate) : 1;
  const t: number[] = [];
  let acc = 0;
  for (let i = 0; i < k; i++) {
    acc += (1 + (clamp(c.jitter, 0, 100) / 100) * (rnd(i, idx) * 2 - 1)) * per;
    t.push(acc);
    if (i + 1 < k && isPunct(g.slice(units[i][0], units[i][1]).join(''))) acc += Math.max(0, c.punctPause) / 1000;
  }
  if (c.speedMode === 'duration' && k > 0) {
    const last = Math.max(1e-9, t[k - 1]);
    for (let i = 0; i < k; i++) t[i] *= Math.max(0, c.duration) / last;
  }
  const appear = c.appear === 'instant' ? 0 : Math.max(0, c.appearMs) / 1000;
  const unitOf = new Array<number>(n).fill(0);
  units.forEach(([a, b], i) => {
    for (let j = a; j < b; j++) unitOf[j] = i;
  });
  return { g, units, t, unitOf, appear, typeEnd: (t[k - 1] ?? 0) + appear, eraseDur: c.erase === 'block' ? 0.45 : n / Math.max(1, c.eraseRate) };
}

export const hasNext = (c: K, n: number, i: number) => n > 1 && (c.chainLoop || i + 1 < n);

export function elapsed(st: State, nowMs: number, age: number): number {
  const mode = st.mode ?? 'auto';
  if (mode === 'auto') return Math.max(0, age);
  if (mode === 'run') return (st.base ?? 0) + Math.max(0, st.since != null ? (nowMs - st.since) / 1000 : 0);
  return st.base ?? 0;
}

function position(c: K, n: number, start: number, e: number, tl: (i: number) => Timeline): [number, number] {
  if (!n) return [0, e];
  const cycle = (t: Timeline) => t.typeEnd + Math.max(0, c.hold) + t.eraseDur;
  let i = Math.min(start, n - 1);
  e = Math.max(0, e);
  if (c.chainLoop && n > 1) {
    let total = 0;
    for (let j = 0; j < n; j++) total += cycle(tl(j));
    if (total > 1e-6) e %= total;
  }
  for (let guard = 0; guard < 4 * n + 4; guard++) {
    if (!hasNext(c, n, i)) return [i, e];
    const cy = cycle(tl(i));
    if (e < cy) return [i, e];
    e -= cy;
    i = (i + 1) % n;
  }
  return [i, e];
}

/** The text shown and its elapsed time, "Show all" included (mirrors now_at). */
export function nowAt(c: K, st: State, n: number, e: number, tl: (i: number) => Timeline): [number, number] {
  if (st.allAt != null && e >= st.allAt) {
    const [i, ea] = position(c, n, st.idx ?? 0, st.allAt, tl);
    e += Math.max(0, tl(i).typeEnd - ea);
  }
  return position(c, n, st.idx ?? 0, e, tl);
}

// --------------------------------------------------------------- layout --

/** Lines of graphemes (pre-wrap), mirrors wrap_g. */
export function wrapG(g: string[], maxW: number, m: (s: string) => number): [number, number][] {
  const nl = (s: string) => s.includes('\n');
  const sp = (s: string) => /^\s+$/u.test(s);
  const width = (a: number, b: number) => m(g.slice(a, b).join('').trimEnd());
  const n = g.length;
  const lines: [number, number][] = [];
  let start = 0;
  let i = 0;
  while (i < n) {
    if (nl(g[i])) {
      lines.push([start, i + 1]);
      start = i + 1;
      i++;
      continue;
    }
    if (sp(g[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !sp(g[j]) && !nl(g[j])) j++;
    if (width(start, j) <= maxW) {
      i = j;
      continue;
    }
    if (start < i) {
      lines.push([start, i]);
      start = i;
      if (width(i, j) <= maxW) {
        i = j;
        continue;
      }
    }
    for (let q = i; q < j; q++) {
      if (q > start && width(start, q + 1) > maxW) {
        lines.push([start, q]);
        start = q;
      }
    }
    i = j;
  }
  lines.push([start, n]);
  return lines;
}

const block = (n: number, size: number, lh: number) => (n ? (n - 1) * size * lh + size : 0);

export interface Lay {
  size: number;
  lines: [number, number][];
  over: boolean;
}

/** Size (auto-shrink on the complete text) and lines, mirrors layout(). */
export function layoutTw(c: K, g: string[], size0: number, w: number, h: number, m: (s: string, size: number) => number): Lay {
  const at = (size: number): [boolean, [number, number][]] => {
    const l = wrapG(g, w, (s) => m(s, size));
    return [block(l.length, size, c.lineHeight) <= h + 0.5, l];
  };
  const [ok, l] = at(size0);
  if (ok || !c.autoShrink || !g.length) return { size: size0, lines: l, over: !ok && g.length > 0 };
  const lo0 = Math.max(1, Math.min(c.minSize, size0));
  const [okLo, lLo] = at(lo0);
  if (!okLo) return { size: lo0, lines: lLo, over: true };
  let lo = lo0;
  let hi = size0;
  let best = lLo;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const [k, ll] = at(mid);
    if (k) {
      lo = mid;
      best = ll;
    } else hi = mid;
  }
  return { size: lo, lines: best, over: false };
}

export interface Vis {
  k: number[];
  shown: number;
  block: number;
  phase: 'typing' | 'hold' | 'erasing' | 'done' | 'idle';
}

export function visible(c: K, tl: Timeline, e: number, next: boolean, idle: boolean): Vis {
  const n = tl.g.length;
  const k = new Array<number>(n).fill(0);
  if (idle) return { k, shown: 0, block: 1, phase: 'idle' };
  const holdEnd = tl.typeEnd + Math.max(0, c.hold);
  if (e < tl.typeEnd || !next || e < holdEnd) {
    let shown = 0;
    for (let i = 0; i < n; i++) {
      const dt = e - tl.t[tl.unitOf[i]];
      k[i] = tl.appear > 0 ? clamp(dt / tl.appear, 0, 1) : dt >= 0 ? 1 : 0;
      if (k[i] > 0) shown = i + 1;
    }
    return { k, shown, block: 1, phase: e < tl.typeEnd ? 'typing' : next ? 'hold' : 'done' };
  }
  const ee = e - holdEnd;
  if (c.erase === 'block') return { k: k.fill(1), shown: n, block: clamp(1 - ee / Math.max(1e-6, tl.eraseDur), 0, 1), phase: 'erasing' };
  const left = Math.max(0, n - Math.floor(ee * Math.max(1, c.eraseRate)));
  for (let i = 0; i < left; i++) k[i] = 1;
  return { k, shown: left, block: 1, phase: 'erasing' };
}

/** The texts of the chain (fields filled in, case changed). */
export function textsOf(l: TwLayer, data: Data): string[] {
  const list = [l.text, ...(l.more ?? []).map((m) => m.text)].map((t) => interpolateText(t ?? '', data));
  return l.uppercase ? list.map((t) => t.toUpperCase()) : list;
}

/** Everything the picture needs at `nowMs` / `age`. */
export function runOf(l: TwLayer, st: State, data: Data, size0: number, ls: number, w: number, h: number, nowMs: number, age: number) {
  const c = cfg(l);
  const list = textsOf(l, data);
  const n = Math.max(1, list.length);
  const font = (size: number) => fontCss(l.fontFamily, l.fontWeight, size);
  const m = (s: string, size: number) => measure(font(size), ls, s);
  const [px, py] = c.plate ? [48, 20] : [0, 0];
  const bw = Math.max(10, w - 2 * px);
  const bh = Math.max(10, h - 2 * py);
  const lays = new Map<number, [string[], Lay]>();
  const layOf = (i: number): [string[], Lay] => {
    let v = lays.get(i);
    if (!v) {
      const g = graphemes(list[i] ?? '');
      v = [g, layoutTw(c, g, size0, bw, bh, m)];
      lays.set(i, v);
    }
    return v;
  };
  const tls = new Map<number, Timeline>();
  const tlOf = (i: number): Timeline => {
    let t = tls.get(i);
    if (!t) {
      let lines: number[] | undefined;
      if (c.unit === 'line') {
        const [g, lay] = layOf(i);
        lines = new Array<number>(g.length).fill(0);
        lay.lines.forEach(([a, b], li) => {
          for (let j = a; j < b; j++) lines![j] = li;
        });
      }
      t = timeline(c, l.speed, list[i] ?? '', i, lines);
      tls.set(i, t);
    }
    return t;
  };
  const idle = st.mode === 'idle';
  const e = elapsed(st, nowMs, age);
  const [idx, el] = idle ? [Math.min(st.idx ?? 0, n - 1), 0] : nowAt(c, st, n, e, tlOf);
  const tl = tlOf(idx);
  const next = hasNext(c, n, idx);
  const vis = visible(c, tl, el, next, idle);
  const [g, lay] = layOf(idx);
  return { c, list, n, idx, tl, vis, g, lay, px, py, bw, bh, font, m, next };
}

// --------------------------------------------------------------- render --

function Render({ layer, r, w, h, data, time, state }: { layer: TwLayer; r: import('../engine/evaluate').Resolved; w: number; h: number; data: Data; time: { nowMs: number; ageSecs: number }; state: unknown }) {
  const st = (state ?? {}) as State;
  const size0 = num(r.fontSize);
  const ls = num(r.letterSpacing);
  const R = runOf(layer, st, data, size0, ls, w, h, time.nowMs, time.ageSecs);
  const { c, g, vis, px, py, bw, bh, m } = R;
  let lay = R.lay;
  if (!c.frozen) lay = { ...layoutTw(c, g.slice(0, vis.shown), lay.size, bw, bh, m), size: lay.size };
  const size = lay.size;
  const lineH = size * c.lineHeight;
  const nl = lay.lines.length;
  const top = py + (layer.verticalAlign === 'top' ? 0 : layer.verticalAlign === 'bottom' ? bh - lineH * nl : (bh - lineH * nl) / 2);
  const fill = cssColor(col(r.fill));
  const font = R.font(size);
  let cursor = null as [number, number] | null; // x, line top
  const afterBreak = vis.shown === 0 || g[vis.shown - 1]?.includes('\n');
  const lines = lay.lines.map(([a, b0], li) => {
    const b = Math.min(b0, g.length);
    const idxs: number[] = [];
    for (let i = a; i < b; i++) if (!g[i].includes('\n') && !g[i].includes('\r')) idxs.push(i);
    const text = idxs.map((i) => g[i]).join('');
    const wt = m(text.trimEnd(), size);
    const x0 = px + (layer.align === 'center' ? (bw - wt) / 2 : layer.align === 'right' ? bw - wt : 0);
    const y = top + li * lineH;
    if (afterBreak && (vis.shown === a || (li === 0 && vis.shown === 0))) cursor = [x0, y];
    if (!afterBreak && vis.shown - 1 >= a && vis.shown - 1 < b) cursor = [x0 + m(g.slice(a, vis.shown).join('').replace(/\n/g, ''), size), y];
    // Graphemes in runs of the same opacity (what is not typed yet is not drawn).
    const runs: { k: number; s: string }[] = [];
    for (const i of idxs) {
      const k = vis.k[i] ?? 0;
      if (k <= 0) continue;
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.s += g[i];
      else runs.push({ k, s: g[i] });
    }
    return (
      <div key={li} style={{ position: 'absolute', left: x0, top: y, height: lineH, lineHeight: `${lineH}px`, whiteSpace: 'pre', font, letterSpacing: ls, fontKerning: 'normal' }}>
        {runs.map((run, j) =>
          run.k >= 1 ? (
            run.s
          ) : (
            <span key={j} style={{ opacity: run.k, position: 'relative', top: c.appear === 'slide' ? (1 - run.k) * 0.45 * size : 0 }}>
              {run.s}
            </span>
          ),
        )}
      </div>
    );
  });
  // Cursor.
  const done = vis.phase === 'done';
  let cur: CSSProperties | null = null;
  if (layer.cursor && !(done && c.cursorHide && g.length)) {
    const typing = vis.phase === 'typing' || vis.phase === 'erasing';
    const on = !c.cursorBlink || typing || Math.floor(time.nowMs / 500) % 2 === 0;
    const [cx, ly] = cursor ?? [px, top];
    // Glyph box top inside the line box (as the Rust renderer: baseline − ascent).
    const gt = ly + (lineH - size * 1.21) / 2;
    const [x, y, cw, ch] = c.cursorCh === '█' ? [cx, gt + 0.1 * size, 0.56 * size, 1.02 * size] : c.cursorCh === '_' ? [cx, gt + size, 0.56 * size, 0.11 * size] : [cx + 0.03 * size, gt + 0.08 * size, 0.09 * size, 1.08 * size];
    if (on) cur = { position: 'absolute', left: x, top: y, width: cw, height: ch, background: c.cursorColor.trim() ? hex(c.cursorColor) : fill };
  }
  return (
    <>
      {c.plate && <div style={{ position: 'absolute', inset: 0, background: hex(c.plateColor), boxShadow: 'inset 10px 0 #ff3b5c', borderRadius: 4 }} />}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: vis.block, color: fill, textShadow: c.shadow ? '0 3px 10px #00000088' : undefined }}>
        {lines}
        {cur && <div style={cur} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------- operator --

const PHASE_COL: Record<string, string> = { typing: '#22c55e', paused: '#f59e0b', erasing: '#ff3b5c', hold: '#a594ff', done: '#a3a9bd', cleared: '#6b7290' };

function Operator({ layer, state, data, act, time }: { layer: TwLayer; state: unknown; data: Data; act: (op: string, args?: unknown) => void; time: { nowMs: number; ageSecs: number } }) {
  const now = useFrame();
  const st = (state ?? {}) as State;
  const offset = time.nowMs - Date.now();
  // Time on air advances with the clock between two updates of the graphic.
  const ageRef = useRef({ age: time.ageSecs, at: Date.now() });
  if (ageRef.current.age !== time.ageSecs) ageRef.current = { age: time.ageSecs, at: Date.now() };
  const age = ageRef.current.age + (now - ageRef.current.at) / 1000;
  const R = runOf(layer, st, data, num(layer.props.fontSize ?? 64), num(layer.props.letterSpacing ?? 0), num(layer.props.width ?? 800), num(layer.props.height ?? 200), now + offset, age);
  const mode = st.mode ?? 'auto';
  const running = mode === 'auto' || mode === 'run';
  const cur = { cur: R.idx };
  // The text shown changed while typing: restart or continue (setting "Edited while typing").
  const seen = useRef<{ idx: number; text: string; shown: number } | null>(null);
  const text = R.list[R.idx] ?? '';
  useEffect(() => {
    const s = seen.current;
    if (s && s.idx === R.idx && s.text !== text && (mode === 'run' || mode === 'paused' || mode === 'auto') && R.vis.phase === 'typing') act('edited', { cur: R.idx, typed: s.shown });
    seen.current = { idx: R.idx, text, shown: R.vis.shown };
  });
  useKeys({
    Enter: () => act('start', cur),
    ' ': () => act('toggle', cur),
    ArrowRight: () => act('next', cur),
  });
  const n = R.g.length;
  const shown = R.vis.shown;
  const ph = mode === 'idle' ? 'cleared' : mode === 'paused' ? 'paused' : R.vis.phase;
  const pct = n ? Math.round((shown / n) * 100) : 100;
  const colr = PHASE_COL[ph] ?? '#a3a9bd';
  return (
    <>
      <Btns
        list={[
          { label: '▶ Start', cls: 'green big', keyHint: 'Enter', onClick: () => act('start', cur) },
          mode === 'paused' ? { label: '▶ Resume', cls: 'violet big', keyHint: 'Space', onClick: () => act('resume', cur) } : { label: '❚❚ Pause', cls: 'big', keyHint: 'Space', disabled: !running, onClick: () => act('pause', cur) },
          { label: 'Show all', cls: 'big', onClick: () => act('showAll', cur) },
          { label: 'Next text ▸', cls: 'big', keyHint: 'Right', disabled: R.list.length < 2, onClick: () => act('next', cur) },
          { label: 'Clear', cls: 'big', onClick: () => act('clear', cur) },
          { label: 'Reset', cls: 'ghost big', onClick: () => act('reset', cur) },
        ]}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline', marginTop: 6 }}>
        <b style={{ fontSize: 18 }}>
          Text {R.idx + 1}/{R.list.length}
        </b>
        <span style={{ color: colr, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>{ph}</span>
        <span style={{ fontFamily: 'var(--mono, monospace)' }}>
          {shown} / {n} characters · {pct} %
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: '#232838', marginTop: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: colr }} />
      </div>
    </>
  );
}

// ------------------------------------------------------------ inspector --

function Inspector({ layer, edit }: { layer: TwLayer; edit: (fn: (l: TwLayer) => void, key?: string) => void }) {
  const c = cfg(layer);
  const set = (key: string, v: unknown) => edit((l) => void ((l as unknown as Record<string, unknown>)[key] = v));
  const unitName = c.unit === 'char' ? ' char/s' : c.unit === 'word' ? ' words/s' : ' lines/s';
  return (
    <>
      <Section id="tw-texts" title="Texts">
        <Content path="text" value="" multiline placeholder="Text to type ({{key}} from the Data canvas)" />
        <ListEditor path="more" value={c.more} fields={[{ key: 'text', placeholder: 'Next text to type' }]} add={() => ({ text: 'New text' })} addLabel="Text" />
        <Note>The texts are typed one after the other (see Chaining). Characters are grapheme clusters: an emoji 👩‍💻, a flag 🇫🇷 or a letter with a combining accent counts as one.</Note>
        <Seg
          label="Edited while typing"
          path="onEdit"
          value={c.onEdit}
          options={[
            ['restart', 'Restart'],
            ['continue', 'Continue'],
          ]}
        />
      </Section>
      <Section id="tw-typing" title="Typing">
        <Seg
          label="Unit"
          path="unit"
          value={c.unit}
          options={[
            ['char', 'Character'],
            ['word', 'Word'],
            ['line', 'Line'],
          ]}
        />
        <Seg
          label="Speed in"
          path="speedMode"
          value={c.speedMode}
          options={[
            ['rate', 'Units / s'],
            ['duration', 'Total duration'],
          ]}
        />
        {c.speedMode === 'rate' ? <Range label="Speed" path="speed" value={layer.speed} min={1} max={80} unit={unitName} /> : <Range label="Duration" path="duration" value={c.duration} min={0.5} max={20} step={0.5} fmt={(v) => `${v.toFixed(1)} s`} />}
        <Range label="Variation" path="jitter" value={c.jitter} min={0} max={80} unit=" %" />
        <Range label="Punctuation pause" path="punctPause" value={c.punctPause} min={0} max={1200} step={20} unit=" ms" />
      </Section>
      <Section id="tw-appear" title="Appearance">
        <Seg
          label="Each unit"
          path="appear"
          value={c.appear}
          options={[
            ['instant', 'Instant'],
            ['fade', 'Fade'],
            ['slide', 'Slide up'],
          ]}
        />
        {c.appear !== 'instant' && <Range label="Duration" path="appearMs" value={c.appearMs} min={40} max={800} step={10} unit=" ms" />}
      </Section>
      <Section id="tw-cursor" title="Cursor">
        <Toggle label="Cursor" path="cursor" value={true} text="Show the cursor" />
        {layer.cursor && (
          <>
            <Seg
              label="Shape"
              path="cursorCh"
              value={c.cursorCh}
              options={[
                ['|', '|'],
                ['_', '_'],
                ['█', '█'],
              ]}
            />
            <ColorPick label="Color" value={c.cursorColor || '#ffffff'} onChange={(v) => set('cursorColor', v)} />
            <Toggle label="Blink" path="cursorBlink" value={true} text="Blinks when idle" />
            <Toggle label="At the end" path="cursorHide" value={false} text="Hides at the end" />
          </>
        )}
      </Section>
      <Section id="tw-chain" title="Chaining">
        <Seg
          label="Erase"
          path="erase"
          value={c.erase}
          options={[
            ['backspace', 'Backspace'],
            ['block', 'All at once'],
          ]}
        />
        {c.erase === 'backspace' && <Range label="Erase speed" path="eraseRate" value={c.eraseRate} min={5} max={200} unit=" char/s" />}
        <Range label="Delay before" path="hold" value={c.hold} min={0} max={10} step={0.1} fmt={(v) => `${v.toFixed(1)} s`} />
        <Toggle label="Loop" path="chainLoop" value={false} text="Back to the first text" />
      </Section>
      <Section id="tw-style" title="Layout and style">
        <Toggle label="Frozen layout" path="frozen" value={true} text="Final position from the start" />
        <Note>{c.frozen ? 'The whole text is laid out before typing (the rest is invisible): no word ever jumps to the next line.' : 'Off for comparison: words jump to the next line while typing.'}</Note>
        <div className="pp-typo">
          <FontControls layer={layer as Layer & FontStyle} set={set} />
          <GroupRow layer={layer as Layer} spec={{ label: 'Size', props: ['fontSize'], min: 1, suffix: 'px' }} />
          <GroupRow layer={layer as Layer} spec={{ label: 'Spacing', props: ['letterSpacing'], precision: 1, suffix: 'px' }} />
          <ColorGroupRow layer={layer as Layer} prop="fill" label="Color" />
        </div>
        <Toggle label="Auto-shrink" path="autoShrink" value={false} text="Fit the complete text" />
        {c.autoShrink && <Range label="Min size" path="minSize" value={c.minSize} min={8} max={Math.max(8, num(layer.props.fontSize ?? 64))} unit=" px" />}
        <Range label="Line height" path="lineHeight" value={c.lineHeight} min={0.9} max={2} step={0.05} fmt={(v) => `×${v.toFixed(2)}`} />
        <Toggle label="Plate" path="plate" value={false} text="Background plate" />
        {c.plate && <ColorPick label="Plate color" path="plateColor" value={D.plateColor} />}
        <Toggle label="Shadow" path="shadow" value={false} text="Soft drop shadow" />
      </Section>
    </>
  );
}

export default defineWidget({
  id: 'typewriter',
  type: 'typewriter',
  label: 'Typewriter',
  group: 'Data',
  icon: Keyboard,
  create: () => ({
    text: 'BREAKING — Le Parlement adopte la réforme des retraites après quatorze heures de débat.',
    speed: 32,
    cursor: true,
    fontFamily: 'Inter',
    fontWeight: 800,
    align: 'left',
    verticalAlign: 'middle',
    uppercase: false,
    more: [{ text: 'Le Premier ministre s’exprimera ce soir à 20 h, en direct de Matignon.' }, { text: 'Bourse : le CAC 40 termine la séance en hausse de 1,8 %.' }],
    jitter: 30,
    punctPause: 280,
    cursorColor: '#ff3b5c',
    cursorHide: true,
    chainLoop: true,
    autoShrink: true,
    plate: true,
    shadow: true,
    props: { width: 1360, height: 260, fontSize: 64, fill: [1, 1, 1, 1] },
  }),
  ownsLook: true,
  live: () => true,
  content: ['text'],
  Render: ({ layer, r, w, h, data, time, state }) => <Render layer={layer} r={r} w={w} h={h} data={data} time={time} state={state} />,
  Inspector: ({ layer, edit }) => <Inspector layer={layer} edit={edit} />,
  Operator: ({ layer, state, data, act, time }) => <Operator layer={layer} state={state} data={data} act={act} time={time} />,
  warnings: (layer, { data, state, r }) => {
    const out: Warning[] = [];
    const c = cfg(layer);
    const list = textsOf(layer, data);
    if (!list.some((t) => t.trim())) out.push({ level: 'info', text: 'Empty text: only the cursor is shown.', op: true });
    const size0 = num(r?.fontSize ?? layer.props.fontSize ?? 64);
    const R = runOf(layer, (state ?? {}) as State, data, size0, num(r?.letterSpacing ?? layer.props.letterSpacing ?? 0), num(r?.width ?? layer.props.width ?? 800), num(r?.height ?? layer.props.height ?? 200), Date.now(), 0);
    if (R.lay.size < size0 - 0.5) out.push({ level: 'info', text: `Auto-shrink: ${Math.round(R.lay.size)} px, computed on the complete text before typing (the size never changes while typing).` });
    if (R.lay.over) out.push({ level: 'warn', text: `The complete text does not fit the box even at ${Math.round(R.lay.size)} px.`, op: true });
    if (!c.frozen) out.push({ level: 'warn', text: 'Frozen layout is off: words may jump to the next line while typing.' });
    return out;
  },
});

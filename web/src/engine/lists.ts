// Lists: a folder's content drawn once per row of a list (Layer.list), going by in its box
// (Layer.roll). Mirror of crates/cg-core/src/lists.rs: one algorithm written twice, keep in sync
// (same test vectors).
import { DEFAULTS, interpolateText, num, parseHex } from './evaluate';
import { asNumber } from './expr';
import { COLOR_PROPS, PROPS, type Data, type InList, type Layer, type ListRepeat, type Motion, type Prop, type Value } from './types';

/** The id suffix of a scrolling folder's moving group (`G~roll`). */
export const ROLL = '~roll';

/** Most times a continuous roll's rows are laid (cg-core: MAX_REPEATS). */
const MAX_REPEATS = 1000;

/** The layer whose clock a layer runs on: a roll group the folder's (its id without `~roll`), else its own. */
export const rollClock = (id: string) => (id.endsWith(ROLL) ? id.slice(0, -ROLL.length) : id);

/** The width of a text on one line in a layer's font (case changed): the renderer's own. */
export type Measure = (layer: Layer, text: string) => number;

/** A row: its columns' values, as text. */
export type Row = Record<string, string>;

/**
 * The enabled rows of a list's value, in order: a JSON array of objects, else (a text) one row
 * `{texte: line}` per non-empty line, trimmed; none when it is missing.
 */
/** A list folder's rows: from the data under its key, else its own; their values filled from the data (a row's `{{q1}}` shows the value `q1`). Mirror of lists::list_rows. */
export function folderRows(list: ListRepeat, data: Data): Row[] {
  const own = list.key && data[list.key] !== undefined;
  const rows = own ? listRows(data[list.key]) : (list.rows ?? []).filter((r) => r.on !== 'false').map((r) => ({ ...r }));
  for (const r of rows) for (const k of Object.keys(r)) if (r[k].includes('{{')) r[k] = interpolateText(r[k], data);
  return rows;
}

export function listRows(value: string | undefined): Row[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed))
    return value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line)
      .map((line) => ({ texte: line }));
  const rows: Row[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    // Switched off by the operator.
    if (o.on === false || o.on === 'false') continue;
    rows.push(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
  }
  return rows;
}

const isList = (l: Layer) => l.type === 'group' && !!l.list;

/**
 * The layers with each list folder's content once per row of its list (`M.id#i`), laid one after
 * the other, and, for a folder that scrolls, going by in its box (a group `G~roll` that moves). The
 * same array when no folder has a list. `measure`: a text's width (row layout).
 */
export function expandLists(layers: Layer[], data: Data, measure: Measure): Layer[] {
  if (!layers.some(isList)) return layers;
  const byId = new Map(layers.map((l) => [l.id, l]));
  // Its folders, nearest first (a loop in broken parents stops).
  const ancestors = new Map<string, Layer[]>();
  for (const l of layers) {
    const up: Layer[] = [];
    for (let p = l.parent ? byId.get(l.parent) : undefined; p && p !== l && !up.includes(p); p = p.parent ? byId.get(p.parent) : undefined) up.push(p);
    ancestors.set(l.id, up);
  }
  // A list folder inside another one's content is left as it is (its content drawn once per copy).
  const folders = layers.filter((l) => isList(l) && !ancestors.get(l.id)!.some(isList));
  const done = new Map<string, Expanded>();
  // A model layer → its folder.
  const modelOf = new Map<string, string>();
  for (const g of folders) {
    const model = layers.filter((l) => ancestors.get(l.id)!.includes(g));
    for (const m of model) modelOf.set(m.id, g.id);
    done.set(g.id, expand(g, model, folderRows(g.list!, data), measure));
  }
  const out: Layer[] = [];
  const placed = new Set<string>();
  for (const l of layers) {
    const g = modelOf.get(l.id);
    if (g !== undefined) {
      // The copies take the model's place (where its first layer was).
      if (!placed.has(g)) out.push(...done.get(g)!.copies);
      placed.add(g);
      continue;
    }
    const e = done.get(l.id);
    if (!e) out.push(l);
    else if (e.roll) out.push(e.folder, e.roll);
    else out.push(e.folder);
  }
  return out;
}

/** A list folder expanded: itself (clipping when it scrolls), its moving group, the copies. */
interface Expanded {
  folder: Layer;
  roll?: Layer;
  copies: Layer[];
}

/** One model layer kept for a row: the model, and its copy with the row's values. */
type Kept = { m: Layer; c: Layer };

function expand(g: Layer, model: Layer[], rows: Row[], measure: Measure): Expanded {
  const list = g.list!;
  const layout = list.layout ?? 'row';
  const gap = list.gap ?? 0;
  const rollId = g.id + ROLL;
  const container = g.roll ? rollId : g.id;
  const inModel = new Map(model.map((m) => [m.id, m]));
  // Each row's kept layers (template order): not when its `when` is false for the row, nor when its parent was not kept.
  const kept: Kept[][] = rows.map((row) => {
    const skip = new Map<string, boolean>();
    const skipped = (m: Layer): boolean => {
      let s = skip.get(m.id);
      if (s === undefined) {
        skip.set(m.id, true);
        const p = m.parent && m.parent !== g.id ? inModel.get(m.parent) : undefined;
        s = !shownFor(m.inList, row) || (!!p && skipped(p));
        skip.set(m.id, s);
      }
      return s;
    };
    return model.filter((m) => !skipped(m)).map((m) => ({ m, c: withRow(m, row) }));
  });
  // A copy placed: its id and parent with `suffix`, the top-level ones moved by each of `moves` (parent space).
  const put = ({ m, c }: Kept, suffix: string, ...moves: [number, number][]): Layer => {
    const l = structuredClone(c);
    l.id = m.id + suffix;
    l.parent = m.parent === g.id ? container : m.parent + suffix;
    if (m.parent === g.id) for (const [dx, dy] of moves) shift(l, dx, dy);
    return l;
  };
  // Extents: from the non-group layers' set props (missing = 0), from the model's start.
  const shapes = model.filter((m) => m.type !== 'group');
  const at = (l: Layer, p: Prop) => num(l.props[p] ?? 0);
  const originX = Math.min(...shapes.map((m) => at(m, 'x')));
  const originY = Math.min(...shapes.map((m) => at(m, 'y')));
  // How far copy `k` goes along the layout's axis (row: a text as wide as its text).
  const extent = (k: Kept[]): number => {
    let end = -Infinity;
    for (const { c } of k) {
      if (c.type === 'group') continue;
      const len = layout === 'row' ? (c.type === 'text' ? (c.text ? measure(c, c.text) : 0) : at(c, 'width')) : at(c, 'height');
      end = Math.max(end, (layout === 'row' ? at(c, 'x') : at(c, 'y')) + len);
    }
    return end === -Infinity ? 0 : end - (layout === 'row' ? originX : originY);
  };
  // Grid: the largest copy's box (set sizes only).
  const cell = (p: 'x' | 'y', size: 'width' | 'height', origin: number) => {
    let best = -Infinity;
    for (const k of kept) {
      const ends = k.filter(({ c }) => c.type !== 'group').map(({ c }) => at(c, p) + at(c, size));
      if (ends.length) best = Math.max(best, Math.max(...ends) - origin);
    }
    return best === -Infinity ? 0 : best;
  };
  const grid = layout === 'grid';
  const cols = Math.max(1, Math.floor(list.cols ?? 3));
  const cellW = grid ? cell('x', 'width', originX) : 0;
  const cellH = grid ? cell('y', 'height', originY) : 0;
  // Offsets (row: x, column: y, grid: its cell), and the content's length.
  const extents = grid ? [] : kept.map(extent);
  const offsets: [number, number][] = [];
  let off = 0;
  kept.forEach((_, i) => {
    if (grid) offsets.push([(i % cols) * (cellW + gap), Math.floor(i / cols) * (cellH + gap)]);
    else {
      offsets.push(layout === 'column' ? [0, off] : [off, 0]);
      off += extents[i] + gap;
    }
  });
  if (!g.roll) return { folder: g, copies: kept.flatMap((k, i) => k.map((x) => put(x, `#${i}`, offsets[i]))) };

  // It scrolls: the folder clips, a group in it moves the copies.
  const roll = g.roll;
  const left = (roll.dir ?? 'left') !== 'up';
  const axis = left ? 'x' : 'y';
  // Its box as drawn (the default size when unset).
  const boxW = num(g.props.width ?? DEFAULTS.width);
  const boxH = num(g.props.height ?? DEFAULTS.height);
  const boxLen = left ? boxW : boxH;
  const along = (d: number): [number, number] => (left ? [d, 0] : [0, d]);
  const copies: Layer[] = [];
  let motion: Motion | undefined;
  if ((roll.mode ?? 'continuous') === 'one') {
    // Pages of one box: row / column one copy each; grid as many as fit, laid as above.
    const fit = (len: number, c: number) => {
      const k = Math.floor((len + gap) / (c + gap));
      return Number.isFinite(k) && k >= 1 ? k : 1;
    };
    const pageCols = grid ? (left ? fit(boxW, cellW) : cols) : 1;
    const perPage = grid ? pageCols * fit(boxH, cellH) : 1;
    // Copy `i` on page `page`: the page along the axis, plus its place in the page.
    const place = (i: number, page: number): [number, number] => {
      const j = i % perPage;
      const [px, py] = along(page * boxLen);
      return grid ? [px + (j % pageCols) * (cellW + gap), py + Math.floor(j / pageCols) * (cellH + gap)] : [px, py];
    };
    kept.forEach((k, i) => copies.push(...k.map((x) => put(x, `#${i}`, place(i, Math.floor(i / perPage))))));
    const steps = Math.ceil(kept.length / perPage);
    if (steps >= 2) {
      // Page 0 again after the last: the wrap is seamless.
      kept.slice(0, perPage).forEach((k, i) => copies.push(...k.map((x) => put(x, `#${i}@w`, place(i, steps)))));
      const pause = roll.pause ?? 4;
      motion = { kind: 'step', axis, distance: boxLen, steps, pause, period: pause + 0.6, from: 0 };
    }
  } else {
    const n = kept.length;
    const total = !n ? 0 : grid ? Math.max(...offsets.map(([x, y]) => (left ? x : y))) + (left ? cellW : cellH) : (layout === 'column' ? offsets[n - 1][1] : offsets[n - 1][0]) + extents[n - 1];
    if ((roll.by ?? 'speed') === 'duration') {
      // Once through, in `duration` seconds: in from the far edge, out at the near one.
      kept.forEach((k, i) => copies.push(...k.map((x) => put(x, `#${i}`, offsets[i]))));
      const duration = roll.duration ?? 30;
      if (n && total > 0 && duration > 0) {
        const speed = (boxLen + total) / duration;
        motion = { kind: 'crawl', axis, distance: total, lead: boxLen, period: total / speed, from: 0, once: true };
      }
    } else {
      // On and on at `speed`: laid again every `L` until the box is covered.
      const L = total + gap;
      const speed = roll.speed ?? 120;
      const runs = n > 0 && L > 0 && speed > 0;
      const times = runs ? Math.min(MAX_REPEATS, Math.max(0, Math.ceil(boxLen / L)) + 1) : 1;
      for (let r = 0; r < times; r++) kept.forEach((k, i) => copies.push(...k.map((x) => put(x, r ? `#${i}@${r}` : `#${i}`, offsets[i], along(r * L)))));
      if (runs) motion = { kind: 'crawl', axis, distance: L, lead: boxLen, period: L / speed, from: 0, once: false };
    }
  }
  // In the folder, at its top left (children are in their parent's space), as big.
  const box: Partial<Record<Prop, Value>> = { x: 0, y: 0 };
  for (const p of ['width', 'height'] as const) if (g.props[p] !== undefined) box[p] = g.props[p];
  const moving = { id: rollId, name: g.name, type: 'group', clip: false, parent: g.id, visible: true, locked: false, props: box, tracks: {}, bindings: {}, ...(g.manualStart ? { manualStart: true } : {}), ...(motion ? { motion } : {}) } as Layer;
  return { folder: { ...g, clip: true } as Layer, roll: moving, copies };
}

/** A model layer shown for a row (`inList.when`; a missing column is empty). */
function shownFor(inList: InList | undefined, row: Row): boolean {
  const w = inList?.when;
  if (!w) return true;
  const v = row[w.col] ?? '';
  switch (w.test) {
    case 'filled':
      return v.trim() !== '';
    case 'empty':
      return v.trim() === '';
    case 'is':
      return w.value !== undefined && v === w.value;
    case 'isNot':
      return w.value === undefined || v !== w.value;
    default:
      return true;
  }
}

/** Every `{{ col }}` of the row's columns in `s` replaced by its value; other placeholders left (cg-core: fill_in). */
export function fillIn(s: string, row: Row): string {
  let out = '';
  let rest = s;
  for (let start = rest.indexOf('{{'); start >= 0; start = rest.indexOf('{{')) {
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf('}}');
    if (end < 0) return out + rest.slice(start);
    const key = after.slice(0, end).trim();
    out += Object.hasOwn(row, key) ? row[key] : rest.slice(start, start + end + 4);
    rest = after.slice(end + 2);
  }
  return out + rest;
}

/** A value as a property takes it (resolveLayer's bindings): a colour, else a number; none if not one. */
function propOf(p: Prop, raw: string): Value | undefined {
  if (COLOR_PROPS.has(p)) return parseHex(raw);
  const t = raw.trim();
  return t === 'true' ? 1 : t === 'false' ? 0 : asNumber(t);
}

/** A copy of a model layer with a row's values: in its text / source, its props bound to a column, its colours by column. */
function withRow(m: Layer, row: Row): Layer {
  const c = structuredClone(m);
  if (c.type === 'text') c.text = fillIn(c.text, row);
  if (c.type === 'image') c.src = fillIn(c.src, row);
  for (const [p, key] of Object.entries(c.bindings ?? {}) as [Prop, string | undefined][]) {
    if (key === undefined || !Object.hasOwn(row, key)) continue;
    delete c.bindings[p];
    const v = propOf(p, row[key]);
    if (v !== undefined) c.props[p] = v;
  }
  // A column's value → a colour (a missing column is empty); a property that is not one is left.
  for (const e of c.inList?.colors ?? []) {
    const v = row[e.col] ?? '';
    if (!PROPS.includes(e.prop) || !Object.hasOwn(e.map, v)) continue;
    const color = propOf(e.prop, e.map[v]);
    if (color !== undefined) c.props[e.prop] = color;
  }
  return c;
}

/** Moved by (dx, dy): its position and every key of its x / y tracks. */
function shift(l: Layer, dx: number, dy: number) {
  for (const [p, d] of [['x', dx], ['y', dy]] as const) {
    if (!d) continue;
    l.props[p] = num(l.props[p] ?? 0) + d;
    for (const k of l.tracks?.[p] ?? []) if (typeof k.value === 'number') k.value += d;
  }
}

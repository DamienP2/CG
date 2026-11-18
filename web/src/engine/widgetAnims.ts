// Internal animations of built widgets: keyframes of their elements started by a trigger (their
// arrival on air, a variable that changes, their Logic), drawn over what the timeline gives.
// Mirror of crates/cg-core/src/built.rs (`apply_anims`, `watch_anims`).
import { resolveLayer, sampleTrack, type Resolved } from './evaluate';
import { elementId, varKey } from './built';
import type { Data, Prop, Template, WidgetAnim } from './types';

/** The data key holding when the animation `anim` of the widget `widget` (its folder id) last started, in seconds on air. */
export const animKey = (widget: string, anim: string) => varKey(widget, `@${anim}`);
const seenKey = (widget: string, v: string) => varKey(widget, `@seen_${v}`);

const num = (s: string | undefined) => {
  const x = Number(String(s ?? '').trim().replace(',', '.'));
  return String(s ?? '').trim() !== '' && Number.isFinite(x) ? x : null;
};

function test(v: string, op: string, value: string): boolean {
  const a = num(v);
  const b = num(value);
  if (a !== null && b !== null) {
    if (op === 'lt') return a < b;
    if (op === 'le') return a <= b;
    if (op === 'gt') return a > b;
    if (op === 'ge') return a >= b;
    if (op === 'ne') return Math.abs(a - b) > 1e-9;
    return Math.abs(a - b) <= 1e-9;
  }
  if (op === 'ne') return v.trim() !== value.trim();
  if (op === 'eq') return v.trim() === value.trim();
  return false;
}

/** The frame of `a` drawn at `secs` on air, or null when it is not playing. */
export function animFrame(a: WidgetAnim, widget: string, secs: number, data: Data): number | null {
  const len = Math.max(0, a.duration);
  if (len <= 0 || !Object.keys(a.tracks ?? {}).length) return null;
  const fps = a.fps || 50;
  let start: number;
  const tr = a.trigger ?? { on: 'logic' };
  if (tr.on === 'arrival') start = 0;
  else if (tr.on === 'while') {
    if (!test(String(data[varKey(widget, tr.var)] ?? ''), tr.test, tr.value)) return null;
    return (((secs * fps) % len) + len) % len;
  } else {
    const s = num(data[animKey(widget, a.id)]);
    if (s === null) return null;
    start = s;
  }
  const f = (secs - start) * fps;
  return f >= 0 && f <= len ? f : null;
}

/** The widgets of `t` with internal animations. */
function animated(t: Template): [string, WidgetAnim[]][] {
  const out: [string, WidgetAnim[]][] = [];
  for (const l of t.layers) {
    const list = (l.widget?.snap as { anims?: WidgetAnim[] } | undefined)?.anims;
    if (list?.length) out.push([l.id, list]);
  }
  return out;
}

export const hasAnims = (t: Template) => t.layers.some((l) => !!(l.widget?.snap as { anims?: WidgetAnim[] } | undefined)?.anims?.length);

/** An internal animation of a widget of `t` is playing at `secs`. */
export const animsRunning = (t: Template, secs: number, data: Data) => animated(t).some(([w, list]) => list.some((a) => animFrame(a, w, secs, data) !== null));

/** Sets in `values` what the internal animations playing at `secs` give their elements; returns the elements changed. */
export function applyAnims(values: Map<string, Resolved>, t: Template, frame: number, secs: number, data: Data, hold: number): string[] {
  const changed: string[] = [];
  for (const [w, list] of animated(t)) {
    for (const a of list) {
      const f = animFrame(a, w, secs, data);
      if (f === null) continue;
      for (const [el, props] of Object.entries(a.tracks)) {
        const id = elementId(w, el);
        const l = t.layers.find((x) => x.id === id);
        if (!l) continue;
        let v = values.get(id);
        if (!v) values.set(id, (v = resolveLayer(l, frame, data, hold)));
        for (const [prop, keys] of Object.entries(props ?? {})) {
          const x = sampleTrack(keys, f);
          if (x !== undefined) (v as Record<string, unknown>)[prop as Prop] = x;
        }
        changed.push(id);
      }
    }
  }
  return changed;
}

/**
 * An animation started by a variable that changed, went up or went down starts now (`secs`):
 * the data with its start (and the values seen), or the same object when nothing started.
 * The Operator's preview and the Builder's try-out call it after each change (the server does on air).
 */
export function watchAnims(t: Template, data: Data, secs: number): Data {
  let out = data;
  const set = (k: string, v: string) => {
    if (out[k] === v) return;
    if (out === data) out = { ...data };
    out[k] = v;
  };
  for (const [w, list] of animated(t)) {
    const vars = new Set<string>();
    for (const a of list) {
      const tr = a.trigger;
      if (!tr || (tr.on !== 'change' && tr.on !== 'increase' && tr.on !== 'decrease')) continue;
      vars.add(tr.var);
      const now = String(data[varKey(w, tr.var)] ?? '');
      const was = data[seenKey(w, tr.var)];
      if (was === undefined || was === now) continue;
      const x = num(was);
      const y = num(now);
      const go = tr.on === 'change' || (x !== null && y !== null && (tr.on === 'increase' ? y > x : y < x));
      if (go) set(animKey(w, a.id), String(Math.round(secs * 10000) / 10000));
    }
    for (const v of vars) set(seenKey(w, v), String(data[varKey(w, v)] ?? ''));
  }
  return out;
}

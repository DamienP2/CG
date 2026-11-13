// Widgets built with the Builder: a definition (Project.widgets) made of plain
// elements, variables, options and controls.
//
// In a template a built widget is a folder (Layer.widget) holding the elements
// generated from its definition (`generate`): both renderers draw them as any
// layer. Its variables are values of the graphic under `varKey`; its buttons
// change them and drive the Temps among its elements through its Logic
// (engine/widgetLogic.ts), which the server runs (crates/cg-core/src/built.rs).
import { parseSetting, formatSetting, readPath, writePath } from './settings';
import type { Data, Layer, Prop, WidgetDef, WidgetInstance } from './types';
import { placedLogic } from './widgetLogic';

/** The instance without its placed Logic (made again from the definition). */
const withoutLogic = ({ logic: _, ...w }: WidgetInstance): WidgetInstance => w;

/** The data key of the variable `name` of the widget placed as `widget` (its layer id). Mirror of built::var_key. */
export function varKey(widget: string, name: string): string {
  return `w_${widget.replace(/[^A-Za-z0-9]/g, '_')}_${name}`;
}

/** The id of an element of the widget `widget` in its template. Mirror of built::element_id. */
export const elementId = (widget: string, element: string) => `${widget}/${element}`;

/** The start value of `name` in this template (else the definition's). */
export function startValue(def: WidgetDef, layer: Layer, name: string): string {
  return layer.widget?.vars?.[name] ?? def.vars.find((v) => v.name === name)?.initial ?? '';
}

/** Its variables at their start values, by data key. */
export function startData(def: WidgetDef, layer: Layer): Data {
  return Object.fromEntries(def.vars.map((v) => [varKey(layer.id, v.name), startValue(def, layer, v.name)]));
}

// -------------------------------------------------------------- controls --

/** What a press asks an element of the widget (a Temps started…): /api/widgets/press. */
export interface Forward {
  layer: string;
  op: string;
  args?: unknown;
}

const num = (s: string | undefined) => {
  const x = parseFloat((s ?? '').trim().replace(',', '.'));
  return Number.isFinite(x) ? x : undefined;
};

// ------------------------------------------------------------ generation --

const hexColor = (s: string): number[] | undefined => {
  const h = s.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return undefined;
  const p = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [p(0), p(2), p(4), h.length === 8 ? p(6) : 1];
};

/** `v` written at `path` of `l`, read as the type already there (a colour as RGBA). */
/** Sets an element's property to an option's value (a colour given as #hex on a colour property). */
export function setOption(l: Layer, path: string, v: unknown) {
  const o = l as unknown as Record<string, unknown>;
  const cur = readPath(o, path);
  let out: unknown = v;
  if (typeof v === 'string' && Array.isArray(cur)) out = hexColor(v) ?? parseSetting(v, cur);
  else if (cur !== undefined && typeof v !== typeof cur) out = parseSetting(formatSetting(v), cur) ?? v;
  writePath(o, path, out);
}

/** The JSON of `l` with the widget's variables (`{{name}}`) read from the graphic's values. */
function withVarKeys<T>(l: T, widget: string, names: string[]): T {
  if (!names.length) return l;
  const re = new RegExp(`\\{\\{\\s*(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\}\\}`, 'g');
  return JSON.parse(JSON.stringify(l).replace(re, (_, n: string) => `{{${varKey(widget, n)}}}`)) as T;
}

/**
 * The layers of the widget placed as `group` (its folder, with `widget` set): the folder, then its
 * elements generated from `def` — ids `${group.id}/${element}`, its variables read from the graphic's
 * values, its options applied, its Repeaters' copies laid out. The template keeps them; the renderers
 * draw them as any layer. Options the template exposes (`widget.options.<id>` in the folder's
 * settingBindings) are bound on their targets, so the Operator's value reaches them.
 */
export function generate(def: WidgetDef, group: Layer): Layer[] {
  const W = group.id;
  const logic = placedLogic(def, group);
  const id = (x: string) => elementId(W, x);
  const names = def.vars.map((v) => v.name);
  const byId = new Map(def.layers.map((l) => [l.id, l]));
  const kids = (pid: string | null) => def.layers.filter((l) => (l.parent ?? null) === pid);
  const out: Layer[] = [];
  const ofCopy = new Map<string, Layer[]>();
  // The elements in paint order; a Repeater's content repeated.
  const place = (l: Layer, parent: string, copy?: { i: number; dx: number; dy: number; lit?: Layer['lit']; suffix: string }) => {
    const g = withVarKeys(structuredClone(l), W, names);
    g.id = id(l.id) + (copy?.suffix ?? '');
    g.parent = parent;
    if (copy && (l.parent ?? null) !== null && byId.get(l.parent!)?.repeat) {
      g.props = { ...g.props, x: (num(String(g.props.x ?? 0)) ?? 0) + copy.dx, y: (num(String(g.props.y ?? 0)) ?? 0) + copy.dy };
      for (const p of ['x', 'y'] as Prop[]) {
        const d = p === 'x' ? copy.dx : copy.dy;
        if (g.tracks?.[p]?.length) g.tracks[p] = g.tracks[p]!.map((k) => ({ ...k, value: typeof k.value === 'number' ? k.value + d : k.value }));
      }
      if (copy.lit) g.lit = copy.lit;
    }
    delete (g as { repeat?: unknown }).repeat;
    // A folder repeated per row of a list: the list's value in the template.
    if (g.list && names.includes(g.list.key)) g.list = { ...g.list, key: varKey(W, g.list.key) };
    out.push(g);
    if (copy) (ofCopy.get(l.id) ?? ofCopy.set(l.id, []).get(l.id)!).push(g);
    if (l.repeat) {
      const r = l.repeat;
      const model = kids(l.id);
      // One step: the model's box (its first element) and the gap.
      const w = num(String(model[0]?.props.width ?? 0)) ?? 0;
      const h = num(String(model[0]?.props.height ?? 0)) ?? 0;
      const cols = Math.max(1, r.layout === 'row' ? r.count : r.layout === 'column' ? 1 : (r.cols ?? 1));
      for (let i = 0; i < Math.max(0, Math.floor(r.count)); i++) {
        const [cx, cy] = [i % cols, Math.floor(i / cols)];
        const c = { i, dx: cx * (w + r.gap), dy: cy * (h + r.gap), lit: r.lit ? { key: varKey(W, r.lit), index: i, off: r.off } : undefined, suffix: `#${i}` };
        for (const m of model) place(m, g.id, c);
      }
      return;
    }
    for (const k of kids(l.id)) place(k, g.id, copy ? { ...copy } : undefined);
  };
  // Its folder: the instance, sized to the widget's frame, with what playing it needs (on air without the library).
  const folder: Layer = {
    ...group,
    type: 'group',
    props: { ...group.props, width: def.width, height: def.height },
    widget: { ...withoutLogic(group.widget!), snap: { id: def.id, name: def.name, vars: def.vars, controls: def.controls }, rev: def.rev ?? 0, ...(logic ? { logic } : {}) },
  } as Layer;
  for (const l of kids(null)) place(l, W);
  // Its options: the template's value (else the default) on each target; an exposed one bound.
  const exposed = folder.settingBindings ?? {};
  const generated = new Map(out.map((l) => [l.id, l]));
  for (const o of def.options) {
    const v = group.widget?.options?.[o.id] ?? o.default;
    const key = exposed[`widget.options.${o.id}`];
    for (const t of o.targets) {
      for (const l of [generated.get(id(t.layer)), ...(ofCopy.get(t.layer) ?? [])]) {
        if (!l) continue;
        if (v !== undefined) setOption(l, t.path, v);
        if (!key) continue;
        if (t.path.startsWith('props.')) l.bindings = { ...l.bindings, [t.path.slice(6) as Prop]: key };
        else l.settingBindings = { ...l.settingBindings, [t.path]: key };
      }
    }
  }
  return [folder, ...out];
}

/** A new widget placed at (x, y): its folder and its elements. */
export function placeWidget(def: WidgetDef, folderId: string, x: number, y: number): Layer[] {
  const group = {
    id: folderId,
    name: def.name,
    type: 'group',
    parent: null,
    visible: true,
    locked: false,
    props: { x, y, width: def.width, height: def.height },
    tracks: {},
    bindings: {},
    widget: { def: def.id, vars: Object.fromEntries(def.vars.map((v) => [v.name, v.initial])), options: {} },
  } as unknown as Layer;
  return generate(def, group);
}

/** The template's layers with the widget placed as `folderId` generated again (its definition or options changed). */
export function regenerate(layers: Layer[], folderId: string, def: WidgetDef): Layer[] {
  const at = layers.findIndex((l) => l.id === folderId);
  if (at < 0) return layers;
  const mine = (l: Layer) => l.id.startsWith(`${folderId}/`);
  const fresh = generate(def, layers[at]);
  const rest = layers.filter((l, i) => i !== at && !mine(l));
  const pos = Math.min(at, rest.length);
  return [...rest.slice(0, pos), ...fresh, ...rest.slice(pos)];
}

/**
 * The Builder's picture: each Repeater's content drawn its number of times (the copies after the
 * first `${id}#${i}`, lit by its variable — the Builder's values are keyed by the variable's name).
 * The first copy keeps the element's id: it is the one selected and edited.
 */
export function repeatPreview(layers: Layer[]): Layer[] {
  const reps = layers.filter((l) => l.type === 'group' && l.repeat);
  if (!reps.length) return layers;
  const out = [...layers];
  const kids = (pid: string) => layers.filter((l) => l.parent === pid);
  const tree = (id: string): Layer[] => kids(id).flatMap((k) => [k, ...tree(k.id)]);
  for (const r of reps) {
    const rep = r.repeat!;
    const model = kids(r.id);
    const w = num(String(model[0]?.props.width ?? 0)) ?? 0;
    const h = num(String(model[0]?.props.height ?? 0)) ?? 0;
    const cols = Math.max(1, rep.layout === 'row' ? rep.count : rep.layout === 'column' ? 1 : (rep.cols ?? 1));
    const lit = (i: number) => (rep.lit ? { key: rep.lit, index: i, off: rep.off } : undefined);
    // The first copy: the elements themselves, lit as the first.
    for (const m of model) {
      const at = out.findIndex((l) => l.id === m.id);
      if (at >= 0 && rep.lit) out[at] = { ...out[at], lit: lit(0) };
    }
    const all = model.flatMap((m) => [m, ...tree(m.id)]);
    const last = out.reduce((a, l, i) => (all.some((x) => x.id === l.id) ? i : a), out.findIndex((l) => l.id === r.id));
    const copies: Layer[] = [];
    for (let i = 1; i < Math.max(1, Math.floor(rep.count)); i++) {
      const dx = (i % cols) * (w + rep.gap);
      const dy = Math.floor(i / cols) * (h + rep.gap);
      for (const l of all) {
        const c = structuredClone(l);
        c.id = `${l.id}#${i}`;
        c.parent = l.parent === r.id ? r.id : `${l.parent}#${i}`;
        if (l.parent === r.id) {
          c.props = { ...c.props, x: (num(String(c.props.x ?? 0)) ?? 0) + dx, y: (num(String(c.props.y ?? 0)) ?? 0) + dy };
          if (rep.lit) c.lit = lit(i);
        }
        copies.push(c);
      }
    }
    out.splice(last + 1, 0, ...copies);
  }
  return out;
}

/** An element generated inside a built widget (its controls are the widget's). */
export function insideWidget(layers: Layer[], l: Layer): boolean {
  const byId = new Map(layers.map((x) => [x.id, x]));
  for (let p = l.parent ? byId.get(l.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) if (p.widget) return true;
  return false;
}

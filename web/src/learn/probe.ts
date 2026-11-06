/*
 * What the lessons test and point at: the Designer's template and selection,
 * the Operator's simulation, the page.
 */
import { useDesigner, findLayer } from '../designer/designerStore';
import { designTemplates } from '../engine/drafts';
import { useApp } from '../store';
import { num, propValue } from '../engine/evaluate';
import type { Layer, Prop } from '../engine/types';

/** Simulations' ids (cg-server sim.rs). */
const SIM = 'sim~';

export const designer = () => useDesigner.getState();
export const template = () => designer().template;
export const layers = (): Layer[] => template()?.layers ?? [];
/** The layers of a type (`rect`, `text`, `group`…). */
export const layersOf = (type: string) => layers().filter((l) => l.type === type);
export const hasLayer = (type: string, n = 1) => layersOf(type).length >= n;
/** The selected layers. */
export const selected = (): Layer[] => {
  const t = template();
  return t ? designer().selected.map((id) => findLayer(t, id)).filter((l): l is Layer => !!l) : [];
};
export const selectedType = (type?: string) => selected().some((l) => !type || l.type === type);
/** A property of a layer at the playhead. */
export const prop = (l: Layer | undefined, p: Prop) => (l ? num(propValue(l, p, designer().frame)) : 0);
/** Keyframes of a layer (all its properties). */
export const keyframes = (l: Layer | undefined) => (l ? Object.values(l.tracks ?? {}).reduce((n, k) => n + (k?.length ?? 0), 0) : 0);
/** Some layer has keyframes on `p` (at least `n`). */
export const animated = (p: Prop, n = 2) => layers().some((l) => (l.tracks?.[p]?.length ?? 0) >= n);
/** The project open (Designer: as designed; Operator: as published). */
export const project = () => useApp.getState().project;
/** The page's address. */
export const path = () => location.pathname;
export const onPage = (re: RegExp) => re.test(location.pathname);
/** An element shown on the page. */
export function shown(sel: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) if (el.getClientRects().length) return el;
  return null;
}
/** An element whose text contains `text`. */
export function withText(sel: string, text: string | RegExp): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const s = el.textContent ?? '';
    if ((typeof text === 'string' ? s.includes(text) : text.test(s)) && el.getClientRects().length) return el;
  }
  return null;
}
/** The graphics on air in this person's simulations (a lesson's antenne: nothing goes on air). */
export const onAir = (): number =>
  Object.entries(useApp.getState().live)
    .filter(([id]) => id.startsWith(SIM))
    .reduce((n, [, l]) => n + Object.keys(l.state?.layers ?? {}).length, 0);
/** The template open in the Designer is the `n`-th one (0-based) of the project, opened if not. */
export function openTemplate(n = 0) {
  const p = project();
  const t = p ? designTemplates(p)[n] : undefined;
  if (t && template()?.id !== t.id) designer().load(t);
}

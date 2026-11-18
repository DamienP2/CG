// The Widget Builder's internal animations, edited with the Designer's timeline: the layers' tracks
// hold the keyframes of the animation chosen (`Template.builderAnim`); the drawing has none. They go
// back into the widget's `anims` when another one is chosen and when the widget is saved (defOf).
import { newId } from '../engine/evaluate';
import type { Keyframe, Layer, Prop, Template, WidgetAnim } from '../engine/types';
import { t } from '../i18n';
import { useApp } from '../store';
import { useDesigner } from './designerStore';

/** The project's frame rate: the timeline's frames. */
export const timelineFps = () => {
  const r = useApp.getState().project?.frameRate;
  return r ? r.num / r.den : 50;
};

const hasTracks = (l: Layer) => Object.values(l.tracks ?? {}).some((k) => (k as Keyframe[] | undefined)?.length);

/** The keyframes the layers hold now, by element. */
function heldTracks(tpl: Template): WidgetAnim['tracks'] {
  const out: WidgetAnim['tracks'] = {};
  for (const l of tpl.layers) if (hasTracks(l)) out[l.id] = structuredClone(l.tracks) as Partial<Record<Prop, Keyframe[]>>;
  return out;
}

/** The widget's animations with the one being edited as the layers hold it (its keyframes, its length). */
export function committedAnims(tpl: Template): WidgetAnim[] {
  const list = tpl.builder?.anims ?? [];
  if (!tpl.builderAnim) return list;
  const fps = timelineFps();
  return list.map((a) => (a.id === tpl.builderAnim ? { ...a, fps, duration: tpl.duration, tracks: heldTracks(tpl) } : a));
}

/** The layers without keyframes (as the widget keeps them: its animations hold them). */
export const drawnLayers = (layers: Layer[]) => layers.map((l) => (hasTracks(l) ? { ...l, tracks: {} } : l));

/** The keyframes of `a` at the timeline's frame rate. */
function retimed(a: WidgetAnim, fps: number): WidgetAnim['tracks'] {
  const k = fps / (a.fps || fps);
  if (Math.abs(k - 1) < 1e-9) return structuredClone(a.tracks);
  const out: WidgetAnim['tracks'] = {};
  for (const [el, props] of Object.entries(a.tracks)) out[el] = Object.fromEntries(Object.entries(props ?? {}).map(([p, keys]) => [p, (keys ?? []).map((x) => ({ ...x, frame: x.frame * k }))]));
  return out;
}

/** In the template being edited: puts away the animation edited, and shows `id`'s keyframes (null: the drawing). */
function show(tpl: Template, id: string | null) {
  if (!tpl.builder) return;
  tpl.builder.anims = committedAnims(tpl);
  tpl.layers = drawnLayers(tpl.layers);
  const a = id ? tpl.builder.anims.find((x) => x.id === id) : undefined;
  const fps = timelineFps();
  if (a) {
    const tracks = retimed(a, fps);
    for (const l of tpl.layers) if (tracks[l.id]) l.tracks = tracks[l.id] as Layer['tracks'];
    tpl.duration = Math.max(1, Math.round(a.duration * (fps / (a.fps || fps))));
    tpl.builderAnim = a.id;
  } else {
    tpl.duration = 50;
    delete tpl.builderAnim;
  }
  // The playhead plays the whole animation: it holds at its end.
  for (const m of tpl.markers) if (m.kind === 'out') m.frame = tpl.duration;
}

/** Shows an animation on the timeline (null: the drawing, without keyframes). */
export function selectAnim(id: string | null) {
  const st = useDesigner.getState();
  if (!st.template?.builder || (st.template.builderAnim ?? null) === id) return;
  st.update((tpl) => show(tpl, id));
  st.setFrame(0);
}

/** A new animation (1 second, at its arrival on air), shown on the timeline. */
export function newAnim(tracks?: WidgetAnim['tracks']) {
  const st = useDesigner.getState();
  if (!st.template?.builder) return null;
  const fps = timelineFps();
  const n = (st.template.builder.anims?.length ?? 0) + 1;
  const a: WidgetAnim = { id: newId(), name: t('Animation {n}', { n }), trigger: { on: 'arrival' }, fps, duration: Math.round(fps), tracks: tracks ?? {} };
  st.update((tpl) => {
    if (!tpl.builder) return;
    tpl.builder.anims = [...committedAnims(tpl), a];
    // Keyframes made on the drawing become this animation's.
    if (!tracks) tpl.layers = drawnLayers(tpl.layers);
    show(tpl, a.id);
    if (tracks) tpl.duration = Math.max(tpl.duration, Math.ceil(Math.max(0, ...Object.values(tracks).flatMap((p) => Object.values(p ?? {}).flatMap((k) => (k ?? []).map((x) => x.frame)))))) || tpl.duration;
  });
  st.setFrame(0);
  return a.id;
}

/** Changes the animation `id` (its name, trigger…). */
export function setAnim(id: string, patch: Partial<WidgetAnim>, key?: string) {
  useDesigner.getState().update((tpl) => {
    if (!tpl.builder) return;
    tpl.builder.anims = (tpl.builder.anims ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a));
  }, key);
}

export function deleteAnim(id: string) {
  useDesigner.getState().update((tpl) => {
    if (!tpl.builder) return;
    if (tpl.builderAnim === id) {
      tpl.layers = drawnLayers(tpl.layers);
      delete tpl.builderAnim;
      tpl.duration = 50;
    }
    tpl.builder.anims = (tpl.builder.anims ?? []).filter((a) => a.id !== id);
  });
}

/** Keyframes set while the drawing is shown: they make a new animation (the drawing has none). */
export function adoptStrayKeys() {
  const tpl = useDesigner.getState().template;
  if (!tpl?.builder || tpl.builderAnim || !tpl.layers.some(hasTracks)) return false;
  newAnim(heldTracks(tpl));
  return true;
}

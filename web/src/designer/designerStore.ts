import { create } from 'zustand';
import { DEFAULTS, defaultData, newId, propValue } from '../engine/evaluate';
import type { Data, Keyframe, Layer, LayerType, Prop, Template, Value } from '../engine/types';

export interface KeyRef {
  layerId: string;
  prop: Prop;
  frame: number;
}

interface DesignerStore {
  template: Template | null;
  past: Template[];
  future: Template[];
  lastCoalesce: { key: string; at: number } | null;
  frame: number;
  playing: boolean;
  loop: boolean;
  /** Stop on pause markers while playing, like on air. */
  playoutPreview: boolean;
  selected: string[];
  selectedKeys: KeyRef[];
  expanded: Record<string, boolean>;
  zoom: number;
  previewData: Data;

  load: (t: Template | null) => void;
  update: (recipe: (t: Template) => void, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  setFrame: (f: number) => void;
  setPlaying: (p: boolean) => void;
  select: (ids: string[]) => void;
  selectKeys: (keys: KeyRef[]) => void;
  toggleExpanded: (id: string) => void;
  set: (partial: Partial<DesignerStore>) => void;
}

const HISTORY = 200;

export const useDesigner = create<DesignerStore>((set, get) => ({
  template: null,
  past: [],
  future: [],
  lastCoalesce: null,
  frame: 0,
  playing: false,
  loop: true,
  playoutPreview: false,
  selected: [],
  selectedKeys: [],
  expanded: {},
  zoom: 8,
  previewData: {},

  load(t) {
    set({
      template: t ? structuredClone(t) : null,
      past: [],
      future: [],
      frame: 0,
      playing: false,
      selected: [],
      selectedKeys: [],
      previewData: t ? defaultData(t) : {},
      lastCoalesce: null,
    });
  },

  update(recipe, coalesceKey) {
    const { template, past, lastCoalesce } = get();
    if (!template) return;
    const next = structuredClone(template);
    recipe(next);
    const now = performance.now();
    const coalesce = coalesceKey && lastCoalesce?.key === coalesceKey && now - lastCoalesce.at < 800;
    set({
      template: next,
      past: coalesce ? past : [...past.slice(-HISTORY), template],
      future: [],
      lastCoalesce: coalesceKey ? { key: coalesceKey, at: now } : null,
    });
  },

  undo() {
    const { past, template, future } = get();
    if (!past.length || !template) return;
    set({ template: past[past.length - 1], past: past.slice(0, -1), future: [template, ...future], lastCoalesce: null });
  },

  redo() {
    const { past, template, future } = get();
    if (!future.length || !template) return;
    set({ template: future[0], future: future.slice(1), past: [...past, template], lastCoalesce: null });
  },

  setFrame(f) {
    const t = get().template;
    const max = t?.duration ?? 0;
    set({ frame: Math.max(0, Math.min(max, f)) });
  },
  setPlaying: (playing) => set({ playing }),
  select: (selected) => set({ selected }),
  selectKeys: (selectedKeys) => set({ selectedKeys }),
  toggleExpanded: (id) => set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  set: (partial) => set(partial),
}));

// ---------------------------------------------------------------------------
// Template mutations (applied on a draft inside `update`).

export function findLayer(t: Template, id: string): Layer | undefined {
  return t.layers.find((l) => l.id === id);
}

export const isAnimated = (l: Layer, p: Prop) => (l.tracks[p]?.length ?? 0) > 0;

/** Sets a property: writes a keyframe when the property is animated (auto-key). */
export function setProp(l: Layer, p: Prop, v: Value, frame: number) {
  const track = l.tracks[p];
  if (track && track.length) {
    const f = Math.round(frame);
    const existing = track.find((k) => k.frame === f);
    if (existing) existing.value = v;
    else {
      track.push({ frame: f, value: v, easing: nearestEasing(track, f) });
      track.sort((a, b) => a.frame - b.frame);
    }
  } else {
    l.props[p] = v;
  }
}

function nearestEasing(track: Keyframe[], f: number) {
  const before = [...track].reverse().find((k) => k.frame < f);
  return before?.easing ?? { type: 'easeInOut' as const };
}

/** The AE stopwatch: enable/disable animation of a property. */
export function toggleStopwatch(l: Layer, p: Prop, frame: number) {
  if (isAnimated(l, p)) {
    l.props[p] = propValue(l, p, frame);
    delete l.tracks[p];
  } else {
    l.tracks[p] = [{ frame: Math.round(frame), value: propValue(l, p, frame), easing: { type: 'easeInOut' } }];
  }
}

export function toggleKeyAt(l: Layer, p: Prop, frame: number) {
  const f = Math.round(frame);
  const track = l.tracks[p] ?? [];
  const idx = track.findIndex((k) => k.frame === f);
  if (idx >= 0) {
    track.splice(idx, 1);
    if (!track.length) {
      l.props[p] = propValue({ ...l, tracks: {} }, p, f);
      delete l.tracks[p];
    }
  } else {
    track.push({ frame: f, value: propValue(l, p, f), easing: nearestEasing(track, f) });
    track.sort((a, b) => a.frame - b.frame);
    l.tracks[p] = track;
  }
}

export function descendants(t: Template, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const l of t.layers) if (l.parent === pid) out.push(l.id), walk(l.id);
  };
  walk(id);
  return out;
}

const LABELS: Record<LayerType, string> = {
  group: 'Group',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  image: 'Image',
};

export function makeLayer(type: LayerType, width: number, height: number, parent?: string | null): Layer {
  const base = {
    id: newId(),
    name: LABELS[type],
    parent: parent ?? null,
    visible: true,
    locked: false,
    tracks: {},
    bindings: {},
  };
  const centered = (w: number, h: number) => ({ x: parent ? 0 : Math.round((width - w) / 2), y: parent ? 0 : Math.round((height - h) / 2), width: w, height: h });
  switch (type) {
    case 'group':
      return { ...base, type, clip: false, props: centered(800, 200) };
    case 'rect':
      return { ...base, type, props: { ...centered(500, 120), fill: [0.486, 0.361, 1, 1] } };
    case 'ellipse':
      return { ...base, type, props: { ...centered(200, 200), fill: [1, 0.231, 0.361, 1] } };
    case 'text':
      return {
        ...base,
        type,
        text: 'New text',
        fontFamily: 'Inter',
        fontWeight: 700,
        align: 'left',
        verticalAlign: 'middle',
        uppercase: false,
        props: { ...centered(700, 100), fontSize: 64, fill: DEFAULTS.fill },
      };
    case 'image':
      return { ...base, type, src: '', fit: 'contain', props: centered(400, 300) };
  }
}

export function newTemplate(name: string): Template {
  return {
    id: newId(),
    name,
    duration: 150,
    markers: [
      { id: newId(), frame: 50, name: 'On air', kind: 'pause' },
      { id: newId(), frame: 100, name: 'Out', kind: 'out' },
    ],
    fields: [],
    layers: [],
  };
}

import { create } from 'zustand';
import { DEFAULTS, defaultData, newId, propValue } from '../engine/evaluate';
import type { Data, FontStyle, Keyframe, Layer, LayerType, Prop, Template, Value } from '../engine/types';

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

export const LABELS: Record<LayerType, string> = {
  group: 'Group',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  image: 'Image',
  clock: 'Clock',
  ticker: 'Ticker',
  roll: 'Credits roll',
  analogClock: 'Analog clock',
  counter: 'Counter',
  progress: 'Progress bar',
  rotator: 'Rotator',
  typewriter: 'Typewriter',
  slideshow: 'Slideshow',
  qrCode: 'QR code',
  barChart: 'Bar chart / poll',
};

/** Widget presets offered in the toolbar menu (a type plus overrides). */
export const WIDGET_PRESETS: { key: string; label: string; hint: string; type: LayerType; patch?: Partial<Record<string, unknown>> }[] = [
  { key: 'clock', label: 'Clock', hint: 'Time of day, any time zone', type: 'clock' },
  { key: 'date', label: 'Date', hint: 'dd/MM/yyyy', type: 'clock', patch: { format: 'dd/MM/yyyy' } },
  { key: 'countdown', label: 'Countdown', hint: 'To a time of day or a date', type: 'clock', patch: { mode: 'countdown', target: '20:00', format: 'HH:mm:ss' } },
  { key: 'timer', label: 'Timer', hint: 'Counts down a duration once on air', type: 'clock', patch: { mode: 'timer', target: '5:00', format: 'mm:ss' } },
  { key: 'elapsed', label: 'Stopwatch', hint: 'Time since the take', type: 'clock', patch: { mode: 'elapsed', format: 'mm:ss.f' } },
  { key: 'analogClock', label: 'Analog clock', hint: 'Face with hands', type: 'analogClock' },
  { key: 'ticker', label: 'Ticker', hint: 'Horizontal crawl', type: 'ticker' },
  { key: 'roll', label: 'Credits roll', hint: 'Vertical scroll', type: 'roll' },
  { key: 'rotator', label: 'Rotator', hint: 'Lines one after another', type: 'rotator' },
  { key: 'typewriter', label: 'Typewriter', hint: 'Letter-by-letter reveal', type: 'typewriter' },
  { key: 'counter', label: 'Counter', hint: 'Animated number', type: 'counter' },
  { key: 'progress', label: 'Progress bar', hint: 'Value / max, animated', type: 'progress' },
  { key: 'barChart', label: 'Bar chart / poll', hint: 'Label: value lines', type: 'barChart' },
  { key: 'slideshow', label: 'Slideshow', hint: 'Images with cross-fade', type: 'slideshow' },
  { key: 'qrCode', label: 'QR code', hint: 'URL or text', type: 'qrCode' },
];

const font = (align: FontStyle['align'] = 'left', weight = 700): FontStyle => ({ fontFamily: 'Inter', fontWeight: weight, align, verticalAlign: 'middle', uppercase: false });

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
    case 'clock':
      return { ...base, type, mode: 'time', format: 'HH:mm:ss', timezone: '', target: '', ...font('center'), props: { ...centered(300, 90), fontSize: 64, fill: DEFAULTS.fill } };
    case 'ticker':
      return {
        ...base,
        type,
        text: 'First headline of the ticker\nSecond headline\nThird headline',
        separator: '   •   ',
        speed: 180,
        ...font('left', 600),
        props: { x: 0, y: parent ? 0 : height - 140, width: parent ? 1000 : width, height: 64, fontSize: 36, fill: DEFAULTS.fill },
      };
    case 'roll':
      return {
        ...base,
        type,
        text: 'PRESENTED BY\nJane Doe\n\nDIRECTED BY\nJohn Smith\n\nPRODUCED BY\nPulse CG',
        speed: 60,
        loop: true,
        ...font('center', 600),
        props: { ...centered(900, 800), fontSize: 44, fill: DEFAULTS.fill },
      };
    case 'analogClock':
      return { ...base, type, timezone: '', seconds: true, accent: '#ff3b5c', props: { ...centered(300, 300), fill: [1, 1, 1, 1], stroke: [0.07, 0.08, 0.12, 1] } };
    case 'counter':
      return {
        ...base,
        type,
        from: '0',
        to: '12500',
        duration: 2,
        decimals: 0,
        prefix: '',
        suffix: '',
        grouping: true,
        ...font('center', 800),
        props: { ...centered(500, 140), fontSize: 110, fill: DEFAULTS.fill },
      };
    case 'progress':
      return { ...base, type, value: '65', max: '100', duration: 1, track: '#ffffff33', props: { ...centered(800, 24), cornerRadius: 12, fill: [0.486, 0.361, 1, 1] } };
    case 'rotator':
      return { ...base, type, text: 'First message\nSecond message\nThird message', interval: 4, fade: 0.5, ...font('left', 600), props: { ...centered(900, 80), fontSize: 48, fill: DEFAULTS.fill } };
    case 'typewriter':
      return { ...base, type, text: 'Breaking news: type your text here', speed: 20, cursor: true, ...font('left', 600), props: { ...centered(1100, 90), fontSize: 52, fill: DEFAULTS.fill } };
    case 'slideshow':
      return { ...base, type, images: '', interval: 5, fade: 0.8, fit: 'cover', props: centered(640, 360) };
    case 'qrCode':
      return { ...base, type, data: 'https://example.com', background: '#ffffff', props: { ...centered(260, 260), fill: [0.05, 0.05, 0.08, 1] } };
    case 'barChart':
      return {
        ...base,
        type,
        text: 'Yes: 58\nNo: 34\nNo opinion: 8',
        percent: true,
        duration: 1.2,
        track: '#ffffff22',
        textColor: '#ffffff',
        ...font('left', 600),
        props: { ...centered(900, 260), fontSize: 36, fill: [0.486, 0.361, 1, 1] },
      };
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

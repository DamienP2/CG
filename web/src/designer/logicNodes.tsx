import {
  AlarmClock,
  ArrowDown,
  ArrowLeftRight,
  Ampersand,
  Binary,
  Blend,
  Calculator,
  CaseUpper,
  ChevronsRight,
  Clock,
  Combine,
  Diamond,
  Equal,
  Hash,
  Hourglass,
  Layers,
  ListOrdered,
  Palette,
  Pause,
  Percent,
  Play,
  Radio,
  Repeat,
  Replace,
  Rows3,
  Ruler,
  Send,
  Sigma,
  Split,
  Square,
  SquareStack,
  Table2,
  Timer,
  ToggleLeft,
  Type,
  Variable,
  WandSparkles,
  Waves,
  Zap,
  Rocket,
  Gauge,
  Shrink,
  Spline,
  Hand,
  type LucideIcon,
} from 'lucide-react';
import { newId } from '../engine/evaluate';
import { metricOf, rowType, type PortType } from '../engine/logic';
import { COLOR_PROPS, PROPS, TEXT_LIKE, type Layer, type LayerRow, type LogicNode, type Prop, type Template, type TriggerEvent } from '../engine/types';
import { widgetOf } from '../widgets';
import { settingPorts } from '../engine/settingPorts';
import { PROP_LABELS } from './Inspector';
import { t } from '../i18n';

/*
 * The nodes of the Logic canvas: their families (palette sections and colours), what the palette
 * offers (entries, some of them a Calculation set up for a use: « Formater un nombre »…), and
 * the labels of a Layer node's rows.
 */

export type Fam = 'layer' | 'input' | 'math' | 'text' | 'cond' | 'time' | 'event' | 'trigger' | 'action' | 'var' | 'mine';

export const FAMS: { id: Fam; label: string }[] = [
  { id: 'layer', label: 'Layers' },
  { id: 'input', label: 'Inputs' },
  { id: 'math', label: 'Maths' },
  { id: 'text', label: 'Text' },
  { id: 'cond', label: 'Conditions' },
  { id: 'time', label: 'Timing' },
  { id: 'event', label: 'Events' },
  { id: 'trigger', label: 'Triggers' },
  { id: 'action', label: 'Actions' },
  { id: 'var', label: 'Variables' },
];

/** What a template offers: a palette entry shows under « Useful here » only when it can serve. */
export interface Has {
  t: Template;
  others: number;
}

export interface Entry {
  key: string;
  fam: Fam;
  label: string;
  icon: LucideIcon;
  /** A short note on the right (a layer's type…). */
  note?: string;
  make: (t: Template, x: number, y: number) => LogicNode;
  can?: (h: Has) => boolean;
}

/** Layers an event or an action can watch or drive. */
export const timerLayer = (l: Layer) => l.type === 'clock' && !!((l as { timerMode?: string }).timerMode || ['countdown', 'stopwatch'].includes((l as { mode?: string }).mode ?? ''));
export const videoLayer = (l: Layer) => l.type === 'image' && !!((l as { video?: boolean }).video || ((l as { frames?: string[] }).frames?.length ?? 0) > 0);
export const scrollLayer = (l: Layer) => l.type === 'ticker' || l.type === 'credits';
const TIMED = new Set(['clock', 'ticker', 'roll', 'counter', 'progress', 'typewriter', 'barChart', 'credits', 'slideshow', 'rotator']);
export const timedLayer = (l: Layer) => TIMED.has(l.type) || videoLayer(l);

/** The variables a template sets (its « Set a variable » nodes). */
export const varNames = (t: Template) => [...new Set((t.logic?.nodes ?? []).flatMap((n) => (n.type === 'setVar' && n.name.trim() ? [n.name.trim()] : [])))];

/** Properties a layer of this type has. */
export function propsOf(l: Layer | undefined): Prop[] {
  if (!l) return [];
  const has = (p: Prop) => {
    if (p === 'fill') return l.type !== 'image';
    if (p === 'stroke' || p === 'strokeWidth') return l.type !== 'image' && l.type !== 'qrCode';
    if (p === 'cornerRadius') return l.type === 'rect' || l.type === 'group' || l.type === 'progress';
    if (p === 'fontSize' || p === 'letterSpacing') return TEXT_LIKE.has(l.type);
    if (p.startsWith('crop')) return l.type === 'image';
    if (p === 'arcStart' || p === 'arcEnd' || p === 'innerRadius') return l.type === 'ellipse';
    if (p === 'drawStart' || p === 'drawEnd') return l.type === 'pen';
    if (p === 'cornerTl' || p === 'cornerTr' || p === 'cornerBr' || p === 'cornerBl') return l.type === 'rect';
    if (p === 'fill2') return ['rect', 'ellipse', 'polygon', 'pen', 'text'].includes(l.type);
    if (p === 'shadowColor' || p === 'shadowX' || p === 'shadowY' || p === 'shadowBlur') return l.type !== 'text';
    return true;
  };
  return PROPS.filter(has);
}

/** Content ports of a layer (what the Data canvas fills: its text, its picture…). */
export function contentOf(l: Layer | undefined): string[] {
  if (!l) return [];
  const spec = widgetOf(l)?.content;
  if (spec) return spec.filter((p) => !['items'].includes(p) || l.type === 'socialWall');
  if (l.type === 'image') return ['src'];
  return typeof (l as { text?: unknown }).text === 'string' ? ['text'] : [];
}

/** Every row a Layer node can show for this layer, by group. */
export function rowsFor(l: Layer | undefined): { key: string; group: string }[] {
  if (!l) return [];
  return [
    ...contentOf(l).map((p) => ({ key: `content.${p}`, group: 'Content' })),
    ...(l.type === 'text' ? ['text.width', 'text.height', 'text.lines', 'text.chars'].map((key) => ({ key, group: 'Measured text' })) : []),
    ...propsOf(l).map((p) => ({ key: p as string, group: COLOR_PROPS.has(p) ? 'Colours' : 'Properties' })),
    // The widget's settings the data can set (a colour of a team, a speed…).
    ...settingPorts(l)
      .filter((sp) => !['grid', 'entries'].includes(sp.path) && !contentOf(l).includes(sp.path))
      .map((sp) => ({ key: `setting.${sp.path}`, group: 'Settings' })),
  ];
}

const PROP_NAMES: Partial<Record<Prop, string>> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height', anchorX: 'Anchor X', anchorY: 'Anchor Y', scaleX: 'Scale X', scaleY: 'Scale Y', rotation: 'Rotation', opacity: 'Opacity', strokeWidth: 'Stroke width', cornerRadius: 'Corner radius', fontSize: 'Text size', letterSpacing: 'Letter spacing', fill: 'Colour' };
const METRIC_NAMES: Record<string, string> = { 'text.width': 'Text width', 'text.height': 'Text height', 'text.lines': 'Lines', 'text.chars': 'Characters' };
const CONTENT_NAMES: Record<string, string> = { text: 'Text', src: 'Picture', items: 'Items', link: 'Data set', csv: 'Values', data: 'Data', value: 'Value', max: 'Maximum', min: 'Minimum', title: 'Title', 'title.text': 'Title', to: 'Value', prefix: 'Prefix', suffix: 'Suffix', goal: 'Goal', url: 'Address', author: 'Author', platform: 'Platform', avatar: 'Avatar', bannerText: 'Banner' };

/** The label of a Layer row. */
export function rowLabel(key: string): string {
  if (metricOf(key)) return t(METRIC_NAMES[key]);
  if (key.startsWith('content.')) {
    const p = key.slice(8);
    return CONTENT_NAMES[p] ? t(CONTENT_NAMES[p]) : p;
  }
  return t(PROP_NAMES[key as Prop] ?? PROP_LABELS[key as Prop] ?? key);
}

/** The rows a new Layer node starts with (`want`: a row of that type, for a wire being dropped). */
export function startRows(l: Layer | undefined, want?: { type: PortType; side: 'in' | 'out' }): LayerRow[] {
  if (!l) return [];
  const all = rowsFor(l).map((r) => r.key);
  if (want) {
    const fits = (k: string) => {
      const ty = rowType(k);
      if (want.side === 'in' && metricOf(k)) return false;
      if (want.side === 'out' && k.startsWith('content.')) return false;
      return want.type === 'any' || want.type === 'flow' ? ty === 'num' : ty === want.type || (want.type === 'bool' && ty === 'num');
    };
    const pref = want.type === 'num' && want.side === 'out' && l.type === 'text' ? 'text.width' : want.type === 'num' ? (want.side === 'in' ? 'x' : 'width') : undefined;
    const key = pref && all.includes(pref) ? pref : all.find(fits);
    return key ? [{ key }] : [];
  }
  if (l.type === 'text') return [{ key: 'content.text' }, { key: 'text.width' }];
  if (l.type === 'image') return [{ key: 'content.src' }, { key: 'opacity' }];
  const c = contentOf(l)[0];
  return c ? [{ key: `content.${c}` }, { key: 'opacity' }] : [{ key: 'x' }, { key: 'y' }];
}

const LAYER_ICONS: Partial<Record<string, LucideIcon>> = { text: Type, image: Square, group: Layers };

const base = (x: number, y: number) => ({ id: newId(), x, y });
const calc = (key: string, fam: Fam, label: string, icon: LucideIcon, expr: string, inputs: string[] = ['a', 'b']): Entry => ({
  key,
  fam,
  label,
  icon,
  make: (_t, x, y) => ({ ...base(x, y), type: 'expr', expr, inputs, title: label }),
});

/** A Layer node for `l`. */
export const layerNode = (l: Layer, x: number, y: number, want?: { type: PortType; side: 'in' | 'out' }): LogicNode => ({ ...base(x, y), type: 'layer', layer: l.id, rows: startRows(l, want) });

/** The palette, for this template. */
export function entries(tpl: Template): Entry[] {
  const fieldKey = tpl.fields[0]?.key ?? '';
  const of = (f: (l: Layer) => boolean) => tpl.layers.find(f)?.id ?? '';
  const ev = (key: string, label: string, icon: LucideIcon, on: () => TriggerEvent, can: (h: Has) => boolean): Entry => ({ key, fam: 'event', label, icon, can, make: (_t, x, y) => ({ ...base(x, y), type: 'event', on: on() }) });
  return [
    ...tpl.layers.map(
      (l): Entry => ({
        key: `layer:${l.id}`,
        fam: 'layer',
        label: l.name,
        icon: LAYER_ICONS[l.type] ?? Square,
        note: l.type,
        make: (_t, x, y) => layerNode(l, x, y),
      }),
    ),
    // Inputs
    { key: 'constant', fam: 'input', label: 'Number', icon: Hash, make: (_t, x, y) => ({ ...base(x, y), type: 'constant', value: 0 }) },
    { key: 'text', fam: 'input', label: 'Text', icon: Type, make: (_t, x, y) => ({ ...base(x, y), type: 'text', value: '' }) },
    { key: 'color', fam: 'input', label: 'Colour', icon: Palette, make: (_t, x, y) => ({ ...base(x, y), type: 'color', value: '#ffffff' }) },
    { key: 'flag', fam: 'input', label: 'Yes / no', icon: ToggleLeft, make: (_t, x, y) => ({ ...base(x, y), type: 'flag', value: true }) },
    { key: 'onAir', fam: 'input', label: 'Another graphic on air', icon: Radio, can: (h) => h.others > 0, make: (_t, x, y) => ({ ...base(x, y), type: 'onAir', template: '', transition: 0.4, test: false }) },
    // Maths
    calc('expr', 'math', 'Calculation', Calculator, 'a + b'),
    calc('clamp', 'math', 'Clamp', Shrink, 'limiter(a, 0, 1920)', ['a']),
    calc('remap', 'math', 'Remap', Spline, 'remapper(a, 0, 100, 0, 1920)', ['a']),
    calc('round', 'math', 'Round off', Binary, 'arrondi(a, 0)', ['a']),
    calc('max', 'math', 'Min / max', Sigma, 'max(a, b)'),
    calc('percent', 'math', 'Percentage', Percent, 'a / b * 100'),
    calc('mix', 'math', 'Mix two colours', Blend, 'mélanger(a, b, c)', ['a', 'b', 'c']),
    { key: 'counter', fam: 'math', label: 'Counter', icon: ListOrdered, make: (_t, x, y) => ({ ...base(x, y), type: 'counter', start: 0, step: 1 }) },
    // Text
    calc('join', 'text', 'Join', Combine, 'a & " " & b'),
    calc('format', 'text', 'Format a number', Gauge, 'format(a, 1)', ['a']),
    calc('short', 'text', 'Short number (1,2 k)', Gauge, 'compact(a)', ['a']),
    calc('plural', 'text', 'Plural', Type, 'a & " " & pluriel(a, "point", "points")', ['a']),
    calc('upper', 'text', 'Upper case', CaseUpper, 'majuscules(a)', ['a']),
    calc('replace', 'text', 'Replace', Replace, 'remplacer(a, "x", "y")', ['a']),
    calc('line', 'text', 'Line n', Rows3, 'ligne(a, 1)', ['a']),
    calc('length', 'text', 'Length', Ruler, 'longueur(a)', ['a']),
    { key: 'lookup', fam: 'text', label: 'Lookup table', icon: Table2, make: (_t, x, y) => ({ ...base(x, y), type: 'lookup', rows: [{ key: '', value: '' }], otherwise: '' }) },
    // Conditions
    { key: 'if', fam: 'cond', label: 'If / else if / else', icon: Split, make: (_t, x, y) => ({ ...base(x, y), type: 'if', inputs: ['a', 'b'], branches: [{ when: 'a > b', value: '1' }], otherwise: '0' }) },
    calc('compare', 'cond', 'Compare', Equal, 'a > b'),
    calc('and', 'cond', 'And / or', Ampersand, 'a et b'),
    calc('between', 'cond', 'Is between', ArrowLeftRight, 'entre(a, 0, 10)', ['a']),
    calc('contains', 'cond', 'Contains', Diamond, 'contient(a, "x")', ['a']),
    calc('empty', 'cond', 'Is empty', Diamond, 'vide(a)', ['a']),
    // Time
    { key: 'wait', fam: 'time', label: 'Wait', icon: Hourglass, make: (_t, x, y) => ({ ...base(x, y), type: 'wait', seconds: 2 }) },
    { key: 'every', fam: 'time', label: 'Every N seconds', icon: Repeat, make: (_t, x, y) => ({ ...base(x, y), type: 'every', seconds: 5 }) },
    { key: 'once', fam: 'time', label: 'Only once', icon: AlarmClock, make: (_t, x, y) => ({ ...base(x, y), type: 'once' }) },
    calc('blink', 'time', 'Blink', Zap, 'clignoter(1)', []),
    calc('osc', 'time', 'Oscillate', Waves, 'osciller(2)', []),
    calc('since', 'time', 'Time since in', Timer, 'temps()', []),
    calc('hour', 'time', 'Hour of the day', Clock, 'heure()', []),
    // Events
    { key: 'start', fam: 'event', label: 'When taken', icon: Rocket, make: (_t, x, y) => ({ ...base(x, y), type: 'start' }) },
    ev('ev:scrollEnd', 'End of the scroll', ArrowLeftRight, () => ({ kind: 'scrollEnd', layer: of(scrollLayer), passes: 1 }), (h) => h.t.layers.some(scrollLayer)),
    ev('ev:timerZero', 'Timer', Timer, () => ({ kind: 'timerZero', layer: of(timerLayer) }), (h) => h.t.layers.some(timerLayer)),
    ev('ev:videoEnd', 'End of the video', Play, () => ({ kind: 'videoEnd', layer: of(videoLayer) }), (h) => h.t.layers.some(videoLayer)),
    ev('ev:lastRow', 'Last row', Rows3, () => ({ kind: 'lastRow', dataset: tpl.datasets?.[0]?.key ?? '' }), (h) => (h.t.datasets?.length ?? 0) > 0),
    ev('ev:dataChange', 'Value changes', Diamond, () => ({ kind: 'dataChange', key: fieldKey }), (h) => h.t.fields.length > 0),
    ev('ev:graphic', 'Another graphic comes in / out', SquareStack, () => ({ kind: 'graphic', template: '' }), (h) => h.others > 0),
    // Triggers
    { key: 'triggerIn', fam: 'trigger', label: 'Trigger received', icon: Zap, make: (_t, x, y) => ({ ...base(x, y), type: 'triggerIn', name: '' }) },
    { key: 'continue', fam: 'trigger', label: 'Continue (F2)', icon: ChevronsRight, make: (_t, x, y) => ({ ...base(x, y), type: 'continue' }) },
    // Actions
    { key: 'out', fam: 'action', label: 'Take out (OUT)', icon: Square, make: (_t, x, y) => ({ ...base(x, y), type: 'out' }) },
    { key: 'resume', fam: 'action', label: 'Resume the pause', icon: Pause, can: (h) => h.t.markers.some((m) => m.kind === 'pause'), make: (tt, x, y) => ({ ...base(x, y), type: 'resume', marker: tt.markers.find((m) => m.kind === 'pause')?.id ?? '' }) },
    { key: 'nextRow', fam: 'action', label: 'Next row', icon: ArrowDown, can: (h) => (h.t.datasets?.length ?? 0) > 0, make: (tt, x, y) => ({ ...base(x, y), type: 'nextRow', dataset: tt.datasets?.[0]?.key ?? '' }) },
    { key: 'fire', fam: 'action', label: 'Fire a trigger', icon: Send, make: (_t, x, y) => ({ ...base(x, y), type: 'fire', name: '' }) },
    { key: 'take', fam: 'action', label: 'Take another graphic', icon: SquareStack, can: (h) => h.others > 0, make: (_t, x, y) => ({ ...base(x, y), type: 'take', template: '' }) },
    { key: 'widget', fam: 'action', label: 'Widget control', icon: Hand, can: (h) => h.t.layers.some(timedLayer), make: (tt, x, y) => ({ ...base(x, y), type: 'widget', layer: tt.layers.find(timedLayer)?.id ?? '', control: 'start' }) },
    // Variables
    { key: 'setVar', fam: 'var', label: 'Set a variable', icon: Variable, make: (tt, x, y) => ({ ...base(x, y), type: 'setVar', name: varNames(tt)[0] ?? 'var1', value: '1', transition: 0 }) },
    { key: 'var', fam: 'var', label: 'Read a variable', icon: Variable, make: (tt, x, y) => ({ ...base(x, y), type: 'var', name: varNames(tt)[0] ?? '', test: 0 }) },
  ];
}

/** The family, label and icon of a node in the canvas. */
export function kindOf(n: LogicNode, tpl: Template): { fam: Fam; label: string; icon: LucideIcon } {
  const all = entries(tpl);
  if (n.type === 'layer') {
    const l = tpl.layers.find((x) => x.id === n.layer);
    return { fam: 'layer', label: l?.name ?? t('Missing layer'), icon: (l && LAYER_ICONS[l.type]) ?? Square };
  }
  if (n.type === 'event') {
    const k = n.on.kind === 'timerAt' ? 'timerZero' : n.on.kind === 'dataIs' ? 'dataChange' : n.on.kind;
    const e = all.find((x) => x.key === `ev:${k}`)!;
    return { fam: 'event', label: t(e.label), icon: e.icon };
  }
  if (n.type === 'expr') {
    const e = all.find((x) => x.key === 'expr')!;
    const preset = n.title ? all.find((x) => x.fam !== 'layer' && x.label === n.title) : undefined;
    return { fam: preset?.fam ?? 'math', label: n.title ? t(n.title) : t('Calculation'), icon: preset?.icon ?? (n.title ? WandSparkles : e.icon) };
  }
  if (n.type === 'setField') return { fam: 'text', label: t('Show in a text'), icon: Type };
  if (n.type === 'field') {
    // A variable, or a column of a data set (its name without the set's).
    const f = tpl.fields.find((x) => x.key === n.key);
    const ds = (tpl.datasets ?? []).find((d) => n.key.startsWith(`${d.key}_`));
    return { fam: 'input', label: f?.label || (ds ? n.key.slice(ds.key.length + 1) : n.key), icon: Rows3 };
  }
  const e = all.find((x) => x.key === n.type);
  return e ? { fam: e.fam, label: t(n.title || e.label), icon: e.icon } : { fam: 'math', label: n.type, icon: Calculator };
}

import {
  AlarmClock,
  RotateCcw,
  MousePointerClick,
  Undo2,
  Move,
  MoveRight,
  GitBranch,
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
  ListVideo,
  CircleSlash,
  type LucideIcon,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useApp } from '../store';
import { newId } from '../engine/evaluate';
import { metricOf, rowType, type PortType } from '../engine/logic';
import { COLOR_PROPS, PROPS, TEXT_LIKE, type Layer, type LayerRow, type LogicNode, type Prop, type Template } from '../engine/types';
import { widgetOf } from '../widgets';
import { settingPorts } from '../engine/settingPorts';
import { PROP_LABELS } from './Inspector';
import { t } from '../i18n';

/*
 * The nodes of the Logic canvas: their families (palette sections and colours), what the palette
 * offers (entries, some of them a Calculation set up for a use: « Formater un nombre »…), and
 * the labels of a Layer node's rows.
 */

export type Fam = 'wbtn' | 'wvar' | 'wel' | 'layer' | 'graphic' | 'playlist' | 'how' | 'input' | 'math' | 'text' | 'cond' | 'time' | 'event' | 'trigger' | 'action' | 'var' | 'mine';

export const FAMS: { id: Fam; label: string }[] = [
  // The Builder: the widget's own.
  { id: 'wbtn', label: 'Widget buttons' },
  { id: 'wvar', label: 'Widget variables' },
  { id: 'wel', label: 'Animated elements' },
  { id: 'layer', label: 'Layers' },
  { id: 'graphic', label: 'Templates' },
  { id: 'playlist', label: 'Playlists' },
  { id: 'event', label: 'When' },
  { id: 'cond', label: 'If' },
  { id: 'how', label: 'How' },
  { id: 'action', label: 'Actions' },
  { id: 'time', label: 'Timing' },
  { id: 'var', label: 'Variables' },
  { id: 'input', label: 'Inputs' },
  { id: 'math', label: 'Maths' },
  { id: 'text', label: 'Text' },
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

/** The id of the stand-in template the Logic canvas edits for the project's Logic. */
export const PROJECT_LOGIC = '__project__';
export const isProjectLogic = (t: Template | undefined) => t?.id === PROJECT_LOGIC;
const hasPlaylists = () => (useApp.getState().project?.playlists.filter((l) => !l.owner).length ?? 0) > 0;

/** Layers an event or an action can watch or drive. */
export const timerLayer = (l: Layer) => l.type === 'clock' && !!((l as { timerMode?: string }).timerMode || ['countdown', 'stopwatch'].includes((l as { mode?: string }).mode ?? ''));
export const videoLayer = (l: Layer) => l.type === 'image' && !!((l as { video?: boolean }).video || ((l as { frames?: string[] }).frames?.length ?? 0) > 0);
export const scrollLayer = (l: Layer) => l.type === 'ticker' || l.type === 'credits';
const TIMED = new Set(['clock', 'ticker', 'roll', 'counter', 'progress', 'typewriter', 'barChart', 'credits', 'slideshow', 'rotator']);
export const timedLayer = (l: Layer) => TIMED.has(l.type) || videoLayer(l) || (l.type === 'group' && !!l.roll);

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

const PROP_NAMES: Partial<Record<Prop, string>> = { x: 'X position', y: 'Y position', width: 'Width', height: 'Height', anchorX: 'Anchor X', anchorY: 'Anchor Y', scaleX: 'Scale X', scaleY: 'Scale Y', rotation: 'Rotation', skewX: 'Skew X', skewY: 'Skew Y', rotateX: '3D rotation X', rotateY: '3D rotation Y', perspective: 'Perspective', depth: 'Thickness', opacity: 'Opacity', strokeWidth: 'Stroke width', cornerRadius: 'Corner radius', fontSize: 'Text size', letterSpacing: 'Letter spacing', fill: 'Colour' };
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

/** An entry's label: names (layers, graphics, the widget's buttons…) as they are, the rest in the interface's language. */
export const entryLabel = (e: Pick<Entry, 'key' | 'label'>) => (/^(layer|tpl|pl|wbtn|wvar|wel):/.test(e.key) ? e.label : t(e.label));

/** The palette, for this template. */
export function entries(tpl: Template): Entry[] {
  return isProjectLogic(tpl) ? projectEntries(tpl) : tpl.builder ? builderEntries(tpl) : templateEntries(tpl);
}

/** What the Logic of a widget (Builder) cannot use: the air of a graphic, other graphics, its own variables. */
const NOT_IN_WIDGET = new Set(['onAir', 'continue', 'out', 'resume', 'nextRow', 'take', 'resumePlaylist', 'stopAuto', 'widget', 'setVar', 'var']);

/** The default change of a widget variable, for its kind. */
export const wvarOp = (kind: string | undefined) => (kind === 'list' ? 'next' : kind === 'bool' ? 'toggle' : kind === 'text' ? 'set' : 'add');

/** The Builder's Logic: the widget's buttons, variables and Temps first, then what a graphic's Logic offers. */
function builderEntries(tpl: Template): Entry[] {
  const b = tpl.builder!;
  const buttons = b.controls.map(
    (c): Entry => ({ key: `wbtn:${c.id}`, fam: 'wbtn', label: c.row ? `${c.row} · ${c.label}` : c.label, icon: MousePointerClick, note: t('Button'), make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: 'control', name: c.id }) }),
  );
  const vars: Entry[] = [
    ...b.vars.map((v): Entry => ({ key: `wvar:${v.name}`, fam: 'wvar', label: v.name, icon: Variable, note: t('Variable'), make: (_t, x, y) => ({ ...base(x, y), type: 'wvar', var: v.name, op: wvarOp(v.kind), value: '1' }) })),
    { key: 'wreset', fam: 'wvar', label: 'Back to the start (all)', icon: RotateCcw, make: (_t, x, y) => ({ ...base(x, y), type: 'wvar', var: '', op: 'reset', value: '' }) },
    { key: 'wundo', fam: 'wvar', label: 'Undo', icon: Undo2, make: (_t, x, y) => ({ ...base(x, y), type: 'wundo' }) },
  ];
  const els = tpl.layers.filter(timedLayer).map(
    (l): Entry => ({ key: `wel:${l.id}`, fam: 'wel', label: l.name, icon: LAYER_ICONS[l.type] ?? Timer, note: t('Element'), make: (_t, x, y) => ({ ...base(x, y), type: 'widget', layer: l.id, control: 'toggle' }) }),
  );
  return [...buttons, ...vars, ...els, ...templateEntries(tpl).filter((e) => e.fam !== 'graphic' && !NOT_IN_WIDGET.has(e.key))];
}

/** What a graphic's own Logic cannot do in the project's: its layers, its events, its pauses, its widgets. */
const NOT_IN_PROJECT = new Set(['onAir', 'continue', 'out', 'resume', 'nextRow', 'widget', 'blink', 'osc']);

/** The project's Logic: its graphics and playlists, and what acts on them. */
function projectEntries(tpl: Template): Entry[] {
  const p = useApp.getState().project;
  const graphics = (p?.templates ?? []).map(
    (x): Entry => ({ key: `tpl:${x.id}`, fam: 'graphic', label: x.name, icon: SquareStack, make: (_t, x0, y0) => ({ ...base(x0, y0), type: 'template', template: x.id }) }),
  );
  // The shared playlists (a personal one is played by hand by its author).
  const lists = (p?.playlists ?? []).filter((l) => !l.owner).map(
    (l): Entry => ({
      key: `pl:${l.id}`,
      fam: 'playlist',
      label: l.name,
      icon: ListVideo,
      note: String((p?.rundown ?? []).filter((r) => r.playlist === l.id).length),
      make: (_t, x0, y0) => ({ ...base(x0, y0), type: 'playlist', playlist: l.id }),
    }),
  );
  const rest = templateEntries(tpl)
    .filter((e) => e.fam !== 'layer' && e.fam !== 'graphic' && !NOT_IN_PROJECT.has(e.key))
    .flatMap((e): Entry[] => {
      if (e.key === 'start') return [{ ...e, label: 'Project loaded' }];
      if (e.key === 'animate') return [{ ...e, can: undefined, make: (_t, x, y) => ({ ...base(x, y), type: 'animate', template: '', layer: '', sets: [{ key: 'x', mode: 'to', value: '0' }] }) }];
      if (e.key === 'take')
        return [
          { ...e, label: 'Take a graphic', can: undefined },
          { key: 'takeOut', fam: 'action', label: 'Take a graphic out', icon: Square, make: (_t, x, y) => ({ ...base(x, y), type: 'take', template: '', out: true }) },
        ];
      return [e];
    });
  return [...graphics, ...lists, ...rest, { key: 'clearAll', fam: 'action', label: 'Clear all', icon: CircleSlash, make: (_t, x, y) => ({ ...base(x, y), type: 'clearAll' }) }];
}

function templateEntries(tpl: Template): Entry[] {
  const others = (useApp.getState().project?.templates ?? []).filter((x) => x.id !== tpl.id);
  return [
    ...others.map((x): Entry => ({ key: `tpl:${x.id}`, fam: 'graphic', label: x.name, icon: SquareStack, make: (_t, x0, y0) => ({ ...base(x0, y0), type: 'template', template: x.id }) })),
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
    // How…: the way the next take or out goes
    { key: 'how', fam: 'how', label: 'How…', icon: MoveRight, make: (_t, x, y) => ({ ...base(x, y), type: 'how', mode: 'fade', seconds: 0.5, easing: { type: 'easeInOut' }, side: 'left' }) },
    // If…: a phrase, true or false
    { key: 'check', fam: 'cond', label: 'If…', icon: GitBranch, make: (_t, x, y) => ({ ...base(x, y), type: 'check', rows: [] }) },
    { key: 'if', fam: 'cond', label: 'If / else if / else', icon: Split, make: (_t, x, y) => ({ ...base(x, y), type: 'if', inputs: ['a', 'b'], branches: [{ when: 'a > b', value: '1' }], otherwise: '0' }) },
    calc('compare', 'cond', 'Compare', Equal, 'a > b'),
    calc('and', 'cond', 'And / or', Ampersand, 'a et b'),
    calc('between', 'cond', 'Is between', ArrowLeftRight, 'entre(a, 0, 10)', ['a']),
    calc('contains', 'cond', 'Contains', Diamond, 'contient(a, "x")', ['a']),
    calc('empty', 'cond', 'Is empty', Diamond, 'vide(a)', ['a']),
    // Time
    { key: 'wait', fam: 'time', label: 'Wait', icon: Hourglass, make: (_t, x, y) => ({ ...base(x, y), type: 'wait', seconds: 2 }) },
    { key: 'once', fam: 'time', label: 'Only once', icon: AlarmClock, make: (_t, x, y) => ({ ...base(x, y), type: 'once' }) },
    calc('blink', 'time', 'Blink', Zap, 'clignoter(1)', []),
    calc('osc', 'time', 'Oscillate', Waves, 'osciller(2)', []),
    calc('since', 'time', 'Time since in', Timer, 'temps()', []),
    calc('hour', 'time', 'Hour of the day', Clock, 'heure()', []),
    // When: a moment of a source (wired in), or of the graphic
    { key: 'when', fam: 'event', label: 'When…', icon: Zap, make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: '' }) },
    { key: 'start', fam: 'event', label: 'When taken', icon: Rocket, make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: 'start' }) },
    { key: 'triggerIn', fam: 'event', label: 'Trigger received', icon: Zap, make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: 'trigger', name: '' }) },
    { key: 'continue', fam: 'event', label: 'Continue (F2)', icon: ChevronsRight, make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: 'continue' }) },
    { key: 'every', fam: 'event', label: 'Every N seconds', icon: Repeat, make: (_t, x, y) => ({ ...base(x, y), type: 'when', on: 'every', seconds: 5 }) },
    // Actions
    { key: 'out', fam: 'action', label: 'Take out (OUT)', icon: Square, make: (_t, x, y) => ({ ...base(x, y), type: 'out' }) },
    { key: 'resume', fam: 'action', label: 'Resume the pause', icon: Pause, can: (h) => h.t.markers.some((m) => m.kind === 'pause'), make: (tt, x, y) => ({ ...base(x, y), type: 'resume', marker: tt.markers.find((m) => m.kind === 'pause')?.id ?? '' }) },
    { key: 'nextRow', fam: 'action', label: 'Next row', icon: ArrowDown, can: (h) => (h.t.datasets?.length ?? 0) > 0, make: (tt, x, y) => ({ ...base(x, y), type: 'nextRow', dataset: tt.datasets?.[0]?.key ?? '' }) },
    { key: 'fire', fam: 'action', label: 'Fire a trigger', icon: Send, make: (_t, x, y) => ({ ...base(x, y), type: 'fire', name: '' }) },
    { key: 'take', fam: 'action', label: 'Take another graphic', icon: SquareStack, can: (h) => h.others > 0, make: (_t, x, y) => ({ ...base(x, y), type: 'take', template: '' }) },
    { key: 'resumePlaylist', fam: 'action', label: 'Resume a playlist', icon: ListVideo, can: hasPlaylists, make: (_t, x, y) => ({ ...base(x, y), type: 'resumePlaylist', playlist: '' }) },
    { key: 'stopAuto', fam: 'action', label: 'Stop the Auto', icon: Pause, can: hasPlaylists, make: (_t, x, y) => ({ ...base(x, y), type: 'stopAuto', playlist: '' }) },
    { key: 'animate', fam: 'action', label: 'Animate a property', icon: Move, can: (h) => h.t.layers.length > 0, make: (tt, x, y) => ({ ...base(x, y), type: 'animate', layer: tt.layers[0]?.id ?? '', sets: [{ key: 'x', mode: 'to', value: '0' }] }) },
    { key: 'playSound', fam: 'action', label: 'Play a sound', icon: Volume2, make: (_t, x, y) => ({ ...base(x, y), type: 'playSound', sound: '', volume: 0 }) },
    { key: 'stopSound', fam: 'action', label: 'Stop a sound', icon: VolumeX, make: (_t, x, y) => ({ ...base(x, y), type: 'stopSound', sound: '' }) },
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
  if (n.type === 'event' || n.type === 'when') return { fam: 'event', label: t('When'), icon: Zap };
  if (n.type === 'wvar') return { fam: 'wvar', label: t('Widget variable'), icon: Variable };
  if (n.type === 'wundo') return { fam: 'wvar', label: t('Undo'), icon: Undo2 };
  if (n.type === 'widget' && tpl.builder) return { fam: 'wel', label: t('Animated element'), icon: Timer };
  if (n.type === 'check') return { fam: 'cond', label: t('If'), icon: GitBranch };
  if (n.type === 'how') return { fam: 'how', label: t('How'), icon: MoveRight };
  if (n.type === 'expr') {
    const e = all.find((x) => x.key === 'expr')!;
    const preset = n.title ? all.find((x) => x.fam !== 'layer' && x.label === n.title) : undefined;
    return { fam: preset?.fam ?? 'math', label: n.title ? t(n.title) : t('Calculation'), icon: preset?.icon ?? (n.title ? WandSparkles : e.icon) };
  }
  if (n.type === 'setField') return { fam: 'text', label: t('Show in a text'), icon: Type };
  if (n.type === 'template') {
    const x = useApp.getState().project?.templates.find((g) => g.id === n.template);
    return { fam: 'graphic', label: x?.name ?? t('Missing graphic'), icon: SquareStack };
  }
  if (n.type === 'playlist') {
    const l = useApp.getState().project?.playlists.find((g) => g.id === n.playlist);
    return { fam: 'playlist', label: l?.name ?? t('Missing playlist'), icon: ListVideo };
  }
  if (n.type === 'take' && n.out && isProjectLogic(tpl)) return { fam: 'action', label: t('Take a graphic out'), icon: Square };
  if (n.type === 'field') {
    // A variable, or a column of a data set (its name without the set's).
    const f = tpl.fields.find((x) => x.key === n.key);
    const ds = (tpl.datasets ?? []).find((d) => n.key.startsWith(`${d.key}_`));
    return { fam: 'input', label: f?.label || (ds ? n.key.slice(ds.key.length + 1) : n.key), icon: Rows3 };
  }
  const e = all.find((x) => x.key === n.type);
  return e ? { fam: e.fam, label: t(n.title || e.label), icon: e.icon } : { fam: 'math', label: n.type, icon: Calculator };
}

// TypeScript mirror of crates/cg-core/src/model.rs — keep in sync.

export type Color = [number, number, number, number];
export type Value = number | Color;

export type Easing =
  | { type: 'linear' }
  | { type: 'hold' }
  | { type: 'easeIn' }
  | { type: 'easeOut' }
  | { type: 'easeInOut' }
  | { type: 'bezier'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'back' }
  | { type: 'elastic' }
  | { type: 'bounce' };

export interface Keyframe {
  frame: number;
  value: Value;
  easing: Easing;
}

export const PROPS = [
  'x',
  'y',
  'width',
  'height',
  'anchorX',
  'anchorY',
  'rotation',
  'scaleX',
  'scaleY',
  'opacity',
  'fill',
  'stroke',
  'strokeWidth',
  'cornerRadius',
  'fontSize',
  'letterSpacing',
  'cropLeft',
  'cropRight',
  'cropTop',
  'cropBottom',
] as const;
export type Prop = (typeof PROPS)[number];

export const COLOR_PROPS: ReadonlySet<Prop> = new Set(['fill', 'stroke']);

export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';
export type ImageFit = 'contain' | 'cover' | 'stretch';

/** Text styling shared by the text-based widgets. */
export interface FontStyle {
  fontFamily: string;
  fontWeight: number;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  uppercase: boolean;
}

export type ClockMode = 'time' | 'countdown' | 'elapsed' | 'timer';

export type LayerKind =
  | { type: 'group'; clip?: boolean }
  | { type: 'rect' }
  | { type: 'ellipse' }
  | ({ type: 'text'; text: string } & FontStyle)
  | { type: 'image'; src: string; fit: ImageFit }
  | ({ type: 'clock'; mode: ClockMode; format: string; timezone: string; target: string } & FontStyle)
  | ({ type: 'ticker'; text: string; separator: string; speed: number } & FontStyle)
  | ({ type: 'roll'; text: string; speed: number; loop: boolean } & FontStyle)
  | { type: 'analogClock'; timezone: string; seconds: boolean; accent: string }
  | ({ type: 'counter'; from: string; to: string; duration: number; decimals: number; prefix: string; suffix: string; grouping: boolean } & FontStyle)
  | { type: 'progress'; value: string; max: string; duration: number; track: string }
  | ({ type: 'rotator'; text: string; interval: number; fade: number } & FontStyle)
  | ({ type: 'typewriter'; text: string; speed: number; cursor: boolean } & FontStyle)
  | { type: 'slideshow'; images: string; interval: number; fade: number; fit: ImageFit }
  | { type: 'qrCode'; data: string; background: string }
  | ({ type: 'barChart'; text: string; percent: boolean; duration: number; track: string; textColor: string } & FontStyle);

export type LayerType = LayerKind['type'];

export type Layer = LayerKind & {
  id: string;
  name: string;
  parent?: string | null;
  visible: boolean;
  locked: boolean;
  props: Partial<Record<Prop, Value>>;
  tracks: Partial<Record<Prop, Keyframe[]>>;
  bindings: Partial<Record<Prop, string>>;
  /** Per-format changes (9:16…), by format id. */
  overrides?: Record<string, LayerOverride>;
};

/** How a layer differs in one format; anything absent is inherited. */
export interface LayerOverride {
  props?: Partial<Record<Prop, Value>>;
  tracks?: Partial<Record<Prop, Keyframe[]>>;
  visible?: boolean;
}

/** Alternative layout of a project; the main one is width × height ("main"). */
export interface Format {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const MAIN_FORMAT = 'main';

export type MarkerKind = 'pause' | 'out' | 'label';

export interface Marker {
  id: string;
  frame: number;
  name: string;
  kind: MarkerKind;
}

export type FieldKind = 'text' | 'multiline' | 'number' | 'color' | 'image';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  default: string;
}

export interface Template {
  id: string;
  name: string;
  duration: number;
  markers: Marker[];
  fields: Field[];
  layers: Layer[];
  /** Default zone (id). */
  zone: string;
  /** Relations between values (node graph). */
  logic?: Logic;
}

export type TextMetric = 'width' | 'height' | 'lines' | 'chars';
export type MathOp = 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'abs' | 'round' | 'floor' | 'ceil';
export type Cmp = 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne' | 'empty' | 'notEmpty';
export type TargetMode = 'set' | 'add' | 'multiply';

export type LogicNodeKind =
  | { type: 'layerProp'; layer: string; prop: Prop }
  | { type: 'textSize'; layer: string; metric: TextMetric }
  | { type: 'field'; key: string }
  | { type: 'constant'; value: number }
  | { type: 'math'; op: MathOp }
  | { type: 'clamp'; min: number; max: number }
  | { type: 'condition'; cmp: Cmp }
  | { type: 'target'; layer: string; prop: Prop; mode: TargetMode };

export type LogicNode = LogicNodeKind & { id: string; x: number; y: number };

export interface LogicEdge {
  from: string;
  to: string;
  /** Input port of `to`: a, b, in, then, else. */
  port: string;
}

export interface Logic {
  nodes: LogicNode[];
  edges: LogicEdge[];
}

export type ZoneTransition = 'sequential' | 'cut';

/** Screen area showing one template at a time; `layer` is the stacking order. */
export interface Zone {
  id: string;
  name: string;
  layer: number;
  color: string;
  transition: ZoneTransition;
  /** Area by format id, in fractions of the frame (designer guide). */
  areas?: Record<string, Area>;
}

/** A rectangle in fractions of the frame (0..1). */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RundownItem {
  id: string;
  name: string;
  templateId: string;
  /** Zone id ("" = the template's zone). */
  zone: string;
  /** Playlist (rundown section) id. */
  playlist: string;
  /** Legacy playout layer, kept in step with the zone by the server. */
  layer: number;
  data: Record<string, string>;
}

export interface FrameRate {
  num: number;
  den: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  templates: Template[];
  rundown: RundownItem[];
  zones: Zone[];
  playlists: Playlist[];
  formats: Format[];
}

export interface Playlist {
  id: string;
  name: string;
}

export type Phase = 'playing' | 'holding' | 'out';

export interface PlayoutItem {
  templateId: string;
  data: Record<string, string>;
  frame: number;
  target: number;
  phase: Phase;
  rundownId?: string | null;
  /** Project frames since the take (keeps counting while holding). */
  age?: number;
  /** Waiting for this graphic to finish going out (sequential zones). */
  next?: { templateId: string; data: Record<string, string>; rundownId?: string | null; target: number } | null;
}

export interface ChannelState {
  layers: Record<string, PlayoutItem>;
}

/** Commands address a zone by id, or a raw playout layer. */
type Target = { zone?: string; layer?: number };

export type Command =
  | ({ action: 'take'; templateId: string; data?: Record<string, string>; rundownId?: string } & Target)
  | ({ action: 'continue' } & Target)
  | ({ action: 'takeOut' } & Target)
  | ({ action: 'update'; data: Record<string, string> } & Target)
  | ({ action: 'clear' } & Target);

export type Data = Record<string, string>;

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  templates: number;
  rundown: number;
}

export interface ChannelInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  projectId: string | null;
  outputs: string[];
  renditions: { id: string; name: string; width: number; height: number }[];
}

export type Role = 'admin' | 'designer' | 'operator' | 'viewer';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  projects: string[] | null;
  channels: string[] | null;
  disabled: boolean;
}

/** Layer types whose text is styled with a FontStyle. */
export const TEXT_LIKE = new Set<LayerType>(['text', 'clock', 'ticker', 'roll', 'counter', 'rotator', 'typewriter', 'barChart']);

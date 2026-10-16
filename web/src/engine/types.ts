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
};

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
}

export interface RundownItem {
  id: string;
  name: string;
  templateId: string;
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
}

export interface ChannelState {
  layers: Record<string, PlayoutItem>;
}

export type Command =
  | { action: 'take'; layer: number; templateId: string; data?: Record<string, string>; rundownId?: string }
  | { action: 'continue'; layer: number }
  | { action: 'takeOut'; layer: number }
  | { action: 'update'; layer: number; data: Record<string, string> }
  | { action: 'clear'; layer?: number | null };

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

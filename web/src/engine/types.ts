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
export type TextScroll = 'none' | 'horizontal' | 'vertical';
export type TextTransform = 'none' | 'upper' | 'lower' | 'capitalize';
export type TextDecoration = 'none' | 'underline' | 'lineThrough';

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
  | ({
      type: 'text';
      text: string;
      /** Paragraph: lines wrap at the box width. */
      wrap?: boolean;
      transform?: TextTransform;
      decoration?: TextDecoration;
      /** In font sizes (default 1.2). */
      lineHeight?: number;
      /** Fixed, or scrolling like a ticker (horizontal) or a credit roll (vertical). */
      scroll?: TextScroll;
      /** px/s. */
      speed?: number;
      separator?: string;
      looping?: boolean;
    } & FontStyle)
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
  /** Timed widgets wait for the operator to start them. */
  manualStart?: boolean;
  /** Scale X and Y change together. */
  scaleLock?: boolean;
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
  /** `out`: the On air point, where the out animation starts (one per template). */
  kind: MarkerKind;
  /** How a pause resumes (default: the operator's Continue). */
  resume?: Resume;
}

export type Resume = { type: 'manual' } | { type: 'after'; seconds: number } | { type: 'trigger'; name: string };

/** Marker model of templates made by this version (see Template.markerModel). */
export const MARKER_MODEL = 2;

export type FieldKind = 'text' | 'multiline' | 'number' | 'color' | 'image' | 'boolean';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  default: string;
  /** Live value from a data source. */
  binding?: FieldBinding | null;
  /** Range of a number (slider). */
  min?: number;
  max?: number;
}

/** A data source and a path in its value (`rows[{row}].name`, `items[*].title`…). */
export interface FieldBinding {
  source: string;
  path: string;
  /** Applied in order to the value read (mirror of model::DataFilter). */
  filters?: DataFilter[];
  /** Sorts a list of the source before the path reads it. */
  sort?: DataSort;
  /** Table pipeline (compiled from the Data canvas): the list read as rows, then the steps. */
  list?: string;
  steps?: DataStep[];
}

/** A step of the table pipeline (mirror of model::DataStep). */
export type DataStep =
  | { type: 'filter'; where: Condition[]; any?: boolean; from: number; count: number; columns: string[] }
  | { type: 'sort'; keys: SortKey[] }
  | { type: 'transform'; columns: string[]; ops: DataFilter[] };

export type CondOp = 'eq' | 'ne' | 'contains' | 'notContains' | 'startsWith' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'notEmpty';
export interface Condition {
  column: string;
  op: CondOp;
  value: string;
}
export interface SortKey {
  column: string;
  descending?: boolean;
  numeric?: boolean;
}

/** How the graphic on air goes from one row of a data set to the next. */
export type RowChange = 'outIn' | 'fade' | 'cut';

/** Rows the operator steps through (mirror of model::DataSet); compiled from a Data set node. */
export interface DataSet {
  key: string;
  name: string;
  source: string;
  list: string;
  steps?: DataStep[];
  change?: RowChange;
}

/** Data keys of a data set: its row, its number of rows, each column of the current row. */
export const rowKey = (key: string) => `${key}__row`;
export const countKey = (key: string) => `${key}__count`;
export const columnKey = (key: string, column: string) => `${key}_${column.replace(/[^A-Za-z0-9]/g, '_')}`;

/** A node of the Data canvas graph: a source's list, a step, or a data set. */
export type FlowNode = { id: string; x: number; y: number } & ({ type: 'source'; source: string; list: string } | DataStep | { type: 'dataset'; key: string; name: string; change: RowChange });
/** The Data canvas graph; an edge goes to a node id or to `field:<key>`. */
export interface DataFlow {
  nodes: FlowNode[];
  edges: { from: string; to: string }[];
}

/** Sorts the list at `list` (dotted keys, "" = the root) by `by` (mirror of model::DataSort). */
export interface DataSort {
  list: string;
  by: string;
  descending?: boolean;
  numeric?: boolean;
}

export type FilterOp = 'add' | 'sub' | 'mul' | 'div';

export type DataFilter =
  | { type: 'upper' }
  | { type: 'lower' }
  | { type: 'capitalize' }
  | { type: 'trim' }
  | { type: 'prefix'; text: string }
  | { type: 'suffix'; text: string }
  | { type: 'replace'; find: string; with: string }
  | { type: 'truncate'; max: number }
  | { type: 'lines'; from: number; count: number }
  | { type: 'join'; separator: string }
  | { type: 'number'; decimals: number; grouping: boolean }
  | { type: 'math'; op: FilterOp; value: number }
  | { type: 'default'; text: string }
  | { type: 'map'; when: string; then: string };

export type DataSourceKind =
  | { type: 'json'; url: string; headers?: Record<string, string> }
  | { type: 'csv'; url: string; header?: boolean }
  | { type: 'rss'; url: string }
  | { type: 'xml'; url: string; headers?: Record<string, string> }
  | { type: 'push'; format?: 'json' | 'csv' | 'xml' };

export type DataSource = DataSourceKind & {
  id: string;
  name: string;
  /** Seconds between fetches. */
  interval: number;
  enabled: boolean;
};

export interface DataStatus {
  updatedAt?: number | null;
  checkedAt?: number | null;
  error?: string | null;
  bytes?: number;
}

export type DataSourceInfo = DataSource & DataStatus;

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
  /** The Data canvas graph; the fields' bindings and the data sets are compiled from it. */
  dataflow?: DataFlow;
  datasets?: DataSet[];
  /** Published revision (0: never published). */
  revision?: number;
  /** Marker model (MARKER_MODEL); older templates are converted by the server. */
  markerModel?: number;
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
  /** When bound fields read their source (default: live). */
  read?: ReadMode;
}

/** `live`: on take and on every change of the source; `take`: once, on take; `manual`: when the operator asks. */
export type ReadMode = 'live' | 'take' | 'manual';

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
  /** Designer drafts not yet published (the operator uses `templates`). */
  drafts?: Template[];
  /** Designer aids (mirror of model::Guides). */
  guides?: Guides;
}

/** Guides, safe areas and areas to keep clear; fractions of the picture (0..1). */
export interface Guides {
  vertical: number[];
  horizontal: number[];
  actionSafe: number;
  titleSafe: number;
  /** Safe areas placed by hand (instead of the margins). */
  actionArea?: Area;
  titleArea?: Area;
  exclusions: Exclusion[];
}

export interface Exclusion {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Playlist {
  id: string;
  name: string;
}

export type Phase = 'playing' | 'holding' | 'out' | 'outHold';

export interface PlayoutItem {
  templateId: string;
  data: Record<string, string>;
  frame: number;
  target: number;
  phase: Phase;
  rundownId?: string | null;
  /** Project frames since the take (keeps counting while holding). */
  age?: number;
  /** Frames spent holding at the current stop. */
  held?: number;
  /** Waiting for this graphic to finish going out (sequential zones). */
  next?: { templateId: string; data: Record<string, string>; rundownId?: string | null; target: number } | null;
  /** Widgets started, paused or reset by the operator, by layer id. */
  clocks?: Record<string, LayerClock>;
}

/** Own time of a widget layer, in frames on air. */
export interface LayerClock {
  offset: number;
  pausedAt?: number | null;
}

export type WidgetControl = 'start' | 'pause' | 'toggle' | 'reset' | 'restart';

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
  | ({ action: 'widget'; target: string; control: WidgetControl } & Target)
  /** Another row of a data set of the graphic on air (1 = first). */
  | ({ action: 'row'; dataset: string; row: number } & Target)
  | ({ action: 'clear' } & Target)
  | { action: 'trigger'; name: string };

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
  /** Template shown on the card. */
  cover?: string;
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

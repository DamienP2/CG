// Map: geometry and logic shared by the drawing, the inspector and the
// Operator. Mirror of crates/cg-core/src/wid/map.rs (projections, key view
// transitions, routes, zones); the data is the same map_world.json.
import worldRaw from '../../../crates/cg-core/src/wid/map_world.json?raw';
import { interpolateText } from '../engine/evaluate';
import type { Data } from '../engine/types';

export type Ll = [number, number];
export interface Region {
  id: string;
  name: string;
  lon: number;
  lat: number;
  ring: Ll[];
}
/** name, lat, lon, importance, min zoom, kind */
export type Place = [string, number, number, number, number, string];
export interface World {
  land: Ll[][];
  lakes: Ll[][];
  borders: Ll[][];
  roads: Ll[][];
  regions: Region[];
  places: Place[];
  paris: { urban: Ll[]; parks: Ll[][]; seine: Ll[]; canal: Ll[]; peri: Ll[]; motorways: Ll[][]; streets: Ll[][]; stands: Ll[]; bowl: Ll[]; pitch: Ll[]; lines: Ll[]; halfway: Ll[]; circle: Ll[] };
}
let parsed: World | null = null;
export const world = (): World => (parsed ??= JSON.parse(worldRaw as string) as World);

// ------------------------------------------------------------- settings --

export type Projection = 'mercator' | 'equalearth' | 'equirect';
export interface View {
  lat: number;
  lon: number;
  zoom: number;
  rot: number;
  tilt: number;
}
export interface KeyView extends Partial<View> {
  name?: string;
}
export type Icon = 'pin' | 'dot' | 'star' | 'stadium' | 'plane';
export interface Marker {
  id?: string;
  on?: boolean;
  name?: string;
  lat?: string | number;
  lon?: string | number;
  icon?: Icon;
  color?: string;
}
export interface Route {
  id?: string;
  on?: boolean;
  name?: string;
  path?: string;
  color?: string;
  dur?: number;
}
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export interface Config {
  style?: 'vector' | 'satellite' | 'mono';
  colors?: { water?: string; land?: string; border?: string; road?: string };
  showBorders?: boolean;
  showRoads?: boolean;
  graticule?: boolean;
  radius?: number;
  projection?: Projection;
  view?: Partial<View>;
  views?: KeyView[];
  transition?: { dur?: number; ease?: 'linear' | 'inout' | 'out' | 'in' | 'sine'; fly?: boolean; flyAmt?: number };
  layers?: { markers?: boolean; routes?: boolean; zones?: boolean; labels?: boolean };
  markers?: Marker[];
  mkSize?: number;
  routes?: Route[];
  curve?: 'gc' | 'straight';
  routeW?: number;
  planeHead?: boolean;
  zones?: { mode?: 'category' | 'scale'; rows?: string[][]; categories?: { name?: string; color?: string }[]; scale?: { v?: number; color?: string }[]; unit?: string; title?: string; opacity?: number; legend?: boolean; legendPos?: Corner };
  labels?: { cities?: boolean; countries?: boolean; minImp?: number; size?: number; collide?: boolean; pad?: number; showHidden?: boolean };
  attribution?: { provider?: 'own' | 'osm' | 'sat'; pos?: Corner; style?: 'dark' | 'light' | 'minimal'; show?: boolean };
  /** Designer only: dragging on the stage pans the map. */
  dragPans?: boolean;
}
export interface State {
  cur?: number | null;
  from?: View | null;
  at?: number;
  layers?: Record<string, boolean>;
  markers?: Record<string, boolean>;
  routesOn?: Record<string, boolean>;
  routes?: Record<string, number>;
  highlight?: string;
}

export const STYLES = {
  vector: { water: '#0b1a3a', land: '#26365a', border: '#9aa6d6', road: '#f5a524' },
  satellite: { water: '#06202e', land: '#41562f', border: '#e7e2c9', road: '#d6c8a0' },
  mono: { water: '#101217', land: '#2c3039', border: '#6b7181', road: '#9ca3af' },
};
export const PROVIDERS = {
  own: { name: 'Pulse vector data (own)', text: 'Map data: Pulse CG', required: false },
  osm: { name: 'OpenStreetMap (ODbL)', text: '© OpenStreetMap contributors', required: true },
  sat: { name: 'Satellite imagery (licensed)', text: 'Imagery © licensed provider', required: true },
};
export const DEFAULT_VIEWS: Required<KeyView>[] = [
  { name: 'World', lat: 25, lon: 10, zoom: 2.65, rot: 0, tilt: 0 },
  { name: 'France', lat: 46.45, lon: 2.6, zoom: 6.25, rot: 0, tilt: 0 },
  { name: 'Paris', lat: 48.868, lon: 2.335, zoom: 12.5, rot: 0, tilt: 0 },
  { name: 'Stadium', lat: 48.9245, lon: 2.3602, zoom: 17.1, rot: -14, tilt: 40 },
];
const DEFAULT_MARKERS: Marker[] = [
  { id: '', on: true, name: 'Stade de France', lat: '48.9245', lon: '2.3602', icon: 'stadium', color: '#22c55e' },
  { id: '', on: true, name: 'Team hotel', lat: '48.8738', lon: '2.295', icon: 'pin', color: '#ff3b5c' },
  { id: '', on: true, name: 'Lyon', lat: '45.764', lon: '4.8357', icon: 'dot', color: '#a594ff' },
  { id: '', on: true, name: 'Marseille', lat: '43.2965', lon: '5.3698', icon: 'dot', color: '#a594ff' },
  { id: '', on: true, name: 'Tokyo 2026 HQ', lat: '35.6762', lon: '139.6503', icon: 'star', color: '#facc15' },
];
const DEFAULT_ROUTES: Route[] = [
  { id: '', on: true, name: 'Team coach', path: 'Lyon > Paris', color: '#22c55e', dur: 3 },
  { id: '', on: true, name: 'World tour', path: 'Paris > Los Angeles > Tokyo', color: '#ff3b5c', dur: 5 },
];
export const ELECTION = {
  mode: 'category' as const,
  title: 'Regional vote · leader',
  unit: '°C',
  rows: [
    ['Region', 'Winner', '%'],
    ['Hauts-de-France', 'Red Union', '38 %'],
    ['Normandie', 'Blue Alliance', '33 %'],
    ['Île-de-France', 'Centre Now', '34 %'],
    ['Grand Est', 'Blue Alliance', '36 %'],
    ['Bretagne', 'Green Wave', '31 %'],
    ['Pays de la Loire', 'Centre Now', '35 %'],
    ['Centre-Val de Loire', 'Blue Alliance', '32 %'],
    ['Bourgogne-Franche-Comté', 'Red Union', '30 %'],
    ['Nouvelle-Aquitaine', 'Green Wave', '34 %'],
    ['Auvergne-Rhône-Alpes', 'Centre Now', '33 %'],
    ['Occitanie', 'Red Union', '37 %'],
    ["Provence-Alpes-Côte d'Azur", 'Blue Alliance', '41 %'],
    ['Corse', 'Blue Alliance', '39 %'],
  ],
  categories: [
    { name: 'Blue Alliance', color: '#2563eb' },
    { name: 'Red Union', color: '#e11d48' },
    { name: 'Green Wave', color: '#16a34a' },
    { name: 'Centre Now', color: '#f59e0b' },
  ],
};
export const SCALE = [
  { v: -5, color: '#3b82f6' },
  { v: 5, color: '#38bdf8' },
  { v: 12, color: '#a3e635' },
  { v: 20, color: '#facc15' },
  { v: 28, color: '#f97316' },
  { v: 36, color: '#dc2626' },
];
export const WEATHER = {
  mode: 'scale' as const,
  title: 'Temperature · °C',
  unit: '°C',
  rows: [['Region', '°C'], ...world().regions.map((r, i) => [r.name, String([11, 12, 14, 9, 13, 15, 14, 10, 18, 8, 21, 23, 22][i] ?? 15)])],
};

/** Settings with their defaults (mirrors Config::default()). */
export function cfg(c: Config) {
  return {
    style: c.style ?? 'vector',
    colors: { ...STYLES.vector, ...c.colors },
    showBorders: c.showBorders ?? true,
    showRoads: c.showRoads ?? true,
    graticule: c.graticule ?? false,
    radius: c.radius ?? 16,
    projection: c.projection ?? 'mercator',
    view: { lat: 46.45, lon: 2.6, zoom: 6.25, rot: 0, tilt: 0, ...c.view } as View,
    views: (c.views ?? DEFAULT_VIEWS).map((v) => ({ name: 'View', lat: 46.45, lon: 2.6, zoom: 6.25, rot: 0, tilt: 0, ...v })),
    transition: { dur: 2.6, ease: 'inout' as const, fly: true, flyAmt: 0.8, ...c.transition },
    layers: { markers: true, routes: true, zones: true, labels: true, ...c.layers },
    markers: (c.markers ?? DEFAULT_MARKERS).map((m) => ({ id: '', on: true, name: 'Marker', lat: '48.8566', lon: '2.3522', icon: 'pin' as Icon, color: '#ff3b5c', ...m })),
    mkSize: c.mkSize ?? 36,
    routes: (c.routes ?? DEFAULT_ROUTES).map((r) => ({ id: '', on: true, name: 'Route', path: 'Paris > New York', color: '#38bdf8', dur: 4, ...r })),
    curve: c.curve ?? 'gc',
    routeW: c.routeW ?? 6,
    planeHead: c.planeHead ?? true,
    zones: { mode: ELECTION.mode as 'category' | 'scale', rows: ELECTION.rows, categories: ELECTION.categories, scale: SCALE, unit: '°C', title: ELECTION.title, opacity: 0.85, legend: true, legendPos: 'bl' as Corner, ...c.zones },
    labels: { cities: true, countries: true, minImp: 3, size: 24, collide: true, pad: 8, showHidden: false, ...c.labels },
    attribution: { provider: 'osm' as const, pos: 'br' as Corner, style: 'dark' as const, show: true, ...c.attribution },
    dragPans: c.dragPans ?? false,
  };
}
export type K = ReturnType<typeof cfg>;
export type MarkerK = K['markers'][number];
export type RouteK = K['routes'][number];

// ---------------------------------------------------------- projections --

const D2R = Math.PI / 180;
const MAXLAT = 85.0511;
const EE = [1.340264, -0.081106, 0.000893, 0.003796];
const EEX = (2 * Math.sqrt(3) * Math.PI) / (3 * EE[0]);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const wraps = (p: Projection) => p !== 'equalearth';

export function project(p: Projection, lon: number, lat: number): [number, number] {
  if (p === 'equalearth') {
    const l = lon * D2R;
    const th = Math.asin((Math.sqrt(3) / 2) * Math.sin(clamp(lat, -90, 90) * D2R));
    const t2 = th * th;
    const t6 = t2 * t2 * t2;
    const x = (2 * Math.sqrt(3) * l * Math.cos(th)) / (3 * (9 * EE[3] * t6 * t2 + 7 * EE[2] * t6 + 3 * EE[1] * t2 + EE[0]));
    const y = th * (EE[0] + EE[1] * t2 + t6 * (EE[2] + EE[3] * t2));
    return [0.5 + x / (2 * EEX), 0.5 - y / (2 * EEX)];
  }
  if (p === 'equirect') return [(lon + 180) / 360, 0.5 - lat / 360];
  const f = clamp(lat, -MAXLAT, MAXLAT) * D2R;
  return [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + f / 2)) / (2 * Math.PI)];
}
export function unproject(p: Projection, X: number, Y: number): [number, number] {
  if (p === 'equalearth') {
    const x = (X - 0.5) * 2 * EEX;
    const y = (0.5 - Y) * 2 * EEX;
    let th = y / EE[0];
    for (let i = 0; i < 10; i++) {
      const t2 = th * th;
      const t6 = t2 * t2 * t2;
      th -= (th * (EE[0] + EE[1] * t2 + t6 * (EE[2] + EE[3] * t2)) - y) / (EE[0] + 3 * EE[1] * t2 + 7 * EE[2] * t6 + 9 * EE[3] * t6 * t2);
    }
    th = clamp(th, -Math.PI / 3, Math.PI / 3);
    const t2 = th * th;
    const t6 = t2 * t2 * t2;
    const lat = Math.asin(clamp((2 * Math.sin(th)) / Math.sqrt(3), -1, 1)) / D2R;
    const lon = (3 * x * (9 * EE[3] * t6 * t2 + 7 * EE[2] * t6 + 3 * EE[1] * t2 + EE[0])) / (2 * Math.sqrt(3) * Math.cos(th)) / D2R;
    return [clamp(lon, -180, 180), lat];
  }
  const lon = X * 360 - 180;
  if (p === 'equirect') return [lon, clamp((0.5 - Y) * 360, -90, 90)];
  return [lon, Math.atan(Math.sinh((0.5 - Y) * 2 * Math.PI)) / D2R];
}
export const normLon = (l: number) => ((((l + 180) % 360) + 360) % 360) - 180;
export const validLL = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export function clampView(v: View): View {
  return {
    lat: Number.isFinite(v.lat) ? clamp(v.lat, -85, 85) : 0,
    lon: Number.isFinite(v.lon) ? normLon(v.lon) : 0,
    zoom: Number.isFinite(v.zoom) ? clamp(v.zoom, 1.5, 18) : 2,
    rot: Number.isFinite(v.rot) ? v.rot : 0,
    tilt: Number.isFinite(v.tilt) ? clamp(v.tilt, 0, 60) : 0,
  };
}
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const EASE = { linear: (k: number) => k, inout: easeInOut, out: (k: number) => 1 - Math.pow(1 - k, 3), in: (k: number) => k * k * k, sine: (k: number) => (1 - Math.cos(Math.PI * k)) / 2 };

export function interpolate(k: K, a: View, b: View, t: number, boxW: number): View {
  const e = (EASE[k.transition.ease] ?? easeInOut)(clamp(t, 0, 1));
  const p = k.projection;
  const [x0, y0] = project(p, a.lon, a.lat);
  const [x1, y1] = project(p, b.lon, b.lat);
  let dx = x1 - x0;
  if (wraps(p)) dx -= Math.round(dx);
  const dy = y1 - y0;
  let x = x0 + dx * e;
  if (wraps(p)) x -= Math.floor(x);
  const [lon, lat] = unproject(p, x, y0 + dy * e);
  let zoom = a.zoom + (b.zoom - a.zoom) * e;
  if (k.transition.fly) {
    const dist = Math.hypot(dx, dy);
    const zFit = Math.log2((0.55 * Math.max(1, boxW)) / Math.max(1e-9, dist * 256));
    const dip = Math.max(0, (a.zoom + b.zoom) / 2 - zFit) * k.transition.flyAmt;
    zoom -= dip * Math.sin(Math.PI * e);
  }
  let dr = b.rot - a.rot;
  dr -= 360 * Math.round(dr / 360);
  return { lat, lon: normLon(lon), zoom: clamp(zoom, 1.5, 18), rot: a.rot + dr * e, tilt: a.tilt + (b.tilt - a.tilt) * e };
}

/** The view at `now` and the transition's progress (null = still), mirrors view_at. */
export function viewAt(k: K, s: State, now: number, boxW: number): [View, number | null] {
  const kv = s.cur != null ? k.views[s.cur] : undefined;
  const to = clampView(kv ? (kv as View) : k.view);
  if (!s.from) return [to, null];
  const dur = k.transition.dur * 1000;
  if (!(dur > 0)) return [to, null];
  const t = (now - (s.at ?? 0)) / dur;
  if (t >= 1) return [to, null];
  return [interpolate(k, clampView(s.from), to, Math.max(0, t), boxW), Math.max(0, t)];
}

export const layerOn = (k: K, s: State, name: keyof K['layers']) => s.layers?.[name] ?? k.layers[name];
export const keyOf = (m: { id: string; name: string }) => (m.id.trim() ? m.id : m.name);
export const markerOn = (s: State, m: MarkerK) => s.markers?.[keyOf(m)] ?? m.on;
export const routeOn = (s: State, r: RouteK) => s.routesOn?.[keyOf(r)] ?? r.on;

/** (lat, lon) of a marker when valid. */
export function markerPos(m: MarkerK, data: Data): [number, number] | null {
  const la = interpolateText(String(m.lat ?? ''), data).trim();
  const lo = interpolateText(String(m.lon ?? ''), data).trim();
  if (!la || !lo) return null;
  const lat = Number(la);
  const lon = Number(lo);
  return validLL(lat, lon) ? [lat, lon] : null;
}

// --------------------------------------------------------------- routes --

export function place(name: string): [number, number] | null {
  const n = name.trim().toLowerCase();
  const p = world().places.find((x) => x[5] !== 'continent' && x[0].toLowerCase() === n);
  return p ? [p[1], p[2]] : null;
}
export function waypoints(path: string): [[number, number][], string[]] {
  const out: [number, number][] = [];
  const bad: string[] = [];
  for (const w of String(path ?? '')
    .split(/[>→]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const parts = w.split(/[,\s]+/).filter(Boolean);
    let ll: [number, number] | null = null;
    if (parts.length === 2 && parts.every((x) => x !== '' && Number.isFinite(Number(x)))) {
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      if (validLL(a, b)) ll = [a, b];
    }
    ll ??= place(w);
    if (ll) out.push(ll);
    else bad.push(w);
  }
  return [out, bad];
}
const routeMemo = new Map<string, [[number, number][], string[]]>();
/** (lat, lon) points, longitudes unwrapped (a leg across 180° continues past it). */
export function routeLine(path: string, curve: string): [[number, number][], string[]] {
  const key = `${path}|${curve}`;
  const m = routeMemo.get(key);
  if (m) return m;
  const [wp, bad] = waypoints(path);
  const line: [number, number][] = [];
  const v = (la: number, lo: number) => [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)];
  for (let i = 0; i + 1 < wp.length; i++) {
    const [la1, lo1] = wp[i];
    const [la2, lo2] = wp[i + 1];
    const a = v(la1, lo1);
    const b = v(la2, lo2);
    const om = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
    const n = Math.max(8, Math.ceil(om / D2R / 1.5));
    for (let j = i ? 1 : 0; j <= n; j++) {
      const f = j / n;
      let la: number, lo: number;
      if (curve === 'straight' || om < 1e-6) {
        let dl = lo2 - lo1;
        dl -= 360 * Math.round(dl / 360);
        la = la1 + (la2 - la1) * f;
        lo = lo1 + dl * f;
      } else {
        const A = Math.sin((1 - f) * om) / Math.sin(om);
        const B = Math.sin(f * om) / Math.sin(om);
        const q = [A * a[0] + B * b[0], A * a[1] + B * b[1], A * a[2] + B * b[2]];
        la = Math.atan2(q[2], Math.hypot(q[0], q[1])) / D2R;
        lo = Math.atan2(q[1], q[0]) / D2R;
      }
      if (line.length) {
        const pl = line[line.length - 1][1];
        lo = pl + (((((lo - pl + 180) % 360) + 360) % 360) - 180);
      }
      line.push([la, lo]);
    }
  }
  const out: [[number, number][], string[]] = [line, bad];
  if (routeMemo.size > 200) routeMemo.clear();
  routeMemo.set(key, out);
  return out;
}
export function routeProgress(s: State, r: RouteK, now: number) {
  const at = s.routes?.[keyOf(r)];
  return at == null ? 1 : easeInOut(clamp((now - at) / (Math.max(0.1, r.dur) * 1000), 0, 1));
}

// ---------------------------------------------------------------- zones --

export const norm = (x: string) =>
  String(x ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
export function regionOf(name: string): Region | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return world().regions.find((r) => norm(r.name) === n || r.id === n);
}
export function hexMix(a: string, b: string, k: number) {
  const p = (s: string) => {
    const v = parseInt(String(s).trim().replace(/^#/, '').slice(0, 6), 16) || 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const pa = p(a);
  const pb = p(b);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(clamp(pa[i] + (pb[i] - pa[i]) * k, 0, 255))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
export function scaleColor(stops: { v?: number; color?: string }[], v: number) {
  if (!stops.length) return '#94a3b8';
  const sv = (i: number) => Number(stops[i].v ?? 0);
  const sc = (i: number) => String(stops[i].color ?? '#ffffff');
  if (v <= sv(0)) return sc(0);
  for (let i = 1; i < stops.length; i++)
    if (v <= sv(i)) {
      const span = sv(i) - sv(i - 1);
      return hexMix(sc(i - 1), sc(i), span > 0 ? (v - sv(i - 1)) / span : 1);
    }
  return sc(stops.length - 1);
}
export interface ZoneFill {
  color: string;
  text: string;
}
export function zoneFills(z: K['zones'], data: Data): [Record<string, ZoneFill>, string[]] {
  const out: Record<string, ZoneFill> = {};
  const unmatched: string[] = [];
  for (const r of (z.rows ?? []).slice(1)) {
    const cell = (i: number) => interpolateText(String(r[i] ?? ''), data);
    const name = cell(0);
    const value = cell(1);
    if (!name.trim()) continue;
    const reg = regionOf(name);
    if (!reg) {
      unmatched.push(name);
      continue;
    }
    const details = r
      .slice(2)
      .map((_, j) => cell(j + 2))
      .filter((x) => x.trim());
    if (z.mode === 'scale') {
      const v = Number(value.trim().replace(',', '.'));
      if (value.trim() === '' || !Number.isFinite(v)) out[reg.id] = { color: '#94a3b8', text: 'no data' };
      else out[reg.id] = { color: scaleColor(z.scale, v), text: [`${value.trim()} ${z.unit}`.trim(), ...details].join(' ') };
    } else {
      const n = norm(value);
      const c = z.categories.find((x) => norm(x.name ?? '') === n);
      out[reg.id] = { color: c?.color ?? '#94a3b8', text: [value.trim(), ...details].join(' ') };
    }
  }
  return [out, unmatched];
}

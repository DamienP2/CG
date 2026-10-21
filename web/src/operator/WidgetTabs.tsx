import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, useApp } from '../store';
import { isTimed } from '../engine/widgets';
import { widgetOf } from '../widgets';
import { oneKey, rowKey, usedDatasets, type DataSet, type Field, type Layer, type LayerClock, type Template } from '../engine/types';
import { datasetUse } from './DataSets';
import { exposedFields, type ExposedLayer } from './Exposed';
import { t, tc } from '../i18n';

/*
 * The graphic selected in the Operator, widget by widget (one tab each): its
 * values (Content), what feeds it (Data), and its internal controls, which
 * drive the preview only (the ones on air are in the On air panel).
 */

/** What one widget (layer) of a template gives the operator. */
export interface WidgetPart {
  layer: Layer;
  /** Values only it uses (texts, pictures, a table's rows…). */
  fields: Field[];
  /** Its properties exposed in the Designer. */
  exposed?: ExposedLayer;
  /** Data sets it reads. */
  datasets: DataSet[];
  /** It shows a data set feeding Texts (a Text reading it). */
  fed: DataSet[];
  /** Fields of it read from a data source. */
  bound: Field[];
  /** Internal controls (start / pause, pages, scores…). */
  controls: boolean;
}

export interface Parts {
  /** Values used by several widgets, or by none (the template's own variables). */
  shared: Field[];
  widgets: WidgetPart[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The widget has controls: its own (spec widgets) or start / pause (timed layers). */
export function hasControls(l: Layer): boolean {
  const def = widgetOf(l.type);
  if (def?.Operator) {
    // A picture has controls only as a sequence of frames.
    if (l.type === 'image') return Array.isArray((l as unknown as { frames?: unknown[] }).frames) && !!(l as unknown as { frames: unknown[] }).frames.length;
    return true;
  }
  return isTimed(l) && l.type !== 'text';
}

const partsCache = new WeakMap<Template, Parts>();
/** Splits a template's values, data and controls by widget. */
export function widgetParts(tpl: Template): Parts {
  const hit = partsCache.get(tpl);
  if (hit) return hit;
  const layers = tpl.layers.filter((l) => l.visible !== false);
  const { content, layers: exposed } = exposedFields(tpl.fields, tpl.layers);
  const json = new Map(layers.map((l) => [l.id, JSON.stringify(l)]));
  const users = (f: Field) =>
    layers.filter((l) => {
      if (Object.values(l.bindings ?? {}).includes(f.key) || Object.values(l.settingBindings ?? {}).includes(f.key)) return true;
      return new RegExp(`\\{\\{\\s*${esc(f.key)}\\s*\\}\\}`).test(json.get(l.id)!);
    });
  const parts = new Map<string, WidgetPart>();
  const part = (l: Layer) => {
    let p = parts.get(l.id);
    if (!p) parts.set(l.id, (p = { layer: l, fields: [], datasets: [], fed: [], bound: [], controls: hasControls(l) }));
    return p;
  };
  const shared: Field[] = [];
  for (const f of content) {
    const u = users(f);
    if (u.length === 1) {
      const p = part(u[0]);
      p.fields.push(f);
      if (f.binding?.source) p.bound.push(f);
    } else shared.push(f);
  }
  for (const e of exposed) {
    const p = part(e.layer);
    p.exposed = e;
    for (const f of e.at.values()) if (f.binding?.source && !p.bound.includes(f)) p.bound.push(f);
  }
  for (const ds of usedDatasets(tpl)) {
    const use = datasetUse(tpl, ds);
    for (const l of layers) {
      if (!json.get(l.id)!.includes(`${ds.key}_`)) continue;
      const p = part(l);
      p.datasets.push(ds);
      if (use.source && use.texts.some((x) => x.id === l.id)) p.fed.push(ds);
    }
  }
  for (const l of layers) if (hasControls(l)) part(l);
  // In the order of the layers.
  const widgets = layers.map((l) => parts.get(l.id)).filter((p): p is WidgetPart => !!p);
  const out = { shared, widgets };
  partsCache.set(tpl, out);
  return out;
}

/** The keys Update sends that belong to a widget: its values, and the row it shows of a data set feeding Texts. */
export function partKeys(tpl: Template, p: Pick<WidgetPart, 'fields' | 'exposed' | 'fed'>): string[] {
  return [...p.fields.map((f) => f.key), ...[...(p.exposed?.at.values() ?? [])].map((f) => f.key), ...p.fed.flatMap((d) => (datasetUse(tpl, d).source ? [rowKey(d.key), oneKey(d.key)] : []))];
}

/** Keys whose value Update would change on air. */
export function changedKeys(sent: Record<string, string>, air: Record<string, string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!air) return out;
  for (const [k, v] of Object.entries(sent)) if ((air[k] ?? '') !== (v ?? '')) out.add(k);
  return out;
}

// ------------------------------------------------------- preview controls --

/** Widget states and clocks of the preview: what its controls changed, nothing on air. */
export interface PreviewRun {
  /** A control was used: the preview runs on from `since`. */
  active: boolean;
  /** Client time (ms) the preview runs from. */
  since: number;
  widgets: Record<string, unknown>;
  /** Clocks of the timed layers, in frames of preview age (as LayerClock on air). */
  clocks: Record<string, LayerClock>;
}

export const newPreviewRun = (): PreviewRun => ({ active: false, since: Date.now(), widgets: {}, clocks: {} });

/** start / pause… of a timed layer, as the server does it on air (PlayoutItem::control). */
export function controlClock(run: PreviewRun, l: Layer, control: 'toggle' | 'reset' | 'restart', ageFrames: number): PreviewRun {
  const c = { ...(run.clocks[l.id] ?? (l.manualStart ? { offset: ageFrames, pausedAt: ageFrames } : { offset: 0 })) };
  const running = c.pausedAt == null;
  if (control === 'toggle') {
    if (running) c.pausedAt = ageFrames;
    else {
      c.offset += ageFrames - (c.pausedAt ?? ageFrames);
      c.pausedAt = null;
    }
  } else if (control === 'reset') {
    c.offset = ageFrames;
    if (!running) c.pausedAt = ageFrames;
  } else {
    c.offset = ageFrames;
    c.pausedAt = null;
  }
  return { ...run, clocks: { ...run.clocks, [l.id]: c } };
}

/** The controls of one widget, driving the preview only. */
export function PreviewControls({ layer, run, setRun, data, fps, ageSecs }: { layer: Layer; run: PreviewRun; setRun: (f: (r: PreviewRun) => PreviewRun) => void; data: Record<string, string>; fps: number; ageSecs: () => number }) {
  const def = widgetOf(layer.type);
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  const toast = useApp((s) => s.toast);
  // The widget's own controls (they re-render with time, like on air).
  const [, tick] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const h = setInterval(() => tick((n) => n + 1), 500);
    return () => {
      live.current = false;
      clearInterval(h);
    };
  }, []);
  const Op = def?.Operator;
  if (Op) {
    const act = async (op: string, args?: unknown) => {
      try {
        const state = await api('POST', '/api/widgets/act', { layer, state: run.widgets[layer.id] ?? null, op, args: args ?? null, data, ageSecs: ageSecs() });
        if (live.current) setRun((r) => ({ ...r, widgets: { ...r.widgets, [layer.id]: state } }));
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    };
    return (
      <div className="opx-pvctl">
        <Op layer={layer as never} state={run.widgets[layer.id]} data={data} act={act} time={{ nowMs: Date.now() + offset, ageSecs: ageSecs(), defaultTz: tz, fps }} />
      </div>
    );
  }
  const c = run.clocks[layer.id];
  const running = c ? c.pausedAt == null : !layer.manualStart;
  const age = ageSecs() * fps;
  return (
    <div className="opx-pvctl clock">
      <button className={`opx-sq ${running ? '' : 'green'}`} title={running ? t('Pause') : tc('action', 'Start')} onClick={() => setRun((r) => controlClock(r, layer, 'toggle', age))}>
        {running ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
      </button>
      <button className="opx-sq" title={t('Back to the start')} onClick={() => setRun((r) => controlClock(r, layer, running ? 'restart' : 'reset', age))}>
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

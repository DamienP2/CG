import { BookMarked, BoxSelect, ChevronDown, ChevronRight, ClipboardPaste, Copy, Database, Link2, Plus, Search, Sparkles, Star, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { holdFrame, interpolateText, newId, resolveLayer, toHex } from '../engine/evaluate';
import { accepts, clockAt, fromPortOf, measureLayer, metricOf, nodeValues, portsOf, rowType, type LVal, type Port, type PortType } from '../engine/logic';
import { exprError, names, parse } from '../engine/expr';
import { COLOR_PROPS, type Color, type Layer, type Logic, type LogicClip, type LogicEdge, type LogicFlow, type LogicFrame, type LogicNode, type Prop, type PropSet, type Template, type TriggerEvent } from '../engine/types';
import { CanvasHeader, CanvasVoid } from '../ui/CanvasHeader';
import { Dropdown } from '../ui/Dropdown';
import { HexColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { can, useApp } from '../store';
import { useLogicFlows } from '../logicFlows';
import { InsertModal, needsOf, PresetsModal, SaveFlowModal, type Needs } from './logicLibrary';
import { DC_MADE, useDataLayer } from './DataCanvas';
import { key as modKey } from './ClipboardMenu';
import { useBoundData } from '../data/dataStore';
import { settingDefaults } from '../engine/settings';
import { settingLabel } from '../engine/settingPorts';
import { autoLayout, measureNodes } from '../ui/autoLayout';
import { freeInView, freeSpot, ResizeCorner, useCanvasView } from '../ui/canvasView';
import { useDesigner } from './designerStore';
import { useProjectLogic } from './projectLogic';
import { HowBody, howOf } from './logicHow';
import { PlaySoundBody, StopSoundBody } from './logicSound';
import { hasMoments, lineFor, momentsOf, needsSteps, needsValue, sourceOf, subjectsOf, testsOf, toSteps } from './logicSteps';
import type { StoreApi, UseBoundStore } from 'zustand';
import { t, tc } from '../i18n';
import { displayPref, setDisplayPref } from '../displayPrefs';
import { entries, FAMS, isProjectLogic, kindOf, layerNode, propsOf, rowLabel, rowsFor, scrollLayer, timedLayer, timerLayer, varNames, videoLayer, type Entry, type Fam } from './logicNodes';

/*
 * The Logic canvas. Every node has its inputs on the left and its outputs on the right; value
 * wires take the colour of what they carry, flow wires ▶ are white. Nodes are gathered in
 * dashed frames (one per function): switched off, folded, copied. The palette filters by name,
 * by what serves in this template, by favourite and by the type of port; a wire dropped in the
 * void offers the nodes that take it. Values update live at the playhead with the preview data;
 * the same graph runs in the Rust renderer, and its flows on air in the server.
 */

const NODE_W = 210;
const WIDE = new Set(['expr', 'if', 'lookup', 'layer', 'check', 'when', 'how', 'animate', 'playSound']);
const FRAME_COLORS = ['#8fa3ff', '#a78bfa', '#22d3ee', '#f59e0b', '#f472b6', '#4ade80', '#fb7185', '#facc15'];
const CLIP_KEY = 'strata.logic.clipboard';
const TYPES: { id: PortType; label: string }[] = [
  { id: 'flow', label: 'Flow' },
  { id: 'num', label: 'Number' },
  { id: 'text', label: 'Text' },
  { id: 'color', label: 'Colour' },
  { id: 'bool', label: 'Yes / no' },
  { id: 'img', label: 'Picture' },
  { id: 'list', label: 'List' },
];

/** A port of a node on the canvas. */
interface PortRef {
  node: string;
  port: string;
  dir: 'in' | 'out';
  type: PortType;
}

/** What is copied: nodes, the wires between them, their frames, the layers and fields they stand for. */
type Clip = LogicClip;

export const fmt = (v: LVal | undefined) => (v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(2)) : `“${v.length > 18 ? `${v.slice(0, 18)}…` : v}”`);

const isHex = (v: LVal | undefined): v is string => typeof v === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v.trim());

/** A value as a node shows it: a number, a swatch, a short text. */
function Val({ v }: { v: LVal | undefined }) {
  if (v === undefined) return null;
  if (isHex(v)) return <span className="lx-sw" style={{ background: v }} title={v} />;
  return <span className="lx-v">{fmt(v)}</span>;
}

/** The Triggers of an older template, joined to its Logic (one graph now; cg_core Template::merge_triggers). */
function mergeTriggers(tpl: Template) {
  const tr = tpl.triggers;
  if (!tr?.nodes.length) return void delete tpl.triggers;
  tpl.logic ??= { nodes: [], edges: [] };
  const taken = new Set(tpl.logic.nodes.map((n) => n.id));
  for (const n of tr.nodes) {
    if (!taken.has(n.id)) continue;
    const old = n.id;
    n.id = `${old}-t`;
    for (const e of tr.edges) {
      if (e.from === old) e.from = n.id;
      if (e.to === old) e.to = n.id;
    }
  }
  tpl.logic.nodes.push(...tr.nodes);
  tpl.logic.edges.push(...tr.edges);
  delete tpl.triggers;
}

/** An expression field: the error shows on it. */
export function ExprInput({ value, onChange, placeholder, k }: { value: string; onChange: (v: string, key?: string) => void; placeholder?: string; k: string }) {
  const err = value.trim() ? exprError(value) : undefined;
  return (
    <span className={`lx-expr ${err ? 'bad' : ''}`} title={err ? `${t('Error')} : ${err}` : undefined}>
      <TextInput value={value} placeholder={placeholder} onChange={(v) => onChange(v, k)} />
    </span>
  );
}

/** A branch value: a colour gets a swatch next to the expression. */
function BranchValue({ value, onChange, k }: { value: string; onChange: (v: string, key?: string) => void; k: string }) {
  const m = /^\s*"(#[0-9a-f]{6}(?:[0-9a-f]{2})?)"\s*$/i.exec(value);
  return (
    <span className="lx-bval">
      {m && <HexColorField compact value={m[1]} onChange={(hex) => onChange(`"${hex}"`, `${k}-c`)} />}
      <ExprInput value={value} onChange={onChange} k={k} placeholder={t('value')} />
    </span>
  );
}

/** « On air »: the graphic watched, how long its presence glides (s), its value in the Designer. */
function OnAirBody({ n, template, set }: { n: Extract<LogicNode, { type: 'onAir' }>; template: Template; set: (patch: Partial<LogicNode>, key?: string) => void }) {
  const project = useApp((s) => s.project);
  return (
    <>
      <Dropdown value={n.template} placeholder={t('Choose a graphic')} options={(project?.templates ?? []).filter((x) => x.id !== template.id).map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => set({ template: id } as Partial<LogicNode>)} />
      <label className="lx-field">
        <span>{t('Transition')}</span>
        <NumberField value={n.transition ?? 0} min={0} max={10} step={0.1} precision={1} suffix="s" onChange={(v) => set({ transition: Math.max(0, v) } as Partial<LogicNode>, `lx-${n.id}-tr`)} />
      </label>
      <label className="lx-field">
        <span>{tc('logic', 'Try')}</span>
        <Segmented
          value={n.test ? '1' : '0'}
          onChange={(v) => set({ test: v === '1' } as Partial<LogicNode>)}
          options={[
            { value: '0', label: t('No') },
            { value: '1', label: t('Yes') },
          ]}
        />
      </label>
    </>
  );
}

/** What an event node watches: its layer, data set, value or graphic, and its settings. */
function EventBody({ n, template, set }: { n: Extract<LogicNode, { type: 'event' }>; template: Template; set: (on: TriggerEvent, key?: string) => void }) {
  const project = useApp((s) => s.project);
  const on = n.on;
  const layers = (f: (l: Layer) => boolean) => template.layers.filter(f).map((l) => ({ value: l.id, label: l.name }));
  const fields = template.fields.map((f) => ({ value: f.key, label: f.label || f.key }));
  switch (on.kind) {
    case 'scrollEnd': {
      const ticker = template.layers.find((l) => l.id === on.layer)?.type === 'ticker';
      return (
        <>
          <Dropdown value={on.layer} placeholder={t('Choose a layer')} options={layers(scrollLayer)} onChange={(layer) => set({ ...on, layer, passes: template.layers.find((l) => l.id === layer)?.type === 'ticker' ? (on.passes ?? 1) : undefined })} />
          {ticker && (
            <label className="lx-field">
              <span>{t('Passes')}</span>
              <NumberField value={on.passes ?? 1} min={1} step={1} onChange={(v) => set({ ...on, passes: Math.max(1, Math.round(v)) }, `lx-${n.id}-p`)} />
            </label>
          )}
        </>
      );
    }
    case 'timerZero':
    case 'timerAt':
      return (
        <>
          <Dropdown value={on.layer} placeholder={t('Choose a layer')} options={layers(timerLayer)} onChange={(layer) => set({ ...on, layer })} />
          <Segmented
            value={on.kind}
            onChange={(k) => set(k === 'timerAt' ? { kind: 'timerAt', layer: on.layer, seconds: 10 } : { kind: 'timerZero', layer: on.layer })}
            options={[
              { value: 'timerZero', label: t('At zero') },
              { value: 'timerAt', label: t('At a time') },
            ]}
          />
          {on.kind === 'timerAt' && <NumberField value={on.seconds} min={0} step={1} suffix="s" onChange={(v) => set({ ...on, seconds: Math.max(0, v) }, `lx-${n.id}-s`)} />}
        </>
      );
    case 'videoEnd':
      return <Dropdown value={on.layer} placeholder={t('Choose a layer')} options={layers(videoLayer)} onChange={(layer) => set({ ...on, layer })} />;
    case 'lastRow':
      return <Dropdown value={on.dataset} placeholder={t('Choose a data set')} options={(template.datasets ?? []).map((d) => ({ value: d.key, label: d.name }))} onChange={(dataset) => set({ ...on, dataset })} />;
    case 'dataChange':
    case 'dataIs':
      return <Dropdown value={on.key} placeholder={t('Choose a field')} options={fields} onChange={(key) => set({ kind: 'dataChange', key })} />;
    case 'graphic':
      return (
        <>
          <Dropdown value={on.template} placeholder={t('Choose a graphic')} options={(project?.templates ?? []).filter((x) => x.id !== template.id).map((x) => ({ value: x.id, label: x.name }))} onChange={(tpl) => set({ ...on, template: tpl })} />
          <Segmented
            value={on.out ? 'out' : 'in'}
            onChange={(v) => set({ ...on, out: v === 'out' || undefined })}
            options={[
              { value: 'in', label: t('Comes in') },
              { value: 'out', label: t('Goes out') },
            ]}
          />
        </>
      );
  }
}

/** The next free input name of a Calculation or an If: a, b, c… */
const nextName = (taken: string[]) => 'abcdefghijklmnopqrstuvwxyz'.split('').find((c) => !taken.includes(c)) ?? `v${taken.length + 1}`;

/** What the ports of the nodes need from the canvas. */
const PortCtx = createContext<{ wiredIn: Set<string>; wiredOut: Set<string>; startWire: (e: React.PointerEvent, ref: PortRef) => void }>({ wiredIn: new Set(), wiredOut: new Set(), startWire: () => {} });

function PortDot({ n, p, dir }: { n: LogicNode; p: Port; dir: 'in' | 'out' }) {
  const { wiredIn, wiredOut, startWire } = useContext(PortCtx);
  return (
    <span
      className={`lx-port ${dir} t-${p.type} ${(dir === 'in' ? wiredIn : wiredOut).has(`${n.id}|${p.id}`) ? 'on' : ''}`}
      data-pk={`${n.id}|${dir}|${p.id}`}
      data-node={n.id}
      data-port={p.id}
      data-dir={dir}
      data-type={p.type}
      title={p.raw ? p.label : t(p.label)}
      onPointerDown={(e) => startWire(e, { node: n.id, port: p.id, dir, type: p.type })}
    />
  );
}

/** A row of a node: an input on its left, an output on its right. */
function Row({ n, inP, outP, children, className = '' }: { n: LogicNode; inP?: Port; outP?: Port; children?: React.ReactNode; className?: string }) {
  return (
    <div className={`lx-row ${className}`}>
      {inP && <PortDot n={n} p={inP} dir="in" />}
      {children}
      {outP && <PortDot n={n} p={outP} dir="out" />}
    </div>
  );
}

/** Which entries take or give a port of this type (for the type filter and the menu of a dropped wire). */
function fits(n: LogicNode, want: { type: PortType; side: 'in' | 'out' }): Port | undefined {
  const { ins, outs } = portsOf(n);
  const list = want.side === 'in' ? ins : outs;
  const ok = (p: Port) => (want.side === 'in' ? accepts(want.type, p.type) : accepts(p.type, want.type));
  return list.find((p) => p.type === want.type && ok(p)) ?? list.find(ok);
}

/** The Logic: what the graphic draws (values, conditions) and what happens on air (events, triggers, actions, variables), one graph. */
export function LogicEditor({ onClose }: { onClose: () => void }) {
  const id = useDesigner((s) => s.template?.id);
  const project = useApp((s) => s.project);
  const projectTpl = useProjectLogic((s) => s.template);
  // No graphic selected: the project's Logic.
  useEffect(() => {
    if (!id && project && !projectTpl) useProjectLogic.getState().open(project);
  }, [id, project, projectTpl]);
  useEffect(() => () => useProjectLogic.setState({ template: null }), []);
  if (id)
    return (
      <SrcCtx.Provider value={useDesigner as unknown as LogicSource}>
        <LogicCanvas key={id} onClose={onClose} />
      </SrcCtx.Provider>
    );
  if (!projectTpl) return null;
  return (
    <SrcCtx.Provider value={useProjectLogic as unknown as LogicSource}>
      <LogicCanvas key="project" onClose={onClose} />
    </SrcCtx.Provider>
  );
}

/** Where the canvas edits: a graphic (the Designer), or the project's Logic. */
type LogicSource = UseBoundStore<
  StoreApi<{ template: Template | null; update: (recipe: (t: Template) => void, key?: string) => void; frame: number; previewData: Record<string, string>; lastCoalesce: unknown }>
>;
const SrcCtx = createContext<LogicSource>(useDesigner as unknown as LogicSource);

function LogicCanvas({ onClose }: { onClose: () => void }) {
  const src = useContext(SrcCtx);
  const { template: tpl, update, frame, previewData } = src(useShallow((s) => ({ template: s.template, update: s.update, frame: s.frame, previewData: s.previewData })));
  const template = tpl!;
  // The project's Logic: no layers, no data of its own.
  const proj = isProjectLogic(template);
  const cv = useCanvasView(`logic.${template.id}`, '.lx-node, .lx-frame, .lx-pill, .dc-node', { onArrange: () => arrange() });
  const sizesKey = `logic.sizes.${template?.id ?? ''}`;
  const [sizes, setSizesState] = useState<Record<string, number>>(() => displayPref(sizesKey, {}));
  const setSize = (id: string, w: number) =>
    setSizesState((cur) => {
      const next = { ...cur, [id]: w };
      setDisplayPref(sizesKey, next);
      return next;
    });
  const widthOf = (n: LogicNode) => sizes[n.id] ?? (WIDE.has(n.type) ? (n.type === 'if' || n.type === 'check' || n.type === 'how' || n.type === 'animate' ? 300 : 240) : NODE_W);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selFrame, setSelFrame] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: PortRef; x: number; y: number } | null>(null);
  const [quick, setQuick] = useState<{ sx: number; sy: number; wx: number; wy: number; from: PortRef } | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  // Palette filters.
  const [search, setSearch] = useState('');
  const [qSearch, setQSearch] = useState('');
  const [scope, setScope] = useState<'here' | 'all' | 'fav'>(() => displayPref('logic.scope', 'here'));
  const [typeFilter, setTypeFilter] = useState<PortType | null>(null);
  const [favs, setFavs] = useState<string[]>(() => displayPref('logic.favs', []));
  const [folded, setFolded] = useState<string[]>(() => displayPref('logic.folded', []));
  const [modal, setModal] = useState<{ kind: 'presets' } | { kind: 'save'; name: string } | { kind: 'insert'; clip: Clip; name: string; needs: Needs; framed: boolean } | null>(null);
  const user = useApp((s) => s.auth?.user);
  const projectId = useApp((s) => s.project?.id);
  const projectFlows = useApp((s) => s.project?.logicFlows) ?? [];
  // The shared playlists only (a personal one is played by hand by its author).
  const projectLists = useApp(useShallow((s) => s.project?.playlists.filter((l) => !l.owner)));
  const toast = useApp((s) => s.toast);
  const shared = useLogicFlows((s) => s.shared);
  const flowsLoaded = useLogicFlows((s) => s.loaded);
  useEffect(() => {
    if (!flowsLoaded) void useLogicFlows.getState().load();
  }, [flowsLoaded]);
  const searchRef = useRef<HTMLInputElement>(null);
  const spaceRef = useRef<HTMLDivElement>(null);
  // The Données layer: sources, steps, data sets, variables (and binding them to layers).
  const keyHandlers = useRef<{ into: (key: string, node: string, port: string) => void; void: (key: string, sx: number, sy: number, at: { x: number; y: number }) => void } | null>(null);
  const data = useDataLayer({
    template,
    cv,
    spaceRef,
    onKeyIntoLogic: (k, n, p) => keyHandlers.current?.into(k, n, p),
    onKeyVoid: (k, sx, sy, at) => keyHandlers.current?.void(k, sx, sy, at),
  });
  const [view, setView] = useState<'all' | 'data' | 'logic'>('all');
  const logic: Logic = template?.logic ?? { nodes: [], edges: [] };
  const frames = logic.frames ?? [];
  const projectTemplates = useApp((s) => s.project?.templates.length ?? 0);
  const hasTriggers = !!template?.triggers?.nodes.length;
  useEffect(() => {
    if (hasTriggers) update((tpl) => mergeTriggers(tpl));
  }, [hasTriggers, update]);

  // Live values at the playhead.
  // The values the stage shows: the data the template is bound to (its sources, its data sets' rows).
  const bound = useBoundData(template, previewData);
  const liveData = useMemo(() => ({ ...bound, ...settingDefaults(template) }), [bound, template]);
  const values = useMemo(() => {
    if (!template) return new Map<string, LVal>();
    const hold = holdFrame(template);
    const resolved = new Map(template.layers.map((l) => [l.id, resolveLayer(l, frame, liveData, hold)]));
    return nodeValues(logic, resolved, liveData, measureLayer(template.layers, liveData, interpolateText), clockAt(frame));
  }, [template, frame, liveData]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => (template ? entries(template) : []), [template]);
  // The ports of each entry, for the type filter.
  const entryPorts = useMemo(() => {
    const m = new Map<string, Set<PortType>>();
    if (!template) return m;
    for (const e of all) {
      const { ins, outs } = portsOf(e.make(template, 0, 0));
      m.set(e.key, new Set([...ins, ...outs].map((p) => p.type)));
    }
    return m;
  }, [all, template]);

  // Where each port is on the canvas (measured after each render).
  useLayoutEffect(() => {
    const space = spaceRef.current;
    if (!space) return;
    const sr = space.getBoundingClientRect();
    const z = cv.view.zoom || 1;
    const next: Record<string, { x: number; y: number }> = {};
    for (const el of space.querySelectorAll<HTMLElement>('[data-pk]')) {
      const r = el.getBoundingClientRect();
      next[el.dataset.pk!] = { x: Math.round((r.left + r.width / 2 - sr.left) / z), y: Math.round((r.top + r.height / 2 - sr.top) / z) };
    }
    if (JSON.stringify(next) !== JSON.stringify(pos)) setPos(next);
  });

  const nodes = new Map(logic.nodes.map((n) => [n.id, n]));
  /** A Logic « field » node whose variable is on the canvas: the variable stands for it. */
  const hiddenField = (n: LogicNode | undefined) => n?.type === 'field' && !!pos[`key:${n.key}`];
  const collapsedOf = (n: LogicNode | undefined) => (n?.frame ? frames.find((f) => f.id === n.frame && f.collapsed) : undefined);
  const wiredIn = new Set(logic.edges.map((e) => `${e.to}|${e.port}`));
  /** The « Show in a text » nodes whose value a content row shows ({{calc_…}} in it). */
  const shownBy = (l: Layer, row: string) => {
    if (!row.startsWith('content.')) return [];
    const raw = String((l as unknown as Record<string, unknown>)[row.slice(8)] ?? '');
    return logic.nodes.filter((x): x is LogicNode & { type: 'setField' } => x.type === 'setField' && raw.includes(`{{${x.key}}}`));
  };
  /** The « Show in a text » nodes a text shows: not drawn, their value goes straight to the text's row. */
  const shownSets = new Set<string>();
  for (const n of logic.nodes)
    if (n.type === 'layer') {
      const l = template.layers.find((x) => x.id === n.layer);
      if (l) for (const r of n.rows) for (const sf of shownBy(l, r.key)) shownSets.add(sf.id);
    }
  /** What feeds a « Show in a text » node (its wire's start). */
  const feedOf = (sf: string) => logic.edges.find((e) => e.to === sf && e.port === 'in');
  // A row of a Layer node fed by the data shows as wired.
  for (const n of logic.nodes)
    if (n.type === 'layer') {
      const l = template.layers.find((x) => x.id === n.layer);
      if (l) for (const r of n.rows) if (!metricOf(r.key) && (data.keysAt(l, r.key).length || shownBy(l, r.key).length)) wiredIn.add(`${n.id}|${r.key}`);
    }
  const wiredOut = new Set(logic.edges.map((e) => `${e.from}|${fromPortOf(e)}`));
  const others = projectTemplates - 1;

  const edit = (fn: (l: Logic) => void, key?: string) =>
    update((tpl) => {
      const g = (tpl.logic ??= { nodes: [], edges: [] });
      fn(g);
      if (g.frames && !g.frames.length) delete g.frames;
      if (!g.nodes.length && !g.frames?.length) delete tpl.logic;
    }, key);
  const setNode = (id: string, patch: Partial<LogicNode>, key?: string) =>
    edit((l) => {
      const n = l.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    }, key);
  const mutate = (id: string, fn: (n: LogicNode) => void, key?: string) =>
    edit((l) => {
      const n = l.nodes.find((x) => x.id === id);
      if (n) fn(n);
    }, key);
  const toWorld = cv.toWorld;
  // An older graph (moments on its graphics and playlists, event nodes): made into steps when opened.
  const old = needsSteps(template.logic);
  useEffect(() => {
    if (old) edit((l) => void toSteps(l));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id, old]);
  // A When wired to a source it cannot watch that way: its source's first moment.
  const unfit = logic.nodes.flatMap((n) => {
    if (n.type !== 'when') return [];
    const src = sourceOf(logic, n.id);
    const o = src ? momentsOf(src, template) : [];
    return o.length && !o.some((x) => x.value === n.on) ? [[n.id, o[0].value] as const] : [];
  });
  const unfitKey = unfit.map((x) => x.join('=')).join(',');
  useEffect(() => {
    if (!unfit.length) return;
    edit((l) => {
      for (const [id, on] of unfit) {
        const m = l.nodes.find((x) => x.id === id);
        if (m?.type === 'when') m.on = on;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unfitKey]);

  /**
   * Puts the data nodes left of the logic ones: always (`align`, after Arrange: side by side, tops
   * level), or only when they overlap (a template from before the two canvases were one).
   */
  const keepDataLeft = (align: boolean) => {
    const b = data.bounds();
    const ns = (src.getState().template?.logic?.nodes ?? []).filter((n) => !hiddenField(n));
    if (!b || !ns.length) return;
    const size = measureNodes(cv.ref.current);
    const lx0 = Math.min(...ns.map((n) => n.x));
    const ly0 = Math.min(...ns.map((n) => n.y));
    const ly1 = Math.max(...ns.map((n) => n.y + (size[n.id]?.h ?? 120)));
    const apart = b.x1 + 120 <= lx0 || b.y0 > ly1 || b.y1 < ly0;
    // Far away (a canvas left wide open): brought back beside the logic.
    const far = b.x1 < lx0 - 800 || b.y0 > ly1 + 800 || b.y1 < ly0 - 800;
    if (!align && apart && !far) return;
    const dx = lx0 - 160 - b.x1;
    const dy = align || b.y0 > ly1 + 800 || b.y1 < ly0 - 800 ? ly0 - b.y0 : 0;
    if (!dx && !dy) return;
    const moved = data.nodesIn({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
    data.place(Object.fromEntries(moved.map((n) => [n.id, { x: n.x + dx, y: n.y + dy }])));
  };
  // After Arrange, once the data nodes are laid out too.
  const alignData = useRef(false);
  useLayoutEffect(() => {
    if (!alignData.current) return;
    alignData.current = false;
    keepDataLeft(true);
  });
  // On opening: a Layer node for each layer the data sets (the wires need one), and the data nodes
  // moved out of the logic's way (a template from when they had a canvas each).
  useEffect(() => {
    const tpl = src.getState().template;
    if (!tpl) return;
    const have = new Set((tpl.logic?.nodes ?? []).flatMap((n) => (n.type === 'layer' ? [n.layer] : [])));
    const missing = tpl.layers.filter((l) => !have.has(l.id) && data.boundRows(l).length);
    if (missing.length) {
      const ns = tpl.logic?.nodes ?? [];
      const x = ns.length ? Math.max(...ns.map((n) => n.x + widthOf(n))) + 120 : 600;
      edit((l) => {
        missing.forEach((ly, i) => l.nodes.push({ id: newId(), type: 'layer', layer: ly.id, rows: data.boundRows(ly).map((key) => ({ key })), x, y: i * 150 }));
      });
    }
    // What the two canvases had twice: a Layer node the Data canvas made for a layer the Logic already
    // has a node for (merged into it), a « Show in a text » no text shows any more (removed).
    const lg = src.getState().template?.logic;
    const json = JSON.stringify(src.getState().template?.layers ?? []);
    const made = (lg?.nodes ?? []).filter((n) => n.type === 'layer' && n.title === DC_MADE && lg!.nodes.some((o) => o.type === 'layer' && o.id !== n.id && o.layer === n.layer && o.title !== DC_MADE));
    const orphans = (lg?.nodes ?? []).filter((n) => n.type === 'setField' && !json.includes(`{{${n.key}}}`) && !lg!.nodes.some((o) => o.type === 'field' && o.key === n.key));
    if (made.length || orphans.length)
      edit((l) => {
        for (const d of made) {
          if (d.type !== 'layer') continue;
          const o = l.nodes.find((x): x is LogicNode & { type: 'layer' } => x.type === 'layer' && x.id !== d.id && x.layer === d.layer && x.title !== DC_MADE)!;
          for (const r of d.rows) if (!o.rows.some((x) => x.key === r.key)) o.rows.push(r);
          for (const e of l.edges) {
            if (e.to === d.id) e.to = o.id;
            if (e.from === d.id) e.from = o.id;
          }
        }
        const gone = new Set([...made, ...orphans].map((n) => n.id));
        l.nodes = l.nodes.filter((n) => !gone.has(n.id));
        l.edges = l.edges.filter((e) => !gone.has(e.to) && !gone.has(e.from));
        // One wire into an input.
        const seen = new Set<string>();
        l.edges = l.edges.filter((e) => !seen.has(`${e.to}|${e.port}`) && (seen.add(`${e.to}|${e.port}`), true));
      });
    const id = requestAnimationFrame(() => keepDataLeft(false));
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The frame a node at this place falls in (the last one drawn, open). */
  const frameAt = (fs: LogicFrame[], x: number, y: number) => [...fs].reverse().find((f) => !f.collapsed && x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
  /** Puts nodes in the frame they are over (or out of any). */
  const refit = (l: Logic, ids: Iterable<string>) => {
    const fs = l.frames ?? [];
    for (const id of ids) {
      const n = l.nodes.find((x) => x.id === id);
      if (!n) continue;
      const f = frameAt(fs, n.x + widthOf(n) / 2, n.y + 16);
      if (f) n.frame = f.id;
      else delete n.frame;
    }
  };

  /** Lays the nodes out from left to right (one step to undo). */
  const arrange = () => {
    const size = measureNodes(cv.ref.current);
    const links = [
      ...logic.edges.map((e) => ({ from: e.from, to: e.to })),
      // A « Show in a text » before the Layer node of the text that shows it.
      ...logic.nodes.flatMap((n) => {
        const l = n.type === 'layer' ? template.layers.find((x) => x.id === n.layer) : undefined;
        return n.type === 'layer' && l ? n.rows.flatMap((r) => shownBy(l, r.key).map((sf) => ({ from: feedOf(sf.id)?.from ?? sf.id, to: n.id }))) : [];
      }),
    ];
    // The last column: what ends a chain (actions, a Layer it sets), not what feeds another node.
    const feeds = new Set(links.map((e) => e.from));
    const at = autoLayout(
      logic.nodes.map((n) => ({ id: n.id, ...(size[n.id] ?? { w: widthOf(n), h: 120 }), side: !feeds.has(n.id) && portsOf(n).outs.every((p) => p.type === 'flow') && portsOf(n).ins.length ? ('end' as const) : undefined })),
      links,
      { tightSources: true },
    );
    src.setState({ lastCoalesce: null });
    data.arrange();
    alignData.current = true;
    edit((l) => {
      for (const n of l.nodes) if (at[n.id]) Object.assign(n, at[n.id]);
      // The frames follow their nodes.
      for (const f of l.frames ?? []) {
        const ms = l.nodes.filter((n) => n.frame === f.id);
        if (!ms.length) continue;
        const x0 = Math.min(...ms.map((n) => n.x)) - 24;
        const y0 = Math.min(...ms.map((n) => n.y)) - 40;
        const x1 = Math.max(...ms.map((n) => n.x + (size[n.id]?.w ?? widthOf(n)))) + 24;
        const y1 = Math.max(...ms.map((n) => n.y + (size[n.id]?.h ?? 120))) + 24;
        Object.assign(f, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    });
  };

  const place = () => {
    const v = cv.visible();
    const at = freeInView(spaceRef.current, v);
    if (at) return at;
    const x = Math.round(v.x + 80 + ((logic.nodes.length * 30) % 300));
    const y = Math.round(v.y + 70 + ((logic.nodes.length * 40) % 360));
    return freeSpot(spaceRef.current, { x, y });
  };

  const addNode = (n: LogicNode) => {
    edit((l) => {
      l.nodes.push(n);
      refit(l, [n.id]);
    });
    setSel(new Set([n.id]));
    setSelFrame(null);
  };
  const addEntry = (e: Entry) => {
    const at = place();
    addNode(e.make(template, at.x, at.y));
  };

  const removeNodes = (ids: Set<string>) =>
    edit((l) => {
      l.nodes = l.nodes.filter((n) => !ids.has(n.id));
      l.edges = l.edges.filter((x) => !ids.has(x.from) && !ids.has(x.to));
    });

  // ── Selection, moves ──────────────────────────────────────────────────
  const dragNodes = (e: React.PointerEvent, n: LogicNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('select, input, textarea, button, label, .lx-port, .cv-resize, .dd-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    let ids = sel;
    if (e.shiftKey) {
      ids = new Set(sel);
      if (ids.has(n.id)) ids.delete(n.id);
      else ids.add(n.id);
      setSel(ids);
      return;
    }
    if (!sel.has(n.id)) {
      ids = new Set([n.id]);
      setSel(ids);
    }
    setSelFrame(null);
    const start = toWorld(e.clientX, e.clientY);
    const base = new Map(logic.nodes.filter((x) => ids.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }]));
    src.setState({ lastCoalesce: null });
    const key = `lx-move-${newId()}`;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      edit((l) => {
        for (const m of l.nodes) {
          const b = base.get(m.id);
          if (b) Object.assign(m, { x: Math.round(b.x + p.x - start.x), y: Math.round(b.y + p.y - start.y) });
        }
      }, key);
    };
    document.body.classList.add('cv-moving');
    const up = () => {
      document.body.classList.remove('cv-moving');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      edit((l) => refit(l, base.keys()), key);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragFrame = (e: React.PointerEvent, f: LogicFrame) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('input, button, .lx-ftoggle')) return;
    e.preventDefault();
    e.stopPropagation();
    setSelFrame(f.id);
    setSel(new Set());
    const start = toWorld(e.clientX, e.clientY);
    const fb = { x: f.x, y: f.y };
    const base = new Map(logic.nodes.filter((n) => n.frame === f.id).map((n) => [n.id, { x: n.x, y: n.y }]));
    src.setState({ lastCoalesce: null });
    const key = `lx-frame-${newId()}`;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const dx = Math.round(p.x - start.x);
      const dy = Math.round(p.y - start.y);
      edit((l) => {
        const ff = l.frames?.find((x) => x.id === f.id);
        if (ff) Object.assign(ff, { x: fb.x + dx, y: fb.y + dy });
        for (const n of l.nodes) {
          const b = base.get(n.id);
          if (b) Object.assign(n, { x: b.x + dx, y: b.y + dy });
        }
      }, key);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** The « Données » frame: dragging it moves the data nodes (sources, steps, data sets, variables). */
  const dragDataFrame = (e: React.PointerEvent) => {
    const b = data.bounds();
    if (e.button !== 0 || !b) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toWorld(e.clientX, e.clientY);
    const base = data.nodesIn({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
    src.setState({ lastCoalesce: null });
    const key = `lx-dframe-${newId()}`;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const dx = Math.round(p.x - start.x);
      const dy = Math.round(p.y - start.y);
      data.place(Object.fromEntries(base.map((n) => [n.id, { x: n.x + dx, y: n.y + dy }])), key);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const resizeFrame = (e: React.PointerEvent, f: LogicFrame) => {
    e.preventDefault();
    e.stopPropagation();
    const start = toWorld(e.clientX, e.clientY);
    const fb = { w: f.w, h: f.h };
    src.setState({ lastCoalesce: null });
    const key = `lx-fsize-${newId()}`;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      edit((l) => {
        const ff = l.frames?.find((x) => x.id === f.id);
        if (ff) Object.assign(ff, { w: Math.max(160, Math.round(fb.w + p.x - start.x)), h: Math.max(90, Math.round(fb.h + p.y - start.y)) });
      }, key);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      edit((l) => refit(l, l.nodes.map((n) => n.id)), key);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const setFrame = (id: string, patch: Partial<LogicFrame>, key?: string) =>
    edit((l) => {
      const f = l.frames?.find((x) => x.id === id);
      if (f) Object.assign(f, patch);
    }, key);

  /** A frame around the selected nodes (or an empty one in view). */
  const makeFrame = () => {
    const ids = sel.size ? [...sel] : [];
    let box = { x: 0, y: 0, w: 420, h: 260 };
    if (ids.length) {
      const els = ids.map((id) => spaceRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)).filter((x): x is HTMLElement => !!x);
      const x0 = Math.min(...els.map((el) => el.offsetLeft)) - 24;
      const y0 = Math.min(...els.map((el) => el.offsetTop)) - 44;
      const x1 = Math.max(...els.map((el) => el.offsetLeft + el.offsetWidth)) + 24;
      const y1 = Math.max(...els.map((el) => el.offsetTop + el.offsetHeight)) + 24;
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else {
      const at = place();
      box = { ...box, x: at.x, y: at.y };
    }
    const f: LogicFrame = { id: newId(), name: `${t('Function')} ${frames.length + 1}`, color: FRAME_COLORS[frames.length % FRAME_COLORS.length], ...box };
    edit((l) => {
      (l.frames ??= []).push(f);
      for (const n of l.nodes) if (ids.includes(n.id)) n.frame = f.id;
    });
    setSelFrame(f.id);
    setSel(new Set());
    setRenaming(f.id);
  };

  const removeFrame = (id: string) =>
    edit((l) => {
      l.frames = (l.frames ?? []).filter((f) => f.id !== id);
      for (const n of l.nodes) if (n.frame === id) delete n.frame;
    });

  // ── Copy / paste ──────────────────────────────────────────────────────
  const clipOf = (ids: Set<string>, frameIds: Set<string>): Clip => {
    const ns = logic.nodes.filter((n) => ids.has(n.id) || (n.frame && frameIds.has(n.frame)));
    const keep = new Set(ns.map((n) => n.id));
    const used = new Set(ns.flatMap((n) => (n.type === 'layer' || n.type === 'widget' ? [n.layer] : [])));
    return {
      v: 1,
      nodes: structuredClone(ns),
      edges: structuredClone(logic.edges.filter((e) => keep.has(e.from) && keep.has(e.to))),
      frames: structuredClone(frames.filter((f) => frameIds.has(f.id) || ns.some((n) => n.frame === f.id))),
      layers: template.layers.filter((l) => used.has(l.id)).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      fields: [...new Set(ns.flatMap((n) => (n.type === 'field' && n.key ? [n.key] : [])))],
    };
  };
  const copy = () => {
    const c = clipOf(sel, new Set(selFrame ? [selFrame] : []));
    if (!c.nodes.length && !c.frames.length) return;
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(c));
    } catch {
      /* private window */
    }
    navigator.clipboard?.writeText(JSON.stringify(c)).catch(() => {});
  };
  /** Puts a clip in this template: new ids, its layers found again here (same id, same name, same type). */
  const insertClip = (c: Clip, at?: { x: number; y: number }, map?: { layers: Record<string, string>; fields: Record<string, string> }, frameName?: string) => {
    const ids = new Map<string, string>();
    for (const n of c.nodes) ids.set(n.id, newId());
    for (const f of c.frames) ids.set(f.id, newId());
    const mapLayer = (id: string) => {
      if (map?.layers[id]) return map.layers[id];
      if (template.layers.some((l) => l.id === id)) return id;
      const was = c.layers.find((l) => l.id === id);
      return (was && (template.layers.find((l) => l.name === was.name) ?? template.layers.find((l) => l.type === was.type))?.id) ?? id;
    };
    const xs = [...c.nodes.map((n) => n.x), ...c.frames.map((f) => f.x)];
    const ys = [...c.nodes.map((n) => n.y), ...c.frames.map((f) => f.y)];
    const o = at ? { x: at.x - Math.min(...xs), y: at.y - Math.min(...ys) } : { x: 40, y: 40 };
    const ns: LogicNode[] = c.nodes.map((n) => {
      const m = { ...structuredClone(n), id: ids.get(n.id)!, x: n.x + o.x, y: n.y + o.y } as LogicNode;
      if (m.frame) m.frame = ids.get(m.frame);
      if (!m.frame) delete m.frame;
      if (m.type === 'layer' || m.type === 'widget') m.layer = mapLayer(m.layer);
      if (m.type === 'field') m.key = map?.fields[m.key] ?? m.key;
      // What the clip leaves to choose: the template's first one.
      const first = (f: (l: Layer) => boolean) => template.layers.find(f)?.id ?? '';
      if (m.type === 'nextRow' && !m.dataset) m.dataset = template.datasets?.[0]?.key ?? '';
      if (m.type === 'widget' && !m.layer) m.layer = first(timedLayer);
      if (m.type === 'event') {
        const on = m.on;
        if (on.kind === 'lastRow' && !on.dataset) on.dataset = template.datasets?.[0]?.key ?? '';
        if ((on.kind === 'timerZero' || on.kind === 'timerAt') && !on.layer) on.layer = first(timerLayer);
        if (on.kind === 'scrollEnd' && !on.layer) on.layer = first(scrollLayer);
        if (on.kind === 'videoEnd' && !on.layer) on.layer = first(videoLayer);
        if (on.kind === 'dataChange' && !on.key) on.key = template.fields[0]?.key ?? '';
      }
      return m;
    });
    const fs: LogicFrame[] = c.frames.map((f) => ({ ...f, id: ids.get(f.id)!, x: f.x + o.x, y: f.y + o.y }));
    // A preset goes in its own frame.
    if (frameName && !fs.length && ns.length) {
      const x0 = Math.min(...ns.map((n) => n.x)) - 24;
      const y0 = Math.min(...ns.map((n) => n.y)) - 44;
      const x1 = Math.max(...ns.map((n) => n.x + widthOf(n))) + 24;
      const y1 = Math.max(...ns.map((n) => n.y + 170)) + 24;
      const f: LogicFrame = { id: newId(), name: frameName, color: FRAME_COLORS[(frames.length + 1) % FRAME_COLORS.length], x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      fs.push(f);
      for (const n of ns) n.frame = f.id;
    }
    const es: LogicEdge[] = c.edges.map((e) => ({ ...e, from: ids.get(e.from)!, to: ids.get(e.to)! }));
    edit((l) => {
      l.nodes.push(...ns);
      l.edges.push(...es);
      if (fs.length) (l.frames ??= []).push(...fs);
    });
    setSel(new Set(ns.map((n) => n.id)));
    setSelFrame(fs.length === 1 ? fs[0].id : null);
  };
  const clipboard = (): Clip | null => {
    try {
      const c = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null') as Clip | null;
      return c?.v === 1 ? c : null;
    } catch {
      return null;
    }
  };
  const paste = () => {
    const c = clipboard();
    if (!c) return;
    const v = cv.visible();
    insertClip(c, { x: Math.round(v.x + 60), y: Math.round(v.y + 60) });
  };

  /** A flow from the Library or a preset: its layers and fields matched first when the template has other ones. */
  const startInsert = (clip: Clip, name: string, framed: boolean) => {
    const needs = needsOf(clip, template);
    const v = cv.visible();
    const at = { x: Math.round(v.x + 80), y: Math.round(v.y + 80) };
    if (needs.layers.length || needs.fields.length) setModal({ kind: 'insert', clip, name, needs, framed });
    else insertClip(clip, at, undefined, framed ? name : undefined);
  };
  const saveFlow = async (name: string, scope: 'project' | 'shared') => {
    const clip = clipOf(sel, new Set(selFrame ? [selFrame] : []));
    if (!clip.nodes.length) return;
    const flow: LogicFlow = { id: newId(), name, author: user?.displayName || user?.username || '', created: Date.now(), clip };
    const ok = scope === 'shared' ? await useLogicFlows.getState().saveShared([...shared, flow]) : projectId ? await useLogicFlows.getState().saveProject(projectId, [...projectFlows, flow]) : false;
    if (ok) toast(t('Saved in the library'));
    setModal(null);
  };
  const askSave = () => setModal({ kind: 'save', name: frames.find((f) => f.id === selFrame)?.name ?? t('Flow') });

  /** A variable (or a data set column) into an input: a Layer row takes it as data, another node through a Field node. */
  const keyInto = (key: string, node: string, port: string) => {
    const n = logic.nodes.find((x) => x.id === node) ?? src.getState().template?.logic?.nodes.find((x) => x.id === node);
    if (!n) return;
    if (n.type === 'layer') {
      if (!metricOf(port)) data.bind(n.layer, port, key);
      return;
    }
    edit((l) => {
      let f = l.nodes.find((x): x is LogicNode & { type: 'field' } => x.type === 'field' && x.key === key);
      if (!f) {
        f = { id: newId(), type: 'field', key, x: n.x - 260, y: n.y };
        l.nodes.push(f);
      }
      l.edges = l.edges.filter((e) => !(e.to === node && e.port === port));
      l.edges.push({ from: f.id, to: node, port });
    });
  };
  keyHandlers.current = {
    into: keyInto,
    void: (key, sx, sy, p) => {
      setQSearch('');
      setQuick({ sx, sy, wx: Math.round(p.x), wy: Math.round(p.y), from: { node: `key:${key}`, port: 'out', dir: 'out', type: 'text' } });
    },
  };

  // ── Wires ─────────────────────────────────────────────────────────────
  const portRef = (el: HTMLElement): PortRef => ({ node: el.dataset.node!, port: el.dataset.port!, dir: el.dataset.dir as 'in' | 'out', type: el.dataset.type as PortType });
  const connect = (a: PortRef, b: PortRef) => {
    const [from, to] = a.dir === 'out' ? [a, b] : [b, a];
    if (from.dir !== 'out' || to.dir !== 'in' || from.node === to.node || !accepts(from.type, to.type)) return;
    if (from.node.startsWith('key:')) return keyInto(from.node.slice(4), to.node, to.port);
    if (to.port.startsWith('setting.')) return;
    // A value into a layer's content (a text, a picture): shown through its key ({{calc_…}}), like the
    // data, so the inspector and the Operator show it too.
    const target = nodes.get(to.node);
    if (target?.type === 'layer' && to.port.startsWith('content.') && from.type !== 'flow') {
      const tl = template.layers.find((x) => x.id === target.layer);
      // A value already shown there: replaced.
      for (const sf of tl ? shownBy(tl, to.port) : []) data.unbind(target.layer, to.port, sf.key);
      const key = `calc_${from.node}${from.port !== 'out' ? `_${from.port}` : ''}`;
      edit((l) => {
        let sf = l.nodes.find((x): x is LogicNode & { type: 'setField' } => x.type === 'setField' && x.key === key);
        if (!sf) {
          const src = l.nodes.find((x) => x.id === from.node);
          sf = { id: newId(), type: 'setField', key, x: (src?.x ?? 0) + 260, y: src?.y ?? 0 };
          l.nodes.push(sf);
        }
        l.edges = l.edges.filter((e) => !(e.to === sf!.id && e.port === 'in') && !(e.to === to.node && e.port === to.port));
        l.edges.push({ from: from.node, ...(from.port !== 'out' ? { fromPort: from.port } : {}), to: sf.id, port: 'in' });
      });
      data.bind(target.layer, to.port, key);
      return;
    }
    edit((l) => {
      // An input takes one wire.
      l.edges = l.edges.filter((x) => !(x.to === to.node && x.port === to.port));
      l.edges.push({ from: from.node, ...(from.port !== 'out' ? { fromPort: from.port } : {}), to: to.node, port: to.port });
    });
  };
  const startWire = (e: React.PointerEvent, ref: PortRef) => {
    e.stopPropagation();
    e.preventDefault();
    let from = ref;
    // Dragging from an input already wired picks its wire up.
    if (ref.dir === 'in') {
      const old = logic.edges.find((x) => x.to === ref.node && x.port === ref.port);
      if (old) {
        const src = nodes.get(old.from);
        const sp = src && portsOf(src).outs.find((p) => p.id === fromPortOf(old));
        edit((l) => void (l.edges = l.edges.filter((x) => x !== l.edges.find((y) => y.to === ref.node && y.port === ref.port))));
        from = { node: old.from, port: fromPortOf(old), dir: 'out', type: sp?.type ?? 'any' };
      }
    }
    setWire({ from, ...toWorld(e.clientX, e.clientY) });
    const move = (ev: PointerEvent) => setWire({ from, ...toWorld(ev.clientX, ev.clientY) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWire(null);
      const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('.lx-port');
      if (hit) return connect(from, portRef(hit));
      const over = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.lx-node, .lx-pal, .lx-quick');
      if (over) return;
      const vr = cv.ref.current?.getBoundingClientRect();
      const w = toWorld(ev.clientX, ev.clientY);
      setQSearch('');
      if (vr) setQuick({ sx: ev.clientX - vr.left, sy: ev.clientY - vr.top, wx: Math.round(w.x), wy: Math.round(w.y), from });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** From the menu of a dropped wire: the node, wired. */
  const addWired = (make: (x: number, y: number) => LogicNode) => {
    if (!quick) return;
    const want = { type: quick.from.type, side: quick.from.dir === 'out' ? ('in' as const) : ('out' as const) };
    const n = make(quick.from.dir === 'out' ? quick.wx + 20 : quick.wx - 240, quick.wy - 20);
    const p = fits(n, want);
    addNode(n);
    if (p) connect(quick.from, { node: n.id, port: p.id, dir: want.side, type: p.type });
    setQuick(null);
  };

  // ── Keys ──────────────────────────────────────────────────────────────
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.size) removeNodes(sel);
      else if (selFrame) removeFrame(selFrame);
      setSel(new Set());
      setSelFrame(null);
    } else if (mod && e.key.toLowerCase() === 'c') copy();
    else if (mod && e.key.toLowerCase() === 'v') paste();
    else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (sel.size || selFrame) insertClip(clipOf(sel, new Set(selFrame ? [selFrame] : [])));
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel(new Set(logic.nodes.map((n) => n.id)));
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (!mod && e.key.toLowerCase() === 'f') makeFrame();
    else if (e.key === 'Escape') {
      setSel(new Set());
      setSelFrame(null);
      setQuick(null);
    }
  };
  /** Esc closes the editor, as the table editor; typing in a field or with a menu open, it closes only that. */
  const escape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
    if (quick || modal || document.querySelector('.modal-back, .dd-list, .cp-pop, .tb-card, .te-full')) return;
    onClose();
  };
  useEffect(() => {
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });

  const onCanvasDown = (e: React.PointerEvent) => {
    setQuick(null);
    // The keys (Del, ⌘C, F…) go to the canvas.
    if (!(e.target as HTMLElement).closest('input, textarea, select, button, [contenteditable]')) (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    const el = e.target as HTMLElement;
    const onVoid = el === cv.ref.current || el.hasAttribute('data-canvas-void') || el instanceof SVGSVGElement;
    if (onVoid) {
      setSel(new Set());
      setSelFrame(null);
    }
    // Shift + drag on the void: select the nodes in a box.
    if (onVoid && e.shiftKey && e.button === 0) {
      e.preventDefault();
      const a = toWorld(e.clientX, e.clientY);
      setBand({ x0: a.x, y0: a.y, x1: a.x, y1: a.y });
      const move = (ev: PointerEvent) => {
        const b = toWorld(ev.clientX, ev.clientY);
        setBand({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const b = toWorld(ev.clientX, ev.clientY);
        const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        setSel(new Set(logic.nodes.filter((n) => !collapsedOf(n) && n.x < x1 && n.x + widthOf(n) > x0 && n.y < y1 && n.y + 60 > y0).map((n) => n.id)));
        setBand(null);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    cv.viewport.onPointerDown(e);
  };

  // ── Rendering ─────────────────────────────────────────────────────────
  const pk = (node: string, dir: 'in' | 'out', port: string) => `${node}|${dir}|${port}`;
  /** Where a wire ends: its port, or the folded frame its node is in. */
  const at = (node: string, dir: 'in' | 'out', port: string) => {
    if (node.startsWith('key:')) return pos[node];
    const hn = nodes.get(node);
    if (hiddenField(hn) && hn?.type === 'field') return pos[`key:${hn.key}`];
    const f = collapsedOf(nodes.get(node));
    return f ? pos[`frame:${f.id}|${dir}`] : pos[pk(node, dir, port)];
  };
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };
  const typeOfOut = (e: LogicEdge): PortType => {
    const n = nodes.get(e.from);
    return (n && portsOf(n).outs.find((p) => p.id === fromPortOf(e))?.type) ?? 'any';
  };

  const pIn = (n: LogicNode, id: string) => portsOf(n).ins.find((p) => p.id === id);
  const pOut = (n: LogicNode, id: string) => portsOf(n).outs.find((p) => p.id === id);
  const v = (n: LogicNode, port: string) => values.get(`${n.id}|${port}`);

  /** Named inputs of a Calculation or an If: rename, remove, add. */
  const inputRows = (n: LogicNode & { inputs: string[] }, used: string[]) => (
    <>
      {n.inputs.map((name, i) => (
        <Row key={`i-${i}`} n={n} inP={pIn(n, name)}>
          <input
            className="lx-name"
            value={name}
            onChange={(e) => {
              const nn = e.target.value.replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 16);
              if (!nn || n.inputs.includes(nn)) return;
              edit((l) => {
                const m = l.nodes.find((x) => x.id === n.id) as typeof n | undefined;
                if (!m) return;
                m.inputs = m.inputs.map((x) => (x === name ? nn : x));
                for (const ed of l.edges) if (ed.to === n.id && ed.port === name) ed.port = nn;
              }, `lx-${n.id}-in-${i}`);
            }}
          />
          <Val v={v(n, `in:${name}`)} />
          {!used.includes(name) && n.inputs.length > 1 && (
            <button
              className="lx-x"
              title={t('Remove')}
              onClick={() =>
                edit((l) => {
                  const m = l.nodes.find((x) => x.id === n.id) as typeof n | undefined;
                  if (m) m.inputs = m.inputs.filter((x) => x !== name);
                  l.edges = l.edges.filter((ed) => !(ed.to === n.id && ed.port === name));
                })
              }
            >
              <X size={10} />
            </button>
          )}
        </Row>
      ))}
      <button className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).inputs.push(nextName((m as typeof n).inputs)))}>
        <Plus size={11} /> {t('input')}
      </button>
    </>
  );

  const body = (n: LogicNode) => {
    const ins = portsOf(n).ins;
    const outs = portsOf(n).outs;
    const run = ins.find((p) => p.type === 'flow' && p.id === 'run');
    const next = outs.find((p) => p.id === 'next');
    const flowRows = (children?: React.ReactNode) => (
      <>
        {run && (
          <Row n={n} inP={run} outP={next}>
            <span className="lx-lab">{t('Run')}</span>
            {next && <span className="lx-lab right">{t('Then')}</span>}
          </Row>
        )}
        {children && <div className="lx-body">{children}</div>}
      </>
    );
    const set = (patch: Partial<LogicNode>, key?: string) => setNode(n.id, patch, key);
    switch (n.type) {
      case 'layer': {
        const l = template.layers.find((x) => x.id === n.layer);
        const have = new Set(n.rows.map((r) => r.key));
        const label = (key: string) => (key.startsWith('setting.') && l ? settingLabel(l, key.slice(8), t).label : rowLabel(key));
        const options = rowsFor(l)
          .filter((r) => !have.has(r.key))
          .map((r) => ({ value: r.key, label: label(r.key), group: t(r.group) }));
        return (
          <>
            {l && hasMoments(l) && (
              <Row n={n} outP={pOut(n, 'src')}>
                <span className="lx-lab right">{t('Moments')}</span>
              </Row>
            )}
            {n.rows.map((r) => {
              const inP = metricOf(r.key) ? undefined : pIn(n, r.key);
              const outP = r.key.startsWith('content.') ? undefined : pOut(n, r.key);
              const logicIn = logic.edges.some((e) => e.to === n.id && e.port === r.key);
              const keys = l && !metricOf(r.key) ? data.keysAt(l, r.key) : [];
              const op = l && !metricOf(r.key) ? data.exposure(l, r.key) : undefined;
              const wired = logicIn || keys.length > 0;
              const shown = logicIn ? v(n, `in:${r.key}`) : keys.length && l && r.key.startsWith('content.') ? data.preview(l, r.key) : v(n, r.key);
              return (
                <Row key={r.key} n={n} inP={inP} outP={outP} className={wired ? 'set' : ''}>
                  <span className="lx-lab">{label(r.key)}</span>
                  {op && (
                    <span className="lx-op" title={t('Typed by the Operator')}>
                      {op.label}
                      <button title={t('Stop: the Operator no longer types it')} onClick={op.stop}>
                        ×
                      </button>
                    </span>
                  )}
                  {logicIn && rowType(r.key) === 'num' && (
                    <button
                      className="lx-mode"
                      title={t('Replace, add to the animation, or multiply')}
                      onClick={() =>
                        mutate(n.id, (m) => {
                          const row = (m as typeof n).rows.find((x) => x.key === r.key);
                          if (row) row.mode = row.mode === 'add' ? 'multiply' : row.mode === 'multiply' ? undefined : 'add';
                          if (row && !row.mode) delete row.mode;
                        })
                      }
                    >
                      {r.mode === 'add' ? '+' : r.mode === 'multiply' ? '×' : '='}
                    </button>
                  )}
                  <Val v={shown} />
                  <button className="lx-x" title={t('Remove')} onClick={() => edit((ll) => {
                    const m = ll.nodes.find((x) => x.id === n.id) as typeof n | undefined;
                    if (m) m.rows = m.rows.filter((x) => x.key !== r.key);
                    ll.edges = ll.edges.filter((ed) => !((ed.to === n.id && ed.port === r.key) || (ed.from === n.id && fromPortOf(ed) === r.key)));
                  })}>
                    <X size={10} />
                  </button>
                </Row>
              );
            })}
            {options.length > 0 && (
              <div className="lx-body">
                <Dropdown className="lx-addrow" value={'' as string} placeholder={`+ ${t('property')}`} options={options} onChange={(key) => mutate(n.id, (m) => void (m as typeof n).rows.push({ key }))} />
              </div>
            )}
          </>
        );
      }
      case 'field':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <Dropdown
              value={n.key}
              placeholder={t('Choose a field')}
              options={[...(template.fields.some((f) => f.key === n.key) || !n.key ? [] : [{ value: n.key, label: n.key }]), ...template.fields.map((f) => ({ value: f.key, label: f.label, note: t(f.kind) }))]}
              onChange={(key) => set({ key } as Partial<LogicNode>)}
            />
          </Row>
        );
      case 'constant':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <NumberField value={n.value} onChange={(x) => set({ value: x } as Partial<LogicNode>, `lx-${n.id}-v`)} />
          </Row>
        );
      case 'text':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <TextInput value={n.value} onChange={(x) => set({ value: x } as Partial<LogicNode>, `lx-${n.id}-v`)} />
          </Row>
        );
      case 'color':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <HexColorField value={n.value} onChange={(x) => set({ value: x } as Partial<LogicNode>, `lx-${n.id}-v`)} />
          </Row>
        );
      case 'flag':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <Segmented
              value={n.value ? '1' : '0'}
              onChange={(x) => set({ value: x === '1' } as Partial<LogicNode>)}
              options={[
                { value: '1', label: t('Yes') },
                { value: '0', label: t('No') },
              ]}
            />
          </Row>
        );
      case 'expr': {
        const used = names(parse(n.expr));
        return (
          <>
            {inputRows(n, used)}
            <div className="lx-body">
              <ExprInput value={n.expr} k={`lx-${n.id}-e`} onChange={(x, key) => set({ expr: x } as Partial<LogicNode>, key)} placeholder="a + b" />
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('Result')}</span>
              <Val v={v(n, 'out')} />
            </Row>
          </>
        );
      }
      case 'if': {
        const used = [...new Set([...n.branches.flatMap((b) => [...names(parse(b.when)), ...names(parse(b.value))]), ...names(parse(n.otherwise))])];
        const chosen = values.get(`${n.id}|chosen`) as number | undefined;
        const setBranch = (i: number, patch: Partial<{ when: string; value: string }>, key?: string) => mutate(n.id, (m) => Object.assign((m as typeof n).branches[i], patch), key);
        return (
          <>
            <Row n={n} inP={pIn(n, 'run')}>
              <span className="lx-lab">{t('When')}</span>
            </Row>
            {inputRows(n, used)}
            {n.branches.map((b, i) => (
              <Row key={`b-${i}`} n={n} outP={pOut(n, `b${i}`)} className={`lx-branch ${chosen === i ? 'chosen' : ''}`}>
                <span className="lx-kw">{i ? t('Else if') : t('If')}</span>
                <ExprInput value={b.when} k={`lx-${n.id}-w${i}`} onChange={(x, key) => setBranch(i, { when: x }, key)} placeholder="a > b" />
                <span className="lx-then">{t('then')}</span>
                <BranchValue value={b.value} k={`lx-${n.id}-v${i}`} onChange={(x, key) => setBranch(i, { value: x }, key)} />
                {n.branches.length > 1 && (
                  <button
                    className="lx-x"
                    title={t('Remove')}
                    onClick={() =>
                      edit((l) => {
                        const m = l.nodes.find((x) => x.id === n.id) as typeof n | undefined;
                        if (!m) return;
                        m.branches.splice(i, 1);
                        // The wires of the branches after it move up one.
                        l.edges = l.edges.filter((ed) => !(ed.from === n.id && fromPortOf(ed) === `b${i}`));
                        for (const ed of l.edges) {
                          const k = ed.from === n.id ? /^b(\d+)$/.exec(fromPortOf(ed)) : null;
                          if (k && +k[1] > i) ed.fromPort = `b${+k[1] - 1}`;
                        }
                      })
                    }
                  >
                    <X size={10} />
                  </button>
                )}
              </Row>
            ))}
            <button className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).branches.push({ when: '', value: '' }))}>
              <Plus size={11} /> {t('else if')}
            </button>
            <Row n={n} outP={pOut(n, 'else')} className={`lx-branch ${chosen === -1 ? 'chosen' : ''}`}>
              <span className="lx-kw">{t('Else')}</span>
              <span className="lx-then">{t('then')}</span>
              <BranchValue value={n.otherwise} k={`lx-${n.id}-o`} onChange={(x, key) => set({ otherwise: x } as Partial<LogicNode>, key)} />
            </Row>
            <Row n={n} outP={pOut(n, 'out')} className="sep">
              <span className="lx-lab right">{t('Result')}</span>
              <Val v={v(n, 'out')} />
            </Row>
          </>
        );
      }
      case 'lookup':
        return (
          <>
            <Row n={n} inP={pIn(n, 'in')}>
              <span className="lx-lab">{t('Key')}</span>
              <Val v={v(n, 'in:in')} />
            </Row>
            <div className="lx-body lx-table">
              {n.rows.map((r, i) => (
                <div key={i} className="lx-trow">
                  <TextInput value={r.key} placeholder={t('key name')} onChange={(x) => mutate(n.id, (m) => void ((m as typeof n).rows[i].key = x), `lx-${n.id}-k${i}`)} />
                  <span>→</span>
                  <TextInput value={r.value} placeholder={t('value')} onChange={(x) => mutate(n.id, (m) => void ((m as typeof n).rows[i].value = x), `lx-${n.id}-r${i}`)} />
                  <button className="lx-x" title={t('Remove')} onClick={() => mutate(n.id, (m) => void (m as typeof n).rows.splice(i, 1))}>
                    <X size={10} />
                  </button>
                </div>
              ))}
              <button className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).rows.push({ key: '', value: '' }))}>
                <Plus size={11} /> {t('row')}
              </button>
              <label className="lx-field">
                <span>{t('Else')}</span>
                <TextInput value={n.otherwise} onChange={(x) => set({ otherwise: x } as Partial<LogicNode>, `lx-${n.id}-o`)} />
              </label>
              <label className="lx-field">
                <span>{t('Match')}</span>
                <Segmented
                  value={n.contains ? 'in' : 'eq'}
                  onChange={(x) => set({ contains: x === 'in' || undefined } as Partial<LogicNode>)}
                  options={[
                    { value: 'eq', label: t('Equal') },
                    { value: 'in', label: t('Contains') },
                  ]}
                />
              </label>
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('Value')}</span>
              <Val v={v(n, 'out')} />
            </Row>
          </>
        );
      case 'onAir':
        return (
          <>
            <div className="lx-body">
              <OnAirBody n={n} template={template} set={set} />
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('On air')}</span>
              <Val v={v(n, 'out')} />
            </Row>
          </>
        );
      case 'var': {
        const names_ = varNames(template);
        return (
          <>
            <div className="lx-body">
              {names_.length ? (
                <Dropdown value={n.name} placeholder={t('Choose a variable')} options={[...(names_.includes(n.name) || !n.name ? [] : [{ value: n.name, label: n.name }]), ...names_.map((x) => ({ value: x, label: x }))]} onChange={(name) => set({ name } as Partial<LogicNode>)} />
              ) : (
                <TextInput value={n.name} placeholder={t('Variable')} onChange={(x) => set({ name: x.replace(/\s+/g, '_') } as Partial<LogicNode>, `lx-${n.id}-n`)} />
              )}
              <label className="lx-field">
                <span>{tc('logic', 'Try')}</span>
                <NumberField value={n.test ?? 0} step={1} onChange={(x) => set({ test: x } as Partial<LogicNode>, `lx-${n.id}-t`)} />
              </label>
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('Value')}</span>
              <Val v={v(n, 'out')} />
            </Row>
          </>
        );
      }
      case 'setField':
        return (
          <Row n={n} inP={pIn(n, 'in')}>
            <span className="lx-note">{`{{${n.key}}}`}</span>
          </Row>
        );
      case 'event':
        return (
          <>
            <div className="lx-body">
              <EventBody n={n} template={template} set={(on, key) => set({ on } as Partial<LogicNode>, key)} />
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('When')}</span>
            </Row>
          </>
        );
      case 'triggerIn':
        return (
          <>
            <div className="lx-body">
              <TextInput value={n.name} placeholder={t('goal, next, line2…')} onChange={(x) => set({ name: x } as Partial<LogicNode>, `lx-${n.id}-n`)} />
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('When')}</span>
            </Row>
          </>
        );
      case 'continue':
      case 'start':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <span className="lx-lab right">{t('When')}</span>
          </Row>
        );
      case 'every':
        return (
          <Row n={n} outP={pOut(n, 'out')}>
            <NumberField value={n.seconds} min={0.1} step={1} precision={1} suffix="s" onChange={(x) => set({ seconds: Math.max(0.1, x) } as Partial<LogicNode>, `lx-${n.id}-s`)} />
          </Row>
        );
      case 'wait':
        return (
          <>
            {flowRows()}
            <Row n={n} inP={pIn(n, 'seconds')}>
              <span className="lx-lab">{t('Seconds')}</span>
              {wiredIn.has(`${n.id}|seconds`) ? <Val v={v(n, 'in:seconds')} /> : <NumberField value={n.seconds} min={0} step={0.5} precision={1} suffix="s" onChange={(x) => set({ seconds: Math.max(0, x) } as Partial<LogicNode>, `lx-${n.id}-s`)} />}
            </Row>
          </>
        );
      case 'counter':
        return (
          <>
            {flowRows()}
            <Row n={n} inP={pIn(n, 'reset')} outP={pOut(n, 'out')}>
              <span className="lx-lab">{t('Reset')}</span>
              <span className="lx-lab right">{t('Counted')}</span>
              <Val v={v(n, 'out')} />
            </Row>
            <div className="lx-body lx-pair">
              <label className="lx-field">
                <span>{t('Start')}</span>
                <NumberField value={n.start} onChange={(x) => set({ start: x } as Partial<LogicNode>, `lx-${n.id}-a`)} />
              </label>
              <label className="lx-field">
                <span>{t('Increment')}</span>
                <NumberField value={n.step} onChange={(x) => set({ step: x } as Partial<LogicNode>, `lx-${n.id}-b`)} />
              </label>
            </div>
          </>
        );
      case 'once':
        return (
          <>
            {flowRows()}
            <Row n={n} inP={pIn(n, 'reset')}>
              <span className="lx-lab">{t('Reset')}</span>
            </Row>
          </>
        );
      case 'out':
        return flowRows();
      case 'resume':
        return flowRows(<Dropdown value={n.marker} placeholder={t('Choose a pause')} options={template.markers.filter((m) => m.kind === 'pause').map((m) => ({ value: m.id, label: m.name || t('Pause') }))} onChange={(marker) => set({ marker } as Partial<LogicNode>)} />);
      case 'fire':
        return flowRows(<TextInput value={n.name} placeholder={t('goal, next, line2…')} onChange={(x) => set({ name: x } as Partial<LogicNode>, `lx-${n.id}-n`)} />);
      case 'nextRow':
        return flowRows(<Dropdown value={n.dataset} placeholder={t('Choose a data set')} options={(template.datasets ?? []).map((d) => ({ value: d.key, label: d.name }))} onChange={(dataset) => set({ dataset } as Partial<LogicNode>)} />);
      case 'take':
        return flowRows(<TakeBody n={n} template={template} set={set} />);
      case 'resumePlaylist':
      case 'stopAuto':
        return flowRows(<Dropdown value={n.playlist} placeholder={t('Choose a playlist')} options={(projectLists ?? []).map((l) => ({ value: l.id, label: l.name }))} onChange={(playlist) => set({ playlist } as Partial<LogicNode>)} />);
      case 'clearAll':
        return flowRows();
      case 'animate': {
        // In the project's Logic: a graphic, then one of its layers.
        const graphics = proj ? (useApp.getState().project?.templates ?? []) : [];
        const g = proj ? graphics.find((x) => x.id === n.template) : template;
        const l = g?.layers.find((x) => x.id === n.layer);
        const props = propsOf(l);
        const isColor = (k: string) => COLOR_PROPS.has(k as Prop);
        const now = (k: string) => {
          const v = l && g ? (resolveLayer(l, holdFrame(g), {}) as unknown as Record<string, unknown>)[k] : undefined;
          return isColor(k) ? (Array.isArray(v) ? toHex(v as Color) : '#ffffff') : typeof v === 'number' ? String(Math.round(v * 100) / 100) : '0';
        };
        const setRow = (i: number, patch: Partial<PropSet>, key?: string) => mutate(n.id, (m) => Object.assign((m as typeof n).sets[i], patch), key);
        return flowRows(
          <>
            {proj && <Dropdown value={n.template ?? ''} placeholder={t('Choose a graphic')} options={graphics.map((x) => ({ value: x.id, label: x.name }))} onChange={(tpl) => set({ template: tpl, layer: '' } as Partial<LogicNode>)} />}
            <Dropdown value={n.layer} placeholder={t('Choose a layer')} options={(g?.layers ?? []).map((x) => ({ value: x.id, label: x.name }))} onChange={(layer) => set({ layer } as Partial<LogicNode>)} />
            {n.sets.map((r, i) => (
              <div key={i} className="lx-phrase lx-set">
                <Dropdown value={r.key} options={[...(r.mode === 'back' ? [{ value: '*', label: t('All properties') }] : []), ...props.map((p) => ({ value: p, label: rowLabel(p) }))]} onChange={(key) => setRow(i, { key, value: key === '*' ? '' : now(key) })} />
                <Dropdown
                  value={r.mode}
                  options={[
                    { value: 'to', label: t('towards') },
                    ...(isColor(r.key) ? [] : [{ value: 'add', label: t('by +') }, { value: 'sub', label: t('by −') }]),
                    { value: 'back', label: t('go back') },
                  ]}
                  onChange={(mode) => setRow(i, { mode: mode as PropSet['mode'], ...(mode === 'add' || mode === 'sub' ? { value: '0' } : mode === 'to' && r.key !== '*' ? { value: now(r.key) } : {}), ...(mode !== 'back' && r.key === '*' ? { key: props[0] ?? 'x', value: now(props[0] ?? 'x') } : {}) })}
                />
                {r.mode !== 'back' &&
                  (isColor(r.key) ? (
                    <HexColorField value={r.value || '#ffffff'} onChange={(x) => setRow(i, { value: x }, `lx-${n.id}-v${i}`)} />
                  ) : (
                    <NumberField value={parseFloat(r.value) || 0} onChange={(x) => setRow(i, { value: String(x) }, `lx-${n.id}-v${i}`)} />
                  ))}
                <button className="lx-x" title={t('Remove')} onClick={() => mutate(n.id, (m) => void (m as typeof n).sets.splice(i, 1))}>
                  <X size={10} />
                </button>
              </div>
            ))}
            <button className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).sets.push({ key: props[0] ?? 'x', mode: 'to', value: now(props[0] ?? 'x') }))}>
              <Plus size={11} /> {t('property')}
            </button>
          </>,
        );
      }
      case 'playSound':
        return flowRows(<PlaySoundBody n={n} set={set} />);
      case 'stopSound':
        return flowRows(<StopSoundBody n={n} set={set} />);
      case 'how':
        return flowRows(<HowBody how={howOf(n)} set={(patch, key) => set(patch as Partial<LogicNode>, key && `lx-${n.id}-${key}`)} />);
      case 'template': {
        const g = useApp.getState().project?.templates.find((x) => x.id === n.template);
        const zone = useApp.getState().project?.zones.find((z) => z.id === g?.zone)?.name;
        return (
          <Row n={n} outP={pOut(n, 'src')}>
            <span className="lx-lab">{zone ? `${t('Zone')} · ${zone}` : ''}</span>
          </Row>
        );
      }
      case 'playlist': {
        const rows = (useApp.getState().project?.rundown ?? []).filter((r) => r.playlist === n.playlist).length;
        return (
          <Row n={n} outP={pOut(n, 'src')}>
            <span className="lx-lab">{t('{n} rows', { n: rows })}</span>
          </Row>
        );
      }
      case 'when': {
        const src = sourceOf(logic, n.id);
        const opts = momentsOf(src, template);
        const lastRowOf = (s: LogicNode | undefined) => (s?.type === 'field' ? (template.datasets ?? []).find((d) => s.key.startsWith(`${d.key}_`))?.key : undefined);
        return (
          <>
            <Row n={n} inP={pIn(n, 'src')}>
              <span className="lx-lab">{src ? kindOf(src, template).label : ''}</span>
            </Row>
            <div className="lx-body">
              <Dropdown
                value={opts.some((o) => o.value === n.on) ? n.on : ''}
                placeholder={t('Choose a moment')}
                options={opts.map((o) => ({ value: o.value, label: t(o.label) }))}
                onChange={(on) => set({ on, ...(on === 'lastRow' && lastRowOf(src) ? { dataset: lastRowOf(src) } : {}) } as Partial<LogicNode>)}
              />
              {n.on === 'trigger' && <TextInput value={n.name ?? ''} placeholder={t('goal, next, line2…')} onChange={(x) => set({ name: x } as Partial<LogicNode>, `lx-${n.id}-n`)} />}
              {(n.on === 'every' || n.on === 'timerAt') && (
                <NumberField value={n.seconds ?? 0} min={n.on === 'every' ? 0.1 : 0} step={1} precision={1} suffix="s" onChange={(x) => set({ seconds: Math.max(n.on === 'every' ? 0.1 : 0, x) } as Partial<LogicNode>, `lx-${n.id}-s`)} />
              )}
              {n.on === 'lastRow' && !src && (
                <Dropdown value={n.dataset ?? ''} placeholder={t('Choose a data set')} options={(template.datasets ?? []).map((d) => ({ value: d.key, label: d.name }))} onChange={(dataset) => set({ dataset } as Partial<LogicNode>)} />
              )}
            </div>
            <Row n={n} outP={pOut(n, 'out')}>
              <span className="lx-lab right">{t('Then')}</span>
            </Row>
          </>
        );
      }
      case 'check': {
        const subjects = subjectsOf(template);
        const truth = v(n, 'out');
        const usesIn = n.rows.some((r) => r.what === 'in');
        const joinOf = (i: number) => n.rows[i].join ?? (n.any ? 'or' : 'and');
        const setRow = (i: number, patch: Partial<{ what: string; test: string; value: string }>, key?: string) =>
          mutate(
            n.id,
            (m) => {
              const r = (m as typeof n).rows[i];
              if (patch.what && patch.what !== r.what) Object.assign(r, lineFor(patch.what));
              else Object.assign(r, patch);
            },
            key,
          );
        return (
          <>
            <Row n={n} inP={pIn(n, 'run')} />
            <div className="lx-body lx-phrases">
              {n.rows.map((r, i) => (
                <div key={i} className={`lx-phrase ${i > 0 && joinOf(i) === 'or' ? 'or' : ''}`}>
                  {i > 0 && (
                    <button
                      className={`lx-join ${joinOf(i)}`}
                      onClick={() =>
                        mutate(n.id, (m) => {
                          const c = m as typeof n;
                          c.rows.forEach((x, j) => void (j > 0 && !x.join && (x.join = c.any ? 'or' : 'and')));
                          delete c.any;
                          c.rows[i].join = c.rows[i].join === 'or' ? 'and' : 'or';
                        })
                      }
                    >
                      {joinOf(i) === 'or' ? t('or') : t('and')}
                    </button>
                  )}
                  <Dropdown value={r.what} placeholder={t('Choose')} options={[...(subjects.some((o) => o.value === r.what) ? [] : [{ value: r.what, label: r.what }]), ...subjects.map((o) => ({ value: o.value, label: t(o.label), group: o.group && t(o.group) }))]} onChange={(what) => setRow(i, { what })} />
                  <Dropdown value={r.test} options={testsOf(r.what).map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(test) => setRow(i, { test })} />
                  {needsValue(r.test) && <TextInput value={r.value ?? ''} placeholder={t('value')} onChange={(x) => setRow(i, { value: x }, `lx-${n.id}-v${i}`)} />}
                  <button className="lx-x" title={t('Remove')} onClick={() => mutate(n.id, (m) => void (m as typeof n).rows.splice(i, 1))}>
                    <X size={10} />
                  </button>
                </div>
              ))}
              {n.rows.length ? (
                <div className="lx-adds">
                  {(['and', 'or'] as const).map((j) => (
                    <button key={j} className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).rows.push({ ...lineFor(subjects[0]?.value ?? 'in'), join: j }))}>
                      <Plus size={11} /> {j === 'and' ? t('and') : t('or')}
                    </button>
                  ))}
                </div>
              ) : (
                <button className="lx-add" onClick={() => mutate(n.id, (m) => void (m as typeof n).rows.push(lineFor(subjects[0]?.value ?? 'in')))}>
                  <Plus size={11} /> {t('condition')}
                </button>
              )}
            </div>
            {usesIn && (
              <Row n={n} inP={pIn(n, 'in')}>
                <span className="lx-lab">{t('Value')}</span>
                <Val v={v(n, 'in:in')} />
              </Row>
            )}
            <Row n={n} outP={pOut(n, 'yes')} className={`lx-branch ${truth === 1 ? 'chosen' : ''}`}>
              <span className="lx-kw yes">{t('True')}</span>
            </Row>
            <Row n={n} outP={pOut(n, 'no')} className={`lx-branch ${truth === 0 && n.rows.length ? 'chosen' : ''}`}>
              <span className="lx-kw no">{t('False')}</span>
            </Row>
          </>
        );
      }
      case 'widget':
        return flowRows(
          <>
            <Dropdown value={n.layer} placeholder={t('Choose a layer')} options={template.layers.filter(timedLayer).map((l) => ({ value: l.id, label: l.name }))} onChange={(layer) => set({ layer } as Partial<LogicNode>)} />
            <Dropdown
              value={n.control}
              options={[
                { value: 'start', label: t('Start it') },
                { value: 'pause', label: t('Pause') },
                { value: 'toggle', label: t('Start / pause') },
                { value: 'reset', label: t('Reset') },
                { value: 'restart', label: t('Restart') },
              ]}
              onChange={(control) => set({ control } as Partial<LogicNode>)}
            />
          </>,
        );
      case 'setVar':
        return (
          <>
            {flowRows(
              <>
                <label className="lx-field">
                  <span>{t('Variable')}</span>
                  <TextInput value={n.name} onChange={(x) => set({ name: x.replace(/\s+/g, '_') } as Partial<LogicNode>, `lx-${n.id}-n`)} />
                </label>
                <label className="lx-field">
                  <span>{t('Transition')}</span>
                  <NumberField value={n.transition ?? 0} min={0} max={10} step={0.1} precision={1} suffix="s" onChange={(x) => set({ transition: Math.max(0, x) } as Partial<LogicNode>, `lx-${n.id}-t`)} />
                </label>
              </>,
            )}
            <Row n={n} inP={pIn(n, 'value')}>
              <span className="lx-lab">{t('Value')}</span>
              {wiredIn.has(`${n.id}|value`) ? <Val v={v(n, 'in:value')} /> : <TextInput value={n.value} onChange={(x) => set({ value: x } as Partial<LogicNode>, `lx-${n.id}-v`)} />}
            </Row>
          </>
        );
    }
    return null;
  };

  /** The value a node shows in its header (its main output). */
  const headValue = (n: LogicNode) => {
    if (n.type === 'layer' || n.type === 'if' || n.type === 'check' || n.type === 'when' || n.type === 'expr' || n.type === 'lookup' || n.type === 'var' || n.type === 'onAir' || n.type === 'counter' || n.type === 'template' || n.type === 'playlist') return undefined;
    const out = portsOf(n).outs.find((p) => p.type !== 'flow');
    return out ? values.get(`${n.id}|${out.id}`) : undefined;
  };

  // Variables (and data set columns) into the rows of the Layer nodes: the data's wires.
  const dataWires: { a: { x: number; y: number }; b: { x: number; y: number }; layer: string; row: string; key: string; set?: string }[] = [];
  {
    const seen = new Set<string>();
    for (const n of logic.nodes) {
      if (n.type !== 'layer') continue;
      const l = template.layers.find((x) => x.id === n.layer);
      if (!l) continue;
      for (const r of n.rows) {
        if (metricOf(r.key) || seen.has(`${n.layer}|${r.key}`)) continue;
        seen.add(`${n.layer}|${r.key}`);
        for (const key of data.keysAt(l, r.key)) {
          const a = pos[`key:${key}`];
          const b = at(n.id, 'in', r.key);
          if (a && b) dataWires.push({ a, b, layer: n.layer, row: r.key, key });
        }
        // A value shown in the text ({{calc_…}}): from what computes it, straight to the row.
        for (const sf of shownBy(l, r.key)) {
          const src = feedOf(sf.id);
          const a = src && at(src.from, 'out', fromPortOf(src));
          const b = at(n.id, 'in', r.key);
          if (a && b) dataWires.push({ a, b, layer: n.layer, row: r.key, key: sf.key, set: sf.id });
        }
      }
    }
  }

  // Where the data nodes are (the « Données » frame around them).
  const dataBox = data.bounds();

  // ── Palette ───────────────────────────────────────────────────────────
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = fold(search.trim());
  const shown = all.filter((e) => {
    if (scope === 'here' && e.can && !e.can({ t: template, others })) return false;
    if (scope === 'fav' && !favs.includes(e.key)) return false;
    if (typeFilter) {
      const types = entryPorts.get(e.key);
      if (!types || !(types.has(typeFilter) || (typeFilter !== 'flow' && types.has('any')))) return false;
    }
    if (q && !fold(`${t(e.label)} ${e.label} ${e.note ?? ''} ${t(FAMS.find((f) => f.id === e.fam)!.label)}`).includes(q)) return false;
    return true;
  });
  const placed = new Set(logic.nodes.flatMap((n) => (n.type === 'layer' ? [`layer:${n.layer}`] : n.type === 'template' ? [`tpl:${n.template}`] : n.type === 'playlist' ? [`pl:${n.playlist}`] : [])));
  const toggleFav = (key: string) => {
    const next = favs.includes(key) ? favs.filter((x) => x !== key) : [...favs, key];
    setFavs(next);
    setDisplayPref('logic.favs', next);
  };
  const toggleFold = (fam: string) => {
    const next = folded.includes(fam) ? folded.filter((x) => x !== fam) : [...folded, fam];
    setFolded(next);
    setDisplayPref('logic.folded', next);
  };

  // The menu of a dropped wire: the nodes that take it.
  const quickList = (() => {
    if (!quick) return [];
    const want = { type: quick.from.type, side: quick.from.dir === 'out' ? ('in' as const) : ('out' as const) };
    const out: { key: string; label: string; fam: Fam; note?: string; make: (x: number, y: number) => LogicNode }[] = [];
    for (const e of all) {
      if (e.can && !e.can({ t: template, others })) continue;
      if (e.fam === 'layer') {
        const l = template.layers.find((x) => `layer:${x.id}` === e.key);
        if (!l) continue;
        const make = (x: number, y: number) => layerNode(l, x, y, want);
        if (!fits(make(0, 0), want)) continue;
        out.push({ key: e.key, label: e.label, fam: e.fam, note: e.note, make });
        continue;
      }
      const make = (x: number, y: number) => e.make(template, x, y);
      if (!fits(make(0, 0), want)) continue;
      out.push({ key: e.key, label: t(e.label), fam: e.fam, make });
    }
    const qq = fold(qSearch.trim());
    return out.filter((o) => !qq || fold(o.label).includes(qq));
  })();

  // ── Minimap ───────────────────────────────────────────────────────────
  const boxes = [...frames.map((f) => ({ x: f.x, y: f.y, w: f.collapsed ? 220 : f.w, h: f.collapsed ? 40 : f.h, c: f.color, frame: true })), ...logic.nodes.filter((n) => !collapsedOf(n)).map((n) => ({ x: n.x, y: n.y, w: widthOf(n), h: 80, c: '', frame: false }))];
  const mini = (() => {
    if (boxes.length < 2) return null;
    const x0 = Math.min(...boxes.map((b) => b.x)) - 40;
    const y0 = Math.min(...boxes.map((b) => b.y)) - 40;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 40;
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 40;
    const k = Math.min(160 / (x1 - x0), 100 / (y1 - y0));
    const vis = cv.visible();
    return { x0, y0, k, w: (x1 - x0) * k, h: (y1 - y0) * k, vis };
  })();

  const canPaste = !!clipboard();

  return (
    <PortCtx.Provider value={{ wiredIn, wiredOut, startWire }}>
    <div className={`logic-editor lx view-${view}`} onKeyDown={(e) => (e.stopPropagation(), escape(e.nativeEvent))}>
      <CanvasHeader icon={<Link2 size={15} />} title={t('Logic')} subject={proj ? t('Project · {name}', { name: template.name }) : template.name} onClose={onClose}>
        {!proj && (
        <div className="segmented lx-view">
          {(['all', 'data', 'logic'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'all' ? t('All') : v === 'data' ? t('Data') : t('Logic')}
            </button>
          ))}
        </div>
        )}
        <div className="spacer" />
        <button className="lx-tool" onClick={makeFrame} title={t('Frame the selected nodes (F)')}>
          <BoxSelect size={13} /> {t('Frame')} <kbd>F</kbd>
        </button>
        <button className="lx-tool" onClick={copy} disabled={!sel.size && !selFrame} title={`${t('Copy')} (${modKey('C')})`}>
          <Copy size={13} /> {t('Copy')}
        </button>
        <button className="lx-tool" onClick={paste} disabled={!canPaste} title={`${t('Paste')} (${modKey('V')})`}>
          <ClipboardPaste size={13} /> {t('Paste')}
        </button>
        {!proj && (
          <>
            <button className="lx-tool" onClick={askSave} disabled={!sel.size && !selFrame} title={t('Save the selection in the library')}>
              <BookMarked size={13} /> {t('Save')}
            </button>
            <button className="lx-tool" onClick={() => setModal({ kind: 'presets' })}>
              <Sparkles size={13} /> {t('Presets')}
            </button>
          </>
        )}
      </CanvasHeader>
      <div className="logic-body">
        <aside className="lx-pal">
          <div className="lx-search">
            <Search size={13} />
            <input ref={searchRef} value={search} placeholder={t('Search')} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
            <kbd>{modKey('K')}</kbd>
          </div>
          <Segmented
            value={scope}
            onChange={(s) => {
              setScope(s);
              setDisplayPref('logic.scope', s);
            }}
            options={[
              { value: 'here', label: t('Useful here') },
              { value: 'all', label: t('All') },
              { value: 'fav', label: '★' },
            ]}
          />
          <div className="lx-types">
            {TYPES.map((ty) => (
              <button key={ty.id} className={`lx-ty t-${ty.id} ${typeFilter === ty.id ? 'on' : ''}`} onClick={() => setTypeFilter(typeFilter === ty.id ? null : ty.id)}>
                <i />
                {t(ty.label)}
              </button>
            ))}
          </div>
          {!proj && scope !== 'fav' && !typeFilter && (!q || /donn|data|sourc|variab|filtr|tri|sort|transf|jeu/.test(q)) && (
            <div className="lx-fam fam-data">
              <button className="lx-famhead" onClick={() => toggleFold('data')}>
                {!folded.includes('data') || q ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <i />
                {t('Data')}
              </button>
              {(!folded.includes('data') || !!q) && data.palette}
            </div>
          )}
          {FAMS.map((f) => {
            const list = shown.filter((e) => e.fam === f.id);
            const total = all.filter((e) => e.fam === f.id).length;
            if (!list.length) return null;
            const open = !folded.includes(f.id) || !!q;
            return (
              <div key={f.id} className={`lx-fam fam-${f.id}`}>
                <button className="lx-famhead" onClick={() => toggleFold(f.id)}>
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <i />
                  {t(f.label)}
                  <em>{list.length === total ? total : `${list.length} / ${total}`}</em>
                </button>
                {open &&
                  list.map((e) => (
                    <div key={e.key} className={`lx-entry ${placed.has(e.key) ? 'placed' : ''}`}>
                      <button onClick={(ev) => ev.detail < 2 && addEntry(e)} title={t('Add')}>
                        <e.icon size={13} />
                        <strong>{e.fam === 'layer' || e.fam === 'graphic' || e.fam === 'playlist' ? e.label : t(e.label)}</strong>
                        {placed.has(e.key) ? <em>{t('placed')}</em> : e.note ? <em>{e.note}</em> : null}
                      </button>
                      <button className={`lx-star ${favs.includes(e.key) ? 'on' : ''}`} title={t('Favourite')} onClick={() => toggleFav(e.key)}>
                        <Star size={11} />
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
          {(() => {
            const mine: (LogicFlow & { scope: string })[] = [...projectFlows.map((f) => ({ ...f, scope: t('project') })), ...shared.map((f) => ({ ...f, scope: t('shared flow') }))].filter((f) => scope !== 'fav' && !typeFilter && (!q || fold(f.name).includes(q)));
            if (!mine.length) return null;
            const open = !folded.includes('mine') || !!q;
            return (
              <div className="lx-fam fam-mine">
                <button className="lx-famhead" onClick={() => toggleFold('mine')}>
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <i />
                  {t('My flows')}
                  <em>{mine.length}</em>
                </button>
                {open &&
                  mine.map((f) => (
                    <div key={f.id} className="lx-entry">
                      <button onClick={() => startInsert(f.clip, f.name, false)} title={t('Insert')}>
                        <BookMarked size={13} />
                        <strong>{f.name}</strong>
                        <em>{f.scope}</em>
                      </button>
                    </div>
                  ))}
              </div>
            );
          })()}
          {!shown.length && <div className="lx-none">{t('No node')}</div>}
        </aside>
        <div {...cv.viewport} className={`logic-canvas ${cv.viewport.className}`} tabIndex={0} onPointerDown={onCanvasDown} onKeyDown={onKey}>
          <div className="logic-space" ref={spaceRef} data-canvas-void style={cv.spaceStyle}>
            {dataBox && !proj && (
              <div className="lx-frame lx-dframe" style={{ left: dataBox.x0 - 28, top: dataBox.y0 - 44, width: dataBox.x1 - dataBox.x0 + 56, height: dataBox.y1 - dataBox.y0 + 72 }}>
                <div className="lx-fhead" onPointerDown={dragDataFrame}>
                  <Database size={12} />
                  <strong>{t('Data')}</strong>
                </div>
              </div>
            )}
            {frames.map((f) =>
              f.collapsed ? (
                <div key={f.id} className={`lx-pill ${f.off ? 'off' : ''} ${selFrame === f.id ? 'sel' : ''}`} style={{ left: f.x, top: f.y, ['--fc' as string]: f.color }} onPointerDown={(e) => dragFrame(e, f)}>
                  <span className="lx-pport in" data-pk={`frame:${f.id}|in`} />
                  <i />
                  <strong>{f.name}</strong>
                  <em>{t('{n} nodes', { n: logic.nodes.filter((n) => n.frame === f.id).length })}</em>
                  <button title={t('Unfold')} onClick={() => setFrame(f.id, { collapsed: undefined })}>
                    <ChevronRight size={12} />
                  </button>
                  <span className="lx-pport out" data-pk={`frame:${f.id}|out`} />
                </div>
              ) : (
                <div key={f.id} className={`lx-frame ${f.off ? 'off' : ''} ${selFrame === f.id ? 'sel' : ''}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h, ['--fc' as string]: f.color }}>
                  <div className="lx-fhead" onPointerDown={(e) => dragFrame(e, f)} onDoubleClick={() => setRenaming(f.id)}>
                    <button className="lx-fdot" title={t('Colour')} onClick={() => setFrame(f.id, { color: FRAME_COLORS[(FRAME_COLORS.indexOf(f.color) + 1) % FRAME_COLORS.length] })} />
                    {renaming === f.id ? (
                      <input autoFocus defaultValue={f.name} onBlur={(e) => (setFrame(f.id, { name: e.target.value.trim() || f.name }), setRenaming(null))} onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()} />
                    ) : (
                      <strong>{f.name}</strong>
                    )}
                    <button className={`lx-ftoggle ${f.off ? '' : 'on'}`} title={f.off ? t('Switched off: its nodes do nothing') : t('Switch off')} onClick={() => setFrame(f.id, { off: f.off ? undefined : true })} />
                    <button title={t('Fold')} onClick={() => setFrame(f.id, { collapsed: true })}>
                      <ChevronDown size={12} />
                    </button>
                  </div>
                  {selFrame === f.id && (
                    <div className="lx-fbar" onPointerDown={(e) => e.stopPropagation()}>
                      <button onClick={copy}>
                        <Copy size={11} /> {t('Copy')}
                      </button>
                      <button onClick={() => insertClip(clipOf(new Set(), new Set([f.id])))}>{t('Duplicate')}</button>
                      <button onClick={askSave}>
                        <BookMarked size={11} /> {t('Save in the library')}
                      </button>
                      <button onClick={() => (removeFrame(f.id), setSelFrame(null))} title={t('Remove the frame (its nodes stay)')}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                  <span className="cv-resize" onPointerDown={(e) => resizeFrame(e, f)} />
                </div>
              ),
            )}
            {!proj && data.space}
            <svg className="logic-wires">
              {dataWires.map((w, i) => (
                <path
                  key={`d${i}`}
                  d={curve(w.a, w.b)}
                  className="wire t-text data-key"
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    data.unbind(w.layer, w.row, w.key);
                    // Its « Show in a text » goes with it.
                    if (w.set) edit((l) => void ((l.nodes = l.nodes.filter((x) => x.id !== w.set)), (l.edges = l.edges.filter((e) => e.to !== w.set && e.from !== w.set))));
                  }}
                >
                  <title>{t('Click to remove')}</title>
                </path>
              ))}
              {logic.edges.map((e, i) => {
                const a = at(e.from, 'out', fromPortOf(e));
                const b = at(e.to, 'in', e.port);
                if (!a || !b) return null;
                const fa = collapsedOf(nodes.get(e.from));
                if (fa && fa === collapsedOf(nodes.get(e.to))) return null;
                const ty = typeOfOut(e);
                return (
                  <path
                    key={i}
                    d={curve(a, b)}
                    className={`wire t-${ty} ${sel.has(e.from) || sel.has(e.to) ? 'hot' : ''}`}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      edit((l) => void (l.edges = l.edges.filter((x) => x !== l.edges[i])));
                    }}
                  >
                    <title>{t('Click to remove')}</title>
                  </path>
                );
              })}
              {wire && at(wire.from.node, wire.from.dir, wire.from.port) && (
                <path d={wire.from.dir === 'out' ? curve(at(wire.from.node, 'out', wire.from.port)!, wire) : curve(wire, at(wire.from.node, 'in', wire.from.port)!)} className={`wire live t-${wire.from.type}`} />
              )}
            </svg>
            {logic.nodes.map((n) => {
              if (collapsedOf(n) || hiddenField(n) || shownSets.has(n.id)) return null;
              const k = kindOf(n, template);
              const off = !!n.frame && frames.some((f) => f.id === n.frame && f.off);
              return (
                <div key={n.id} data-node-id={n.id} className={`lx-node fam-${k.fam} ${sel.has(n.id) ? 'sel' : ''} ${off ? 'off' : ''}`} style={{ left: n.x, top: n.y, width: widthOf(n) }} onPointerDown={(e) => dragNodes(e, n)}>
                  <div className="lx-head">
                    <k.icon size={12} />
                    <span className="lx-title">{k.label}</span>
                    {n.type === 'layer' && <small>{t('layer')}</small>}
                    <span className="lx-hv">
                      <Val v={headValue(n)} />
                    </span>
                    <button className="lx-del" title={t('Delete (Del)')} onClick={() => removeNodes(new Set([n.id]))}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {body(n)}
                  <ResizeCorner onPointerDown={(e) => cv.resize(e, (w) => setSize(n.id, w))} />
                </div>
              );
            })}
            {band && <div className="lx-band" style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }} />}
          </div>
          {quick && (
            <div className="lx-quick" style={{ left: quick.sx, top: quick.sy }} onPointerDown={(e) => e.stopPropagation()}>
              <div className="lx-search">
                <Search size={12} />
                <input autoFocus value={qSearch} placeholder={t('Search')} onChange={(e) => setQSearch(e.target.value)} onKeyDown={(e) => (e.key === 'Escape' ? setQuick(null) : e.key === 'Enter' && quickList[0] ? addWired(quickList[0].make) : undefined)} />
              </div>
              <div className="lx-qh">
                <i className={`t-${quick.from.type}`} />
                {quick.from.dir === 'out' ? t('Takes {what}', { what: t(TYPES.find((x) => x.id === quick.from.type)?.label ?? 'a value') }) : t('Gives {what}', { what: t(TYPES.find((x) => x.id === quick.from.type)?.label ?? 'a value') })}
              </div>
              <div className="lx-qlist">
                {quickList.slice(0, 40).map((o) => (
                  <button key={o.key} className={`fam-${o.fam}`} onClick={() => addWired(o.make)}>
                    <i />
                    {o.label}
                    <em>{o.note ?? t(FAMS.find((f) => f.id === o.fam)!.label)}</em>
                  </button>
                ))}
                {!quickList.length && <div className="lx-none">{t('No node')}</div>}
              </div>
            </div>
          )}
          {mini && (
            <div
              className="lx-mini"
              style={{ width: mini.w, height: mini.h }}
              onPointerDown={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const wx = mini.x0 + (e.clientX - r.left) / mini.k;
                const wy = mini.y0 + (e.clientY - r.top) / mini.k;
                const vr = cv.ref.current?.getBoundingClientRect();
                if (vr) cv.setView({ ...cv.view, x: vr.width / 2 - wx * cv.view.zoom, y: vr.height / 2 - wy * cv.view.zoom });
              }}
            >
              {boxes.map((b, i) => (
                <div key={i} className={b.frame ? 'f' : 'n'} style={{ left: (b.x - mini.x0) * mini.k, top: (b.y - mini.y0) * mini.k, width: b.w * mini.k, height: b.h * mini.k, ['--fc' as string]: b.c }} />
              ))}
              <div className="v" style={{ left: (mini.vis.x - mini.x0) * mini.k, top: (mini.vis.y - mini.y0) * mini.k, width: mini.vis.w * mini.k, height: mini.vis.h * mini.k }} />
            </div>
          )}
          {!logic.nodes.length && !frames.length && data.empty && <CanvasVoid icon={Link2} text={t('No relation')} />}
          {cv.controls}
        </div>
      </div>
      {!proj && data.overlays}
      {modal?.kind === 'presets' && (
        <PresetsModal
          template={template}
          onClose={() => setModal(null)}
          onPick={(p) => {
            setModal(null);
            startInsert(p.clip, t(p.name), true);
          }}
        />
      )}
      {modal?.kind === 'save' && <SaveFlowModal name={modal.name} canShare={can.design(user)} onClose={() => setModal(null)} onSave={(n, sc) => void saveFlow(n, sc)} />}
      {modal?.kind === 'insert' && (
        <InsertModal
          name={modal.name}
          needs={modal.needs}
          template={template}
          onClose={() => setModal(null)}
          onInsert={(layers, fields) => {
            const v = cv.visible();
            insertClip(modal.clip, { x: Math.round(v.x + 80), y: Math.round(v.y + 80) }, { layers, fields }, modal.framed ? modal.name : undefined);
            setModal(null);
          }}
        />
      )}
    </div>
    </PortCtx.Provider>
  );
}

/** « Take another graphic »: which one, in or out. */
function TakeBody({ n, template, set }: { n: Extract<LogicNode, { type: 'take' }>; template: Template; set: (patch: Partial<LogicNode>) => void }) {
  const project = useApp((s) => s.project);
  return (
    <>
      <Dropdown value={n.template} placeholder={t('Choose a graphic')} options={(project?.templates ?? []).filter((x) => x.id !== template.id).map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => set({ template: id } as Partial<LogicNode>)} />
      <Segmented
        value={n.out ? 'out' : 'in'}
        onChange={(x) => set({ out: x === 'out' || undefined } as Partial<LogicNode>)}
        options={[
          { value: 'in', label: t('Take') },
          { value: 'out', label: t('Take out') },
        ]}
      />
    </>
  );
}


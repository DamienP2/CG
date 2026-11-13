// A widget built with the Builder, placed in a template (a folder with `widget`, engine/built.ts):
// its control centre made from its definition (the Designer's try-out, the Operator's preview and
// its On air card) and, in the template, its options.
import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeftRight, Check, ChevronsRight, Flag, Minus, Pause, Play, Plus, Puzzle, RefreshCw, RotateCcw, SkipBack, SkipForward, Square, Timer, Trophy, Undo2, X, Zap, type LucideIcon } from 'lucide-react';
import { regenerate, startValue, varKey, type Forward } from '../engine/built';
import { placedLogic } from '../engine/widgetLogic';
import type { BuiltControl, Layer, WidgetDef, WidgetOption } from '../engine/types';
import { api, useApp } from '../store';
import { findLayer, useDesigner } from '../designer/designerStore';
import { openBuilderPage } from '../designer/builder';
import { useDefOf } from '../widgetLibrary';
import { t } from '../i18n';
import { Bound, CentreModeContext, ColorPick, defineWidget, Msg, Num, Row, Section, Seg, setPath, Text, Toggle, useCentreMode, type OperatorProps } from './kit';
import { Centre, SetInput, type Line2Item } from './centre';

/** The icons a control can have (Builder › Controls). */
export const BUILT_ICONS: Record<string, LucideIcon> = {
  play: Play,
  pause: Pause,
  undo: Undo2,
  prev: SkipBack,
  next: SkipForward,
  swap: ArrowLeftRight,
  reset: RotateCcw,
  plus: Plus,
  minus: Minus,
  flag: Flag,
  stop: Square,
  zap: Zap,
  refresh: RefreshCw,
  continue: ChevronsRight,
  check: Check,
  x: X,
  timer: Timer,
  trophy: Trophy,
  puzzle: Puzzle,
};

/** What playing a placed widget needs, from its snapshot (as on air): its definition without elements. */
const fromSnap = (layer: Layer): WidgetDef | undefined => {
  const s = layer.widget?.snap;
  return s ? { width: 0, height: 0, layers: [], options: [], ...s } : undefined;
};

/** The exposure path of a control the Designer chooses to give the Operator. */
export const controlPath = (id: string) => `widget.controls.${id}`;
/** The exposure path of an option. */
export const optionPath = (id: string) => `widget.options.${id}`;

/** A switch shows the variable it switches. */
const shows = (c: BuiltControl) => c.shows ?? c.actions.find((a) => a.op === 'toggle')?.var;
/** A field's hint: a time for a Temps it sets, else nothing. */
const hint = (c: BuiltControl) => c.placeholder ?? (c.actions.some((a) => a.op === 'timer' && a.value === 'set') ? 'mm:ss' : '');

/** Controls grouped by the row they sit in, in their order. */
function byRow(list: BuiltControl[]): [string, BuiltControl[]][] {
  const out: [string, BuiltControl[]][] = [];
  for (const c of list) {
    const row = c.row ?? '';
    const g = out.find(([r]) => r === row);
    if (g) g[1].push(c);
    else out.push([row, [c]]);
  }
  return out;
}

/**
 * The control centre of a built widget. On air its controls go to the server (its Logic runs with the
 * template's); in the Operator's preview they set the take's start values; in the Designer they try
 * them on its values — both through the same Logic, run once by the server (/api/widgets/press).
 */
function BuiltCentre(p: OperatorProps) {
  const lib = useDefOf(p.layer);
  const mode = useCentreMode();
  // The Designer tries the widget as it is now; the Operator plays it as its template was made.
  const def = mode === 'designer' ? (lib ?? fromSnap(p.layer)) : (fromSnap(p.layer) ?? lib);
  return def ? <CentreOf {...p} def={def} /> : null;
}

/** The control centre of the widget `def` placed as `layer`. `builder`: tried in the Builder (its variables by their names, its elements by their ids). */
function CentreOf({ def, layer, data, act, item, setData, builder }: OperatorProps & { def: WidgetDef; builder?: boolean }) {
  const mode = useCentreMode();
  const toast = useApp((s) => s.toast);
  // The widgets' states (Undo) between presses off air.
  const states = useRef<Record<string, unknown>>({});
  const designer = mode === 'designer';
  const sb = layer.settingBindings ?? {};
  // What the Operator gets: every control, but those the Designer chooses (exposed in the template).
  const given = (c: BuiltControl) => !c.choose || designer || !!sb[controlPath(c.id)];
  const run = (c: BuiltControl, typed?: string): void => {
    if (item) return void act(c.id, typed !== undefined ? { value: typed } : undefined);
    // The Designer tries the widget as it is now; the Operator as its template placed it.
    const logic = designer ? placedLogic(def, layer) : (layer.widget?.logic ?? placedLogic(def, layer));
    if (!logic) return;
    api<{ set: Record<string, string>; states: Record<string, unknown>; forward: Forward[] }>('POST', '/api/widgets/press', { logic, widget: layer.id, control: c.id, value: typed ?? '', data, states: states.current })
      .then((r) => {
        states.current = r.states;
        if (designer) {
          // In the Builder: its variables are the template's fields, its elements its layers.
          const own = (k: string, pre: string) => (builder && k.startsWith(pre) ? k.slice(pre.length) : k);
          const set = Object.fromEntries(Object.entries(r.set).map(([k, v]) => [own(k, varKey(layer.id, '')), v]));
          useDesigner.setState((s) => ({ previewData: { ...s.previewData, ...set } }));
          // Its Temps are tried too.
          for (const f of r.forward) void useDesigner.getState().actWidget(own(f.layer, `${layer.id}/`), f.op, f.args);
        } else setData?.(r.set);
      })
      .catch((e: Error) => toast(e.message, 'error'));
  };
  const ask = (c: BuiltControl) => (item && c.confirm ? t('{name} is on air: {action}?', { name: layer.name, action: c.label.toLowerCase() }) : undefined);
  const value = (name: string) => data[varKey(layer.id, name)] ?? startValue(def, layer, name);
  const actions: Line2Item[] = def.controls
    .filter((c) => (c.place ?? 'actions') === 'actions' && given(c))
    .map((c) =>
      c.kind === 'field'
        ? { field: true as const, placeholder: hint(c), title: c.label, onSet: (v: string) => run(c, v) }
        : { icon: BUILT_ICONS[c.icon ?? ''] ?? Square, text: c.icon ? undefined : c.label, label: c.label, key: c.key, main: c.main, tone: c.tone, confirm: ask(c), onClick: () => void run(c) },
    );
  const rows = byRow(def.controls.filter((c) => c.place === 'row' && given(c))).map(([row, cs]) => (
    <div key={row} className="cc-team">
      <span className="cc-tn">{row}</span>
      {cs.map((c) => (
        <button key={c.id} className="cc-sq txt" title={c.key ? `${c.label} · ${c.key}` : c.label} onClick={() => void run(c)}>
          <span className="cc-txt">{c.label}</span>
        </button>
      ))}
    </div>
  ));
  const one = (c: BuiltControl): ReactNode =>
    c.kind === 'field' ? (
      <SetInput key={c.id} placeholder={hint(c)} title={c.label} onSet={(v) => run(c, v)} />
    ) : c.kind === 'toggle' ? (
      <button key={c.id} className={`wk-tog ${shows(c) && ['true', '1'].includes(value(shows(c)!)) ? 'on' : ''}`} title={c.label} onClick={() => void run(c)}>
        <i />
      </button>
    ) : (
      <button key={c.id} className="cc-sq txt" title={c.label} onClick={() => void run(c)}>
        <span className="cc-txt">{c.label}</span>
      </button>
    );
  const settings = byRow(def.controls.filter((c) => c.place === 'settings' && given(c))).map(([row, cs]) => {
    const chosen = cs.filter((c) => c.choose).map((c) => controlPath(c.id));
    return (
      <Row key={row} label={row} expose={chosen.length ? chosen : undefined} exposeValue={chosen.length > 1 ? Object.fromEntries(chosen.map((p) => [p, true])) : true}>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{cs.map(one)}</span>
      </Row>
    );
  });
  return (
    <Centre name={layer.name} actions={actions} rows={rows.length ? rows : undefined} l3Air>
      {settings.length ? settings : undefined}
    </Centre>
  );
}

/** The widget being built, as one layer (its variables keyed as in a template). */
const TRY_ID = 'builder';

/** In the Builder: the control centre its controls make (the Operator's preview and its On air card), tried on the stage. */
export function BuiltTry({ def }: { def: WidgetDef }) {
  const previewData = useDesigner((s) => s.previewData);
  const layer = { id: TRY_ID, name: def.name, type: 'group', parent: null, visible: true, locked: false, props: {}, tracks: {}, bindings: {}, widget: { def: def.id, vars: {}, options: {} } } as unknown as Layer;
  const data = Object.fromEntries(def.vars.map((v) => [varKey(TRY_ID, v.name), previewData[v.name] ?? v.initial]));
  return (
    <div className="pp-try">
      <CentreModeContext.Provider value="designer">
        <CentreOf def={def} layer={layer} data={data} act={() => {}} state={undefined} time={{ nowMs: Date.now(), ageSecs: 0, defaultTz: '' }} builder />
      </CentreModeContext.Provider>
    </div>
  );
}

/** One option of the widget in the template's inspector (its exposure radio at the end). */
function OptionRow({ o }: { o: WidgetOption }) {
  const path = `widget.options.${o.id}`;
  if (o.kind === 'color') return <ColorPick label={o.name} path={path} value={String(o.default ?? '')} />;
  if (o.kind === 'number') return <Num label={o.name} path={path} value={Number(o.default ?? 0)} />;
  if (o.kind === 'bool') return <Toggle label={o.name} path={path} value={!!o.default} />;
  if (o.kind === 'choice' && o.choices?.length) return <Seg label={o.name} path={path} value={String(o.default ?? '')} options={o.choices} />;
  return <Text label={o.name} path={path} value={String(o.default ?? '')} />;
}

/** In a template: Edit the widget (the Builder), then its options as this template sets them. */
function BuiltInspector({ layer, data }: { layer: Layer; data: Record<string, string> }) {
  const def = useDefOf(layer);
  const update = useDesigner((s) => s.update);
  const tplId = useDesigner((s) => s.template?.id);
  // An option exposed or no longer: its elements are bound to the Operator's value (or not).
  const exposure = JSON.stringify(Object.keys(layer.settingBindings ?? {}).filter((k) => k.startsWith('widget.options.')));
  const was = useRef(exposure);
  useEffect(() => {
    if (!def || was.current === exposure) return;
    was.current = exposure;
    update((tpl) => void (tpl.layers = regenerate(tpl.layers, layer.id, def)));
  }, [exposure, def, layer.id, update]);
  if (!def) return <Msg level="warn">{t('This widget is no longer in the project.')}</Msg>;
  const set = (path: string, v: unknown, coalesce?: boolean) =>
    update(
      (tpl) => {
        const f = findLayer(tpl, layer.id);
        if (!f) return;
        setPath(f, path, v);
        tpl.layers = regenerate(tpl.layers, layer.id, def);
      },
      coalesce ? `wopt-${layer.id}-${path}` : undefined,
    );
  const groups: [string, WidgetOption[]][] = [];
  for (const o of def.options) {
    const g = groups.find(([n]) => n === (o.group ?? ''));
    if (g) g[1].push(o);
    else groups.push([o.group ?? '', [o]]);
  }
  return (
    <>
      <div className="wk-wbar">
        <button className="btn small" onClick={() => void openBuilderPage(def.id, { fromTemplate: tplId })}>
          <Puzzle size={13} /> {t('Edit the widget')}
        </button>
      </div>
      <Bound obj={layer} set={set} data={data}>
        {groups.map(([g, list]) => (
          <Section key={g} id={`wopt-${g}`} title={g || t('Options')}>
            {list.map((o) => (
              <OptionRow key={o.id} o={o} />
            ))}
          </Section>
        ))}
      </Bound>
    </>
  );
}

export default defineWidget({
  id: 'built',
  type: 'group',
  label: 'Widget',
  group: 'Data',
  icon: Puzzle,
  create: () => ({}),
  ownsLook: true,
  quiet: true,
  Inspector: ({ layer, data }) => <BuiltInspector layer={layer as unknown as Layer} data={data} />,
  Operator: (p) => <BuiltCentre {...(p as OperatorProps)} />,
  controls: (l) => !!(l as unknown as Layer).widget,
});

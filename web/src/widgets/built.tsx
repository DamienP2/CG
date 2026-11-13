// A widget built with the Builder, placed in a template (a folder with `widget`, engine/built.ts):
// its control centre made from its definition (the Designer's try-out, the Operator's preview and
// its On air card) and, in the template, its options.
import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeftRight, Check, ChevronsRight, Flag, Minus, Pause, Play, Plus, Puzzle, RefreshCw, RotateCcw, SkipBack, SkipForward, Square, Timer, Trophy, Undo2, X, Zap, type LucideIcon } from 'lucide-react';
import { act as builtAct, regenerate, startValue, varKey, type BuiltState } from '../engine/built';
import type { BuiltControl, Layer, WidgetDef, WidgetOption } from '../engine/types';
import { useApp } from '../store';
import { findLayer, useDesigner } from '../designer/designerStore';
import { openBuilder } from '../designer/builder';
import { t } from '../i18n';
import { Bound, ColorPick, defineWidget, Msg, Num, Row, Section, Seg, setPath, Text, Toggle, useCentreMode, type OperatorProps } from './kit';
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

/** The definition of the widget placed as `layer` (in the open project). */
export function useWidgetDef(layer: Layer | undefined): WidgetDef | undefined {
  return useApp((s) => (layer?.widget ? s.project?.widgets?.find((d) => d.id === layer.widget!.def) : undefined));
}

/** The exposure path of a control the Designer chooses to give the Operator. */
export const controlPath = (id: string) => `widget.controls.${id}`;
/** The exposure path of an option. */
export const optionPath = (id: string) => `widget.options.${id}`;

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
 * The control centre of a built widget. On air its controls go to the server (built::act); in the
 * Operator's preview they set the take's start values; in the Designer they try them on its values.
 */
function BuiltCentre({ layer, data, act, item, setData }: OperatorProps) {
  const def = useWidgetDef(layer);
  const mode = useCentreMode();
  const toast = useApp((s) => s.toast);
  const st = useRef<BuiltState | undefined>(undefined);
  if (!def) return null;
  const designer = mode === 'designer';
  const sb = layer.settingBindings ?? {};
  // What the Operator gets: every control, but those the Designer chooses (exposed in the template).
  const given = (c: BuiltControl) => !c.choose || designer || !!sb[controlPath(c.id)];
  const run = (c: BuiltControl, typed?: string): string | void => {
    if (item) return void act(c.id, typed !== undefined ? { value: typed } : undefined);
    try {
      const r = builtAct(def, layer, data, st.current, c.id, typed);
      st.current = r.state;
      if (designer) {
        useDesigner.setState((s) => ({ previewData: { ...s.previewData, ...r.set } }));
        // Its Temps are tried too.
        for (const f of r.forward) void useDesigner.getState().actWidget(f.layer, f.op, f.args);
      } else setData?.(r.set);
    } catch (e) {
      const m = (e as Error).message;
      toast(m, 'error');
      return m;
    }
  };
  const ask = (c: BuiltControl) => (item && c.confirm ? t('{name} is on air: {action}?', { name: layer.name, action: c.label.toLowerCase() }) : undefined);
  const value = (name: string) => data[varKey(layer.id, name)] ?? startValue(def, layer, name);
  const actions: Line2Item[] = def.controls
    .filter((c) => (c.place ?? 'actions') === 'actions' && given(c))
    .map((c) =>
      c.kind === 'field'
        ? { field: true as const, placeholder: c.placeholder ?? '', title: c.label, onSet: (v: string) => run(c, v) }
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
      <SetInput key={c.id} placeholder={c.placeholder ?? ''} title={c.label} onSet={(v) => run(c, v)} />
    ) : c.kind === 'toggle' ? (
      <button key={c.id} className={`wk-tog ${c.shows && ['true', '1'].includes(value(c.shows)) ? 'on' : ''}`} title={c.label} onClick={() => void run(c)}>
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
  const def = useWidgetDef(layer);
  const update = useDesigner((s) => s.update);
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
        <button className="btn small" onClick={() => openBuilder(def.id)}>
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

// The Builder's panels (the widget being made, open in the Designer): on the left the widget and
// its variables, in the toolbar the way back to the template, on the right Element / Options /
// Controls.
import { useState } from 'react';
import { ArrowLeft, ChevronRight, Hash, List, Plus, SlidersHorizontal, ToggleLeft, Trash2, Type } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { newId } from '../engine/evaluate';
import { readPath } from '../engine/settings';
import type { BuiltControl, CtlAction, Layer, Template, WidgetOption, WidgetVar } from '../engine/types';
import { t } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { BUILT_ICONS } from '../widgets/built';
import { builderHooks, Section } from '../widgets/kit';
import { closeBuilder, varFields } from './builder';
import { findLayer, useDesigner } from './designerStore';
import { Inspector } from './Inspector';

const update = (fn: (t: Template) => void, key?: string) => useDesigner.getState().update(fn, key);
/** Changes the widget's definition (the variables also as the template's fields, for its texts). */
const edit = (fn: (b: NonNullable<Template['builder']>, t: Template) => void, key?: string) =>
  update((tpl) => {
    if (!tpl.builder) return;
    fn(tpl.builder, tpl);
    tpl.fields = varFields(tpl.builder.vars);
  }, key);

// ------------------------------------------------------------------ left --

const VAR_ICONS = { number: Hash, text: Type, list: List, bool: ToggleLeft, team: Hash };

/** The widget (its name, where it is kept) and its variables. */
export function BuilderLeft() {
  const tpl = useDesigner((s) => s.template);
  const [open, setOpen] = useState<string | null>(null);
  if (!tpl?.builder) return null;
  const b = tpl.builder;
  const add = () => {
    const taken = new Set(b.vars.map((v) => v.name));
    let n = b.vars.length + 1;
    while (taken.has(`valeur_${n}`)) n++;
    const name = `valeur_${n}`;
    edit((d) => void d.vars.push({ name, kind: 'number', initial: '0' }));
    setOpen(name);
  };
  const setVar = (name: string, patch: Partial<WidgetVar>) => edit((d) => void (d.vars = d.vars.map((v) => (v.name === name ? { ...v, ...patch } : v))), `var-${name}`);
  return (
    <>
      <section className="project-panel">
        <header>
          <span>{t('Widget')}</span>
        </header>
        <div className="pjp-body">
          <input className="bl-name" value={tpl.name} onChange={(e) => update((d) => void (d.name = e.target.value), 'builder-name')} />
          <div className="bl-row">
            <span className="prop-label">{t('Kept in')}</span>
            <div className="segmented">
              <button type="button" className={b.shared ? '' : 'on'} onClick={() => edit((d) => void delete d.shared)}>
                {t('Kept in: project')}
              </button>
              <button type="button" className={b.shared ? 'on' : ''} onClick={() => edit((d) => void (d.shared = true))}>
                {t('Kept in: shared')}
              </button>
            </div>
          </div>
        </div>
      </section>
      <div className="template-list bl-vars">
        <header>
          <span>{t('Variables')}</span>
          <div className="header-actions">
            <button className="opx-add" title={t('New variable')} onClick={add}>
              <Plus size={14} />
            </button>
          </div>
        </header>
        {b.vars.map((v) => {
          const Icon = VAR_ICONS[v.kind ?? 'text'] ?? Hash;
          return (
            <div key={v.name} className={`bl-var ${open === v.name ? 'open' : ''}`}>
              <button className="bl-var-head" onClick={() => setOpen(open === v.name ? null : v.name)}>
                <span className="bl-vic">
                  <Icon size={14} />
                </span>
                <span className="bl-vtext">
                  <span className="mono">{v.name}</span>
                  <em>{v.list?.length ? v.list.join(' · ') : v.initial || '—'}</em>
                </span>
                <ChevronRight size={13} className="bl-chev" />
              </button>
              {open === v.name && (
                <div className="bl-var-body">
                  <label className="bl-row">
                    <span className="prop-label">{t('Name')}</span>
                    <input
                      className="mono"
                      defaultValue={v.name}
                      onBlur={(e) => {
                        const n = e.target.value.trim().replace(/[^A-Za-z0-9_]/g, '_');
                        if (n && n !== v.name && !b.vars.some((x) => x.name === n)) {
                          setVar(v.name, { name: n });
                          setOpen(n);
                        }
                      }}
                    />
                  </label>
                  <div className="bl-row">
                    <span className="prop-label">{t('Kind')}</span>
                    <Dropdown
                      value={v.kind ?? 'text'}
                      options={[
                        { value: 'number', label: t('Number') },
                        { value: 'text', label: t('Text') },
                        { value: 'list', label: t('List') },
                        { value: 'bool', label: t('Yes / no') },
                      ]}
                      onChange={(k) => setVar(v.name, { kind: k as WidgetVar['kind'], ...(k === 'list' && !v.list?.length ? { list: [v.initial || 'A'] } : {}) })}
                    />
                  </div>
                  {v.kind === 'list' && (
                    <label className="bl-row">
                      <span className="prop-label">{t('Values')}</span>
                      <input defaultValue={(v.list ?? []).join(', ')} onBlur={(e) => setVar(v.name, { list: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                    </label>
                  )}
                  <label className="bl-row">
                    <span className="prop-label">{t('At the start')}</span>
                    <input value={v.initial} onChange={(e) => setVar(v.name, { initial: e.target.value })} />
                  </label>
                  <div className="bl-row">
                    <span className="prop-label">{t('After air')}</span>
                    <div className="segmented">
                      <button type="button" className={v.keep === false ? '' : 'on'} onClick={() => setVar(v.name, { keep: undefined })}>
                        {t('Kept')}
                      </button>
                      <button type="button" className={v.keep === false ? 'on' : ''} onClick={() => setVar(v.name, { keep: false })}>
                        {t('Starts again')}
                      </button>
                    </div>
                  </div>
                  <button className="btn small ghost danger" onClick={() => edit((d) => void (d.vars = d.vars.filter((x) => x.name !== v.name)))}>
                    <Trash2 size={13} /> {t('Delete')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// --------------------------------------------------------------- toolbar --

/** Back to the template the widget is in, and its name. */
export function BuilderCrumb() {
  const { builder, name } = useDesigner(useShallow((s) => ({ builder: s.builder, name: s.template?.name ?? '' })));
  const back = useDesigner((s) => s.builder?.back);
  return (
    <div className="format-bar bl-crumb">
      <button title={t('Back to the template')} onClick={() => void closeBuilder()}>
        <ArrowLeft size={14} /> {back ? t('Template') : t('Templates')}
      </button>
      <ChevronRight size={14} className="bl-sep" />
      <button className="on" title={builder?.defId}>
        {BUILT_ICONS.puzzle && <BUILT_ICONS.puzzle size={14} />} {name}
      </button>
    </div>
  );
}

// ----------------------------------------------------------------- right --

/** A row's button in the Builder: publishes the property as an option of the widget (or removes it). */
export function OptionToggle({ layer, paths, label, value }: { layer: Layer; paths: readonly string[]; label?: string; value?: unknown }) {
  const tpl = useDesigner((s) => s.template);
  if (!tpl?.builder) return null;
  const has = (o: WidgetOption, p: string) => o.targets.some((x) => x.layer === layer.id && x.path === p);
  const mine = tpl.builder.options.filter((o) => paths.some((p) => has(o, p)));
  const on = mine.length > 0;
  const toggle = () =>
    edit((b) => {
      if (on) {
        b.options = b.options.map((o) => ({ ...o, targets: o.targets.filter((x) => !(x.layer === layer.id && paths.includes(x.path))) })).filter((o) => o.targets.length);
        return;
      }
      for (const p of paths) {
        const cur = readPath(layer, p) ?? value;
        const hex = (c: unknown) => (Array.isArray(c) ? `#${c.slice(0, 3).map((v: number) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : c);
        const kind: WidgetOption['kind'] = Array.isArray(cur) ? 'color' : typeof cur === 'number' ? 'number' : typeof cur === 'boolean' ? 'bool' : /font/i.test(p) ? 'font' : 'text';
        b.options.push({ id: newId(), name: label || p.split('.').pop() || p, group: layer.name, kind, default: kind === 'color' ? hex(cur) : cur, targets: [{ layer: layer.id, path: p }] });
      }
    });
  return (
    <button className={`pp-op bl-opt ${on ? 'on' : ''}`} title={on ? t('Option of the widget ({names}) · click to remove', { names: mine.map((o) => o.name).join(', ') }) : t('Publish as an option of the widget')} onClick={toggle}>
      <SlidersHorizontal size={13} />
    </button>
  );
}

/** The widget's options: what the Designer will set in a template, and what each drives. */
function OptionsPane() {
  const tpl = useDesigner((s) => s.template)!;
  const select = useDesigner((s) => s.select);
  const b = tpl.builder!;
  const groups: [string, WidgetOption[]][] = [];
  for (const o of b.options) {
    const g = groups.find(([n]) => n === (o.group ?? ''));
    if (g) g[1].push(o);
    else groups.push([o.group ?? '', [o]]);
  }
  const setOpt = (id: string, patch: Partial<WidgetOption>) => edit((d) => void (d.options = d.options.map((o) => (o.id === id ? { ...o, ...patch } : o))), `opt-${id}`);
  if (!b.options.length) return <div className="bl-empty">{t('Select an element, then publish its properties with')} <SlidersHorizontal size={12} /></div>;
  return (
    <>
      {groups.map(([g, list]) => (
        <Section key={g} id={`bopt-${g}`} title={g || t('Options')}>
          {list.map((o) => (
            <div key={o.id} className="row wk-row bl-optrow">
              <span className="wk-gut" />
              <input className="bl-optname" value={o.name} onChange={(e) => setOpt(o.id, { name: e.target.value })} />
              <div className="wk-ctl">
                <div className="bl-links">
                  {o.targets.map((x) => {
                    const l = findLayer(tpl, x.layer);
                    return (
                      <button key={`${x.layer}-${x.path}`} className="wk-chip bl-link" onClick={() => select([x.layer])}>
                        {l?.name ?? x.layer} · {x.path.replace(/^props\./, '')}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button className="icon-btn ghost" title={t('Remove the option')} onClick={() => edit((d) => void (d.options = d.options.filter((x) => x.id !== o.id)))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </Section>
      ))}
    </>
  );
}

const OPS: [CtlAction['op'], string][] = [
  ['add', 'Add to'],
  ['set', 'Set'],
  ['toggle', 'Switch'],
  ['next', 'Next value of'],
  ['prev', 'Previous value of'],
  ['cycle', 'Next value (round) of'],
  ['reset', 'Back to the start'],
  ['undo', 'Undo'],
  ['timer', 'Temps'],
];
const TIMER_OPS: [string, string][] = [
  ['toggle', 'Play / Pause'],
  ['start', 'Play'],
  ['pause', 'Pause'],
  ['reset', 'Reset'],
  ['restart', 'Restart'],
  ['adjust', '± seconds'],
  ['set', 'Set to'],
];

/** The widget's controls: the Operator's buttons, rows and fields, and what each does. */
function ControlsPane() {
  const tpl = useDesigner((s) => s.template)!;
  const b = tpl.builder!;
  const [sel, setSel] = useState<string | null>(b.controls[0]?.id ?? null);
  const c = b.controls.find((x) => x.id === sel);
  const setCtl = (id: string, patch: Partial<BuiltControl>) => edit((d) => void (d.controls = d.controls.map((x) => (x.id === id ? { ...x, ...patch } : x))), `ctl-${id}`);
  const setAct = (i: number, patch: Partial<CtlAction>) => c && setCtl(c.id, { actions: c.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const add = () => {
    const id = newId();
    edit((d) => void d.controls.push({ id, label: t('Button'), place: 'actions', actions: [] }));
    setSel(id);
  };
  const temps = tpl.layers.filter((l) => l.type === 'clock');
  const vars = b.vars.map((v) => ({ value: v.name, label: v.name }));
  const place = (x: BuiltControl) => x.place ?? 'actions';
  const groups: [string, BuiltControl[]][] = [
    [t('Buttons'), b.controls.filter((x) => place(x) === 'actions')],
    [t('Rows of buttons'), b.controls.filter((x) => place(x) === 'row')],
    [t('Settings'), b.controls.filter((x) => place(x) === 'settings')],
  ];
  return (
    <>
      {groups.map(([g, list]) =>
        list.length ? (
          <Section key={g} id={`bctl-${g}`} title={g}>
            {list.map((x) => {
              const Icon = x.icon ? BUILT_ICONS[x.icon] : undefined;
              return (
                <button key={x.id} className={`row wk-row bl-ctl ${sel === x.id ? 'sel' : ''}`} onClick={() => setSel(x.id)}>
                  <span className="bl-ic">{Icon ? <Icon size={14} /> : <span className="cc-txt">{x.label}</span>}</span>
                  <span className="prop-label">{x.row ? `${x.row} · ${x.label}` : x.label}</span>
                  <span className="bl-act">{x.actions.map(actionText).join(' · ') || '—'}</span>
                  {x.key ? <kbd className="kc">{x.key}</kbd> : <span />}
                </button>
              );
            })}
          </Section>
        ) : null,
      )}
      <div className="bl-addrow">
        <button className="btn small" onClick={add}>
          <Plus size={13} /> {t('Control')}
        </button>
      </div>
      {c && (
        <Section id="bctl-edit" title={`${t('Control')} · ${c.label}`}>
          <div className="bl-form">
            <label className="bl-row">
              <span className="prop-label">{t('Label')}</span>
              <input value={c.label} onChange={(e) => setCtl(c.id, { label: e.target.value })} />
            </label>
            <div className="bl-row">
              <span className="prop-label">{t('Icon')}</span>
              <Dropdown value={c.icon ?? ''} options={[{ value: '', label: t('Its label') }, ...Object.keys(BUILT_ICONS).map((k) => ({ value: k, label: k }))]} onChange={(v) => setCtl(c.id, { icon: v || undefined })} />
            </div>
            <label className="bl-row">
              <span className="prop-label">{t('Key')}</span>
              <input className="mono bl-key" value={c.key ?? ''} placeholder="—" maxLength={3} onChange={(e) => setCtl(c.id, { key: e.target.value.toUpperCase() || undefined })} />
            </label>
            <div className="bl-row">
              <span className="prop-label">{t('Kind')}</span>
              <div className="segmented">
                {(
                  [
                    ['button', t('Button')],
                    ['field', t('Field')],
                    ['toggle', t('Switch')],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" className={(c.kind ?? 'button') === k ? 'on' : ''} onClick={() => setCtl(c.id, { kind: k === 'button' ? undefined : k })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="bl-row">
              <span className="prop-label">{t('Place')}</span>
              <div className="segmented">
                {(
                  [
                    ['actions', t('Buttons')],
                    ['row', t('Row')],
                    ['settings', t('Settings')],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" className={place(c) === k ? 'on' : ''} onClick={() => setCtl(c.id, { place: k })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {place(c) !== 'actions' && (
              <label className="bl-row">
                <span className="prop-label">{t('Row')}</span>
                <input value={c.row ?? ''} onChange={(e) => setCtl(c.id, { row: e.target.value })} />
              </label>
            )}
            {c.actions.map((a, i) => (
              <div key={i} className="bl-row bl-action">
                <span className="prop-label">{i ? '' : t('Does')}</span>
                <div className="bl-action-ctl">
                  <Dropdown value={a.op} options={OPS.map(([v, l]) => ({ value: v, label: t(l) }))} onChange={(op) => setAct(i, { op: op as CtlAction['op'] })} />
                  {a.op === 'timer' ? (
                    <>
                      <Dropdown value={a.layer ?? ''} options={temps.map((l) => ({ value: l.id, label: l.name }))} onChange={(v) => setAct(i, { layer: v })} />
                      <Dropdown value={a.value ?? 'toggle'} options={TIMER_OPS.map(([v, l]) => ({ value: v, label: t(l) }))} onChange={(v) => setAct(i, { value: v })} />
                      {(a.value === 'adjust' || a.value === 'set') && <input className="bl-val" value={a.arg ?? ''} placeholder={c.kind === 'field' ? '$value' : a.value === 'adjust' ? '10' : '0:30'} onChange={(e) => setAct(i, { arg: e.target.value })} />}
                    </>
                  ) : a.op === 'undo' ? null : (
                    <>
                      <Dropdown value={a.var ?? ''} options={a.op === 'reset' ? [{ value: '', label: t('All') }, ...vars] : vars} onChange={(v) => setAct(i, { var: v })} />
                      {(a.op === 'add' || a.op === 'set') && <input className="bl-val" value={a.value ?? ''} placeholder={c.kind === 'field' ? '$value' : '1'} onChange={(e) => setAct(i, { value: e.target.value })} />}
                    </>
                  )}
                  <button className="icon-btn ghost" title={t('Remove')} onClick={() => setCtl(c.id, { actions: c.actions.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
            <div className="bl-row">
              <span className="prop-label">{c.actions.length ? '' : t('Does')}</span>
              <button className="btn small ghost" onClick={() => setCtl(c.id, { actions: [...c.actions, { op: 'add', var: b.vars[0]?.name ?? '', value: '1' }] })}>
                <Plus size={13} /> {t('Action')}
              </button>
            </div>
            <div className="bl-row">
              <span className="prop-label">{t('Ask on air')}</span>
              <button className={`wk-tog ${c.confirm ? 'on' : ''}`} onClick={() => setCtl(c.id, { confirm: !c.confirm || undefined })}>
                <i />
              </button>
            </div>
            <div className="bl-row">
              <span className="prop-label">{t('The Designer chooses')}</span>
              <button className={`wk-tog ${c.choose ? 'on' : ''}`} onClick={() => setCtl(c.id, { choose: !c.choose || undefined })}>
                <i />
              </button>
            </div>
            <button className="btn small ghost danger" onClick={() => edit((d) => void (d.controls = d.controls.filter((x) => x.id !== c.id)))}>
              <Trash2 size={13} /> {t('Delete the control')}
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

/** What an action does, in a few words. */
function actionText(a: CtlAction): string {
  if (a.op === 'timer') return `${a.layer ?? ''} : ${a.value ?? ''}${a.arg ? ` ${a.arg}` : ''}`;
  if (a.op === 'add') return `${a.var} + ${a.value}`;
  if (a.op === 'set') return `${a.var} = ${a.value}`;
  if (a.op === 'undo') return t('Undo');
  if (a.op === 'reset') return a.var ? `${a.var} ↺` : t('All ↺');
  return `${a.var} ${a.op === 'prev' ? '←' : a.op === 'toggle' ? '⇄' : '→'}`;
}

/** The right panel of the Builder: the element selected, the options, the controls. */
export function BuilderRight() {
  const [tab, setTab] = useState<'el' | 'opt' | 'ctl'>('el');
  const tpl = useDesigner((s) => s.template);
  const selected = useDesigner((s) => s.selected);
  if (!tpl?.builder) return null;
  return (
    <>
      <div className="segmented bl-tabs">
        {(
          [
            ['el', t('Element')],
            ['opt', t('Options')],
            ['ctl', t('Controls of the widget')],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'el' ? (
        selected.length ? (
          <Inspector />
        ) : (
          <div className="inspector">
            <div className="bl-empty">{t('Select an element')}</div>
          </div>
        )
      ) : (
        <div className="inspector">
          {tab === 'opt' ? <OptionsPane /> : <ControlsPane />}
        </div>
      )}
    </>
  );
}

builderHooks.OptionToggle = OptionToggle;

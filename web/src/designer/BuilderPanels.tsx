// The Builder's panels (the widget being made, open in the Designer): on the left the widget and
// its variables, in the toolbar the way back to the template, on the right Element / Options /
// Controls.
import { useState } from 'react';
import { ArrowLeft, Braces, CaseSensitive, ChevronRight, Hash, Image, List, Palette, Plus, SlidersHorizontal, ToggleLeft, Trash2, Type, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { setOption } from '../engine/built';
import { DEFAULTS, newId, propValue } from '../engine/evaluate';
import { readPath, writePath } from '../engine/settings';
import type { BuiltControl, CtlAction, Layer, Prop, Template, WidgetOption, WidgetVar } from '../engine/types';
import { t } from '../i18n';
import { ContextMenu } from '../ui/ContextMenu';
import { Dropdown } from '../ui/Dropdown';
import { BUILT_ICONS, BuiltTry } from '../widgets/built';
import { builderHooks, Section } from '../widgets/kit';
import { closeBuilder, defOf, varFields } from './builder';
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

const VAR_ICONS = { number: Hash, text: Type, list: List, bool: ToggleLeft };

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
            <span className="prop-label">{t('Icon')}</span>
            <Dropdown value={b.icon ?? 'puzzle'} options={ICON_OPTIONS()} onChange={(v) => edit((d) => void (d.icon = v))} />
          </div>
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

/** The kind of option a property makes (from its value). */
function optionKind(value: unknown, path: string): WidgetOption['kind'] {
  return Array.isArray(value) ? 'color' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : /font/i.test(path) ? 'font' : 'text';
}

/** The options' group of an element: its outermost folder in the widget (Équipe 1…), else none. */
function groupOf(tpl: Template, layer: Layer): string | undefined {
  let name: string | undefined;
  for (let f = layer.parent ? findLayer(tpl, layer.parent) : undefined; f; f = f.parent ? findLayer(tpl, f.parent) : undefined) name = f.name;
  return name;
}

/**
 * A row's button in the Builder: publishes the property as an option of the widget, a new one or
 * one already there of its kind (one option, several elements), or removes it.
 */
export function OptionToggle({ layer, paths, label, value, chip }: { layer: Layer; paths: readonly string[]; label?: string; value?: unknown; /** A chip with its word (under a text). */ chip?: boolean }) {
  const tpl = useDesigner((s) => s.template);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!tpl?.builder) return null;
  const has = (o: WidgetOption, p: string) => o.targets.some((x) => x.layer === layer.id && x.path === p);
  const mine = tpl.builder.options.filter((o) => paths.some((p) => has(o, p)));
  const on = mine.length > 0;
  // A property's value: the layer's, else its default (a property the layer does not set yet).
  const valueOf = (p: string): unknown => {
    const v = readPath(layer, p);
    if (v !== undefined) return v;
    if (p.startsWith('props.') && p.slice(6) in DEFAULTS) return propValue(layer, p.slice(6) as Prop, 0);
    return paths.length === 1 ? value : (value as Record<string, unknown> | undefined)?.[p];
  };
  const kind = optionKind(valueOf(paths[0]), paths[0]);
  const same = tpl.builder.options.filter((o) => o.kind === kind);
  const create = () =>
    edit((b) => {
      for (const p of paths) {
        const cur = valueOf(p);
        const hex = (c: unknown) => (Array.isArray(c) ? `#${c.slice(0, 3).map((v: number) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : c);
        const k = optionKind(cur, p);
        b.options.push({ id: newId(), name: label || p.split('.').pop() || p, group: groupOf(tpl, layer), kind: k, default: k === 'color' ? hex(cur) : cur, targets: [{ layer: layer.id, path: p }] });
      }
    });
  // Joined to an option: the element takes its value.
  const link = (o: WidgetOption) =>
    edit((b, d) => {
      b.options = b.options.map((x) => (x.id === o.id ? { ...x, targets: [...x.targets, ...paths.map((p) => ({ layer: layer.id, path: p }))] } : x));
      const l = findLayer(d, layer.id);
      if (l && o.default !== undefined) for (const p of paths) setOption(l, p, o.default);
    });
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (on) {
      edit((b) => void (b.options = b.options.map((o) => ({ ...o, targets: o.targets.filter((x) => !(x.layer === layer.id && paths.includes(x.path))) })).filter((o) => o.targets.length)));
      return;
    }
    if (!same.length) return create();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <>
      <button className={`${chip ? 'wk-chip op' : 'pp-op'} bl-opt ${on ? 'on' : ''}`} title={on ? t('Option of the widget ({names}) · click to remove', { names: mine.map((o) => o.name).join(', ') }) : t('Publish as an option of the widget')} onClick={toggle}>
        <SlidersHorizontal size={chip ? 12 : 13} />
        {chip && (on ? mine.map((o) => o.name).join(', ') : t('Option'))}
      </button>
      {menu && (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Plus size={13} />, label: t('New option'), run: create },
            null,
            ...same.map((o) => ({ icon: <SlidersHorizontal size={13} />, label: o.group ? `${o.group} · ${o.name}` : o.name, run: () => link(o) })),
          ]}
        />
      )}
    </>
  );
}

/** A variable's name from an element's (« Score 1 » → score_1), not taken yet. */
function varName(base: string, vars: WidgetVar[]): string {
  const b =
    base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'valeur';
  let name = b;
  for (let i = 2; vars.some((v) => v.name === name); i++) name = `${b}_${i}`;
  return name;
}

/**
 * A content's button in the Builder: it shows a variable of the widget (a new one, from its value,
 * or one already there), or its own text again.
 */
export function VarToggle({ layer, path, raw, chip }: { layer: Layer; path: string; raw: string; /** A chip with its word (under a text). */ chip?: boolean }) {
  const tpl = useDesigner((s) => s.template);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!tpl?.builder) return null;
  const vars = tpl.builder.vars;
  const m = /^\{\{\s*(\w+)\s*\}\}$/.exec(raw.trim());
  const cur = m ? vars.find((v) => v.name === m[1]) : undefined;
  const put = (v: string) =>
    update((d) => {
      const l = findLayer(d, layer.id);
      if (l) writePath(l as unknown as Record<string, unknown>, path, v);
    });
  const create = () => {
    const name = varName(layer.name, vars);
    const numeric = raw.trim() !== '' && !Number.isNaN(Number(raw));
    edit((b, d) => {
      b.vars.push({ name, kind: numeric ? 'number' : 'text', initial: raw });
      const l = findLayer(d, layer.id);
      if (l) writePath(l as unknown as Record<string, unknown>, path, `{{${name}}}`);
    });
  };
  const click = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (cur) return put(cur.initial);
    if (!vars.length) return create();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <>
      <button className={`${chip ? 'wk-chip op' : 'pp-op'} ${cur ? 'on' : ''}`} title={cur ? t('Shows the variable {name} · click to stop', { name: cur.name }) : t('Show a variable of the widget')} onClick={click}>
        <Braces size={chip ? 12 : 13} />
        {chip && (cur ? cur.name : t('Variable'))}
      </button>
      {menu && (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Plus size={13} />, label: t('New variable'), run: create },
            null,
            ...vars.map((v) => {
              const I = VAR_ICONS[v.kind ?? 'text'] ?? Hash;
              return { icon: <I size={13} />, label: v.name, run: () => put(`{{${v.name}}}`) };
            }),
          ]}
        />
      )}
    </>
  );
}

const OPTION_ICONS: Record<WidgetOption['kind'], typeof Hash> = { color: Palette, number: Hash, text: Type, font: CaseSensitive, bool: ToggleLeft, choice: List, image: Image };

/** The widget's options: what the Designer will set in a template (its name, its group), and what each drives. */
function OptionsPane() {
  const tpl = useDesigner((s) => s.template)!;
  const select = useDesigner((s) => s.select);
  const [open, setOpen] = useState<string | null>(null);
  const b = tpl.builder!;
  const groups: [string, WidgetOption[]][] = [];
  for (const o of b.options) {
    const g = groups.find(([n]) => n === (o.group ?? ''));
    if (g) g[1].push(o);
    else groups.push([o.group ?? '', [o]]);
  }
  const setOpt = (id: string, patch: Partial<WidgetOption>) => edit((d) => void (d.options = d.options.map((o) => (o.id === id ? { ...o, ...patch } : o))), `opt-${id}`);
  if (!b.options.length) return <div className="bl-empty">{t('Select an element, then publish its properties with')} <SlidersHorizontal size={12} /></div>;
  const where = (x: WidgetOption['targets'][number]) => `${findLayer(tpl, x.layer)?.name ?? x.layer} · ${x.path.replace(/^props\./, '')}`;
  return (
    <>
      {groups.map(([g, list]) => (
        <Section key={g} id={`bopt-${g}`} title={g || t('Options')}>
          {list.map((o) => {
            const Icon = OPTION_ICONS[o.kind] ?? Type;
            return (
              <div key={o.id} className={`bl-var ${open === o.id ? 'open' : ''}`}>
                <button className="bl-var-head" onClick={() => setOpen(open === o.id ? null : o.id)}>
                  <span className="bl-vic">
                    <Icon size={14} />
                  </span>
                  <span className="bl-vtext">
                    <span>{o.name}</span>
                    <em>{o.targets.map(where).join(' · ')}</em>
                  </span>
                  <ChevronRight size={13} className="bl-chev" />
                </button>
                {open === o.id && (
                  <div className="bl-var-body">
                    <label className="bl-row">
                      <span className="prop-label">{t('Name')}</span>
                      <input value={o.name} onChange={(e) => setOpt(o.id, { name: e.target.value })} />
                    </label>
                    <label className="bl-row">
                      <span className="prop-label">{t('Group')}</span>
                      <input list="bl-groups" value={o.group ?? ''} placeholder={t('Options')} onChange={(e) => setOpt(o.id, { group: e.target.value || undefined })} />
                    </label>
                    <div className="bl-row">
                      <span className="prop-label">{t('Drives')}</span>
                      <div className="bl-links">
                        {o.targets.map((x) => (
                          <span key={`${x.layer}-${x.path}`} className="wk-chip bl-link">
                            <button onClick={() => select([x.layer])}>{where(x)}</button>
                            {o.targets.length > 1 && (
                              <button title={t('Remove')} onClick={() => setOpt(o.id, { targets: o.targets.filter((y) => y !== x) })}>
                                <X size={11} />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button className="btn small ghost danger" onClick={() => edit((d) => void (d.options = d.options.filter((x) => x.id !== o.id)))}>
                      <Trash2 size={13} /> {t('Remove the option')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      ))}
      <datalist id="bl-groups">
        {groups.filter(([g]) => g).map(([g]) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </>
  );
}

/** The icons a widget or a control can have, drawn in the list. */
const ICON_OPTIONS = () =>
  Object.entries(BUILT_ICONS).map(([k, I]) => ({ value: k, label: t(ICON_NAMES[k] ?? k), icon: <I size={14} /> }));
const ICON_NAMES: Record<string, string> = {
  play: 'Play',
  pause: 'Pause',
  undo: 'Undo',
  prev: 'Previous',
  next: 'Next',
  swap: 'Swap',
  reset: 'Reset',
  plus: 'Plus',
  minus: 'Minus',
  flag: 'Flag',
  stop: 'Stop',
  zap: 'Flash',
  refresh: 'Refresh',
  continue: 'Continue',
  check: 'Check',
  x: 'Cross',
  timer: 'Timer',
  trophy: 'Trophy',
  puzzle: 'Puzzle',
};

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
  const def = defOf(tpl);
  return (
    <>
      {def && def.controls.length > 0 && <BuiltTry def={def} />}
      {groups.map(([g, list]) =>
        list.length ? (
          <Section key={g} id={`bctl-${g}`} title={g}>
            {list.map((x) => {
              const Icon = x.icon ? BUILT_ICONS[x.icon] : undefined;
              return (
                <button key={x.id} className={`row wk-row bl-ctl ${sel === x.id ? 'sel' : ''}`} onClick={() => setSel(x.id)}>
                  <span className="bl-ic">{Icon ? <Icon size={14} /> : <span className="cc-txt">{x.label}</span>}</span>
                  <span className="prop-label">{x.row ? `${x.row} · ${x.label}` : x.label}</span>
                  <span className="bl-act">{x.actions.map((a) => actionText(a, tpl)).join(' · ') || '—'}</span>
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
              <Dropdown value={c.icon ?? ''} options={[{ value: '', label: t('Its label') }, ...ICON_OPTIONS()]} onChange={(v) => setCtl(c.id, { icon: v || undefined })} />
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
            {place(c) === 'actions' && (c.kind ?? 'button') === 'button' && (
              <div className="bl-row">
                <span className="prop-label">{t('Look')}</span>
                <div className="segmented">
                  {(
                    [
                      ['plain', t('Normal')],
                      ['main', t('Main')],
                      ['red', t('Danger')],
                    ] as const
                  ).map(([k, l]) => (
                    <button key={k} type="button" className={(c.main ? 'main' : c.tone === 'red' ? 'red' : 'plain') === k ? 'on' : ''} onClick={() => setCtl(c.id, { main: k === 'main' || undefined, tone: k === 'red' ? 'red' : undefined })}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
function actionText(a: CtlAction, tpl: Template): string {
  if (a.op === 'timer') {
    const op = TIMER_OPS.find(([v]) => v === a.value)?.[1];
    return `${(a.layer && findLayer(tpl, a.layer)?.name) || a.layer || ''} : ${op ? t(op) : (a.value ?? '')}${a.arg ? ` ${a.arg}` : ''}`;
  }
  if (a.op === 'add') return a.value?.startsWith('-') ? `${a.var} − ${a.value.slice(1)}` : `${a.var} + ${a.value}`;
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
builderHooks.VarToggle = VarToggle;

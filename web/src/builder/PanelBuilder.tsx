// The Widget Builder's Panneau space: the Operator's panel of the widget, built on a grid of 12
// columns — a palette of components, the panel as the Operator sees it in the preview or on air
// (drag a component to move it, its corner to stretch it), and the component chosen.
import { useMemo, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, Hash, Heading, Link2, MousePointerClick, Rows3, SlidersHorizontal, Table2, ToggleLeft, Trash2, type LucideIcon } from 'lucide-react';
import { newId } from '../engine/evaluate';
import { bottomOf, defaultSize, kindOf, packed, panelOf, PANEL_COLS, shownIn, withCells } from '../engine/panelLayout';
import { controlSteps, DIRECT, logicOf } from '../engine/widgetLogic';
import type { BuiltControl, Template, WidgetVar } from '../engine/types';
import { t, tn } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { confirmDialog } from '../ui/dialogs';
import { useDesigner } from '../designer/designerStore';
import { openControlLogic, varFields } from '../designer/builder';
import { cellStyle, ControlView, PANEL_GAP, PANEL_ROW, useWidth } from '../widgets/panel';

type Kind = NonNullable<BuiltControl['kind']>;

/** The palette: what each component is and the variable kind it shows. */
const PALETTE: { kind: Kind; label: string; icon: LucideIcon; hint: string; var?: WidgetVar['kind'] }[] = [
  { kind: 'title', label: 'Title', icon: Heading, hint: 'A heading between groups of controls' },
  { kind: 'button', label: 'Button', icon: MousePointerClick, hint: 'Runs its Logic when pressed' },
  { kind: 'buttons', label: 'Row of buttons', icon: Rows3, hint: 'Several buttons; each gives its text to the Logic (+1, +2, +3…)' },
  { kind: 'number', label: 'Number − / +', icon: Hash, hint: 'Sets a number variable', var: 'number' },
  { kind: 'dropdown', label: 'Dropdown', icon: ChevronDown, hint: 'Sets a variable to a choice', var: 'text' },
  { kind: 'toggle', label: 'Switch', icon: ToggleLeft, hint: 'Turns a yes / no variable on or off', var: 'bool' },
  { kind: 'slider', label: 'Slider', icon: SlidersHorizontal, hint: 'Sets a number between two values', var: 'number' },
  { kind: 'field', label: 'Text field', icon: CaseSensitive, hint: 'The Operator types a value', var: 'text' },
  { kind: 'list', label: 'Table', icon: Table2, hint: 'The rows of a list of elements, edited by the Operator', var: 'rows' },
];

const update = (fn: (t: Template) => void, key?: string) => useDesigner.getState().update(fn, key);
/** Changes the widget's controls, each with its cell from then on. */
const editControls = (fn: (cs: BuiltControl[]) => BuiltControl[], key?: string) =>
  update((tpl) => {
    if (!tpl.builder) return;
    tpl.builder.controls = fn(withCells(tpl.builder.controls));
    tpl.fields = varFields(tpl.builder.vars);
  }, key);

export function PanelBuilder() {
  const tpl = useDesigner((s) => s.template);
  const preview = useDesigner((s) => s.previewData);
  const [mode, setMode] = useState<'pvw' | 'air'>('pvw');
  const [sel, setSel] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const width = useWidth(grid);
  const b = tpl?.builder;
  const placed = useMemo(() => (b ? panelOf(b) : []), [b]);
  if (!b || !tpl) return null;
  const def = { ...b, name: tpl.name, layers: tpl.layers };
  const value = (name: string) => preview[name] ?? b.vars.find((v) => v.name === name)?.initial ?? '';
  const rows = Math.max(bottomOf(placed) + 2, 6);
  const c = b.controls.find((x) => x.id === sel);

  const add = (kind: Kind) => {
    const p = PALETTE.find((x) => x.kind === kind)!;
    const v = p.var ? b.vars.find((x) => (x.kind ?? 'text') === p.var) : undefined;
    const ctl: BuiltControl = {
      id: newId(),
      label: t(p.label),
      kind,
      actions: [],
      visible: 'both',
      ...(kind === 'buttons' ? { items: ['−1', '+1', '+2', '+3'] } : {}),
      ...(kind === 'dropdown' ? { items: v?.list?.length ? v.list : [t('Choice 1'), t('Choice 2')] } : {}),
      ...(kind === 'slider' ? { min: 0, max: 100 } : {}),
      ...(kind === 'list' ? (v ? { list: v.name } : {}) : v ? { var: v.name } : {}),
    };
    ctl.grid = { x: 0, y: bottomOf(placed), ...defaultSize(ctl) };
    editControls((cs) => [...cs, ctl]);
    setSel(ctl.id);
  };

  // Drag to move, the corner to stretch: whole cells.
  const drag = (e: React.PointerEvent, id: string, resize: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(id);
    const start = placed.find((p) => p.c.id === id)?.at;
    if (!start || !width) return;
    const col = (width - 11 * PANEL_GAP) / 12 + PANEL_GAP;
    const row = PANEL_ROW + PANEL_GAP;
    const sx = e.clientX;
    const sy = e.clientY;
    const el = e.currentTarget.closest<HTMLElement>('.pb-cell');
    let at = start;
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - sx) / col);
      const dy = Math.round((ev.clientY - sy) / row);
      at = resize ? { ...start, w: Math.max(1, Math.min(PANEL_COLS - start.x, start.w + dx)), h: Math.max(1, start.h + dy) } : { ...start, x: Math.max(0, Math.min(PANEL_COLS - start.w, start.x + dx)), y: Math.max(0, start.y + dy) };
      if (el) Object.assign(el.style, cellStyle(at, width));
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (at !== start) editControls((cs) => cs.map((x) => (x.id === id ? { ...x, grid: at } : x)));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <div className="pb">
      <aside className="pb-side">
        <div className="pb-sec">
          <header>{t('Components')}</header>
          <p className="pb-hint">{t('Click to add one under the panel, then place it on the grid.')}</p>
          <div className="pb-palette">
            {PALETTE.map((p) => (
              <button key={p.kind} className="pb-pal" title={t(p.hint)} onClick={() => add(p.kind)}>
                <p.icon size={17} />
                {t(p.label)}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <div className="pb-main">
        <div className="pb-bar">
          <span className="pb-muted">{t('What the Operator sees')}</span>
          <div className="segmented">
            <button type="button" className={`pvw ${mode === 'pvw' ? 'on' : ''}`} onClick={() => setMode('pvw')}>
              {t('Preview')}
            </button>
            <button type="button" className={`air ${mode === 'air' ? 'on' : ''}`} onClick={() => setMode('air')}>
              {t('On air')}
            </button>
          </div>
          <span className="grow" />
          <span className="pb-muted">{t('Drag to move · the corner to stretch')}</span>
        </div>
        <div className="pb-wrap" onPointerDown={() => setSel(null)}>
          <div className="pb-console">
            <header>
              {tpl.name}
              <span className="grow" />
              <span className={`pb-mode ${mode}`}>{mode === 'pvw' ? t('Preview') : t('On air')}</span>
            </header>
            <div className="pb-grid" ref={grid} style={{ height: rows * (PANEL_ROW + PANEL_GAP), ['--col' as string]: `${(width - 11 * PANEL_GAP) / 12 + PANEL_GAP}px`, ['--row' as string]: `${PANEL_ROW + PANEL_GAP}px` }}>
              {width > 0 &&
                placed.map(({ c: x, at }) => {
                  const off = !shownIn(x, mode);
                  return (
                    <div
                      key={x.id}
                      className={`pb-cell wp-cell k-${kindOf(x)} ${sel === x.id ? 'on' : ''} ${off ? 'off' : ''}`}
                      data-off={off ? (mode === 'pvw' ? t('Hidden in Preview') : t('Hidden on air')) : undefined}
                      style={cellStyle(at, width)}
                      onPointerDown={(e) => drag(e, x.id, false)}
                    >
                      <ControlView c={x} def={def} value={value} run={() => {}} setRows={() => {}} inert />
                      <span className="pb-rs" onPointerDown={(e) => drag(e, x.id, true)} />
                    </div>
                  );
                })}
              {!placed.length && <p className="pb-empty">{t('No control yet: add one from the palette.')}</p>}
            </div>
          </div>
          <p className="pb-foot">{tn(packed(placed.filter((p) => shownIn(p.c, mode))).length, '{n} component shown', '{n} components shown')}</p>
        </div>
      </div>
      <aside className="pb-side right">{c ? <ControlInspector c={c} onDeleted={() => setSel(null)} /> : <div className="pb-sec"><p className="pb-hint">{t('Choose a component of the panel to set it.')}</p></div>}</aside>
    </div>
  );
}

/** The component chosen: its label, its variable, its buttons, when it shows, what it does. */
function ControlInspector({ c, onDeleted }: { c: BuiltControl; onDeleted: () => void }) {
  const tpl = useDesigner((s) => s.template)!;
  const b = tpl.builder!;
  const set = (patch: Partial<BuiltControl>, key?: string) => editControls((cs) => cs.map((x) => (x.id === c.id ? { ...x, ...patch } : x)), key);
  const kind = kindOf(c);
  const p = PALETTE.find((x) => x.kind === kind);
  const vars = b.vars.filter((v) => (kind === 'list' ? v.kind === 'rows' : v.kind !== 'rows'));
  const steps = controlSteps(logicOf(b), c.id);
  const direct = DIRECT.has(kind) && !!c.var;
  const newVar = () => {
    const taken = new Set(b.vars.map((v) => v.name));
    const base = c.label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'valeur';
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    const kv = p?.var ?? 'text';
    const v: WidgetVar = { name, kind: kv, initial: kv === 'number' ? '0' : kv === 'bool' ? 'false' : kv === 'rows' ? '[]' : (c.items?.[0] ?? ''), ...(kv === 'rows' ? { columns: [{ name: 'texte', kind: 'text' as const }] } : {}) };
    update((d) => {
      if (!d.builder) return;
      d.builder.vars = [...d.builder.vars, v];
      d.builder.controls = withCells(d.builder.controls).map((x) => (x.id === c.id ? { ...x, ...(kind === 'list' ? { list: name } : { var: name }) } : x));
      d.fields = varFields(d.builder.vars);
    });
  };
  return (
    <>
      <div className="pb-sec">
        <header>
          {p && <p.icon size={14} />} {p ? t(p.label) : kind}
        </header>
        <label className="pb-field">
          <span>{t('Label')}</span>
          <input value={c.label} onChange={(e) => set({ label: e.target.value }, `pb-label-${c.id}`)} />
        </label>
        {(p?.var || kind === 'buttons') && (
          <div className="pb-field">
            <span>{kind === 'buttons' ? t('Shows (optional)') : t('Variable')}</span>
            <div className="pb-line">
              <Dropdown
                value={(kind === 'list' ? c.list : c.var) ?? ''}
                placeholder={t('Choose a variable')}
                options={[...(kind === 'buttons' ? [{ value: '', label: t('None') }] : []), ...vars.map((v) => ({ value: v.name, label: v.name }))]}
                onChange={(v) => set(kind === 'list' ? { list: v || undefined } : { var: v || undefined })}
              />
              {p?.var && (
                <button className="btn small" onClick={newVar} title={t('A new variable for this component')}>
                  {t('New')}
                </button>
              )}
            </div>
          </div>
        )}
        {(kind === 'buttons' || kind === 'dropdown') && (
          <label className="pb-field">
            <span>{kind === 'buttons' ? t('Buttons') : t('Choices')}</span>
            <input defaultValue={(c.items ?? []).join(', ')} key={c.id} onBlur={(e) => set({ items: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </label>
        )}
        {(kind === 'number' || kind === 'slider') && (
          <div className="pb-two">
            <label className="pb-field">
              <span>{t('Minimum')}</span>
              <input type="number" value={c.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : +e.target.value }, `pb-min-${c.id}`)} />
            </label>
            <label className="pb-field">
              <span>{t('Maximum')}</span>
              <input type="number" value={c.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : +e.target.value }, `pb-max-${c.id}`)} />
            </label>
          </div>
        )}
        {kind === 'field' && (
          <label className="pb-field">
            <span>{t('Placeholder')}</span>
            <input value={c.placeholder ?? ''} onChange={(e) => set({ placeholder: e.target.value || undefined }, `pb-ph-${c.id}`)} />
          </label>
        )}
        {kind === 'button' && (
          <div className="pb-field">
            <span>{t('Look')}</span>
            <div className="segmented">
              {(
                [
                  ['plain', t('Normal')],
                  ['main', t('Main')],
                  ['red', t('Danger')],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" className={(k === 'main' ? c.main : k === 'red' ? c.tone === 'red' : !c.main && c.tone !== 'red') ? 'on' : ''} onClick={() => set({ main: k === 'main' || undefined, tone: k === 'red' ? 'red' : undefined })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {kind !== 'title' && (
        <div className="pb-sec">
          <header>{t('Shown')}</header>
          <div className="segmented">
            {(
              [
                ['both', t('Both')],
                ['pvw', t('Preview')],
                ['air', t('On air')],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" className={`${k} ${(c.visible ?? 'both') === k ? 'on' : ''}`} onClick={() => set({ visible: k === 'both' ? undefined : k })}>
                {l}
              </button>
            ))}
          </div>
          <p className="pb-hint">{(c.visible ?? 'both') === 'pvw' ? t('To prepare: the Operator no longer sees it once the widget is on air.') : c.visible === 'air' ? t('Only while the widget is on air.') : t('In the preview it prepares the start values; on air it acts live.')}</p>
          <label className="pb-check">
            <input type="checkbox" checked={!!c.confirm} onChange={(e) => set({ confirm: e.target.checked || undefined })} />
            {t('Ask on air before acting')}
          </label>
          <label className="pb-check">
            <input type="checkbox" checked={!!c.choose} onChange={(e) => set({ choose: e.target.checked || undefined })} />
            {t('The Designer chooses whether the Operator gets it')}
          </label>
          {(kind === 'button' || kind === 'buttons') && (
            <label className="pb-field">
              <span>{t('Key')}</span>
              <input value={c.key ?? ''} maxLength={12} placeholder={t('None')} onChange={(e) => set({ key: e.target.value || undefined }, `pb-key-${c.id}`)} />
            </label>
          )}
        </div>
      )}
      {kind !== 'title' && (
        <div className="pb-sec">
          <header>{t('What it does')}</header>
          {direct && <p className="pb-does">{t('Sets {var} to what the Operator gives.', { var: c.var! })}</p>}
          {kind === 'list' && c.list && <p className="pb-does">{t('Changes the rows of {var}.', { var: c.list })}</p>}
          <p className="pb-hint">{steps ? tn(steps, 'Its Logic: {n} step.', 'Its Logic: {n} steps.') : direct ? t('Its Logic can do more (play an animation…).') : t('Nothing yet: give it a Logic.')}</p>
          <button className="btn small" onClick={() => openControlLogic(c.id)}>
            <Link2 size={13} /> {steps ? t('Open its Logic') : t('Give it a Logic')}
          </button>
        </div>
      )}
      <div className="pb-sec">
        <button
          className="btn small ghost danger"
          onClick={() =>
            void confirmDialog({ title: t('Delete “{name}”?', { name: c.label }), confirm: t('Delete'), danger: true }).then((ok) => {
              if (!ok) return;
              editControls((cs) => cs.filter((x) => x.id !== c.id));
              onDeleted();
            })
          }
        >
          <Trash2 size={13} /> {t('Delete the component')}
        </button>
        {kind === 'list' && !b.vars.some((v) => v.kind === 'rows') && <p className="pb-hint">{t('A table edits a « List of elements » variable.')}</p>}
      </div>
    </>
  );
}

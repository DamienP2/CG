// The Operator's panel of a built widget: its controls on their grid (engine/panelLayout.ts), as the
// Operator uses them (in the preview, on air) and as the Widget Builder shows them.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Square } from 'lucide-react';
import { kindOf, numberOf, packed, panelOf, shownIn, type Placed } from '../engine/panelLayout';
import type { BuiltControl, WidgetDef } from '../engine/types';
import { t } from '../i18n';
import { confirmDialog } from '../ui/dialogs';
import { allRows, type Row as ListRow } from '../designer/rowsVar';
import { ListEditor } from './builtList';
import { SetInput } from './centre';
import { BUILT_ICONS } from './built';

export const PANEL_ROW = 48;
export const PANEL_GAP = 6;

/** Where a cell of the grid sits (px), the panel `width` wide. */
export function cellStyle(at: Placed['at'], width: number): CSSProperties {
  const col = (width - 11 * PANEL_GAP) / 12;
  return { left: at.x * (col + PANEL_GAP), top: at.y * (PANEL_ROW + PANEL_GAP), width: at.w * col + (at.w - 1) * PANEL_GAP, height: at.h * PANEL_ROW + (at.h - 1) * PANEL_GAP };
}

/** The value a control shows as true (a switch). */
const truthy = (v: string) => ['true', '1', 'yes', 'on', 'oui'].includes(String(v).trim().toLowerCase());

export interface PanelProps {
  def: WidgetDef;
  /** A variable's value now (its start value when not set). */
  value: (name: string) => string;
  /** What is shown: the preview's controls, those on air, or every one (the Builder). */
  mode: 'pvw' | 'air' | 'all';
  /** The Operator gets it (the Designer may choose). */
  given?: (c: BuiltControl) => boolean;
  run: (c: BuiltControl, value?: string) => void;
  setRows: (c: BuiltControl, rows: ListRow[]) => void;
  /** On air: controls that ask first do. */
  onAir?: boolean;
  /** The Builder: drawn, not used (its own editor places them). */
  inert?: boolean;
}

/** One control as the Operator uses it. */
export function ControlView({ c, def, value, run, setRows, onAir, inert }: Omit<PanelProps, 'mode' | 'given'> & { c: BuiltControl }): ReactNode {
  const go = async (v?: string) => {
    if (inert) return;
    if (onAir && c.confirm && !(await confirmDialog({ title: t('{name} is on air: {action}?', { name: def.name, action: c.label.toLowerCase() }), confirm: c.label, danger: c.tone === 'red' }))) return;
    run(c, v);
  };
  const cur = c.var ? value(c.var) : '';
  const label = <span className="wp-l">{c.label}</span>;
  switch (kindOf(c)) {
    case 'title':
      return <div className="wp-title">{c.label}</div>;
    case 'buttons':
      return (
        <>
          <span className="wp-l">
            {c.label}
            {c.var && <b className="wp-val">{cur}</b>}
          </span>
          <div className="wp-row">
            {(c.items ?? []).map((it) => (
              <button key={it} className="wp-btn mono" onClick={() => void go(it.replace('−', '-'))}>
                {it}
              </button>
            ))}
          </div>
        </>
      );
    case 'number': {
      const n = Number.isFinite(numberOf(cur)) ? numberOf(cur) : 0;
      const clamp = (x: number) => Math.min(c.max ?? Infinity, Math.max(c.min ?? -Infinity, x));
      return (
        <>
          {label}
          <div className="wp-step">
            <button className="wp-btn" aria-label={t('Minus')} onClick={() => void go(String(clamp(n - 1)))}>
              −
            </button>
            <span className="wp-num">{cur || '0'}</span>
            <button className="wp-btn" aria-label={t('Plus')} onClick={() => void go(String(clamp(n + 1)))}>
              +
            </button>
          </div>
        </>
      );
    }
    case 'dropdown':
      return (
        <>
          {label}
          <select className="wp-select" value={cur} disabled={inert} aria-label={c.label} onChange={(e) => void go(e.target.value)}>
            {!(c.items ?? []).includes(cur) && <option value={cur}>{cur || '—'}</option>}
            {(c.items ?? []).map((it) => (
              <option key={it} value={it}>
                {it}
              </option>
            ))}
          </select>
        </>
      );
    case 'toggle': {
      // A switch tied to a variable shows it; older ones show the variable they name.
      const on = truthy(c.var ? cur : c.shows ? value(c.shows) : '');
      return (
        <div className="wp-tog">
          <button className={`wk-tog ${on ? 'on' : ''}`} aria-pressed={on} title={c.label} onClick={() => void go(c.var ? String(!on) : undefined)}>
            <i />
          </button>
          <span>{c.label}</span>
        </div>
      );
    }
    case 'slider':
      return <SliderView c={c} cur={cur} go={(v) => void go(v)} inert={inert} />;
    case 'field':
      return (
        <>
          {label}
          {inert ? <span className="wp-input">{cur || c.placeholder || ''}</span> : <SetInput placeholder={c.placeholder || cur || ''} title={c.label} width={0} onSet={(v) => void go(v)} />}
        </>
      );
    case 'list': {
      const v = def.vars.find((x) => x.name === c.list);
      return (
        <>
          {label}
          <div className="wp-list">
            <ListEditor cols={v?.columns ?? []} rows={allRows(c.list ? value(c.list) : '[]')} onChange={(r) => !inert && setRows(c, r)} />
          </div>
        </>
      );
    }
    default: {
      const Icon = c.icon ? (BUILT_ICONS[c.icon] ?? Square) : null;
      return (
        <button className={`wp-btn big ${c.main ? 'main' : ''} ${c.tone === 'red' ? 'danger' : ''}`} title={c.key ? `${c.label} · ${c.key}` : c.label} onClick={() => void go()}>
          {Icon && <Icon size={15} />}
          <span>{c.label}</span>
          {c.key && <kbd className="kc">{c.key}</kbd>}
        </button>
      );
    }
  }
}

function SliderView({ c, cur, go, inert }: { c: BuiltControl; cur: string; go: (v: string) => void; inert?: boolean }) {
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  return (
    <>
      <span className="wp-l">
        {c.label} <b className="wp-val">{v}</b>
      </span>
      <input
        className="wp-slider"
        type="range"
        min={c.min ?? 0}
        max={c.max ?? 100}
        value={Number(v) || 0}
        disabled={inert}
        aria-label={c.label}
        onChange={(e) => setV(e.target.value)}
        onPointerUp={() => v !== cur && go(v)}
        onKeyUp={() => v !== cur && go(v)}
      />
    </>
  );
}

/** The width of an element, followed. */
export function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** The widget's panel: its controls on their grid, the rows with nothing shown packed away. */
export function PanelView(p: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const list = packed(panelOf(p.def).filter(({ c }) => shownIn(c, p.mode) && (p.given ? p.given(c) : true)));
  if (!list.length) return <div className="wp-none">{p.mode === 'air' ? t('No control on air.') : t('No control.')}</div>;
  const rows = list.reduce((m, x) => Math.max(m, x.at.y + x.at.h), 0);
  return (
    <div className="wp-grid" ref={ref} style={{ height: rows * (PANEL_ROW + PANEL_GAP) - PANEL_GAP }}>
      {width > 0 &&
        list.map(({ c, at }) => (
          <div key={c.id} className={`wp-cell k-${kindOf(c)}`} style={cellStyle(at, width)}>
            <ControlView c={c} {...p} />
          </div>
        ))}
    </div>
  );
}

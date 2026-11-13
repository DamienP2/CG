// Builder › a variable « List of elements » (kind `rows`): its columns and its rows at the start. Its
// value is a JSON array of objects, one key per column (engine/lists.ts reads it; `on: false` skips a row).
import { Plus, X } from 'lucide-react';
import type { WidgetVar } from '../engine/types';
import { t, tn } from '../i18n';
import { Dropdown } from '../ui/Dropdown';

export type Row = Record<string, string>;
type Column = NonNullable<WidgetVar['columns']>[number];

/** Every row of a list's value (the switched-off ones too). */
export function allRows(value: string | undefined): Row[] {
  try {
    const v = JSON.parse(value ?? '');
    return Array.isArray(v) ? v.filter((r) => r && typeof r === 'object').map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]))) : [];
  } catch {
    return [];
  }
}

export const rowsJson = (rows: Row[]) => JSON.stringify(rows);

/** A row is shown unless switched off. */
export const rowOn = (r: Row) => r.on !== 'false';

/** The kinds of a column. */
export const COLUMN_KINDS = (): { value: Column['kind']; label: string }[] => [
  { value: 'text', label: t('Text') },
  { value: 'choice', label: t('Choice') },
  { value: 'image', label: t('Image') },
  { value: 'color', label: t('Colour') },
];

/** Under its name: how many rows, which columns. */
export const rowsSummary = (v: WidgetVar) => `${tn(allRows(v.initial).length, '{n} row', '{n} rows')} · ${(v.columns ?? []).map((c) => c.name).join(', ')}`;

/** Its columns and its rows at the start. */
export function RowsVarBody({ v, set }: { v: WidgetVar; set: (patch: Partial<WidgetVar>) => void }) {
  const cols = v.columns ?? [];
  const rows = allRows(v.initial);
  const setCols = (next: Column[], rename?: [string, string]) => {
    const moved = rename ? rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k === rename[0] ? rename[1] : k, x]))) : rows;
    set({ columns: next, initial: rowsJson(moved) });
  };
  const setCell = (i: number, col: string, value: string) => set({ initial: rowsJson(rows.map((r, j) => (j === i ? { ...r, [col]: value } : r))) });
  const addCol = () => {
    const taken = new Set(cols.map((c) => c.name));
    let n = cols.length + 1;
    while (taken.has(`colonne_${n}`)) n++;
    setCols([...cols, { name: `colonne_${n}`, kind: 'text' }]);
  };
  return (
    <>
      <div className="bl-row bl-row-top">
        <span className="prop-label">{t('Columns')}</span>
        <div className="bl-cols">
          {cols.map((c, ci) => (
            <div key={c.name} className="bl-col">
              <input
                className="mono"
                defaultValue={c.name}
                onBlur={(e) => {
                  const n = e.target.value.trim().replace(/[^\p{L}\p{N}_]/gu, '_');
                  if (n && n !== c.name && !cols.some((x) => x.name === n)) setCols(cols.map((x, j) => (j === ci ? { ...x, name: n } : x)), [c.name, n]);
                }}
              />
              <Dropdown value={c.kind} options={COLUMN_KINDS()} onChange={(k) => setCols(cols.map((x, j) => (j === ci ? { ...x, kind: k as Column['kind'] } : x)))} />
              <button className="icon-btn ghost" title={t('Remove')} disabled={cols.length < 2} onClick={() => setCols(cols.filter((_, j) => j !== ci))}>
                <X size={12} />
              </button>
              {c.kind === 'choice' && (
                <input className="bl-col-choices" defaultValue={(c.choices ?? []).join(', ')} placeholder={t('Values')} onBlur={(e) => setCols(cols.map((x, j) => (j === ci ? { ...x, choices: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} />
              )}
            </div>
          ))}
          <button className="bl-addcol" title={t('New column')} onClick={addCol}>
            <Plus size={12} />
          </button>
        </div>
      </div>
      <div className="bl-row bl-row-top">
        <span className="prop-label">{t('At the start')}</span>
        <div className="bl-rows">
          <div className="bl-tr bl-th" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr)) 22px` }}>
            {cols.map((c) => (
              <span key={c.name}>{c.name}</span>
            ))}
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="bl-tr" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr)) 22px` }}>
              {cols.map((c) =>
                c.kind === 'choice' && c.choices?.length ? (
                  <Dropdown key={c.name} value={r[c.name] ?? ''} options={[{ value: '', label: '—' }, ...c.choices.map((x) => ({ value: x, label: x }))]} onChange={(x) => setCell(i, c.name, x)} />
                ) : (
                  <input key={c.name} defaultValue={r[c.name] ?? ''} onBlur={(e) => e.target.value !== (r[c.name] ?? '') && setCell(i, c.name, e.target.value)} />
                ),
              )}
              <button className="icon-btn ghost" title={t('Remove')} onClick={() => set({ initial: rowsJson(rows.filter((_, j) => j !== i)) })}>
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="bl-addrow-line" onClick={() => set({ initial: rowsJson([...rows, Object.fromEntries(cols.map((c) => [c.name, '']))]) })}>
            <Plus size={12} /> {t('Row')}
          </button>
        </div>
      </div>
    </>
  );
}

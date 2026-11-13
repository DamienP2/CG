// The rows of a widget's « List of elements » as the Operator edits them (a control of kind `list`): on
// or off, in order, each column, a row added or removed. On air each change goes out at once.
import { useRef, useState } from 'react';
import { GripVertical, Plus, X } from 'lucide-react';
import type { WidgetVar } from '../engine/types';
import { t } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { rowOn, type Row } from '../designer/rowsVar';

type Column = NonNullable<WidgetVar['columns']>[number];

export function ListEditor({ cols, rows, onChange }: { cols: Column[]; rows: Row[]; onChange: (rows: Row[]) => void }) {
  const drag = useRef<number | null>(null);
  const [draft, setDraft] = useState<Row>({});
  const set = (i: number, patch: Row) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const grid = { gridTemplateColumns: `14px 34px ${cols.map((c) => (c.kind === 'choice' ? '110px' : 'minmax(0, 1fr)')).join(' ')} 26px` };
  const cell = (c: Column, value: string, onSet: (v: string) => void, k: string) =>
    c.kind === 'choice' && c.choices?.length ? (
      <Dropdown key={k} value={value} placeholder={c.name} options={[{ value: '', label: '—' }, ...c.choices.map((x) => ({ value: x, label: x }))]} onChange={onSet} />
    ) : (
      <input key={k} defaultValue={value} placeholder={c.name} onBlur={(e) => e.target.value !== value && onSet(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    );
  const add = () => {
    if (!cols.some((c) => (draft[c.name] ?? '').trim())) return;
    onChange([...rows, Object.fromEntries(cols.map((c) => [c.name, draft[c.name] ?? '']))]);
    setDraft({});
  };
  return (
    <div className="bl-list">
      {rows.map((r, i) => (
        <div
          key={`${i}:${JSON.stringify(r)}`}
          className={`bl-li ${rowOn(r) ? '' : 'off'}`}
          style={grid}
          onDragOver={(e) => drag.current !== null && e.preventDefault()}
          onDrop={() => {
            const from = drag.current;
            drag.current = null;
            if (from === null || from === i) return;
            const next = [...rows];
            const [moved] = next.splice(from, 1);
            next.splice(i, 0, moved);
            onChange(next);
          }}
        >
          <span className="bl-grip" draggable onDragStart={() => (drag.current = i)} title={t('Move')}>
            <GripVertical size={12} />
          </span>
          <button className={`wk-tog ${rowOn(r) ? 'on' : ''}`} title={rowOn(r) ? t('Switch off') : t('Switch on')} onClick={() => set(i, { on: rowOn(r) ? 'false' : 'true' })}>
            <i />
          </button>
          {cols.map((c) => cell(c, r[c.name] ?? '', (v) => set(i, { [c.name]: v }), c.name))}
          <button className="icon-btn ghost" title={t('Remove')} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="bl-li bl-li-new" style={grid}>
        <span />
        <span />
        {cols.map((c) =>
          c.kind === 'choice' && c.choices?.length ? (
            <Dropdown key={c.name} value={draft[c.name] ?? ''} placeholder={c.name} options={c.choices.map((x) => ({ value: x, label: x }))} onChange={(v) => setDraft({ ...draft, [c.name]: v })} />
          ) : (
            <input key={c.name} placeholder={c.name} value={draft[c.name] ?? ''} onChange={(e) => setDraft({ ...draft, [c.name]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          ),
        )}
        <button className="icon-btn ghost" title={t('Add')} onClick={add}>
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

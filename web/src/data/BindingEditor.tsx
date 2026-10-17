import { Link2, Link2Off, ListTree, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Data, Field, FieldBinding, Template } from '../engine/types';
import { navigate } from '../router';
import { api } from '../store';
import { JsonTree } from './JsonTree';
import { lookup, useData, useSources } from './dataStore';

/** The first `[n]` of a path, for the "every item" / "operator picks" shortcuts. */
const FIRST_INDEX = /\[(-?\d+)\]/;

/**
 * Binding of a template field to a data source: source, path (picked in the
 * value's tree), live value. Paths can use other fields: `rows[{row}].name`.
 */
export function BindingEditor({
  field,
  template,
  data,
  onChange,
  onAddField,
}: {
  field: Field;
  template: Template;
  data: Data;
  onChange: (b: FieldBinding | null) => void;
  onAddField: (f: Field) => void;
}) {
  const sources = useSources();
  const b = field.binding;
  const version = useData((s) => (b ? (s.versions[b.source] ?? 0) : 0));
  const [value, setValue] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!b?.source || !b.path) {
      setValue(null);
      return;
    }
    let live = true;
    const h = setTimeout(() => lookup(b.source, b.path, data).then((v) => live && setValue(v)), 200);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [b?.source, b?.path, data, version, b]);

  if (!b) {
    return (
      <button className="btn small link-btn" title="Take this field's value from a data source (API, Google Sheet, RSS…)" onClick={() => onChange({ source: sources[0]?.id ?? '', path: '' })}>
        <Link2 size={12} /> Link to data
      </button>
    );
  }
  const index = b.path.match(FIRST_INDEX);
  const vars = [...b.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const missing = vars.filter((v) => !template.fields.some((f) => f.key === v));
  return (
    <div className="binding">
      <div className="row">
        <Link2 size={12} className="binding-icon" />
        <select value={b.source} onChange={(e) => onChange({ ...b, source: e.target.value })}>
          {!sources.some((s) => s.id === b.source) && <option value={b.source}>{b.source ? `(missing: ${b.source})` : '— source —'}</option>}
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="icon-btn ghost" title="Unlink" onClick={() => onChange(null)}>
          <Link2Off size={12} />
        </button>
      </div>
      {!sources.length && (
        <p className="hint">
          No data source yet:{' '}
          <a href="/data" onClick={(e) => (e.preventDefault(), navigate('/data'))}>
            create one in Data
          </a>
          .
        </p>
      )}
      <div className="row">
        <input className="mono" placeholder="path, e.g. items[0].title" value={b.path} onChange={(e) => onChange({ ...b, path: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <button className="icon-btn ghost" title="Pick in the source's value" disabled={!b.source} onClick={() => setPicking(true)}>
          <ListTree size={13} />
        </button>
      </div>
      {index && (
        <div className="binding-shortcuts">
          <button className="chip" title="Every item, one per line (ticker, list)" onClick={() => onChange({ ...b, path: b.path.replace(FIRST_INDEX, '[*]') })}>
            every item
          </button>
          <button
            className="chip"
            title="The operator picks the row with a number field"
            onClick={() => {
              if (!template.fields.some((f) => f.key === 'row')) onAddField({ key: 'row', label: 'Row', kind: 'number', default: index[1] });
              onChange({ ...b, path: b.path.replace(FIRST_INDEX, '[{row}]') });
            }}
          >
            operator picks the row
          </button>
        </div>
      )}
      {missing.length > 0 && <p className="hint warn">The path uses {missing.map((m) => `{${m}}`).join(', ')}: add a field with that key.</p>}
      <div className={`binding-value ${value === null ? 'none' : ''}`} title="Live value">
        <span className="live-dot" />
        {value === null ? (b.path ? 'no value at this path' : 'choose a path') : value.length > 80 ? `${value.slice(0, 80)}…` : value || '(empty)'}
      </div>
      {picking && <PickDialog source={b.source} path={b.path} onPick={(p) => (onChange({ ...b, path: p }), setPicking(false))} onClose={() => setPicking(false)} />}
    </div>
  );
}

export function PickDialog({ source, path, onPick, onClose }: { source: string; path: string; onPick: (p: string) => void; onClose: () => void }) {
  const [value, setValue] = useState<unknown>(undefined);
  const name = useData((s) => s.sources.find((x) => x.id === source)?.name ?? source);
  useEffect(() => {
    api('GET', `/api/data/sources/${encodeURIComponent(source)}/value`)
      .then(setValue)
      .catch(() => setValue(null));
  }, [source]);
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal pick-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <ListTree size={15} />
          <h2>{name}: pick a value</h2>
          <div className="spacer" />
          <button className="icon-btn ghost" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        {value === undefined ? <p className="muted">Loading…</p> : value === null ? <p className="muted">This source has no value yet.</p> : <JsonTree value={value} onPick={onPick} picked={path} />}
      </div>
    </div>
  );
}

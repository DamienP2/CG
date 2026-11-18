// The Widget Builder's Données space: the data sources feeding the widget's variables. A field of a
// source (`home.score`) fills a variable (`score_1`); the templates using the widget keep it up to
// date on air, and may read another source of the same shape (another match).
import { useEffect, useMemo, useState } from 'react';
import { Database, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useSources } from '../data/dataStore';
import type { Template, WidgetSource } from '../engine/types';
import { t, tn } from '../i18n';
import { api, useApp } from '../store';
import { Dropdown } from '../ui/Dropdown';
import { useDesigner } from '../designer/designerStore';
import { varFields } from '../designer/builder';

const update = (fn: (t: Template) => void, key?: string) => useDesigner.getState().update(fn, key);
const editSources = (fn: (s: WidgetSource[]) => WidgetSource[], key?: string) =>
  update((tpl) => {
    if (!tpl.builder) return;
    tpl.builder.sources = fn(structuredClone(tpl.builder.sources ?? []));
    tpl.fields = varFields(tpl.builder.vars);
  }, key);

/** The paths of a value, with what each holds (lists: their first item, and their length). */
function pathsOf(v: unknown, at = '', out: [string, string][] = []): [string, string][] {
  if (out.length > 400) return out;
  if (Array.isArray(v)) {
    out.push([`${at}.length`.replace(/^\./, ''), String(v.length)]);
    if (v.length) pathsOf(v[0], `${at}[0]`, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) pathsOf(x, at ? `${at}.${k}` : k, out);
  } else if (at) out.push([at, v === null || v === undefined ? '' : String(v)]);
  return out;
}

export function DataSpace() {
  const tpl = useDesigner((s) => s.template);
  const projectId = useApp((s) => s.projectId);
  const all = useSources();
  // The sources this widget may read: shared ones, and its project's (a shared widget: shared ones only).
  const usable = useMemo(() => all.filter((s) => !s.project || (s.project === projectId && projectId !== 'widgets')), [all, projectId]);
  const sources = tpl?.builder?.sources ?? [];
  const [sel, setSel] = useState<string | null>(sources[0]?.source ?? null);
  const cur = sources.find((s) => s.source === sel) ?? null;
  const [value, setValue] = useState<unknown>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!cur) return setValue(undefined);
    let on = true;
    api<unknown>('GET', `/api/data/sources/${encodeURIComponent(cur.source)}/value`)
      .then((v) => on && setValue(v))
      .catch(() => on && setValue(null));
    return () => void (on = false);
  }, [cur?.source, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const paths = useMemo(() => pathsOf(value), [value]);
  const shown = new Map(paths);
  if (!tpl?.builder) return null;
  const vars = tpl.builder.vars;
  const nameOf = (id: string) => all.find((s) => s.id === id)?.name ?? id;
  const free = usable.filter((s) => !sources.some((x) => x.source === s.id));

  const add = (id: string) => {
    editSources((list) => [...list, { source: id, map: [] }]);
    setSel(id);
  };
  const setMap = (i: number, patch: Partial<WidgetSource['map'][number]>, key?: string) => editSources((list) => list.map((s) => (s.source === sel ? { ...s, map: s.map.map((m, j) => (j === i ? { ...m, ...patch } : m)) } : s)), key);

  return (
    <div className="ds">
      <aside className="pb-side">
        <div className="pb-sec">
          <header>{t('Sources of the widget')}</header>
          {sources.map((s) => {
            const info = all.find((x) => x.id === s.source);
            return (
              <button key={s.source} className={`ds-src ${sel === s.source ? 'on' : ''}`} onClick={() => setSel(s.source)}>
                <b>{nameOf(s.source)}</b>
                <span className="ds-meta">
                  {info?.type && <span className="wb-chip data">{info.type.toUpperCase()}</span>}
                  <span className="wb-chip">{tn(s.map.filter((m) => m.var && m.path).length, '{n} field tied', '{n} fields tied')}</span>
                </span>
                {info?.error ? <span className="ds-err">{info.error}</span> : info?.updatedAt ? <span className="ds-ok">{t('Received {time}', { time: new Date(info.updatedAt).toLocaleTimeString() })}</span> : null}
              </button>
            );
          })}
          {free.length ? (
            <Dropdown value="" placeholder={t('Add a source…')} options={free.map((s) => ({ value: s.id, label: s.name, sub: s.project ? t('Of the project') : t('Shared') }))} onChange={add} />
          ) : (
            <p className="pb-hint">{usable.length ? t('Every source is tied already.') : t('No data source yet: add one in Data.')}</p>
          )}
          <p className="pb-hint">{t('A template using the widget may read another source of the same shape (another match): its inspector shows them.')}</p>
        </div>
      </aside>
      <div className="ds-main">
        {cur ? (
          <>
            <div className="ds-head">
              <div>
                <h2>{nameOf(cur.source)}</h2>
                <p>{t('Each field received can fill a variable of the widget. On air the variable follows the source; a control of the Operator changes it until the next value received.')}</p>
              </div>
              <span className="grow" />
              <button className="btn small ghost danger" onClick={() => (editSources((list) => list.filter((s) => s.source !== cur.source)), setSel(sources.find((s) => s.source !== cur.source)?.source ?? null))}>
                <Trash2 size={13} /> {t('Untie the source')}
              </button>
            </div>
            <table className="ds-map">
              <thead>
                <tr>
                  <th>{t('Field received')}</th>
                  <th />
                  <th>{t('Variable of the widget')}</th>
                  <th>{t('Value now')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cur.map.map((m, i) => (
                  <tr key={i}>
                    <td>
                      <input className="mono" list="ds-paths" value={m.path} placeholder="home.score" onChange={(e) => setMap(i, { path: e.target.value }, `ds-path-${i}`)} />
                    </td>
                    <td className="ds-arrow">→</td>
                    <td>
                      <Dropdown value={m.var} placeholder={t('Choose a variable')} options={vars.map((v) => ({ value: v.name, label: v.name }))} onChange={(v) => setMap(i, { var: v })} />
                    </td>
                    <td className="ds-val mono">{shown.get(m.path) ?? '—'}</td>
                    <td>
                      <button className="icon-btn ghost" title={t('Remove')} onClick={() => editSources((list) => list.map((s) => (s.source === sel ? { ...s, map: s.map.filter((_, j) => j !== i) } : s)))}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn small" onClick={() => editSources((list) => list.map((s) => (s.source === sel ? { ...s, map: [...s.map, { path: '', var: '' }] } : s)))}>
              <Plus size={13} /> {t('Tie a field')}
            </button>
            <datalist id="ds-paths">
              {paths.map(([p]) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </>
        ) : (
          <div className="ds-void">
            <Database size={28} />
            <p>{t('Tie a data source to fill the widget’s variables on air: a score, a clock, results…')}</p>
          </div>
        )}
      </div>
      <aside className="pb-side right">
        {cur && (
          <div className="pb-sec">
            <header>
              {t('Last value received')}
              <span className="grow" />
              <button className="icon-btn ghost" title={t('Read again')} onClick={() => setTick((x) => x + 1)}>
                <RefreshCw size={13} />
              </button>
            </header>
            {value === undefined ? (
              <p className="pb-hint">{t('Loading…')}</p>
            ) : value === null ? (
              <p className="pb-hint">{t('Nothing received yet.')}</p>
            ) : (
              <div className="ds-paths">
                {paths.slice(0, 200).map(([p, v]) => {
                  const used = cur.map.some((m) => m.path === p);
                  return (
                    <button key={p} className={`ds-path ${used ? 'on' : ''}`} title={t('Tie this field')} onClick={() => !used && editSources((list) => list.map((s) => (s.source === sel ? { ...s, map: [...s.map, { path: p, var: '' }] } : s)))}>
                      <span className="mono">{p}</span>
                      <em>{v}</em>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

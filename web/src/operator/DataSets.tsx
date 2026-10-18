import { ChevronLeft, ChevronRight, Play, Repeat, Rows3, Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { pipeline, useData, type Stage } from '../data/dataStore';
import { Cell } from '../designer/DataCanvas';
import { rowKey, type Command, type Data, type DataSet, type PlayoutItem } from '../engine/types';

/*
 * The data sets of a graphic in the Operator: its rows, the one on air
 * (AIR, red) and the one coming next (NEXT, green, shown in Preview).
 * Click a row: it is next. Double-click: on air at once. Take next row
 * shows it the way the Designer set (out › in, crossfade, cut); Auto steps
 * on by itself.
 */

/** The rows of a data set now (its last table), refreshed when the source changes. */
export function useDatasetRows(ds: DataSet, data: Data): Stage | null | undefined {
  const version = useData((s) => s.versions[ds.source] ?? 0);
  const used = JSON.stringify(ds.steps ?? []).match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? [];
  const sub = Object.fromEntries(used.map((k) => [k, data[k] ?? '']));
  const key = JSON.stringify([ds.source, ds.list, ds.steps, sub, version]);
  const [stage, setStage] = useState<Stage | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void pipeline(ds.source, ds.list, ds.steps ?? [], sub).then((r) => live && setStage(r ? r.stages[r.stages.length - 1] : null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stage;
}

const rowOf = (data: Data | undefined, ds: DataSet) => Math.max(1, parseInt(data?.[rowKey(ds.key)] ?? '1', 10) || 1);

export function DataSetPanel({
  ds,
  draft,
  onAir,
  operate,
  zone,
  onNext,
  onTake,
  command,
  keys,
}: {
  ds: DataSet;
  /** The item's data: its row is the next one. */
  draft: Data;
  /** The item on air, if it is. */
  onAir: PlayoutItem | undefined;
  operate: boolean;
  zone: string | undefined;
  onNext: (row: number) => void;
  /** Takes the item (not on air yet) on this row. */
  onTake: (row: number) => void;
  command: (c: Command) => void;
  /** ← → and N drive this one. */
  keys?: boolean;
}) {
  const t = useDatasetRows(ds, draft);
  const total = t?.total ?? 0;
  // On air: the row it shows, or the one it comes back with.
  const air = onAir ? rowOf(onAir.next?.rundownId === onAir.rundownId && onAir.next ? onAir.next.data : onAir.data, ds) : null;
  const next = Math.min(rowOf(draft, ds), Math.max(total, 1));
  const [auto, setAuto] = useState(false);
  const [every, setEvery] = useState(8);
  const [loop, setLoop] = useState(true);
  const [since, setSince] = useState(Date.now());
  const after = (row: number) => (row < total ? row + 1 : loop ? 1 : row);

  /** NEXT on air; the one after becomes NEXT. */
  const show = (row: number) => {
    if (!onAir) {
      onTake(row);
      onNext(after(row));
      return;
    }
    command({ action: 'row', dataset: ds.key, row, zone });
    onNext(after(row));
    setSince(Date.now());
  };

  // Auto: the next row every few seconds while on air.
  const latest = useRef({ show, next, onAir, total, loop });
  latest.current = { show, next, onAir, total, loop };
  useEffect(() => {
    if (!auto || !onAir) return;
    setSince(Date.now());
    const h = setInterval(() => {
      const c = latest.current;
      if (!c.onAir || !c.total) return;
      if (!c.loop && air !== null && air >= c.total) return setAuto(false);
      c.show(c.next);
    }, every * 1000);
    return () => clearInterval(h);
  }, [auto, every, !!onAir]); // eslint-disable-line react-hooks/exhaustive-deps
  // Taken (or stepped) onto the NEXT row: the one after is next.
  useEffect(() => {
    if (air !== null && air === next && total > 1) onNext(after(air));
  }, [air]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' && next > 1) (e.preventDefault(), onNext(next - 1));
      else if (e.key === 'ArrowRight' && next < total) (e.preventDefault(), onNext(next + 1));
      else if ((e.key === 'n' || e.key === 'N') && operate && total) (e.preventDefault(), show(next));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const [, tick] = useState(0);
  useEffect(() => {
    if (!auto) return;
    const h = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(h);
  }, [auto]);
  const progress = auto && onAir ? Math.min(1, (Date.now() - since) / (every * 1000)) : 0;

  return (
    <div className="ods">
      <div className="ods-bar">
        <Rows3 size={14} className="ods-icon" />
        <strong>{ds.name}</strong>
        <span className="muted small">
          {total} row{total === 1 ? '' : 's'} · {ds.change === 'fade' ? 'crossfade' : ds.change === 'cut' ? 'cut' : 'out › in'}
        </span>
        <span className="spacer" />
        <button className="opx-btn small" title="Previous row as NEXT (←)" disabled={next <= 1} onClick={() => onNext(next - 1)}>
          <ChevronLeft size={13} />
        </button>
        <button className="opx-btn small" title="Following row as NEXT (→)" disabled={next >= total} onClick={() => onNext(next + 1)}>
          <ChevronRight size={13} />
        </button>
        <button className="opx-btn red" disabled={!operate || !total} title={onAir ? 'Show the NEXT row on air (N)' : 'Take the graphic with the NEXT row'} onClick={() => show(next)}>
          <Play size={12} fill="currentColor" /> {onAir ? 'Take next row' : 'Take'}
        </button>
      </div>
      <div className="ods-rows">
        {t === undefined && <p className="opx-hint pad">Loading the rows…</p>}
        {t === null && <p className="opx-hint pad">No data from {ds.source} yet.</p>}
        {t && (
          <table>
            <thead>
              <tr>
                <th />
                <th>#</th>
                {t.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => {
                const n = i + 1;
                const isAir = air === n;
                const isNext = n === next;
                return (
                  <tr key={i} className={isAir ? 'air' : isNext ? 'next' : ''} onClick={() => onNext(n)} onDoubleClick={() => operate && show(n)} title="Click: next · double-click: on air">
                    <td className="ods-tag">{isAir ? <span className="ods-badge air">AIR</span> : isNext ? <span className="ods-badge next">NEXT</span> : null}</td>
                    <td className="ods-n">{n}</td>
                    {r.map((c, j) => (
                      <td key={j}>
                        <Cell v={c} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="ods-auto">
        <label className="ods-toggle" title="Show the next row by itself, while the graphic is on air">
          <input type="checkbox" checked={auto} disabled={!operate} onChange={(e) => setAuto(e.target.checked)} />
          <Timer size={13} /> Auto every
        </label>
        <input type="number" min={1} max={600} value={every} onChange={(e) => setEvery(Math.max(1, +e.target.value || 1))} onKeyDown={(e) => e.stopPropagation()} />
        <span className="muted small">s</span>
        <div className="ods-prog">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
        <label className="ods-toggle" title="After the last row, back to the first">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          <Repeat size={13} /> Loop
        </label>
      </div>
    </div>
  );
}

/** Row buttons of the data sets of a graphic on air (internal controls). */
export function AirRows({ sets, item, command, zone }: { sets: DataSet[]; item: PlayoutItem; command: (c: Command) => void; zone: string }) {
  return (
    <>
      {sets.map((ds) => {
        const data = item.next?.rundownId === item.rundownId && item.next ? item.next.data : item.data;
        const row = rowOf(data, ds);
        const total = parseInt(item.data[`${ds.key}__count`] ?? '0', 10) || 0;
        const go = (r: number) => command({ action: 'row', dataset: ds.key, row: r, zone });
        return (
          <div key={ds.key} className="opx-widget">
            <Rows3 size={13} className="ods-icon" />
            <span className="opx-widget-name">
              <strong>{ds.name}</strong>
              <span className="muted small">
                row {row} / {total}
              </span>
            </span>
            <button className="opx-sq" title="Previous row" disabled={row <= 1} onClick={() => go(row - 1)}>
              <ChevronLeft size={13} />
            </button>
            <button className="opx-sq" title="Next row" disabled={row >= total} onClick={() => go(row + 1)}>
              <ChevronRight size={13} />
            </button>
          </div>
        );
      })}
    </>
  );
}

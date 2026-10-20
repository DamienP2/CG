// The Table editor: a modal over the Designer with the real table on a canvas (click a column, a row or the
// title to edit it, drag a column edge for its width), its structure on the left (toggles, columns, row styles)
// and the settings of what is selected on the right.
import { CanvasHeader } from '../ui/CanvasHeader';
import { ArrowDownUp, Eye, EyeOff, GripVertical, Plus, Redo2, Table as TableIcon, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBoundData } from '../data/dataStore';
import { GroupRow } from '../designer/Inspector';
import { findLayer, useDesigner } from '../designer/designerStore';
import { holdFrame, num as vnum, resolveLayer } from '../engine/evaluate';
import type { Data, Layer, Template } from '../engine/types';
import { Btns, Bound, Content, getPath, GridEditor, Note, Num, Row, Section, Seg, Select, setPath, Text, Toggle, useBound } from './kit';
import { cfg, ColorPickRow, DST, FMTS, headerH, model, TableRender, TITLE_H, widths, type Col, type Config } from './table';
import { colFor } from './table-build';
import { useTableEditor } from './table-editor-store';

type TL = Layer & Config;
type RowId = 'header' | 'odd' | 'even' | 'hl' | 'top3' | 'hcol';
type Sel = { kind: 'table' } | { kind: 'title' } | { kind: 'rank' } | { kind: 'col'; i: number } | { kind: 'row'; id: RowId };
const ROW_NAMES: Record<RowId, string> = {
  header: 'Header row',
  odd: 'Odd rows',
  even: 'Even rows',
  hl: 'Highlighted row',
  top3: 'Top 3',
  hcol: 'Header column',
};
const TYPE_ABBR: Record<string, string> = {
  text: 'txt',
  number: 'num',
  image: 'pic',
};

/** The editor of the Table being edited, if any (mounted once by the Designer). */
export function TableEditor() {
  const id = useTableEditor((s) => s.id);
  const close = useTableEditor((s) => s.close);
  const template = useDesigner((s) => s.template);
  const previewData = useDesigner((s) => s.previewData);
  const data = useBoundData(template, previewData);
  const layer = id && template ? findLayer(template, id) : undefined;
  useEffect(() => {
    if (id && (!layer || layer.type !== 'table')) close();
  }, [id, layer, close]);
  if (!template || !layer || layer.type !== 'table') return null;
  return createPortal(<Editor key={layer.id} layer={layer as TL} template={template} data={data} onClose={close} />, document.body);
}

/** Sample rows from the columns, to preview a table with no data yet. */
function sampleGrid(cols: Col[]): string[][] {
  const head = [...new Set(cols.flatMap((c) => [c.src ?? '', c.mark ?? '']).filter(Boolean))];
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
  const COLORS = ['#5c6fd6', '#22c55e', '#f5a524', '#ff3b5c', '#38bdf8', '#a78bfa', '#facc15', '#f472b6', '#94a3b8'];
  const rows = NAMES.map((n, r) =>
    head.map((h) => {
      if (cols.some((c) => c.mark === h)) return COLORS[r];
      const c = cols.find((x) => x.src === h);
      if (c?.type === 'number') return c.fmt === '+0' ? String(12 - r * 4) : String(40 - r * 4);
      if (c?.type === 'image') return '';
      return n;
    }),
  );
  return [head, ...rows];
}

function Editor({ layer, template, data, onClose }: { layer: TL; template: Template; data: Data; onClose: () => void }) {
  const { update, undo, redo, past, future } = useDesigner();
  const frame = useDesigner((s) => s.frame);
  const [sel, setSel] = useState<Sel>({ kind: 'table' });
  const k = cfg(layer);
  const live = model(k, data);
  const [sample, setSample] = useState(() => !live.rows.length && k.cols.length > 0);
  const [page, setPage] = useState(0);
  const edit = (fn: (l: TL) => void, key?: string) => update((t) => fn(findLayer(t, layer.id) as TL), key);
  const set = (path: string, v: unknown, coalesce?: boolean) => edit((l) => setPath(l, path, v), coalesce ? `${path}-${layer.id}` : undefined);
  // Columns follow the data until they are set: the first change writes them.
  const ensureCols = (l: TL) => {
    if (!l.cols?.length)
      l.cols = live.head.filter(Boolean).map((h) => ({
        src: h,
        label: h,
        type: 'text',
        align: 'left',
        w: 100,
        pct: 10,
        fmt: '0',
        on: true,
      }));
  };
  const cols = k.cols.length ? k.cols : live.head.filter(Boolean).map((h) => cfg({ cols: [{ src: h, label: h }] }).cols[0]);
  const selectCol = (i: number) => {
    if (!k.cols.length) edit(ensureCols);
    setSel({ kind: 'col', i });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !t.closest('input, textarea, select, .dd-list')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown: TL = sample ? { ...layer, link: '', grid: sampleGrid(cols) } : layer;
  const dsKey = /\{\{(\w+)__table\}\}/.exec(k.link)?.[1];
  const ds = dsKey ? template.datasets?.find((d) => d.key === dsKey) : undefined;
  const source = ds ? `${ds.name} · ${live.rows.length} rows` : k.link.trim() ? `Linked data · ${live.rows.length} rows` : `Rows by hand · ${live.rows.length}`;

  return (
    <div className="logic-editor te-full" role="dialog" aria-label={`Table editor: ${layer.name}`}>
      <CanvasHeader icon={<TableIcon size={15} />} title={layer.name} subject={template.name} onClose={onClose}>
        <span className={`te-chip ${ds || k.link.trim() ? 'data' : ''}`}>{source}</span>
        <div className="segmented te-seg" title="Preview the table with its data, or with sample rows">
          <button className={!sample ? 'on' : ''} onClick={() => setSample(false)}>
            Live data
          </button>
          <button className={sample ? 'on' : ''} onClick={() => setSample(true)} disabled={!cols.length}>
            Sample
          </button>
        </div>
        <button className="icon-btn ghost" title="Undo" disabled={!past.length} onClick={undo}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn ghost" title="Redo" disabled={!future.length} onClick={redo}>
          <Redo2 size={15} />
        </button>
        <button className="btn primary small" onClick={onClose}>
          Done
        </button>
      </CanvasHeader>
      <div className="te-body">
        <Bound obj={layer} set={set} data={data}>
          <aside className="te-left">
            <Structure k={k} cols={cols} live={live} sel={sel} setSel={setSel} selectCol={selectCol} edit={edit} ensureCols={ensureCols} />
          </aside>
          <TableCanvas layer={shown} template={template} data={data} frame={frame} sel={sel} setSel={setSel} selectCol={selectCol} page={page} setPage={setPage} edit={edit} ensureCols={ensureCols} addCol={() => addCol(edit, ensureCols, live, setSel)} />
          <aside className="te-right">
            <Settings layer={layer} k={k} live={live} sel={sel} setSel={setSel} edit={edit} set={set} dsName={ds?.name} />
          </aside>
        </Bound>
      </div>
    </div>
  );
}

type Edit = (fn: (l: TL) => void, key?: string) => void;
type Live = ReturnType<typeof model>;

/** Adds the first column of the data not shown yet (else a new one) and selects it. */
function addCol(edit: Edit, ensureCols: (l: TL) => void, live: Live, setSel: (s: Sel) => void) {
  let at = 0;
  edit((l) => {
    ensureCols(l);
    const free = live.head.find((h) => h && !l.cols!.some((c) => c.src === h || c.mark === h));
    const i = free ? live.head.indexOf(free) : -1;
    l.cols!.push(
      free
        ? colFor(
            free,
            live.rows.map((r) => r.r[i] ?? ''),
          )
        : {
            src: live.head[0] ?? '',
            label: 'New',
            type: 'text',
            align: 'left',
            w: 100,
            pct: 10,
            fmt: '0',
            on: true,
          },
    );
    at = l.cols!.length - 1;
  });
  setSel({ kind: 'col', i: at });
}

// ------------------------------------------------------------ left --
function Structure({ k, cols, live, sel, setSel, selectCol, edit, ensureCols }: { k: ReturnType<typeof cfg>; cols: ReturnType<typeof cfg>['cols']; live: Live; sel: Sel; setSel: (s: Sel) => void; selectCol: (i: number) => void; edit: Edit; ensureCols: (l: TL) => void }) {
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const zebra = k.st.even.bg !== k.st.odd.bg || k.st.even.color !== k.st.odd.color;
  const tog = (label: string, on: boolean, fn: (l: TL, v: boolean) => void) => (
    <button className={`te-tog ${on ? 'on' : ''}`} onClick={() => edit((l) => fn(l, !on))}>
      <span>{label}</span>
      <i />
    </button>
  );
  const move = (from: number, to: number) => {
    if (from === to) return;
    edit((l) => {
      ensureCols(l);
      const [c] = l.cols!.splice(from, 1);
      l.cols!.splice(to, 0, c);
    });
    if (sel.kind === 'col' && sel.i === from) setSel({ kind: 'col', i: to });
  };
  const unmapped = k.cols.length ? live.unmapped : [];
  const rowsList: RowId[] = ['header', 'odd', ...(zebra ? (['even'] as RowId[]) : []), 'hl', 'top3', ...(k.headerColOn ? (['hcol'] as RowId[]) : [])];
  return (
    <>
      <div className="te-sec">
        <span className="te-lbl">Table</span>
        {tog('Title bar', k.title.on, (l, v) => void (l.title = { ...l.title, on: v }))}
        {tog('Header row', k.headerRow, (l, v) => void (l.headerRow = v))}
        {tog('Rank column', k.showRank, (l, v) => void (l.showRank = v))}
        {tog('Header column', k.headerColOn, (l, v) => {
          l.headerColOn = v;
          if (v && !l.headerCol) l.headerCol = cols.find((c) => c.type === 'text')?.src ?? '';
        })}
      </div>
      <div className="te-sec">
        <span className="te-lbl">Columns</span>
        {k.showRank && (
          <div className={`te-item ${sel.kind === 'rank' ? 'on' : ''}`} onClick={() => setSel({ kind: 'rank' })}>
            <span className="te-grip" />
            <span className="te-nm"># Rank</span>
            <span className="te-ty">auto</span>
          </div>
        )}
        {cols.map((c, i) => {
          const missing = live.missing.includes(c.src) && c.on;
          return (
            <div
              key={i}
              className={`te-item ${sel.kind === 'col' && sel.i === i ? 'on' : ''} ${c.on ? '' : 'off'} ${drag?.over === i && drag.from !== i ? (drag.from < i ? 'drop-after' : 'drop-before') : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
                setDrag({ from: i, over: i });
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over !== i) setDrag({ ...drag, over: i });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) move(drag.from, i);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
              onClick={() => selectCol(i)}
            >
              <span className="te-grip" title="Drag to reorder">
                <GripVertical size={12} />
              </span>
              <span className="te-nm">{c.label || c.src || '—'}</span>
              {missing ? (
                <span className="te-warn" title={`'${c.src}' is not in the data`}>
                  <TriangleAlert size={12} />
                </span>
              ) : (
                <span className="te-ty">{TYPE_ABBR[c.type]}</span>
              )}
              <button
                className="te-eye"
                title={c.on ? 'Hide' : 'Show'}
                onClick={(e) => {
                  e.stopPropagation();
                  edit((l) => {
                    ensureCols(l);
                    l.cols![i] = { ...l.cols![i], on: !c.on };
                  });
                }}
              >
                {c.on ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            </div>
          );
        })}
        {unmapped.map((h) => (
          <div key={h} className="te-new">
            <span>
              New in the data: <b>{h}</b>
            </span>
            <button
              className="btn small"
              onClick={() =>
                edit((l) => {
                  const i = live.head.indexOf(h);
                  l.cols = [
                    ...(l.cols ?? []),
                    colFor(
                      h,
                      live.rows.map((r) => r.r[i] ?? ''),
                    ),
                  ];
                })
              }
            >
              Add
            </button>
          </div>
        ))}
        <button className="te-add" onClick={() => addCol(edit, ensureCols, live, setSel)}>
          <Plus size={12} /> Column
        </button>
      </div>
      <div className="te-sec">
        <span className="te-lbl">Rows</span>
        {rowsList.map((id) => {
          const p = id === 'hl' ? k.st.hl : id === 'top3' ? k.st.top3 : k.st[id];
          return (
            <div key={id} className={`te-item te-style ${sel.kind === 'row' && sel.id === id ? 'on' : ''}`} onClick={() => setSel({ kind: 'row', id })}>
              <span className="te-nm">{ROW_NAMES[id]}</span>
              {id === 'top3' && !k.cf.top3 ? (
                <span className="te-ty">off</span>
              ) : (
                <span className="te-pair">
                  <i style={{ background: p.bg }} />
                  <i style={{ background: p.color }} />
                </span>
              )}
            </div>
          );
        })}
        {!zebra && (
          <button
            className="te-add"
            onClick={() =>
              edit(
                (l) =>
                  void (l.st = {
                    ...l.st,
                    even: { ...DST.even, color: k.st.odd.color },
                  }),
              )
            }
          >
            <Plus size={12} /> Even rows (zebra)
          </button>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------ canvas --
function TableCanvas({
  layer,
  template,
  data,
  frame,
  sel,
  setSel,
  selectCol,
  page,
  setPage,
  edit,
  ensureCols,
  addCol,
}: {
  layer: TL;
  template: Template;
  data: Data;
  frame: number;
  sel: Sel;
  setSel: (s: Sel) => void;
  selectCol: (i: number) => void;
  page: number;
  setPage: (p: number) => void;
  edit: Edit;
  ensureCols: (l: TL) => void;
  addCol: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const r = resolveLayer(layer, frame, data, holdFrame(template));
  const W = Math.max(50, vnum(r.width));
  const H = Math.max(50, vnum(r.height));
  const size = Math.max(1, vnum(r.fontSize as number));
  const k = cfg(layer);
  const m = model(k, data);
  const pages = Math.max(1, Math.ceil(m.rows.length / k.perPage));
  const pg = Math.min(page, pages - 1);
  const scroll = k.pageMode === 'scroll';
  const s = Math.min(1, (avail - 96) / W);
  const ws = widths(k, m, W, size);
  const xs: number[] = [];
  ws.reduce((x, w, i) => ((xs[i] = x), x + w + k.gap), 0);
  const hh = headerH(k);
  const step = k.rowH + k.gap;
  const showHead = k.headerRow && (scroll || k.repeatHeader || pg === 0);
  let y = 0;
  const titleY = y;
  if (k.title.on) y += TITLE_H + k.gap;
  const headY = y;
  if (showHead) y += hh + k.gap;
  const bodyY = y;
  const list = scroll ? m.rows.slice(0, k.perPage) : m.rows.slice(pg * k.perPage, pg * k.perPage + k.perPage);
  const bodyH = !m.rows.length ? k.rowH * 2 : Math.max(0, list.length * step - k.gap);
  const totalH = bodyY + bodyH;
  const viewH = Math.max(H, totalH + (pages > 1 && !scroll && k.indicator ? 70 : 0));
  // The column of the editor's list behind a shown column.
  const colIndex = (j: number) => {
    const mc = m.cols[j];
    if (!mc || mc.i === undefined) return -1;
    const list = k.cols.length ? k.cols : null;
    return list ? list.findIndex((c) => c.on && c.src === mc.col.src) : m.head.filter(Boolean).indexOf(mc.col.src);
  };
  const selJ = sel.kind === 'col' ? m.cols.findIndex((_, j) => colIndex(j) === sel.i) : sel.kind === 'rank' ? m.cols.findIndex((c) => c.i === undefined) : -1;
  const rowStyle = (rank: number): RowId => (k.cf.top3 && rank <= 3 ? 'top3' : rank % 2 ? 'odd' : 'even');
  const pickCol = (j: number) => {
    const i = colIndex(j);
    if (m.cols[j]?.i === undefined) setSel({ kind: 'rank' });
    else if (i >= 0) selectCol(i);
  };

  // Drag a column edge: the two columns share their width (switches to % widths).
  const resize = (e: React.PointerEvent, j: number) => {
    e.preventDefault();
    e.stopPropagation();
    const a = colIndex(j);
    const b = colIndex(j + 1);
    if (a < 0 || b < 0) return;
    const n = m.cols.length;
    const rk = m.cols.some((c) => c.i === undefined) ? 80 : 0;
    const space = W - k.gap * Math.max(0, n - 1) - rk;
    const fixed = k.widthMode === 'fixed';
    const base = m.cols.map((_, q) => (fixed ? ws[q] : (ws[q] / space) * 100));
    const x0 = e.clientX;
    const key = `te-rz-${layer.id}`;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s;
      const d = fixed ? dx : (dx / space) * 100;
      const min = fixed ? 30 : 3;
      const total = base[j] + base[j + 1];
      const wa = Math.min(total - min, Math.max(min, base[j] + d));
      edit((l) => {
        ensureCols(l);
        if (!fixed) l.widthMode = 'percent';
        m.cols.forEach((_, q) => {
          const i = colIndex(q);
          if (i < 0) return;
          const v = q === j ? wa : q === j + 1 ? total - wa : base[q];
          l.cols![i] = {
            ...l.cols![i],
            [fixed ? 'w' : 'pct']: Math.round(v * 10) / 10,
          };
        });
      }, key);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      useDesigner.setState({ lastCoalesce: null });
      selectCol(a);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const Z = ({ x, y, w, h, cls, title, onClick, children }: { x: number; y: number; w: number; h: number; cls: string; title?: string; onClick?: () => void; children?: ReactNode }) => (
    <div
      className={`te-zone ${cls}`}
      title={title}
      style={{ left: x * s, top: y * s, width: w * s, height: h * s }}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {children}
    </div>
  );

  return (
    <div className="te-center">
      <div className="te-tools">
        <span className="te-hint">Click a column, a row or the title · drag a column edge to resize</span>
        <span className="te-sp" />
        {!scroll && pages > 1 && (
          <div className="segmented te-seg">
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} className={i === pg ? 'on' : ''} onClick={() => setPage(i)}>
                Page {i + 1}
              </button>
            ))}
          </div>
        )}
        <span className="te-size">
          {Math.round(W)} × {Math.round(H)} · {Math.round(s * 100)}%
        </span>
      </div>
      <div className="te-canvas" ref={box} onClick={() => setSel({ kind: 'table' })}>
        <div className="te-stage" style={{ width: W * s, height: viewH * s }}>
          <div className="te-box" style={{ width: W * s, height: H * s }} title="The layer's box" />
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: W,
              height: viewH,
              transform: `scale(${s})`,
              transformOrigin: '0 0',
              pointerEvents: 'none',
            }}
          >
            <TableRender layer={layer} r={r as never} w={W} data={data} time={{ nowMs: Date.now(), ageSecs: 60 }} state={{ page: pg }} />
          </div>
          {k.title.on && <Z x={0} y={titleY} w={W} h={TITLE_H} cls={`title ${sel.kind === 'title' ? 'on' : ''}`} title="Title bar" onClick={() => setSel({ kind: 'title' })} />}
          {list.map((row, i) => {
            const id = rowStyle(row.rank);
            return <Z key={i} x={0} y={bodyY + i * step} w={W} h={k.rowH} cls={`row ${sel.kind === 'row' && sel.id === id ? 'on' : ''}`} title={ROW_NAMES[id]} onClick={() => setSel({ kind: 'row', id })} />;
          })}
          {selJ >= 0 && <Z x={xs[selJ]} y={0} w={ws[selJ]} h={totalH} cls="colsel" />}
          {showHead && (
            <>
              <Z x={0} y={headY} w={W} h={hh} cls={`headband ${sel.kind === 'row' && sel.id === 'header' ? 'on' : ''}`} />
              {m.cols.map((c, j) => (
                <Z key={j} x={xs[j]} y={headY} w={ws[j]} h={hh} cls={`head ${j === selJ ? 'on' : ''}`} title={c.i === undefined ? 'Rank column' : `Column ${c.col.label || c.col.src}`} onClick={() => pickCol(j)} />
              ))}
            </>
          )}
          {m.cols.map((c, j) =>
            j < m.cols.length - 1 && c.i !== undefined && m.cols[j + 1].i !== undefined ? (
              <div
                key={`rz${j}`}
                className="te-rz"
                style={{
                  left: (xs[j] + ws[j] + k.gap / 2) * s - 4,
                  top: 0,
                  height: totalH * s,
                }}
                title="Drag to resize"
                onPointerDown={(e) => resize(e, j)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : null,
          )}
          {!showHead &&
            m.cols.map((c, j) => (
              <Z key={`c${j}`} x={xs[j]} y={-22 / s} w={ws[j]} h={18 / s} cls={`chead ${j === selJ ? 'on' : ''}`} title="Select the column" onClick={() => pickCol(j)}>
                <span>{c.i === undefined ? '#' : c.col.label || c.col.src}</span>
              </Z>
            ))}
          <button
            className="te-plus"
            style={{ left: W * s + 10, top: (showHead ? headY : bodyY) * s }}
            title="Add a column"
            onClick={(e) => {
              e.stopPropagation();
              addCol();
            }}
          >
            <Plus size={14} />
          </button>
        </div>
        {!m.rows.length && !m.cols.length && <p className="te-empty">No columns yet: wire a data set's All rows to the table in the Data canvas, or type rows in Source.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ right --
function Settings({ layer, k, live, sel, setSel, edit, set, dsName }: { layer: TL; k: ReturnType<typeof cfg>; live: Live; sel: Sel; setSel: (s: Sel) => void; edit: Edit; set: (path: string, v: unknown, coalesce?: boolean) => void; dsName?: string }) {
  const head = live.head.filter(Boolean);
  const colOpts: [string, string][] = k.cols.map((c) => [c.src, c.label || c.src]);
  const zebra = k.st.even.bg !== k.st.odd.bg || k.st.even.color !== k.st.odd.color;
  const title = (badge: string, name: string) => (
    <div className="te-selname">
      <span className="te-badge">{badge}</span>
      <b>{name}</b>
    </div>
  );

  if (sel.kind === 'col') {
    const c = k.cols[sel.i];
    if (!c) return <Note>Select a column.</Note>;
    const p = `cols.${sel.i}`;
    const srcs = [...new Set([...head, c.src])].filter(Boolean).map((h) => [h, h] as [string, string]);
    const sorted = k.sortCol === c.src;
    return (
      <div className="te-form">
        {title('Column', c.label || c.src)}
        <Select label="Data" path={`${p}.src`} value={c.src} expose={false} options={srcs.length ? srcs : [['', '—']]} />
        <Text label="Header" path={`${p}.label`} value={c.label} />
        <Seg
          label="Shows"
          path={`${p}.type`}
          value={c.type}
          expose={false}
          options={[
            ['text', 'Text'],
            ['number', 'Number'],
            ['image', 'Picture'],
          ]}
        />
        <Seg
          label="Align"
          path={`${p}.align`}
          value={c.align}
          options={[
            ['left', 'Left'],
            ['center', 'Centre'],
            ['right', 'Right'],
          ]}
        />
        {k.widthMode === 'auto' ? (
          <Seg
            label="Width"
            value="auto"
            onChange={(v) => v !== 'auto' && set('widthMode', v)}
            options={[
              ['auto', 'Auto'],
              ['percent', '%'],
              ['fixed', 'px'],
            ]}
          />
        ) : (
          <Num label="Width" path={`${p}.${k.widthMode === 'fixed' ? 'w' : 'pct'}`} value={k.widthMode === 'fixed' ? c.w : c.pct} min={0} unit={k.widthMode === 'fixed' ? 'px' : '%'} />
        )}
        {c.type === 'number' && <Seg label="Format" path={`${p}.fmt`} value={c.fmt} options={FMTS} />}
        {c.type === 'text' && <Select label="Colour mark" path={`${p}.mark`} value={c.mark} expose={false} options={[['', 'None'], ...head.filter((h) => h !== c.src).map((h) => [h, `From ${h}`] as [string, string])]} />}
        <Toggle label="Sort" value={sorted} text="Sort on this column" onChange={(v) => set('sortCol', v ? c.src : '')} />
        {sorted && (
          <Seg
            label="Order"
            path="sortDir"
            value={k.sortDir}
            options={[
              ['desc', 'Biggest first'],
              ['asc', 'Smallest first'],
            ]}
          />
        )}
        {c.type === 'number' && <Toggle label="Negative" path="cf.neg" value={k.cf.neg} text="Negative values in colour" />}
        <div className="te-actions">
          <button className="btn small" onClick={() => edit((l) => void (l.cols![sel.i] = { ...l.cols![sel.i], on: !c.on }))}>
            {c.on ? <EyeOff size={13} /> : <Eye size={13} />} {c.on ? 'Hide' : 'Show'}
          </button>
          <button
            className="btn small danger"
            onClick={() => {
              edit((l) => void l.cols!.splice(sel.i, 1));
              setSel({ kind: 'table' });
            }}
          >
            <Trash2 size={13} /> Remove
          </button>
        </div>
      </div>
    );
  }
  if (sel.kind === 'rank') {
    return (
      <div className="te-form">
        {title('Column', 'Rank')}
        <Note>The position of each row once sorted (1, 2, 3…).</Note>
        <Toggle label="Rank" path="showRank" value={k.showRank} text="Show the rank" />
        <Toggle label="Top 3" path="cf.top3" value={k.cf.top3} text="Mark the first 3 rows" />
        {k.cf.top3 && <ColorPickRow label="Accent" path="cf.top3Color" value={k.cf.top3Color} />}
      </div>
    );
  }
  if (sel.kind === 'title') {
    return (
      <div className="te-form">
        {title('Title', 'Title bar')}
        <Toggle label="Shown" path="title.on" value={k.title.on} />
        <Content label="Text" path="title.text" value={k.title.text} />
      </div>
    );
  }
  if (sel.kind === 'row') {
    const id = sel.id;
    return (
      <div className="te-form">
        {title('Rows', ROW_NAMES[id])}
        {id === 'header' && (
          <>
            <Toggle label="Shown" path="headerRow" value={k.headerRow} />
            <Colours path="st.header" />
            <Num label="Text size" path="headSize" value={k.headSize} min={6} max={200} unit="px" />
            {k.pageMode === 'pages' && <Toggle label="Each page" path="repeatHeader" value={k.repeatHeader} text="Repeat on every page" />}
          </>
        )}
        {(id === 'odd' || id === 'even') && (
          <>
            <Colours path={`st.${id}`} />
            <GroupRow
              layer={layer as never}
              spec={{
                label: 'Text size',
                props: ['fontSize'],
                min: 1,
                suffix: 'px',
              }}
            />
            <Num label="Height" path="rowH" value={k.rowH} min={30} max={160} unit="px" />
            <Toggle
              label="Zebra"
              value={zebra}
              text="Odd and even rows differ"
              onChange={(v) =>
                set(
                  'st.even',
                  v
                    ? {
                        ...(k.st.odd.bg === DST.even.bg ? DST.odd : DST.even),
                        color: k.st.odd.color,
                      }
                    : { ...k.st.odd },
                )
              }
            />
          </>
        )}
        {id === 'hl' && (
          <>
            <Colours path="st.hl" />
            <Note>The operator picks the highlighted row in the Operator.</Note>
          </>
        )}
        {id === 'top3' && (
          <>
            <Toggle label="Top 3" path="cf.top3" value={k.cf.top3} text="Mark the first 3 rows" />
            {k.cf.top3 && (
              <>
                <Colours path="st.top3" />
                <ColorPickRow label="Accent" path="cf.top3Color" value={k.cf.top3Color} />
              </>
            )}
          </>
        )}
        {id === 'hcol' && (
          <>
            <Toggle label="Shown" path="headerColOn" value={k.headerColOn} />
            <Select label="Column" path="headerCol" value={k.headerCol} options={colOpts.length ? colOpts : [['', '—']]} />
            <Colours path="st.hcol" />
          </>
        )}
      </div>
    );
  }
  // The table itself.
  return (
    <div className="te-form">
      {title('Table', layer.name)}
      <Section id="te-source" title="Source">
        {/\{\{\w+\}\}/.test(k.link) ? (
          <>
            <Row label="Rows">
              <span className="te-chip data">{dsName ? `${dsName} · All rows` : 'Linked data'}</span>
            </Row>
            <Note>
              {live.rows.length} rows · {head.length} columns in the data. Wired in the Data canvas.
            </Note>
          </>
        ) : (
          <>
            <Content label="Rows" path="link" placeholder="{{key}}" />
            {!k.link.trim() && (
              <div className="te-grid">
                <GridEditor path="grid" header csv />
              </div>
            )}
          </>
        )}
      </Section>
      <Section id="te-pages" title="Pages">
        <Num label="Rows per page" path="perPage" value={k.perPage} min={1} max={99} />
        <Seg
          label="More rows"
          path="pageMode"
          value={k.pageMode}
          options={[
            ['pages', 'Pages'],
            ['scroll', 'Scroll'],
          ]}
        />
        {k.pageMode === 'pages' ? <Toggle label="Indicator" path="indicator" value={k.indicator} text="Page dots under the table" /> : <Num label="Speed" path="scrollSpeed" value={k.scrollSpeed} min={1} max={2000} unit="px/s" />}
      </Section>
      <Section id="te-cascade" title="Rows come in">
        <Seg
          label="Style"
          value={k.cascade.on ? k.cascade.style : 'none'}
          onChange={(v) => edit((l) => void (l.cascade = v === 'none' ? { ...l.cascade, on: false } : { ...l.cascade, on: true, style: v as 'slide' }))}
          options={[
            ['slide', 'Slide'],
            ['fade', 'Fade'],
            ['flip', 'Flip'],
            ['none', 'None'],
          ]}
        />
        {k.cascade.on && (
          <>
            <Num label="Offset" path="cascade.offset" value={k.cascade.offset} min={0} max={5000} step={5} unit="ms" />
            <Num label="Duration" path="cascade.dur" value={k.cascade.dur} min={10} max={5000} step={10} unit="ms" />
          </>
        )}
      </Section>
      <Section id="te-sort" title="Sort" closed>
        <Select label="Column" path="sortCol" value={k.sortCol} options={[['', 'As received'], ...colOpts]} />
        {!!k.sortCol && (
          <Seg
            label="Order"
            path="sortDir"
            value={k.sortDir}
            options={[
              ['desc', 'Biggest first'],
              ['asc', 'Smallest first'],
            ]}
          />
        )}
      </Section>
      <Section id="te-layout" title="Size & spacing" closed>
        <GroupRow
          layer={layer as never}
          spec={{
            label: 'Text size',
            props: ['fontSize'],
            min: 1,
            suffix: 'px',
          }}
        />
        <Num label="Row height" path="rowH" value={k.rowH} min={30} max={160} unit="px" />
        <Num label="Padding" path="pad" value={k.pad} min={0} max={200} unit="px" />
        <Num label="Spacing" path="gap" value={k.gap} min={0} max={100} unit="px" />
        <Seg
          label="Widths"
          path="widthMode"
          value={k.widthMode}
          options={[
            ['auto', 'Auto'],
            ['percent', '%'],
            ['fixed', 'px'],
          ]}
        />
        <Seg
          label="Too long"
          path="overflow"
          value={k.overflow}
          options={[
            ['shrink', 'Shrink'],
            ['squeeze', 'Squeeze'],
            ['ellipsis', '…'],
          ]}
        />
        {k.overflow === 'shrink' && <Num label="Min size" path="minSize" value={k.minSize} min={4} max={200} unit="px" />}
        {k.overflow !== 'ellipsis' && <Num label="Min width" path="minSqueeze" value={k.minSqueeze} min={20} max={100} unit="%" />}
      </Section>
      <Section id="te-colors" title="Colours" closed>
        <ColorPickRow label="Background" path="st.tableBg" value={k.st.tableBg} />
        <Toggle label="Negative" path="cf.neg" value={k.cf.neg} text="Negative numbers in colour" />
        {k.cf.neg && <ColorPickRow label="Colour" path="cf.negColor" value={k.cf.negColor} />}
        <Toggle label="One cell" path="cell.on" value={k.cell.on} />
        {k.cell.on && (
          <>
            <Num label="Row" path="cell.row" value={k.cell.row} min={1} />
            <Num label="Column" path="cell.col" value={k.cell.col} min={1} />
            <Colours path="cell" />
          </>
        )}
      </Section>
      <Section id="te-borders" title="Borders" closed>
        {(
          [
            ['outer', 'Outer'],
            ['innerH', 'Between rows'],
            ['innerV', 'Between columns'],
          ] as const
        ).map(([b, lab]) => (
          <div key={b}>
            <Toggle label={lab} path={`borders.${b}.on`} value={k.borders[b].on} />
            {k.borders[b].on && (
              <>
                <Num label="Width" path={`borders.${b}.width`} value={k.borders[b].width} min={1} max={50} unit="px" />
                <ColorPickRow label="Colour" path={`borders.${b}.color`} value={k.borders[b].color} />
              </>
            )}
          </div>
        ))}
      </Section>
      <Section id="te-merges" title="Merged cells" closed>
        <Btns
          list={[
            {
              label: k.merges.length ? '+ Merge' : 'Merge cells',
              cls: 'ghost',
              onClick: () => set('merges', [...k.merges, { on: true, row: 2, col: 1, span: 2, text: '' }]),
            },
          ]}
        />
        {k.merges.map((g, i) => (
          <div key={i} className="te-merge">
            <Num label="Row" path={`merges.${i}.row`} value={g.row} min={1} />
            <Num label="From column" path={`merges.${i}.col`} value={g.col} min={1} />
            <Num label="Cells" path={`merges.${i}.span`} value={g.span} min={2} />
            <Text label="Text" path={`merges.${i}.text`} value={g.text} placeholder="Keep the first cell" />
            <Btns
              list={[
                {
                  label: 'Remove',
                  cls: 'ghost',
                  onClick: () =>
                    set(
                      'merges',
                      k.merges.filter((_, q) => q !== i),
                    ),
                },
              ]}
            />
          </div>
        ))}
      </Section>
      <Section id="te-empty" title="No rows" closed>
        <Seg
          label="Shows"
          path="emptyMode"
          value={k.emptyMode}
          options={[
            ['message', 'Message'],
            ['hide', 'Nothing'],
          ]}
        />
        {k.emptyMode === 'message' && <Text label="Message" path="emptyText" value={k.emptyText} />}
      </Section>
      <p className="te-hint">
        <ArrowDownUp size={11} /> Click a column, a row or the title on the table to edit it.
      </p>
    </div>
  );
}

/** Background and text colours of a level, one per row (the panel is narrow for both on one line). */
function Colours({ path }: { path: string }) {
  const b = useBound();
  const v = (getPath(b.obj, path) ?? {}) as { bg?: string; color?: string };
  const d = (getPath({ st: DST, cell: { bg: '#facc15', color: '#111111' } }, path) ?? {}) as { bg?: string; color?: string };
  return (
    <>
      <ColorPickRow label="Background" path={`${path}.bg`} value={v.bg ?? d.bg ?? '#000000'} />
      <ColorPickRow label="Text" path={`${path}.color`} value={v.color ?? d.color ?? '#ffffff'} />
    </>
  );
}

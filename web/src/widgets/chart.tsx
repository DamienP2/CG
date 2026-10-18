// Chart: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/chart.rs; layout mirrored in chart-layout.tsx; actions in crates/cg-core/src/wid/chart.rs.
import { useEffect } from 'react';
import { ChartColumn } from 'lucide-react';
import { num, type Resolved } from '../engine/evaluate';
import type { Data } from '../engine/types';
import { GroupRow } from '../designer/Inspector';
import { Btns, ColorPick, Content, defineWidget, GridEditor, Msg, Note, Num, Range, Row, Section, Seg, Select, Text, Toggle, useKeys, type Warning } from './kit';
import { cfg, fmt, layout, parse, PAL, resolveGrid, revealMode, SAMPLE, seriesStyle, shownGrid, sliceColor, st, steps, withData, type Config as LConfig, type Out, type Prim, type State as LState } from './chart-layout';

/** Settings of the layer (flattened into it; every field optional). */
export type Config = LConfig;
/** What the operator changes on air (mirrors `State` in the Rust module). */
export type State = LState;

const SAMPLES: Record<string, { data: string[][]; axis: { suffix: string; decimals: number } }> = {
  poll: { data: SAMPLE, axis: { suffix: ' %', decimals: 0 } },
  budget: {
    data: [
      ['Year', 'Revenue', 'Costs', 'Balance'],
      ['2021', '42', '-38', '4'],
      ['2022', '45', '-47', '-2'],
      ['2023', '51', '-49', '2'],
      ['2024', '48', '-53', '-5'],
      ['2025', '56', '-50', '6'],
    ],
    axis: { suffix: ' M€', decimals: 0 },
  },
  share: {
    data: [
      ['Channel', 'Share'],
      ['Pulse TV', '24.5'],
      ['TF Nord', '18.2'],
      ['Canal Est', '14.9'],
      ['Info 24', '9.1'],
      ['Sport+', '5.4'],
      ['Kids', '3.2'],
      ['Docs', '2.1'],
      ['Music', '1.4'],
      ['Local', '0.9'],
      ['Weather', '0.6'],
    ],
    axis: { suffix: ' %', decimals: 1 },
  },
};

/** Layout of the layer at a moment (both the stage and the warnings use it). */
function run(layer: Config, data: Data, state: unknown, w: number, h: number, fs: number, ageMs: number, now: number): Out {
  const c0 = cfg(layer);
  const s = st(state);
  const grid = shownGrid(c0, s, data);
  return layout({ cfg: withData(c0, data), st: s, grid, w, h, fs, ageMs, now });
}

let seq = 0;
function Svg({ prims, w, h }: { prims: Prim[]; w: number; h: number }) {
  const id = `wch${(seq = (seq + 1) % 1e6)}`;
  const clips = new Map<string, number>();
  const clipOf = (c?: [number, number, number, number]) => {
    if (!c) return undefined;
    const k = c.join(',');
    if (!clips.has(k)) clips.set(k, clips.size);
    return `url(#${id}c${clips.get(k)})`;
  };
  const body = prims.map((p, i) => {
    if (p.kind === 'shape')
      return (
        <path
          key={i}
          d={p.d}
          clipPath={clipOf(p.clip)}
          fill={p.fill ?? 'none'}
          fillOpacity={p.fillOpacity}
          stroke={p.stroke ?? 'none'}
          strokeWidth={p.stroke ? p.width : undefined}
          strokeDasharray={p.dash?.join(' ')}
          strokeLinejoin={p.round ? 'round' : 'miter'}
          strokeLinecap={p.round ? 'round' : 'butt'}
          opacity={p.opacity}
        />
      );
    if (!p.text || p.opacity <= 0) return null;
    return (
      <text
        key={i}
        x={p.x}
        y={p.y}
        clipPath={clipOf(p.clip)}
        transform={p.rotate ? `rotate(-90 ${p.x} ${p.y})` : undefined}
        textAnchor={p.anchor}
        fontSize={p.size}
        fontWeight={p.weight}
        fill={p.fill}
        opacity={p.opacity}
        stroke={p.halo}
        strokeWidth={p.halo ? 5 : undefined}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ whiteSpace: 'pre' }}
      >
        {p.text}
      </text>
    );
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <defs>
        {[...clips].map(([k, n]) => {
          const [x, y, cw, ch] = k.split(',').map(Number);
          return (
            <clipPath key={n} id={`${id}c${n}`} clipPathUnits="userSpaceOnUse">
              <rect x={x} y={y} width={cw} height={ch} />
            </clipPath>
          );
        })}
      </defs>
      {body}
    </svg>
  );
}

const fsOf = (r: Resolved | undefined, layer: { props: Record<string, unknown> }) => num((r?.fontSize ?? layer.props.fontSize ?? 26) as number);

export default defineWidget({
  id: 'chart',
  type: 'chart',
  label: 'Chart',
  group: 'Data',
  icon: ChartColumn,
  presets: [
    { label: 'Columns', hint: 'Grouped, stacked or 100 %' },
    { label: 'Lines', patch: { chartType: 'lines' } },
    { label: 'Areas', patch: { chartType: 'areas', areaMode: 'stacked' } },
    { label: 'Pie', patch: { chartType: 'pie', data: SAMPLES.share.data, axis: { suffix: ' %', decimals: 1 }, labels: { value: false, pct: true, name: true, pos: 'outside' }, title: { text: 'Audience share', sub: 'Yesterday · 4+' } } },
  ],
  create: () => ({ chartType: 'columns', data: SAMPLE.map((r) => r.slice()), props: { width: 1460, height: 820, fontSize: 26 } }),
  ownsLook: true,
  live: () => true,
  content: ['csv', 'title.text'],
  Render: ({ layer, r, w, h, data, time, state }) => {
    const out = run(layer, data, state, w, h, num(r.fontSize), time.ageSecs * 1000, time.nowMs);
    return <Svg prims={out.prims} w={w} h={h} />;
  },
  Inspector: ({ layer, data, edit }) => {
    const c = cfg(layer);
    const P = parse(c, resolveGrid(c, data));
    const type = c.chartType;
    return (
      <>
        <Section id="chart-chart" title="Chart">
          <Seg
            label="Type"
            path="chartType"
            value={c.chartType}
            options={[
              ['columns', 'Columns'],
              ['areas', 'Areas'],
              ['lines', 'Lines'],
              ['pie', 'Pie'],
            ]}
          />
          {type === 'columns' && (
            <Seg
              label="Columns"
              path="colMode"
              value={c.colMode}
              options={[
                ['grouped', 'Grouped'],
                ['stacked', 'Stacked'],
                ['percent', '100 %'],
              ]}
            />
          )}
          {type === 'areas' && (
            <Seg
              label="Areas"
              path="areaMode"
              value={c.areaMode}
              options={[
                ['simple', 'Simple'],
                ['stacked', 'Stacked'],
              ]}
            />
          )}
          <GroupRow layer={layer} spec={{ label: 'Text size', props: ['fontSize'], min: 8, suffix: 'px' }} />
        </Section>
        <Section id="chart-data" title="Data">
          <Seg
            label="Source"
            path="source"
            value={c.source}
            options={[
              ['grid', 'Typed'],
              ['csv', 'CSV'],
            ]}
          />
          {c.source === 'csv' ? (
            <>
              <Content label="CSV" path="csv" value="" multiline placeholder={'Month;Martin;Durand\nJan;28;24'} />
              <Note>Paste CSV text, or wire a {'{{key}}'} whose data value is CSV text (a linked source of the Data canvas). First column: categories; first row: series names.</Note>
            </>
          ) : (
            <>
              <Select
                label="Sample"
                value=""
                options={[
                  ['', 'Load a sample…'],
                  ['poll', 'Poll (3 series × 6 months)'],
                  ['budget', 'Budget (negative values)'],
                  ['share', 'Audience share (pie)'],
                ]}
                onChange={(v) =>
                  SAMPLES[v] &&
                  edit((l) => {
                    l.data = SAMPLES[v].data.map((r) => r.slice());
                    l.axis = { ...l.axis, ...SAMPLES[v].axis };
                  })
                }
              />
              <GridEditor path="data" value={c.data} header csv />
              <Note>First column: categories. Other columns: one series each (header = name). Empty cell = missing value. A cell may hold a {'{{key}}'} of the Data canvas.</Note>
            </>
          )}
          <Seg
            label="Missing"
            path="missing"
            value={c.missing}
            options={[
              ['gap', 'Gap'],
              ['interp', 'Interpolate'],
              ['zero', 'As zero'],
            ]}
          />
        </Section>
        {type !== 'pie' && (
          <Section id="chart-axes" title="Axes">
            {type === 'columns' && c.colMode === 'percent' ? (
              <Note>100 %: the axis is fixed at 0 – 100 %.</Note>
            ) : (
              <>
                <Seg
                  label="Range"
                  path="axis.auto"
                  value={c.axis.auto}
                  options={[
                    [true, 'Auto'],
                    [false, 'Fixed'],
                  ]}
                />
                {!c.axis.auto && (
                  <>
                    <Num label="Min" path="axis.min" value={c.axis.min} precision={2} />
                    <Num label="Max" path="axis.max" value={c.axis.max} precision={2} />
                  </>
                )}
                {type === 'lines' && c.axis.auto && <Toggle label="Zero" path="axis.zero" value={c.axis.zero} text="Start the axis at zero" />}
              </>
            )}
            <Range label="Ticks" path="axis.ticks" value={c.axis.ticks} min={2} max={12} />
            <Seg
              label="Decimals"
              path="axis.decimals"
              value={c.axis.decimals}
              options={[
                [0, '0'],
                [1, '0.0'],
                [2, '0.00'],
              ]}
            />
            <Text label="Prefix" path="axis.prefix" value={c.axis.prefix} placeholder="$" />
            <Text label="Suffix" path="axis.suffix" value={c.axis.suffix} placeholder=" %" />
            <Seg
              label="Thousands"
              path="axis.sep"
              value={c.axis.sep}
              options={[
                ['space', '1 000'],
                ['comma', '1,000'],
                ['none', '1000'],
              ]}
            />
            <Toggle label="Grid" path="axis.grid" value={c.axis.grid} text="Horizontal lines" />
            <Toggle label="" path="axis.vgrid" value={c.axis.vgrid} text="Vertical lines" />
            <Text label="X title" path="axis.xTitle" value={c.axis.xTitle} placeholder="e.g. Month" />
            <Text label="Y title" path="axis.yTitle" value={c.axis.yTitle} placeholder="e.g. % of voters" />
          </Section>
        )}
        {type !== 'pie' && (
          <Section id="chart-series" title="Series">
            {P.ser.map((name, j) => {
              const s = seriesStyle(c, j);
              return (
                <Row key={j} label={name}>
                  <input type="color" value={s.color.slice(0, 7)} onChange={(e) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), color: e.target.value }), `chs-${layer.id}-${j}`)} />
                  {type !== 'columns' && (
                    <>
                      <select title="Line width" value={s.width} onChange={(e) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), width: +e.target.value }))}>
                        {[0, 2, 4, 6, 8, 12].map((v) => (
                          <option key={v} value={v}>
                            {v} px
                          </option>
                        ))}
                      </select>
                      <select title="Markers" value={s.marker} onChange={(e) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), marker: e.target.value as never }))}>
                        <option value="none">No marker</option>
                        <option value="circle">● Circle</option>
                        <option value="square">■ Square</option>
                        <option value="diamond">◆ Diamond</option>
                      </select>
                    </>
                  )}
                </Row>
              );
            })}
            {type !== 'columns' && (
              <>
                <Toggle label="Smoothing" path="smooth" value={c.smooth} text="Smooth curves" />
                <Note>Width 0 px on an area: no outline line.</Note>
              </>
            )}
            {type === 'areas' && <Range label="Area opacity" path="areaOpacity" value={c.areaOpacity} min={0.1} max={1} step={0.05} />}
          </Section>
        )}
        {type === 'pie' && (
          <Section id="chart-pie" title="Pie">
            <Select label="Series" path="pie.series" value={c.pie.series} options={P.ser.map((x, j) => [j, x] as const)} />
            <Range label="Start angle" path="pie.start" value={c.pie.start} min={0} max={359} unit="°" />
            <Seg
              label="Sort"
              path="pie.sort"
              value={c.pie.sort}
              options={[
                ['none', 'As typed'],
                ['desc', 'Largest first'],
                ['asc', 'Smallest first'],
              ]}
            />
            <Range label="Donut" path="pie.donut" value={c.pie.donut} min={0} max={85} fmt={(v) => (v ? `${v} %` : 'Full pie')} />
            {c.pie.donut > 30 && <Toggle label="Centre" path="pie.centerTotal" value={c.pie.centerTotal} text="Show the total in the hole" />}
            <Select label="Exploded" path="pie.explode" value={c.pie.explode} options={[[-1, 'None'] as const, ...P.cats.map((x) => [x.ri, x.name] as const)]} />
            {c.pie.explode >= 0 && <Range label="Distance" path="pie.explodeDist" value={c.pie.explodeDist} min={5} max={90} unit=" px" />}
            <Toggle label="Others" path="pie.others" value={c.pie.others} text="Group small slices" />
            {c.pie.others && <Range label="Under" path="pie.othersPct" value={c.pie.othersPct} min={1} max={15} step={0.5} unit=" %" />}
            {P.cats.slice(0, 12).map((x, i) => (
              <ColorPick key={i} label={x.name} value={sliceColor(c, i)} onChange={(v) => edit((l) => void ((l.sliceColors ??= PAL.slice(0, Math.max(i + 1, P.cats.length)).map((_, k) => sliceColor(c, k)))[i] = v), `chsl-${layer.id}-${i}`)} />
            ))}
          </Section>
        )}
        <Section id="chart-labels" title="Labels">
          <Toggle label="Show" path="labels.value" value={c.labels.value} text="Value" />
          <Toggle label="" path="labels.pct" value={c.labels.pct} text="Percentage" />
          <Toggle label="" path="labels.name" value={c.labels.name} text={type === 'pie' ? 'Slice name' : type === 'columns' ? 'Series name' : 'Series name at the line end'} />
          <Seg
            label="Position"
            path="labels.pos"
            value={c.labels.pos}
            options={[
              ['inside', 'Inside'],
              ['outside', type === 'pie' ? 'Outside + leader' : 'Outside'],
            ]}
          />
          <Seg
            label="Overlap"
            path="labels.overlap"
            value={c.labels.overlap}
            options={[
              ['offset', 'Offset'],
              ['hide', 'Hide'],
            ]}
          />
          {type === 'pie' && <Range label="Min slice" path="labels.minSize" value={c.labels.minSize} min={0} max={10} step={0.5} unit=" %" />}
          <Note>
            {type === 'pie'
              ? 'Offset: crowded labels are moved apart (small slices go outside with a leader line). Hide: no label under the minimum slice size, nor when it would overlap.'
              : 'Offset: labels that collide are moved (staggered or pushed apart, outside when a bar is too small). Hide: they are dropped.'}
          </Note>
        </Section>
        <Section id="chart-title" title="Title & legend" closed>
          <Content label="Title" path="title.text" value={c.title.text} />
          <Content label="Subtitle" path="title.sub" value={c.title.sub} />
          <Seg
            label="Title"
            path="title.pos"
            value={c.title.pos}
            options={[
              ['left', 'Left'],
              ['center', 'Centre'],
              ['none', 'Hidden'],
            ]}
          />
          <Seg
            label="Legend"
            path="legend"
            value={c.legend}
            options={[
              ['top', 'Top'],
              ['bottom', 'Bottom'],
              ['right', 'Right'],
              ['none', 'None'],
            ]}
          />
          <Toggle label="Panel" path="panel.on" value={c.panel.on} text="Background panel" />
          {c.panel.on && (
            <>
              <ColorPick label="Panel colour" path="panel.color" value={c.panel.color} />
              <Range label="Panel opacity" path="panel.opacity" value={c.panel.opacity} min={0.2} max={1} step={0.02} />
            </>
          )}
        </Section>
        <Section id="chart-anim" title="Animation">
          <Seg
            label="Entrance"
            path="anim.fx"
            value={c.anim.fx}
            options={[
              ['auto', 'By type'],
              ['grow', 'Grow'],
              ['draw', 'Draw'],
              ['sweep', 'Sweep'],
              ['fade', 'Fade'],
              ['none', 'Cut'],
            ]}
          />
          <Note>By type: columns grow, lines and areas draw from left to right, the pie sweeps round. It runs from the take (scrub the timeline to replay it here).</Note>
          <Range label="Duration" path="anim.dur" value={c.anim.dur} min={0.2} max={3} step={0.1} unit=" s" />
          <Range label="Stagger" path="anim.stagger" value={c.anim.stagger} min={0} max={400} step={10} unit=" ms" />
          <Range label="Update" path="anim.upd" value={c.anim.upd} min={0} max={3} step={0.1} fmt={(v) => (v ? `${v.toFixed(1)} s` : 'Cut')} />
          <Seg
            label="Curve"
            path="anim.curve"
            value={c.anim.curve}
            options={[
              ['ease', 'Ease in-out'],
              ['out', 'Ease out'],
              ['linear', 'Linear'],
            ]}
          />
          <Seg
            label="Reveal"
            path="reveal"
            value={c.reveal}
            options={[
              ['all', 'All at once'],
              ['series', 'Series by series'],
              ['categories', type === 'pie' ? 'Slice by slice' : 'Category by category'],
            ]}
          />
          <Note>Update: on Reload, values are interpolated from what is on screen (no restart). A category added on air grows in on its own. Reveal: the Operator shows the next step.</Note>
        </Section>
      </>
    );
  },
  Operator: ({ layer, state, data, act, item, time }) => {
    const c = cfg(layer);
    const s = st(state);
    // On air: keep the values taken, so that later data updates tween on Reload.
    const snap = !!item && !s.cur;
    useEffect(() => {
      if (snap) act('reload', { cut: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap]);
    const P = parse(c, shownGrid(c, s, data));
    const live = resolveGrid(c, data);
    const pending = !!s.cur && JSON.stringify(s.cur) !== JSON.stringify(live);
    const n = steps(c, s, P);
    const mode = revealMode(c, s);
    const step = Math.min(Math.max(1, s.step), n);
    useKeys({ r: () => act('reload'), ArrowRight: () => n && act('next'), ArrowLeft: () => n && act('prev') });
    const next = mode === 'series' ? P.ser[step] : P.cats[step]?.name;
    const hlBtns = (kind: 'series' | 'category', items: [number, string][]) => [
      { label: 'None', cls: s.hl.kind === 'none' ? 'violet' : 'ghost', onClick: () => act('highlight', { kind: 'none' }) },
      ...items.map(([idx, name]) => ({ label: name, cls: s.hl.kind === kind && s.hl.idx === idx ? 'violet' : 'ghost', onClick: () => act('highlight', { kind, idx }) })),
    ];
    void time;
    return (
      <>
        <Note>
          {s.cur ? pending ? <b style={{ color: '#facc15' }}>● New data waiting: Reload to show it</b> : 'Data on screen is up to date' : 'Live data'}
          {n ? (
            <>
              {' '}
              · Step{' '}
              <b>
                {step} / {n}
              </b>
              {step < n ? (
                <>
                  {' '}
                  · next: <b>{next}</b>
                </>
              ) : (
                ' · all shown'
              )}
            </>
          ) : null}
        </Note>
        <Btns label="Data" list={[{ label: '⟳ Reload data', cls: `violet big`, keyHint: 'R', onClick: () => act('reload'), title: 'Values move from what is shown to the current data' }]} />
        <Seg label="Reveal" value={mode} onChange={(v) => act('revealMode', { mode: v })} options={[['all', 'All at once'], ...(c.chartType === 'pie' ? [] : [['series', 'Series by series'] as const]), ['categories', c.chartType === 'pie' ? 'Slice by slice' : 'Category by category']]} />
        {n > 0 && (
          <Btns
            list={[
              { label: '◀ Back', cls: 'ghost', keyHint: '←', onClick: () => act('prev'), disabled: step <= 1 },
              { label: 'Next step ▶', cls: 'green big', keyHint: '→', onClick: () => act('next'), disabled: step >= n },
              { label: 'Show all', cls: 'ghost', onClick: () => act('showAll'), disabled: step >= n },
            ]}
          />
        )}
        {c.chartType !== 'pie' ? (
          <>
            <Btns
              label="Highlight series"
              list={hlBtns(
                'series',
                P.ser.map((x, j) => [j, x]),
              )}
            />
            <Btns
              label={c.chartType === 'columns' ? 'Highlight column' : 'Highlight point'}
              list={hlBtns(
                'category',
                P.cats.slice(0, 14).map((x) => [x.ri, x.name]),
              )}
            />
          </>
        ) : (
          <Btns
            label="Highlight slice"
            list={hlBtns(
              'category',
              P.cats.slice(0, 14).map((x) => [x.ri, x.name]),
            )}
          />
        )}
        {s.cur && !item && (
          <Msg level="info">
            The try-out holds the data of its last Reload.{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), act('reset'))}>
              Back to the live data
            </a>
          </Msg>
        )}
      </>
    );
  },
  warnings: (layer, { data, state, r }) => {
    const c = cfg(layer);
    const s = st(state);
    const P = parse(c, shownGrid(c, s, data));
    const w = num((r?.width ?? layer.props.width ?? 1460) as number);
    const h = num((r?.height ?? layer.props.height ?? 820) as number);
    const o = run(layer, data, state, w, h, fsOf(r, layer), 1e9, Date.now() + 1e7);
    const out: Warning[] = [];
    if (c.chartType === 'pie') {
      if (o.pieNeg.length) out.push({ level: 'error', text: `Negative value refused in a pie: ${o.pieNeg.map(([n, v]) => `${n} (${fmt(c, v)})`).join(', ')} not drawn.`, op: true });
      if (o.pieZero) out.push({ level: 'error', text: 'Pie total is zero: empty circle shown, nothing to share out.', op: true });
      if (o.pieOthers) out.push({ level: 'info', text: `${o.pieOthers} slices under ${c.pie.othersPct} % grouped in "Others".` });
      if (P.ser.length > 1) out.push({ level: 'info', text: `A pie shows one series: "${P.ser[Math.min(Math.max(0, c.pie.series), P.ser.length - 1)]}".` });
      if (o.pieMissing) out.push({ level: 'info', text: `${o.pieMissing} missing value${o.pieMissing > 1 ? 's' : ''}: slice not drawn.` });
    } else {
      if (P.missing) out.push({ level: 'info', text: `${P.missing} missing value${P.missing > 1 ? 's' : ''}: ${c.missing === 'gap' ? 'shown as a gap' : c.missing === 'interp' ? 'interpolated (hollow marker / dashed column), gap at the ends' : 'counted as zero'}.`, op: true });
      const hasNeg = P.cats.some((x) => x.vals.some((v) => v != null && v < 0));
      if (hasNeg && c.chartType === 'columns' && c.colMode === 'percent') out.push({ level: 'warn', text: '100 % columns with negative values: negatives are left out of the shares.' });
      if (hasNeg && c.chartType === 'areas' && c.areaMode === 'stacked') out.push({ level: 'warn', text: 'Stacked areas with negative values are hard to read: prefer lines or columns.' });
      if (!c.axis.auto && !(c.chartType === 'columns' && c.colMode === 'percent')) {
        const all = P.cats.flatMap((x) => x.vals).filter((v): v is number => v != null);
        if (all.some((v) => v > c.axis.max || v < c.axis.min)) out.push({ level: 'warn', text: `Fixed axis ${c.axis.min} – ${c.axis.max}: some values are outside and cut at the edge.` });
      }
    }
    if (!P.cats.length || !P.ser.length) out.push({ level: 'warn', text: 'No data: the chart shows "No data".', op: true });
    if (o.hidden) out.push({ level: 'info', text: `${o.hidden} label${o.hidden > 1 ? 's' : ''} hidden to avoid overlaps${c.chartType === 'pie' && c.labels.overlap === 'hide' ? ` (or under ${c.labels.minSize} %)` : ''}.` });
    return out;
  },
});

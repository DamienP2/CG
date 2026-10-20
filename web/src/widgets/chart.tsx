// Chart: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/chart.rs; layout mirrored in chart-layout.tsx; actions in crates/cg-core/src/wid/chart.rs.
import { Dropdown } from '../ui/Dropdown';
import { useEffect } from 'react';
import { ChartColumn } from 'lucide-react';
import { num, type Resolved } from '../engine/evaluate';
import type { Data } from '../engine/types';
import { GroupRow } from '../designer/Inspector';
import { Btns, ColorPick, Content, defineWidget, GridEditor, Msg, Note, Num, Row, Section, Seg, Select, Text, Toggle, useKeys, type Warning } from './kit';
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
      ['Strata TV', '24.5'],
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
  create: () => ({ chartType: 'columns', data: SAMPLE.map((r) => r.slice()), title: { pos: 'none' }, labels: { value: false }, panel: { on: false }, props: { width: 1460, height: 820, fontSize: 26 } }),
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
    const pct = type === 'columns' && c.colMode === 'percent';
    const labelsOn = c.labels.value || c.labels.pct || c.labels.name;
    return (
      <>
        <Section id="chart-data" title="Data">
          <Seg
            label="Source"
            path="source"
            value={c.source}
            options={[
              ['grid', 'Table'],
              ['csv', 'CSV'],
            ]}
          />
          {c.source === 'csv' ? (
            <Content label="CSV" path="csv" value="" multiline placeholder={'Month;Martin;Durand\nJan;28;24'} />
          ) : (
            <>
              <Select
                label="Sample"
                value=""
                options={[
                  ['', 'Load…'],
                  ['poll', 'Poll'],
                  ['budget', 'Budget'],
                  ['share', 'Audience share'],
                ]}
                onChange={(v) =>
                  SAMPLES[v] &&
                  edit((l) => {
                    l.data = SAMPLES[v].data.map((r) => r.slice());
                    l.axis = { ...l.axis, ...SAMPLES[v].axis };
                  })
                }
              />
              <Row expose="data" exposeValue={c.data}>
                <GridEditor path="data" value={c.data} header csv />
              </Row>
            </>
          )}
          <Seg
            label="Missing"
            path="missing"
            value={c.missing}
            options={[
              ['gap', 'Gap'],
              ['interp', 'Interpolate'],
              ['zero', 'Zero'],
            ]}
          />
        </Section>
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
          {type === 'pie' && (
            <>
              <Select label="Series" path="pie.series" value={c.pie.series} options={P.ser.map((x, j) => [j, x] as const)} />
              <Seg
                label="Sort"
                path="pie.sort"
                value={c.pie.sort}
                options={[
                  ['none', 'As typed'],
                  ['desc', 'Largest'],
                  ['asc', 'Smallest'],
                ]}
              />
              <Num label="Start angle" path="pie.start" value={c.pie.start} min={0} max={359} unit="°" />
              <Num label="Donut" path="pie.donut" value={c.pie.donut} min={0} max={85} unit="%" />
              {c.pie.donut > 30 && <Toggle label="Total" path="pie.centerTotal" value={c.pie.centerTotal} />}
              <Select label="Exploded" path="pie.explode" value={c.pie.explode} options={[[-1, 'None'] as const, ...P.cats.map((x) => [x.ri, x.name] as const)]} />
              {c.pie.explode >= 0 && <Num label="Distance" path="pie.explodeDist" value={c.pie.explodeDist} min={0} max={400} unit="px" />}
              <Toggle label="Others" path="pie.others" value={c.pie.others} />
              {c.pie.others && <Num label="Under" path="pie.othersPct" value={c.pie.othersPct} min={0} max={50} step={0.5} precision={1} unit="%" />}
            </>
          )}
        </Section>
        {type !== 'pie' && (
          <Section id="chart-axes" title="Axes">
            {!pct && (
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
                {type === 'lines' && c.axis.auto && <Toggle label="From zero" path="axis.zero" value={c.axis.zero} />}
              </>
            )}
            <Num label="Ticks" path="axis.ticks" value={c.axis.ticks} min={2} max={12} />
            <Toggle label="Grid" path="axis.grid" value={c.axis.grid} />
            <Toggle label="Vertical grid" path="axis.vgrid" value={c.axis.vgrid} />
            <Text label="X title" path="axis.xTitle" value={c.axis.xTitle} />
            <Text label="Y title" path="axis.yTitle" value={c.axis.yTitle} />
          </Section>
        )}
        <Section id="chart-format" title="Numbers">
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
        </Section>
        {type !== 'pie' ? (
          <Section id="chart-series" title="Series">
            {P.ser.map((name, j) => {
              const s = seriesStyle(c, j);
              return (
                <Row expose={[`series.${j}.color`, `series.${j}.width`, `series.${j}.marker`]} exposeValue={{ [`series.${j}.color`]: s.color, [`series.${j}.width`]: s.width, [`series.${j}.marker`]: s.marker }} key={j} label={name}>
                  <input type="color" value={s.color.slice(0, 7)} onChange={(e) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), color: e.target.value }), `chs-${layer.id}-${j}`)} />
                  {type !== 'columns' && (
                    <>
                      <span className="dd-cell" title="Line width">
                        <Dropdown value={String(s.width)} options={[0, 2, 4, 6, 8, 12].map((v) => ({ value: String(v), label: `${v} px` }))} onChange={(v) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), width: +v }))} />
                      </span>
                      <span className="dd-cell" title="Marker">
                        <Dropdown
                          value={s.marker}
                          options={[
                            { value: 'none', label: '—' },
                            { value: 'circle', label: '● Circle' },
                            { value: 'square', label: '■ Square' },
                            { value: 'diamond', label: '◆ Diamond' },
                          ]}
                          onChange={(v) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), marker: v as never }))}
                        />
                      </span>
                    </>
                  )}
                </Row>
              );
            })}
            {type !== 'columns' && <Toggle label="Smooth" path="smooth" value={c.smooth} />}
            {type === 'areas' && <Num label="Area opacity" expose="areaOpacity" exposeValue={c.areaOpacity} value={Math.round(c.areaOpacity * 100)} min={10} max={100} unit="%" onChange={(v) => edit((l) => void (l.areaOpacity = v / 100), `chao-${layer.id}`)} />}
          </Section>
        ) : (
          <Section id="chart-slices" title="Slices">
            {P.cats.slice(0, 12).map((x, i) => (
              <ColorPick
                expose={`sliceColors.${i}`}
                exposeValue={sliceColor(c, i)}
                key={i}
                label={x.name}
                value={sliceColor(c, i)}
                onChange={(v) => edit((l) => void ((l.sliceColors ??= PAL.slice(0, Math.max(i + 1, P.cats.length)).map((_, k) => sliceColor(c, k)))[i] = v), `chsl-${layer.id}-${i}`)}
              />
            ))}
          </Section>
        )}
        <Section id="chart-labels" title="Labels">
          <Toggle
            expose={['labels.value', 'labels.pct', 'labels.name']}
            exposeValue={{ 'labels.value': c.labels.value, 'labels.pct': c.labels.pct, 'labels.name': c.labels.name }}
            label="Labels"
            value={labelsOn}
            onChange={(v) => edit((l) => void (l.labels = { ...l.labels, value: v, pct: false, name: false }))}
          />
          {labelsOn && (
            <>
              <Toggle label="Value" path="labels.value" value={c.labels.value} />
              <Toggle label="Percentage" path="labels.pct" value={c.labels.pct} />
              <Toggle label="Name" path="labels.name" value={c.labels.name} />
              <Seg
                label="Position"
                path="labels.pos"
                value={c.labels.pos}
                options={[
                  ['inside', 'Inside'],
                  ['outside', 'Outside'],
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
              {type === 'pie' && <Num label="Min slice" path="labels.minSize" value={c.labels.minSize} min={0} max={10} step={0.5} precision={1} unit="%" />}
            </>
          )}
        </Section>
        <Section id="chart-layout" title="Layout">
          <GroupRow layer={layer} spec={{ label: 'Text size', props: ['fontSize'], min: 8, suffix: 'px' }} />
          <Toggle
            expose="title.pos"
            exposeValue={c.title.pos}
            exposeOptions={[
              ['left', 'Left'],
              ['center', 'Centre'],
              ['none', 'Hidden'],
            ]}
            label="Title"
            value={c.title.pos !== 'none'}
            onChange={(v) => edit((l) => void (l.title = { ...l.title, pos: v ? 'left' : 'none' }))}
          />
          {c.title.pos !== 'none' && (
            <>
              <Content label="Title" path="title.text" value={c.title.text} />
              <Content label="Subtitle" path="title.sub" value={c.title.sub} />
              <Seg
                expose={false}
                label="Align"
                path="title.pos"
                value={c.title.pos}
                options={[
                  ['left', 'Left'],
                  ['center', 'Centre'],
                ]}
              />
            </>
          )}
          <Toggle
            expose="legend"
            exposeValue={c.legend}
            exposeOptions={[
              ['top', 'Top'],
              ['bottom', 'Bottom'],
              ['right', 'Right'],
              ['none', 'None'],
            ]}
            label="Legend"
            value={c.legend !== 'none'}
            onChange={(v) => edit((l) => void (l.legend = v ? 'top' : 'none'))}
          />
          {c.legend !== 'none' && (
            <Seg
              expose={false}
              label="Position"
              path="legend"
              value={c.legend}
              options={[
                ['top', 'Top'],
                ['bottom', 'Bottom'],
                ['right', 'Right'],
              ]}
            />
          )}
          <Toggle label="Panel" path="panel.on" value={c.panel.on} />
          {c.panel.on && (
            <>
              <ColorPick label="Color" path="panel.color" value={c.panel.color} />
              <Num label="Opacity" expose="panel.opacity" exposeValue={c.panel.opacity} value={Math.round(c.panel.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => edit((l) => void (l.panel = { ...l.panel, opacity: v / 100 }), `chpo-${layer.id}`)} />
            </>
          )}
        </Section>
        <Section id="chart-anim" title="Animation">
          <Seg
            label="Entrance"
            path="anim.fx"
            value={c.anim.fx}
            options={[
              ['auto', 'Auto'],
              ['grow', 'Grow'],
              ['draw', 'Draw'],
              ['sweep', 'Sweep'],
              ['fade', 'Fade'],
              ['none', 'Cut'],
            ]}
          />
          <Num label="Duration" path="anim.dur" value={c.anim.dur} min={0} max={30} step={0.1} precision={1} unit="s" />
          <Num label="Stagger" path="anim.stagger" value={c.anim.stagger} min={0} max={5000} step={10} unit="ms" />
          <Num label="Update" path="anim.upd" value={c.anim.upd} min={0} max={30} step={0.1} precision={1} unit="s" />
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
              ['all', 'All'],
              ['series', 'By series'],
              ['categories', type === 'pie' ? 'By slice' : 'By category'],
            ]}
          />
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
              { label: 'Back', cls: 'ghost', keyHint: '←', onClick: () => act('prev'), disabled: step <= 1 },
              { label: 'Next step', cls: 'green big', keyHint: '→', onClick: () => act('next'), disabled: step >= n },
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

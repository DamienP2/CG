// Chart: settings, drawing, inspector and Operator controls.
// Same picture as crates/cg-render/src/wid/chart.rs; layout mirrored in chart-layout.tsx; actions in crates/cg-core/src/wid/chart.rs.
import { Dropdown } from '../ui/Dropdown';
import { useEffect } from 'react';
import { ChartColumn, ChevronLeft, ChevronRight, ChevronsRight, RefreshCw } from 'lucide-react';
import { num, type Resolved } from '../engine/evaluate';
import type { Data } from '../engine/types';
import { t, tn } from '../i18n';
import { GroupRow } from '../designer/Inspector';
import { Btns, ColorPick, Content, defineWidget, GridEditor, Msg, Note, Num, OpRow, Row, Section, Seg, Select, Text, Toggle, useKeys, type Warning } from './kit';
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
        <Section id="chart-data" title={t('Data')}>
          <Seg
            label={t('Source')}
            path="source"
            value={c.source}
            options={[
              ['grid', t('Table')],
              ['csv', 'CSV'],
            ]}
          />
          {c.source === 'csv' ? (
            <Content label="CSV" path="csv" value="" multiline placeholder={t('Month;Martin;Durand\nJan;28;24')} />
          ) : (
            <>
              <Select
                label={t('Sample')}
                value=""
                options={[
                  ['', t('Load…')],
                  ['poll', t('Poll')],
                  ['budget', t('Budget')],
                  ['share', t('Audience share')],
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
            label={t('Missing')}
            path="missing"
            value={c.missing}
            options={[
              ['gap', t('Gap')],
              ['interp', t('Interpolate')],
              ['zero', t('Zero')],
            ]}
          />
        </Section>
        <Section id="chart-chart" title={t('Chart')}>
          <Seg
            label={t('Type')}
            path="chartType"
            value={c.chartType}
            options={[
              ['columns', t('Columns')],
              ['areas', t('Areas')],
              ['lines', t('Lines')],
              ['pie', t('Pie')],
            ]}
          />
          {type === 'columns' && (
            <Seg
              label={t('Columns')}
              path="colMode"
              value={c.colMode}
              options={[
                ['grouped', t('Grouped')],
                ['stacked', t('Stacked')],
                ['percent', '100 %'],
              ]}
            />
          )}
          {type === 'areas' && (
            <Seg
              label={t('Areas')}
              path="areaMode"
              value={c.areaMode}
              options={[
                ['simple', t('Simple')],
                ['stacked', t('Stacked')],
              ]}
            />
          )}
          {type === 'pie' && (
            <>
              <Select label={t('Series')} path="pie.series" value={c.pie.series} options={P.ser.map((x, j) => [j, x] as const)} />
              <Seg
                label={t('Sort')}
                path="pie.sort"
                value={c.pie.sort}
                options={[
                  ['none', t('As typed')],
                  ['desc', t('Largest')],
                  ['asc', t('Smallest')],
                ]}
              />
              <Num label={t('Start angle')} path="pie.start" value={c.pie.start} min={0} max={359} unit="°" />
              <Num label={t('Donut')} path="pie.donut" value={c.pie.donut} min={0} max={85} unit="%" />
              {c.pie.donut > 30 && <Toggle label={t('Total')} path="pie.centerTotal" value={c.pie.centerTotal} />}
              <Select label={t('Exploded')} path="pie.explode" value={c.pie.explode} options={[[-1, t('None')] as const, ...P.cats.map((x) => [x.ri, x.name] as const)]} />
              {c.pie.explode >= 0 && <Num label={t('Distance')} path="pie.explodeDist" value={c.pie.explodeDist} min={0} max={400} unit="px" />}
              <Toggle label={t('Others')} path="pie.others" value={c.pie.others} />
              {c.pie.others && <Num label={t('Under')} path="pie.othersPct" value={c.pie.othersPct} min={0} max={50} step={0.5} precision={1} unit="%" />}
            </>
          )}
        </Section>
        {type !== 'pie' && (
          <Section id="chart-axes" title={t('Axes')}>
            {!pct && (
              <>
                <Seg
                  label={t('Range')}
                  path="axis.auto"
                  value={c.axis.auto}
                  options={[
                    [true, t('Auto')],
                    [false, t('Fixed')],
                  ]}
                />
                {!c.axis.auto && (
                  <>
                    <Num label="Min" path="axis.min" value={c.axis.min} precision={2} />
                    <Num label="Max" path="axis.max" value={c.axis.max} precision={2} />
                  </>
                )}
                {type === 'lines' && c.axis.auto && <Toggle label={t('From zero')} path="axis.zero" value={c.axis.zero} />}
              </>
            )}
            <Num label={t('Ticks')} path="axis.ticks" value={c.axis.ticks} min={2} max={12} />
            <Toggle label={t('Grid')} path="axis.grid" value={c.axis.grid} />
            <Toggle label={t('Vertical grid')} path="axis.vgrid" value={c.axis.vgrid} />
            <Text label={t('X title')} path="axis.xTitle" value={c.axis.xTitle} />
            <Text label={t('Y title')} path="axis.yTitle" value={c.axis.yTitle} />
          </Section>
        )}
        <Section id="chart-format" title={t('Numbers')}>
          <Seg
            label={t('Decimals')}
            path="axis.decimals"
            value={c.axis.decimals}
            options={[
              [0, '0'],
              [1, '0.0'],
              [2, '0.00'],
            ]}
          />
          <Text label={t('Prefix')} path="axis.prefix" value={c.axis.prefix} placeholder="$" />
          <Text label={t('Suffix')} path="axis.suffix" value={c.axis.suffix} placeholder=" %" />
          <Seg
            label={t('Thousands')}
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
          <Section id="chart-series" title={t('Series')}>
            {P.ser.map((name, j) => {
              const s = seriesStyle(c, j);
              return (
                <Row expose={[`series.${j}.color`, `series.${j}.width`, `series.${j}.marker`]} exposeValue={{ [`series.${j}.color`]: s.color, [`series.${j}.width`]: s.width, [`series.${j}.marker`]: s.marker }} key={j} label={name}>
                  <input type="color" value={s.color.slice(0, 7)} onChange={(e) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), color: e.target.value }), `chs-${layer.id}-${j}`)} />
                  {type !== 'columns' && (
                    <>
                      <span className="dd-cell" title={t('Line width')}>
                        <Dropdown value={String(s.width)} options={[0, 2, 4, 6, 8, 12].map((v) => ({ value: String(v), label: `${v} px` }))} onChange={(v) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), width: +v }))} />
                      </span>
                      <span className="dd-cell" title={t('Marker')}>
                        <Dropdown
                          value={s.marker}
                          options={[
                            { value: 'none', label: '—' },
                            { value: 'circle', label: t('● Circle') },
                            { value: 'square', label: t('■ Square') },
                            { value: 'diamond', label: t('◆ Diamond') },
                          ]}
                          onChange={(v) => edit((l) => void ((l.series ??= [])[j] = { ...(l.series?.[j] ?? {}), marker: v as never }))}
                        />
                      </span>
                    </>
                  )}
                </Row>
              );
            })}
            {type !== 'columns' && <Toggle label={t('Smooth')} path="smooth" value={c.smooth} />}
            {type === 'areas' && <Num label={t('Area opacity')} expose="areaOpacity" exposeValue={c.areaOpacity} value={Math.round(c.areaOpacity * 100)} min={10} max={100} unit="%" onChange={(v) => edit((l) => void (l.areaOpacity = v / 100), `chao-${layer.id}`)} />}
          </Section>
        ) : (
          <Section id="chart-slices" title={t('Slices')}>
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
        <Section id="chart-labels" title={t('Labels')}>
          <Toggle
            expose={['labels.value', 'labels.pct', 'labels.name']}
            exposeValue={{ 'labels.value': c.labels.value, 'labels.pct': c.labels.pct, 'labels.name': c.labels.name }}
            label={t('Labels')}
            value={labelsOn}
            onChange={(v) => edit((l) => void (l.labels = { ...l.labels, value: v, pct: false, name: false }))}
          />
          {labelsOn && (
            <>
              <Toggle label={t('Value')} path="labels.value" value={c.labels.value} />
              <Toggle label={t('Percentage')} path="labels.pct" value={c.labels.pct} />
              <Toggle label={t('Name')} path="labels.name" value={c.labels.name} />
              <Seg
                label={t('Position')}
                path="labels.pos"
                value={c.labels.pos}
                options={[
                  ['inside', t('Inside')],
                  ['outside', t('Outside')],
                ]}
              />
              <Seg
                label={t('Overlap')}
                path="labels.overlap"
                value={c.labels.overlap}
                options={[
                  ['offset', t('Offset')],
                  ['hide', t('Hide')],
                ]}
              />
              {type === 'pie' && <Num label={t('Min slice')} path="labels.minSize" value={c.labels.minSize} min={0} max={10} step={0.5} precision={1} unit="%" />}
            </>
          )}
        </Section>
        <Section id="chart-layout" title={t('Layout')}>
          <GroupRow layer={layer} spec={{ label: t('Text size'), props: ['fontSize'], min: 8, suffix: 'px' }} />
          <Toggle
            expose="title.pos"
            exposeValue={c.title.pos}
            exposeOptions={[
              ['left', t('Left')],
              ['center', t('Centre')],
              ['none', t('Hidden')],
            ]}
            label={t('Title')}
            value={c.title.pos !== 'none'}
            onChange={(v) => edit((l) => void (l.title = { ...l.title, pos: v ? 'left' : 'none' }))}
          />
          {c.title.pos !== 'none' && (
            <>
              <Content label={t('Title')} path="title.text" value={c.title.text} />
              <Content label={t('Subtitle')} path="title.sub" value={c.title.sub} />
              <Seg
                expose={false}
                label={t('Align')}
                path="title.pos"
                value={c.title.pos}
                options={[
                  ['left', t('Left')],
                  ['center', t('Centre')],
                ]}
              />
            </>
          )}
          <Toggle
            expose="legend"
            exposeValue={c.legend}
            exposeOptions={[
              ['top', t('Top')],
              ['bottom', t('Bottom')],
              ['right', t('Right')],
              ['none', t('None')],
            ]}
            label={t('Legend')}
            value={c.legend !== 'none'}
            onChange={(v) => edit((l) => void (l.legend = v ? 'top' : 'none'))}
          />
          {c.legend !== 'none' && (
            <Seg
              expose={false}
              label={t('Position')}
              path="legend"
              value={c.legend}
              options={[
                ['top', t('Top')],
                ['bottom', t('Bottom')],
                ['right', t('Right')],
              ]}
            />
          )}
          <Toggle label={t('Panel')} path="panel.on" value={c.panel.on} />
          {c.panel.on && (
            <>
              <ColorPick label={t('Color')} path="panel.color" value={c.panel.color} />
              <Num label={t('Opacity')} expose="panel.opacity" exposeValue={c.panel.opacity} value={Math.round(c.panel.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => edit((l) => void (l.panel = { ...l.panel, opacity: v / 100 }), `chpo-${layer.id}`)} />
            </>
          )}
        </Section>
        <Section id="chart-anim" title={t('Animation')}>
          <Seg
            label={t('Entrance')}
            path="anim.fx"
            value={c.anim.fx}
            options={[
              ['auto', t('Auto')],
              ['grow', t('Grow')],
              ['draw', t('Draw')],
              ['sweep', t('Sweep')],
              ['fade', t('Fade')],
              ['none', t('Cut')],
            ]}
          />
          <Num label={t('Duration')} path="anim.dur" value={c.anim.dur} min={0} max={30} step={0.1} precision={1} unit="s" />
          <Num label={t('Stagger')} path="anim.stagger" value={c.anim.stagger} min={0} max={5000} step={10} unit="ms" />
          <Num label={t('Update')} path="anim.upd" value={c.anim.upd} min={0} max={30} step={0.1} precision={1} unit="s" />
          <Seg
            label={t('Curve')}
            path="anim.curve"
            value={c.anim.curve}
            options={[
              ['ease', t('Ease in-out')],
              ['out', t('Ease out')],
              ['linear', t('Linear')],
            ]}
          />
          <Seg
            label={t('Reveal')}
            path="reveal"
            value={c.reveal}
            options={[
              ['all', t('All')],
              ['series', t('By series')],
              ['categories', type === 'pie' ? t('By slice') : t('By category')],
            ]}
          />
        </Section>
      </>
    );
  },
  // One row: the reveal step, back / next / all, reload the data.
  Compact: ({ layer, state, data, act }) => {
    const c = cfg(layer);
    const s = st(state);
    const P = parse(c, shownGrid(c, s, data));
    const n = steps(c, s, P);
    const step = Math.min(Math.max(1, s.step), n);
    return (
      <OpRow
        value={n ? `${step}/${n}` : undefined}
        list={[
          !!n && { icon: ChevronLeft, title: t('Back'), disabled: step <= 1, onClick: () => act('prev') },
          !!n && { icon: ChevronRight, title: t('Next step'), tone: 'green', disabled: step >= n, onClick: () => act('next') },
          !!n && { icon: ChevronsRight, title: t('Show all'), disabled: step >= n, onClick: () => act('showAll') },
          { icon: RefreshCw, title: t('Reload data'), onClick: () => act('reload') },
        ]}
      />
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
      { label: t('None'), cls: s.hl.kind === 'none' ? 'violet' : 'ghost', onClick: () => act('highlight', { kind: 'none' }) },
      ...items.map(([idx, name]) => ({ label: name, cls: s.hl.kind === kind && s.hl.idx === idx ? 'violet' : 'ghost', onClick: () => act('highlight', { kind, idx }) })),
    ];
    void time;
    return (
      <>
        <Note>
          {s.cur ? pending ? <b style={{ color: '#facc15' }}>{t('● New data waiting: Reload to show it')}</b> : t('Data on screen is up to date') : t('Live data')}
          {n ? (
            <>
              {' '}
              · {t('Step')}{' '}
              <b>
                {step} / {n}
              </b>
              {step < n ? (
                <>
                  {' '}
                  · {t('next:')} <b>{next}</b>
                </>
              ) : (
                ` · ${t('all shown')}`
              )}
            </>
          ) : null}
        </Note>
        <Btns label={t('Data')} list={[{ label: t('⟳ Reload data'), cls: `violet big`, keyHint: 'R', onClick: () => act('reload'), title: t('Values move from what is shown to the current data') }]} />
        <Seg label={t('Reveal')} value={mode} onChange={(v) => act('revealMode', { mode: v })} options={[['all', t('All at once')], ...(c.chartType === 'pie' ? [] : [['series', t('Series by series')] as const]), ['categories', c.chartType === 'pie' ? t('Slice by slice') : t('Category by category')]]} />
        {n > 0 && (
          <Btns
            list={[
              { label: t('Back'), cls: 'ghost', keyHint: '←', onClick: () => act('prev'), disabled: step <= 1 },
              { label: t('Next step'), cls: 'green big', keyHint: '→', onClick: () => act('next'), disabled: step >= n },
              { label: t('Show all'), cls: 'ghost', onClick: () => act('showAll'), disabled: step >= n },
            ]}
          />
        )}
        {c.chartType !== 'pie' ? (
          <>
            <Btns
              label={t('Highlight series')}
              list={hlBtns(
                'series',
                P.ser.map((x, j) => [j, x]),
              )}
            />
            <Btns
              label={c.chartType === 'columns' ? t('Highlight column') : t('Highlight point')}
              list={hlBtns(
                'category',
                P.cats.slice(0, 14).map((x) => [x.ri, x.name]),
              )}
            />
          </>
        ) : (
          <Btns
            label={t('Highlight slice')}
            list={hlBtns(
              'category',
              P.cats.slice(0, 14).map((x) => [x.ri, x.name]),
            )}
          />
        )}
        {s.cur && !item && (
          <Msg level="info">
            {t('The try-out holds the data of its last Reload.')}{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), act('reset'))}>
              {t('Back to the live data')}
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
      if (o.pieNeg.length) out.push({ level: 'error', text: t('Negative value refused in a pie: {list} not drawn.', { list: o.pieNeg.map(([n, v]) => `${n} (${fmt(c, v)})`).join(', ') }), op: true });
      if (o.pieZero) out.push({ level: 'error', text: t('Pie total is zero: empty circle shown, nothing to share out.'), op: true });
      if (o.pieOthers) out.push({ level: 'info', text: t('{n} slices under {pct} % grouped in "Others".', { n: o.pieOthers, pct: c.pie.othersPct }) });
      if (P.ser.length > 1) out.push({ level: 'info', text: t('A pie shows one series: "{name}".', { name: P.ser[Math.min(Math.max(0, c.pie.series), P.ser.length - 1)] }) });
      if (o.pieMissing) out.push({ level: 'info', text: tn(o.pieMissing, '{n} missing value: slice not drawn.', '{n} missing values: slice not drawn.') });
    } else {
      if (P.missing) {
        const how = c.missing === 'gap' ? t('shown as a gap') : c.missing === 'interp' ? t('interpolated (hollow marker / dashed column), gap at the ends') : t('counted as zero');
        out.push({ level: 'info', text: tn(P.missing, '{n} missing value: {how}.', '{n} missing values: {how}.', { how }), op: true });
      }
      const hasNeg = P.cats.some((x) => x.vals.some((v) => v != null && v < 0));
      if (hasNeg && c.chartType === 'columns' && c.colMode === 'percent') out.push({ level: 'warn', text: t('100 % columns with negative values: negatives are left out of the shares.') });
      if (hasNeg && c.chartType === 'areas' && c.areaMode === 'stacked') out.push({ level: 'warn', text: t('Stacked areas with negative values are hard to read: prefer lines or columns.') });
      if (!c.axis.auto && !(c.chartType === 'columns' && c.colMode === 'percent')) {
        const all = P.cats.flatMap((x) => x.vals).filter((v): v is number => v != null);
        if (all.some((v) => v > c.axis.max || v < c.axis.min)) out.push({ level: 'warn', text: t('Fixed axis {min} – {max}: some values are outside and cut at the edge.', { min: c.axis.min, max: c.axis.max }) });
      }
    }
    if (!P.cats.length || !P.ser.length) out.push({ level: 'warn', text: t('No data: the chart shows "No data".'), op: true });
    if (o.hidden)
      out.push({
        level: 'info',
        text: c.chartType === 'pie' && c.labels.overlap === 'hide' ? tn(o.hidden, '{n} label hidden to avoid overlaps (or under {pct} %).', '{n} labels hidden to avoid overlaps (or under {pct} %).', { pct: c.labels.minSize }) : tn(o.hidden, '{n} label hidden to avoid overlaps.', '{n} labels hidden to avoid overlaps.'),
      });
    return out;
  },
});

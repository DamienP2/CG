// The Widget Builder's Essayer space: the widget being built played as the Operator will, without a
// channel. The Preview prepares its start values; « Take » puts it on the Programme, where its
// arrival animation plays and the panel acts live (its Logic run by the server, as on air), its
// clocks run and its animations start when their variables change.
import { useEffect, useMemo, useRef, useState } from 'react';
import { placeWidget, startValue, varKey, type Forward } from '../engine/built';
import { defaultData } from '../engine/evaluate';
import { LiveTime } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import { MARKER_MODEL, type BuiltControl, type Data, type Layer, type Template } from '../engine/types';
import { placedLogic } from '../engine/widgetLogic';
import { watchAnims } from '../engine/widgetAnims';
import { t } from '../i18n';
import { api, clientNow, useApp } from '../store';
import { defOf } from '../designer/builder';
import { useDesigner } from '../designer/designerStore';
import { rowsJson, type Row as ListRow } from '../designer/rowsVar';
import { PanelView, useWidth } from '../widgets/panel';

/** The widget's folder in the try-out template. */
const W = 'try';
const PIC = { width: 1920, height: 1080 };

interface Line {
  at: string;
  text: string;
  where?: 'pvw' | 'air';
}

export function TrySpace() {
  const base = useDesigner((s) => s.base);
  const lang = useApp((s) => s.project?.language || 'fr');
  const def = useMemo(() => (base ? defOf(base) : null), [base]);
  // The widget placed bottom left of the picture (smaller when it does not fit).
  const tpl = useMemo<Template | null>(() => {
    if (!def) return null;
    const m = 0.05;
    const k = Math.min(1, (PIC.width * (1 - 2 * m)) / def.width, (PIC.height * (1 - 2 * m)) / def.height);
    const layers = placeWidget(def, W, PIC.width * m, PIC.height * (1 - m) - def.height * k);
    if (k < 1) {
      const f = layers.find((l) => l.id === W)!;
      f.props = { ...f.props, scaleX: k, scaleY: k, anchorX: 0, anchorY: 0 };
    }
    return { id: 'try', name: def.name, duration: 1, markers: [], fields: [], layers, zone: '', revision: 0, markerModel: MARKER_MODEL } as unknown as Template;
  }, [def]);
  const folder = tpl?.layers.find((l) => l.id === W) as Layer | undefined;
  const start = useMemo<Data>(() => (tpl && def && folder ? { ...defaultData(tpl), ...Object.fromEntries(def.vars.map((v) => [varKey(W, v.name), startValue(def, folder, v.name)])) } : {}), [tpl, def, folder]);
  const [pvw, setPvw] = useState<Data>(start);
  const [pgm, setPgm] = useState<Data | null>(null);
  const [takenAt, setTakenAt] = useState(0);
  const [mode, setMode] = useState<'pvw' | 'air'>('pvw');
  const [states, setStates] = useState<Record<string, unknown>>({});
  const pressStates = useRef<Record<string, unknown>>({});
  const [log, setLog] = useState<Line[]>([]);
  // The widget changed in another space: the preview starts again from its start values.
  useEffect(() => setPvw(start), [start]);
  const say = (text: string, where?: Line['where']) => setLog((l) => [{ at: new Date().toLocaleTimeString(), text, where }, ...l].slice(0, 60));
  const age = () => (takenAt ? (clientNow() - takenAt) / 1000 : 0);
  if (!def || !tpl || !folder) return null;

  const onAir = mode === 'air' && !!pgm;
  const data = onAir ? pgm! : pvw;
  const setData = (patch: Data, secs: number) => {
    const apply = (d: Data) => watchAnims(tpl, { ...d, ...patch }, secs);
    if (onAir) setPgm((d) => apply(d ?? pvw));
    else setPvw((d) => apply(d));
  };
  const run = (c: BuiltControl, value?: string) => {
    const logic = placedLogic(def, folder);
    if (!logic) return say(t('{name}: no Logic yet.', { name: c.label }), onAir ? 'air' : 'pvw');
    const secs = onAir ? age() : 0;
    api<{ set: Record<string, string>; states: Record<string, unknown>; forward: Forward[] }>('POST', '/api/widgets/press', { logic, widget: W, control: c.id, value: value ?? '', data, states: pressStates.current })
      .then(async (r) => {
        pressStates.current = r.states;
        for (const [k, v] of Object.entries(r.set)) if (v === '$now') r.set[k] = String(Math.round(secs * 1000) / 1000);
        setData(r.set, secs);
        const changed = Object.entries(r.set).filter(([k]) => k.startsWith(varKey(W, '')) && !k.includes('@')).map(([k, v]) => `${k.slice(varKey(W, '').length)} = ${v}`);
        say(`${c.label}${value !== undefined ? ` (${value})` : ''}${changed.length ? ` → ${changed.join(', ')}` : ''}`, onAir ? 'air' : 'pvw');
        // Its clocks: started, paused, set… as on air.
        for (const f of r.forward) {
          const layer = tpl.layers.find((l) => l.id === f.layer);
          if (!layer) continue;
          const state = await api('POST', '/api/widgets/act', { layer, state: states[f.layer] ?? null, op: f.op, args: f.args ?? null, data, ageSecs: secs, fps: 50 }).catch(() => null);
          if (state !== null) setStates((s) => ({ ...s, [f.layer]: state }));
        }
      })
      .catch((e: Error) => say(e.message, onAir ? 'air' : 'pvw'));
  };
  const setRows = (c: BuiltControl, rows: ListRow[]) => c.list && setData({ [varKey(W, c.list)]: rowsJson(rows) }, onAir ? age() : 0);
  const value = (name: string) => data[varKey(W, name)] ?? '';
  const take = () => {
    if (pgm) {
      setPgm(null);
      setTakenAt(0);
      setMode('pvw');
      say(t('OUT: the widget leaves the air.'), 'air');
      return;
    }
    // On the Programme with what the Preview prepared: its arrival plays.
    setPgm(watchAnims(tpl, { ...pvw }, 0));
    setTakenAt(clientNow());
    setStates({});
    setMode('air');
    say(t('TAKE: the widget goes on air with the values prepared.'), 'air');
  };

  return (
    <div className="ty">
      <div className="ty-main">
        <div className="ty-mons">
          <Monitor label={t('Preview')} kind="pvw" status={t('ready')} tpl={tpl} data={pvw} ageSecs={0} since={0} lang={lang} states={{}} />
          <Monitor label={t('Programme')} kind="pgm" status={pgm ? t('on air') : t('nothing on air')} tpl={pgm ? tpl : null} data={pgm ?? {}} ageSecs={0} since={takenAt} lang={lang} states={states} />
        </div>
        <div className="ty-log">
          <header>
            {t('What happens')}
            <span className="grow" />
            <button className="btn small ghost" onClick={() => setLog([])}>
              {t('Clear')}
            </button>
          </header>
          <div className="ty-lines">
            {log.length ? (
              log.map((l, i) => (
                <span key={i}>
                  {l.at} · {l.where && <b className={l.where}>{l.where === 'air' ? t('ON AIR') : t('PREVIEW')}</b>} {l.text}
                </span>
              ))
            ) : (
              <span>{t('Prepare the widget in the Preview, then take it on air.')}</span>
            )}
          </div>
        </div>
        <p className="pb-hint">{t('In the Preview the panel prepares the start values: nothing goes on air. Once taken, the same panel acts live, with the components given to the air.')}</p>
      </div>
      <aside className="ty-side">
        <header>
          <div className="segmented">
            <button type="button" className={`pvw ${mode === 'pvw' ? 'on' : ''}`} onClick={() => setMode('pvw')}>
              {t('Preview')}
            </button>
            <button type="button" className={`air ${mode === 'air' ? 'on' : ''}`} disabled={!pgm} onClick={() => setMode('air')}>
              {t('On air')}
            </button>
          </div>
          <span className="grow" />
          <button className={`ty-take ${pgm ? 'out' : ''}`} onClick={take}>
            {pgm ? t('Take out') : t('Take on air')}
          </button>
        </header>
        <div className="ty-panel">
          <div className={`cc ${onAir ? 'air' : 'operator'} wp`}>
            <PanelView key={mode} def={def} value={value} mode={onAir ? 'air' : 'pvw'} run={run} setRows={setRows} onAir={onAir} />
          </div>
        </div>
      </aside>
    </div>
  );
}

function Monitor({ label, kind, status, tpl, data, ageSecs, since, lang, states }: { label: string; kind: 'pvw' | 'pgm'; status: string; tpl: Template | null; data: Data; ageSecs: number; since: number; lang: string; states: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const scale = width / PIC.width;
  return (
    <div className={`ty-mon ${kind}`}>
      <header>
        {label}
        <span className="grow" />
        <span className="ty-st">{status}</span>
      </header>
      <div className="ty-pic" ref={ref} style={{ height: (width * PIC.height) / PIC.width }}>
        {tpl && width > 0 && (
          <Viewport width={PIC.width} height={PIC.height} scale={scale}>
            {/* On air: its time runs from the take; the Preview stands still, settled (counters at their values). */}
            <LiveTime ageSecs={ageSecs} since={since || undefined} ticking={since ? 'all' : 'wall'} settled={!since} widgetState={(id) => states[id]} lang={lang}>
              <Scene template={tpl} frame={0} data={data} />
            </LiveTime>
          </Viewport>
        )}
      </div>
    </div>
  );
}

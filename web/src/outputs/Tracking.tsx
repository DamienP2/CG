import { Box, Brush, Crosshair, Eraser, Plus, RotateCcw, Trash2, User, VideoOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../store';
import { t, tc, tn } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { NumberField } from '../ui/fields';
import { anchorFrom, follow, useCameras } from '../engine/tracking';
import { fps as fpsText, num } from '../perf/format';
import { CUT_DEFAULTS, type Cut, type InputConfig, type InputInfo, type ServerConfig, type Stroke } from './types';
import { OnSwitch } from './OnSwitch';
import { Group, inputState, useInputStatus, type InputState } from './Inputs';

/*
 * Diffusion › Camera tracking: the tracked cameras on the left; the chosen
 * one on the whole page: its picture with the people found, its movement,
 * how its people are cut out, how it is received and its optics. Saved with
 * the rest of the settings (the save bar); the cut out is tried at once.
 */

/** Frames the samples are held, to meet the video. */
const DELAYS = [0, 1, 2, 3, 4, 5, 6, 8, 10];

type Edit = (fn: (x: InputConfig) => void) => void;

export function TrackingMode({ cfg, saved, edit }: { cfg: ServerConfig; saved: ServerConfig; edit: (fn: (c: ServerConfig) => void) => void }) {
  const cams = (cfg.inputs ?? []).filter((i) => i.kind === 'tracking');
  const [sel, setSel] = useState<string | null>(null);
  const status = useInputStatus();
  const current = cams.find((i) => i.id === sel) ?? cams[0];
  const editInput = (id: string, fn: (i: InputConfig) => void) =>
    edit((c) => {
      const i = (c.inputs ?? []).find((x) => x.id === id);
      if (i) fn(i);
    });

  const add = () => {
    const ids = new Set((cfg.inputs ?? []).map((i) => i.id));
    let n = 1;
    while (ids.has(`input-${n}`)) n++;
    const id = `input-${n}`;
    // OpenTrackIO: the multicast group of source 1, on its port.
    const name = t('Camera {n}', { n: cams.length + 1 });
    edit((c) => void (c.inputs ??= []).push({ id, name, kind: 'tracking', url: '', port: 55555, multicast: true, source: 1, delay: 0, listen: false, ndiSource: '', device: 0, width: 1920, height: 1080, fps: 25, buffer: 2, hwDecode: false }));
    setSel(id);
  };
  const remove = (id: string) => {
    const at = cams.findIndex((c) => c.id === id);
    edit((c) => void (c.inputs = (c.inputs ?? []).filter((i) => i.id !== id)));
    setSel(cams[at + 1]?.id ?? cams[at - 1]?.id ?? null);
  };

  return (
    <div className="outputs-page">
      <aside className="lib-nav">
        <div className="lib-nav-section">
          <span className="grow">{t('Cameras')}</span>
          <button className="icon-btn ghost" title={t('Add a camera')} onClick={add}>
            <Plus size={14} />
          </button>
        </div>
        {cams.map((i) => {
          const st = inputState(i, saved, status);
          return (
            <div key={i.id} role="button" tabIndex={0} className={`oc-channel vs-item ${i.id === current?.id ? 'on' : ''} ${i.enabled === false ? 'off' : ''}`} onClick={() => setSel(i.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(i.id)}>
              <OnSwitch on={i.enabled !== false} mini onChange={(v) => editInput(i.id, (x) => void (x.enabled = v))} />
              <span className={`oc-dot ${st.tone}`} />
              <span className="grow">
                <span>{i.name || i.id}</span>
                <small title={st.text}>{stateText(st)}</small>
              </span>
            </div>
          );
        })}
      </aside>
      <main className="oc-main tk-main">
        {current ? (
          <Camera
            key={current.id}
            input={current}
            state={inputState(current, saved, status)}
            edit={(fn) => editInput(current.id, fn)}
            remove={() => remove(current.id)}
            pictures={(cfg.inputs ?? []).filter((x) => x.kind !== 'tracking').map((x) => ({ id: x.id, name: x.name || x.id }))}
          />
        ) : (
          <div className="vs-empty tk-empty">
            <Crosshair size={28} />
            <p>{t('No camera')}</p>
            <button className="btn" onClick={add}>
              <Plus size={14} /> {t('Add a camera')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/** "Receiving · 50 Hz". */
const stateText = (st: InputState) => (st.live && st.info?.fps ? `${st.text} · ${fpsText(st.info.fps)} Hz` : st.text);

/** The settings, the defaults where missing (and nothing of older ones). */
const cutOf = (i: InputConfig): Cut => Object.fromEntries(Object.entries(CUT_DEFAULTS).map(([k, v]) => [k, i.cut?.[k as keyof Cut] ?? v])) as unknown as Cut;
const same = (a: Cut, b: Cut) => JSON.stringify(a) === JSON.stringify(b);

type View = 'image' | 'cut' | 'result';

/** The brush or the eraser, and its width (a fraction of the picture's). */
interface Tool {
  erase: boolean;
  size: number;
}

function Camera({ input: i, state, edit, remove, pictures }: { input: InputConfig; state: InputState; edit: Edit; remove: () => void; pictures: { id: string; name: string }[] }) {
  const [view, setView] = useState<View>('result');
  const [tool, setTool] = useState<Tool>({ erase: false, size: 0.03 });
  const cut = cutOf(i);
  const chosen = cut.foreground === 'chosen';
  const setCut = (patch: Partial<Cut>) =>
    edit((x) => {
      const next = { ...cutOf(x), ...patch };
      // The defaults are not written down.
      if (same(next, CUT_DEFAULTS)) delete x.cut;
      else x.cut = next;
    });

  // Tried at once on the camera (kept once saved).
  const key = JSON.stringify(cut);
  useEffect(() => {
    if (!i.image) return;
    const h = setTimeout(() => void api('PUT', `/api/inputs/${encodeURIComponent(i.id)}/cut`, JSON.parse(key)).catch(() => {}), 120);
    return () => clearTimeout(h);
  }, [i.id, i.image, key]);

  // B: the brush, E: the eraser (not while typing).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'e') setTool((x) => ({ ...x, erase: k === 'e' }));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const p = state.info?.people;
  return (
    <>
      <header className="tk-head">
        <OnSwitch on={i.enabled !== false} onChange={(v) => edit((x) => void (x.enabled = v))} />
        <input className="tk-name" value={i.name} spellCheck={false} aria-label={t('Name')} onChange={(e) => edit((x) => void (x.name = e.target.value))} />
        <span className={`tk-pill ${state.tone}`} title={state.text}>
          <i />
          {stateText(state)}
        </span>
        <span className="tk-pill">OpenTrackIO</span>
        {!!state.info?.mixerDelay && (
          <span className="tk-pill">
            {t('Delay at the mixer')} · <b>{tn(state.info.mixerDelay, '{n} frame', '{n} frames')}</b>
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn ghost" title={t('Remove the camera')} onClick={remove}>
          <Trash2 size={15} />
        </button>
      </header>

      <div className="tk-top">
        <div className="tk-left">
          <section className="tk-view">
            <div className="tk-bar">
              <div className="segmented tk-views">
                {(
                  [
                    ['image', tc('trkview', 'Picture')],
                    ['cut', tc('trkview', 'Cut out')],
                    ['result', tc('trkview', 'Result')],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className={`tk-screen ${chosen ? 'tk-paint' : ''}`}>
              {i.image ? (
                <PeopleImage id={i.id} view={view} />
              ) : (
                <span className="tk-none">
                  <VideoOff size={22} />
                  {t('No picture')}
                </span>
              )}
              {chosen && <Paint id={i.id} strokes={cut.strokes} shown={view !== 'image'} tool={tool} add={(st) => setCut({ strokes: [...cut.strokes, st] })} />}
              <span className="tk-hud tl">{i.name || i.id}</span>
              {p?.ms != null && <span className="tk-hud tr">{num(p.ms, 0)} ms</span>}
            </div>
          </section>
          <Movement id={i.id} />
        </div>
        <CutCard input={i} cut={cut} setCut={setCut} edit={edit} info={state.info} pictures={pictures} tool={tool} setTool={setTool} />
      </div>

      <div className="tk-bottom">
        <section className="tk-card">
          <h3>{t('Reception')}</h3>
          <div className="tk-grid2">
            <Group label={t('Reception')}>
              <div className="seg vs-seg">
                {[true, false].map((m) => (
                  <button key={String(m)} type="button" className={(i.multicast ?? true) === m ? 'on' : ''} onClick={() => edit((x) => void (x.multicast = m))}>
                    {m ? 'Multicast' : 'Unicast'}
                  </button>
                ))}
              </div>
            </Group>
            <Group label={t('Port')}>
              <NumberField value={i.port || 55555} min={1} max={65535} onChange={(v) => edit((x) => void (x.port = Math.max(1, Math.min(65535, Math.round(v) || 0))))} />
            </Group>
            <Group label={t('Source number')}>
              <NumberField value={i.source ?? 1} min={0} max={255} title={(i.multicast ?? true) ? `239.135.1.${i.source ?? 1}` : undefined} onChange={(v) => edit((x) => void (x.source = Math.max(0, Math.min(255, Math.round(v) || 0))))} />
            </Group>
            <Group label={tc('camera', 'Delay')}>
              <Dropdown
                value={String(i.delay ?? 0)}
                title={tc('camera', 'Delay')}
                options={[...(DELAYS.includes(i.delay ?? 0) ? [] : [i.delay ?? 0]), ...DELAYS].map((d) => ({ value: String(d), label: tn(d, '{n} frame', '{n} frames') }))}
                onChange={(v) => edit((x) => void (x.delay = Number(v)))}
              />
            </Group>
          </div>
        </section>
        <Optics input={i} edit={edit} />
      </div>
    </>
  );
}

/** The camera's picture, or its people (shown or over a band), five times a second (looking keeps them found). */
function PeopleImage({ id, view }: { id: string; view: View }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let after: string | null = null;
    let shown: string | null = null;
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const q = new URLSearchParams({ view, ...(after ? { after } : {}) });
          const r: Response = await fetch(`/api/inputs/${encodeURIComponent(id)}/people.jpg?${q}`, { credentials: 'same-origin', signal: abort.signal, cache: 'no-store' });
          if (r.status === 200) {
            after = r.headers.get('x-frame');
            const next = URL.createObjectURL(await r.blob());
            const old = shown;
            shown = next;
            setUrl(next);
            if (old) setTimeout(() => URL.revokeObjectURL(old), 500);
          }
        } catch {
          if (abort.signal.aborted) break;
        }
        await new Promise((res) => setTimeout(res, document.hidden ? 1000 : 120));
      }
    })();
    return () => {
      abort.abort();
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [id, view]);
  return url ? <img src={url} alt="" draggable={false} /> : <span className="tk-none">{t('Waiting for a picture…')}</span>;
}

/** Points of a stroke closer than this to the last one kept are dropped (a fraction of the width). */
const SPACING = 0.003;
const round = (v: number) => Math.round(v * 10000) / 10000;

/** Painting over the picture: the cursor, the stroke being painted, and the paint where the camera sees it now (`shown`). */
function Paint({ id, strokes, shown, tool, add }: { id: string; strokes: Stroke[]; shown: boolean; tool: Tool; add: (s: Stroke) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLElement>(null);
  const cam = useCameras((x) => x.samples[id]);
  const [drawing, setDrawing] = useState<Stroke | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.round(el.clientWidth * devicePixelRatio), h: Math.round(el.clientHeight * devicePixelRatio) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const { w, h } = size;
    c.width = w;
    c.height = h;
    g.clearRect(0, 0, w, h);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = g.fillStyle = '#34d399';
    for (const st of [...(shown ? strokes : []), ...(drawing ? [drawing] : [])]) {
      // Where the camera sees it now (as painted without a camera).
      const pts: [number, number, number][] = [];
      for (const [u, v] of st.points) {
        const m = st.anchor && cam ? follow(st.anchor, cam, w, h, u * w, v * h) : [0, 0, 1];
        if (m) pts.push([u * w + m[0], v * h + m[1], m[2]]);
      }
      if (!pts.length) continue;
      g.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
      g.lineWidth = st.size * w * pts[0][2];
      g.beginPath();
      if (pts.length === 1) {
        g.arc(pts[0][0], pts[0][1], g.lineWidth / 2, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      g.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
      g.stroke();
    }
  }, [size, strokes, drawing, shown, cam]);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const moveCursor = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const c = cursor.current;
    if (!c) return;
    const d = tool.size * r.width;
    Object.assign(c.style, { display: 'block', left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: `${d}px`, height: `${d}px` });
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // The camera now: the paint stays on the set.
    const sample = useCameras.getState().samples[id];
    setDrawing({ ...(tool.erase ? { erase: true } : {}), size: round(tool.size), points: [at(e).map(round) as [number, number]], ...(sample ? { anchor: anchorFrom(sample) } : {}) });
  };
  const move = (e: React.PointerEvent) => {
    moveCursor(e);
    if (!drawing) return;
    const [u, v] = at(e);
    const [lu, lv] = drawing.points[drawing.points.length - 1];
    const r = box.current!.getBoundingClientRect();
    if (Math.hypot(u - lu, ((v - lv) * r.height) / r.width) < SPACING) return;
    setDrawing({ ...drawing, points: [...drawing.points, [round(u), round(v)]] });
  };
  const up = () => {
    if (drawing) add(drawing);
    setDrawing(null);
  };
  return (
    <div className="tk-brush" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => cursor.current && (cursor.current.style.display = 'none')}>
      <canvas ref={canvas} />
      <i ref={cursor} className={`tk-cursor ${tool.erase ? 'erase' : ''}`} />
    </div>
  );
}

const deg = (v: number) => `${num(v, 2)}°`;

/** Pan, tilt, roll and the lens, as the camera sends them. */
function Movement({ id }: { id: string }) {
  const s = useCameras((x) => x.samples[id]);
  const cells: [string, string][] = [
    ['Pan', s ? deg(s.pan) : '—'],
    ['Tilt', s ? deg(s.tilt) : '—'],
    ['Roll', s ? deg(s.roll) : '—'],
    [t('Focal length'), s?.focal ? `${num(s.focal, 1)} mm` : '—'],
    [t('Focus'), s?.focus ? `${num(s.focus, 2)} m` : '—'],
    [t('Iris'), s?.iris ? `f/${num(s.iris, 1)}` : '—'],
  ];
  return (
    <section className="tk-card">
      <h3>{t('Movement')}</h3>
      <div className="tk-live">
        {cells.map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            <b>{v}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Sensor widths a camera can film with (mm). */
const FULL_FRAME = 35.6;
const SUPER_35 = 24.9;

/** What the camera sends of its optics, and what the tracking uses when it does not. */
function Optics({ input: i, edit }: { input: InputConfig; edit: Edit }) {
  const s = useCameras((x) => x.samples[i.id]);
  const sensor = i.sensor ?? 0;
  const sensorOptions = [
    ...(s?.sensorSent ? [{ value: '0', label: t('Received from the camera') }] : []),
    { value: s?.sensorSent ? String(FULL_FRAME) : '0', label: `${t('Full frame')} · ${num(FULL_FRAME, 1)} mm` },
    { value: String(SUPER_35), label: `Super 35 · ${num(SUPER_35, 1)} mm` },
  ];
  const shown = sensor === SUPER_35 ? String(SUPER_35) : s?.sensorSent && sensor === FULL_FRAME ? String(FULL_FRAME) : '0';
  return (
    <section className="tk-card">
      <h3>{t('Optics')}</h3>
      <div className="tk-live">
        <div>
          <small>{t('Distortion')}</small>
          <b>{s?.distortion ? tc('distortion', 'Received') : '—'}</b>
        </div>
        <div>
          <small>{t('Optical centre')}</small>
          <b>{s?.pupilSent ? `${num(s.pupil ?? 0, 2)} m` : '—'}</b>
        </div>
        <div>
          <small>{t('Sensor')}</small>
          <b>{s?.sensorSent ? `${num(s.sensor, 1)} mm` : '—'}</b>
        </div>
      </div>
      <div className="tk-grid2">
        <Group label={t('Sensor')}>
          <Dropdown value={shown} title={t('Sensor')} options={sensorOptions} onChange={(v) => edit((x) => void (Number(v) ? (x.sensor = Number(v)) : delete x.sensor))} />
        </Group>
        <Group label={t('Optical centre')}>
          {s?.pupilSent ? (
            <input className="input" value={t('Received · {value}', { value: `${num(s.pupil ?? 0, 2)} m` })} disabled />
          ) : (
            <NumberField value={i.pupil ?? 0} min={0} max={1} step={0.01} precision={2} suffix="m" onChange={(v) => edit((x) => void (v > 0 ? (x.pupil = Math.min(1, v)) : delete x.pupil))} />
          )}
        </Group>
      </div>
    </section>
  );
}

const signed = (v: number, unit: string) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))} ${unit}`;

/** What finds the people: "GPU · CUDA · 4 ms", "CPU · 2 cores · 18 ms". */
function deviceText(p?: InputInfo['people']): { text: string; slow: boolean; title?: string } | null {
  const d = p?.device;
  if (!d) return null;
  const ms = p?.ms != null ? ` · ${num(p.ms, 0)} ms` : '';
  if (d.kind === 'gpu') return { text: `GPU · ${d.provider ?? ''}${ms}`, slow: false };
  const cpu = `CPU · ${tn(d.threads ?? 1, '{n} core', '{n} cores')}${ms}`;
  return d.noGpu ? { text: `${t('GPU unavailable')} · ${cpu}`, slow: true, title: d.noGpu } : { text: cpu, slow: false };
}

function CutCard({ input: i, cut, setCut, edit, info, pictures, tool, setTool }: { input: InputConfig; cut: Cut; setCut: (p: Partial<Cut>) => void; edit: Edit; info?: InputInfo; pictures: { id: string; name: string }[]; tool: Tool; setTool: (t: Tool) => void }) {
  const device = i.image ? deviceText(info?.people) : null;
  const slider = (k: 'contour' | 'edge' | 'steady' | 'shift', label: string, min: number, max: number, show: (v: number) => string, lo: string, hi: string) => (
    <div className="tk-sl">
      <div className="tk-sl-top">
        <span className="set-label">{label}</span>
        <button className={`tk-reset ${cut[k] !== CUT_DEFAULTS[k] ? 'on' : ''}`} title={t('Default value')} onClick={() => setCut({ [k]: CUT_DEFAULTS[k] })}>
          <RotateCcw size={11} />
        </button>
        <b>{show(cut[k])}</b>
      </div>
      <input type="range" min={min} max={max} step={1} value={cut[k]} aria-label={label} onChange={(e) => setCut({ [k]: Number(e.target.value) })} />
      <div className="tk-sl-ends">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
  return (
    <section className="tk-card tk-cut">
      <h3>{t('Cut out')}</h3>
      <Group label={t('Compute')}>
        <div className="seg vs-seg">
          {(['auto', 'gpu', 'cpu'] as const).map((p) => (
            <button key={p} type="button" className={cut.processor === p ? 'on' : ''} onClick={() => setCut({ processor: p })}>
              {p === 'auto' ? t('Auto') : p.toUpperCase()}
            </button>
          ))}
        </div>
      </Group>
      {device && (
        <div className={`tk-procinfo ${device.slow ? 'slow' : ''}`} title={device.title}>
          <i />
          {device.text}
        </div>
      )}
      <Group label={t('Picture')}>
        <Dropdown
          value={i.image ?? ''}
          title={t('Picture')}
          options={[
            { value: '', label: tc('picture', 'None') },
            ...pictures.map((p) => ({ value: p.id, label: p.name })),
            ...(i.image && !pictures.some((p) => p.id === i.image) ? [{ value: i.image, label: t('(missing: {source})', { source: i.image }) }] : []),
          ]}
          onChange={(v) => edit((x) => void (v ? (x.image = v) : delete x.image))}
        />
      </Group>
      {slider('contour', t('Contour'), -10, 10, (v) => signed(v, 'px'), tc('cut', 'Shrink'), t('Widen'))}
      {slider('edge', tc('cut', 'Edge'), 0, 100, (v) => `${v} %`, t('Sharp'), t('Soft'))}
      {slider('steady', t('Steadiness'), 0, 100, (v) => `${v} %`, t('Reactive'), tc('cut', 'Steady'))}
      {slider('shift', tc('cut', 'Shift'), -3, 3, (v) => signed(v, tc('frames', 'fr.')), t('Before'), t('After'))}
      <Foreground cut={cut} setCut={setCut} items={info?.people?.items ?? []} tool={tool} setTool={setTool} />
    </section>
  );
}

/** Who passes in front of the graphics: every person, or what was painted (the brush, the eraser, what they chose). */
function Foreground({ cut, setCut, items, tool, setTool }: { cut: Cut; setCut: (p: Partial<Cut>) => void; items: NonNullable<NonNullable<InputInfo['people']>['items']>; tool: Tool; setTool: (t: Tool) => void }) {
  const chosen = cut.foreground === 'chosen';
  const n = { person: 0, object: 0 };
  const remove = (gone: number[]) => {
    const left = cut.strokes.filter((_, k) => !gone.includes(k));
    // Only erasers left: nothing.
    setCut({ strokes: left.some((x) => !x.erase) ? left : [] });
  };
  const shown = items.filter((it) => it.strokes.some((k) => k < cut.strokes.length));
  return (
    <div className="tk-fg">
      <span className="set-label">{t('Foreground')}</span>
      <div className="seg vs-seg tk-mode">
        {(['all', 'chosen'] as const).map((f) => (
          <button key={f} type="button" className={cut.foreground === f ? 'on' : ''} onClick={() => setCut({ foreground: f })}>
            {f === 'all' ? t('All the people') : t('My selection')}
          </button>
        ))}
      </div>
      {chosen && (
        <>
          <div className="tk-tools">
            <div className="segmented tk-toolseg">
              <button className={!tool.erase ? 'on' : ''} title={`${t('Brush')} (B)`} onClick={() => setTool({ ...tool, erase: false })}>
                <Brush size={14} /> {t('Brush')}
              </button>
              <button className={tool.erase ? 'on' : ''} title={`${t('Eraser')} (E)`} onClick={() => setTool({ ...tool, erase: true })}>
                <Eraser size={14} /> {t('Eraser')}
              </button>
            </div>
            <input type="range" className="tk-size" min={10} max={120} step={1} value={Math.round(tool.size * 1280)} title={t('Size')} aria-label={t('Size')} onChange={(e) => setTool({ ...tool, size: Number(e.target.value) / 1280 })} />
          </div>
          <div className="tk-items">
            {shown.map((it) => {
              const person = it.kind === 'person';
              const k = ++n[it.kind];
              return (
                <div key={`${it.kind}-${it.strokes.join('.')}`} className="tk-zi">
                  <span>
                    {person ? <User size={13} /> : <Box size={13} />} {person ? t('Person {n}', { n: k }) : t('Object {n}', { n: k })}
                    <small>{person ? t('follows the person') : t('fixed to the set')}</small>
                  </span>
                  <button className="icon-btn ghost" title={t('Remove')} onClick={() => remove(it.strokes)}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
